/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { LocalState } from './local-state.js';
import { SessionStore } from './sessions.js';
import { ModelStore } from './models.js';
import { applicableRules, readMaterial, sha256 } from './context-files.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { TaskStore } from '../tasks/task-store.js';
import { readSnapshot } from '../workspace/patch-review.js';
import type { ExecutionContext } from '../runtime/types.js';
import type { ToolSpecRegistry } from '../runtime/registry.js';

export const previewSchema = z.strictObject({
  prompt: z.string().max(32_768).default(''), files: z.array(z.string().max(1024)).max(32).default([]),
  writePaths: z.array(z.string().max(1024)).max(20).default([]),
  sessionId: z.string().uuid().optional(), modelId: z.string().optional(),
  allowedTools: z.array(z.string()).max(32).default([]), maxBytes: z.coerce.number().int().positive().max(256 * 1024).default(64 * 1024),
});
export type PreviewInput = z.input<typeof previewSchema>;
const memorySchema = z.array(z.strictObject({ id: z.string().uuid(), text: z.string().max(8192), approved: z.literal(true) }));
const extensionSchema = z.array(z.strictObject({ id: z.string(), enabled: z.boolean(), status: z.literal('unverified') }));
const materialSchema = z.strictObject({
  path: z.string(), source: z.enum(['file', 'rule']), sha256: z.string(), bytes: z.number(),
  redacted: z.boolean(), text: z.string(),
});
const historicalPromptSchema = z.object({ prompt: z.string(), materials: z.array(materialSchema),
  memories: z.array(z.unknown()), tasks: z.array(z.unknown()), writeScope: z.array(z.unknown()) }).passthrough();

function compactHistory(history: unknown[], current: z.infer<typeof materialSchema>[]): unknown[] {
  const compact = (text: string): string => {
    try {
      const parsed = historicalPromptSchema.safeParse(JSON.parse(text));
      if (!parsed.success) { return text; }
      let changed = false;
      const materials = parsed.data.materials.map((material) => {
        if (!current.some((item) => item.path === material.path && item.source === material.source &&
          item.sha256 === material.sha256 && item.bytes === material.bytes &&
          item.redacted === material.redacted && item.text === material.text)) { return material; }
        changed = true;
        return { path: material.path, source: material.source, sha256: material.sha256,
          bytes: material.bytes, redacted: material.redacted, textReference: 'current-material' };
      });
      // Keep the saved transcript intact; only replace identical approved text in this send.
      return changed ? JSON.stringify({ ...parsed.data, materials }) : text;
    } catch { return text; }
  };
  return history.map((message) => {
    const parsed = z.object({ role: z.literal('user'), content: z.unknown() }).passthrough().safeParse(message);
    if (!parsed.success) { return message; }
    const content = parsed.data.content;
    if (typeof content === 'string') { return { ...parsed.data, content: compact(content) }; }
    if (!Array.isArray(content)) { return message; }
    return { ...parsed.data, content: content.map((part) => {
      const block = z.object({ type: z.literal('text'), text: z.string() }).passthrough().safeParse(part);
      return block.success ? { ...block.data, text: compact(block.data.text) } : part;
    }) };
  });
}

export class ContextService {
  private readonly state: LocalState;
  constructor(private readonly context: ExecutionContext, private readonly registry?: ToolSpecRegistry) { this.state = new LocalState(context.dataDir); }
  private memoryName(): string { return `memory-${this.context.workspaceId}`; }
  async memories() { return this.state.read(this.memoryName(), memorySchema, []); }
  async addMemory(text: string) {
    assertPublicValue(text);
    return this.state.update(this.memoryName(), memorySchema, [], (value) => [...value, { id: randomUUID(), text, approved: true as const }]);
  }
  async removeMemory(id: string) {
    return this.state.update(this.memoryName(), memorySchema, [], (value) => value.filter((item) => item.id !== id));
  }
  async extensions() { return this.state.read('extensions', extensionSchema, []); }
  async setExtension(id: string, enabled: boolean) {
    if (enabled) { throw new Error('Executable extension is not verified; enabling is unavailable'); }
    z.string().regex(/^[a-z0-9-]{1,64}$/).parse(id);
    return this.state.update('extensions', extensionSchema, [], (value) => [
      ...value.filter((item) => item.id !== id), { id, enabled, status: 'unverified' as const },
    ]);
  }
  async rules(files: string[] = []) { return applicableRules(this.context.projectRoot ?? this.context.cwd, files, this.context.dataDir); }
  private async toolContracts(ids: string[]) {
    if (!ids.length) { return []; }
    const registry = this.registry ?? (await (await import('../runtime/runtime.js')).createRuntime()).registry;
    return [...new Set(ids)].sort().map((id) => {
      const spec = registry.get(id);
      if (!spec) { throw new Error('Unknown context tool'); }
      return { id, command: spec.command, risk: spec.risk, description: spec.description, adapter: spec.adapter,
        inputSchema: z.toJSONSchema(spec.inputSchema, { io: 'input', unrepresentable: 'any' }) };
    });
  }
  async preview(input: PreviewInput) {
    const request = previewSchema.parse(input), root = this.context.projectRoot ?? this.context.cwd;
    assertPublicValue(request.prompt);
    const materials = await this.rules([...request.files, ...request.writePaths]);
    const writeScope = [];
    for (const path of [...new Set(request.writePaths)].sort()) {
      const snapshot = await readSnapshot(this.context, path);
      writeScope.push({ path, oldHash: snapshot.oldHash });
    }
    for (const file of [...new Set(request.files)].sort()) {
      const path = resolve(root, file);
      if (path === this.context.dataDir || path.startsWith(`${this.context.dataDir}${sep}`)) { throw new Error('Product state is not sendable context'); }
      materials.push(await readMaterial(root, file, 'file', this.context.dataDir));
    }
    const memories = await this.memories(), store = new ModelStore(this.context.dataDir);
    const model = request.modelId ? await store.get(request.modelId) : await store.selected();
    const session = request.sessionId ? await new SessionStore(this.context.dataDir).show(request.sessionId) : null;
    if (session && session.projectRoot !== this.context.projectRoot) { throw new Error('Session belongs to a different project'); }
    const history = compactHistory(session?.entries.filter((entry) => entry.type === 'message').map((entry) => entry.value) ?? [], materials);
    const tools = await this.toolContracts(request.allowedTools);
    const tasks = session ? (await new TaskStore(this.context.dataDir).list()).filter((task) =>
      task.sessionId === session.id && task.toolId !== 'agent.run').map((task) => ({
      id: task.id, toolId: task.toolId, state: task.state, receipt: task.receipt ?? null,
    })) : [];
    const promptText = JSON.stringify({ prompt: request.prompt, materials, memories, tasks, writeScope });
    const text = JSON.stringify({ prompt: request.prompt, materials, memories, tasks, writeScope, history, tools });
    const bytes = Buffer.byteLength(text);
    if (bytes > request.maxBytes) { throw new Error('Selected context exceeds the sending budget'); }
    const payload = { request, projectRoot: this.context.projectRoot, model, materials, memories, history, tasks, tools, writeScope };
    return { hash: sha256(JSON.stringify(payload)), bytes, text, promptText, materials, memories, history, tasks, tools, model, writeScope, scope: 'explicit-files-and-approved-memory' };
  }
}
