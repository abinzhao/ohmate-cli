/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createInterface } from 'node:readline/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import { ContextService } from '../agent/context-service.js';
import { renderReceipt } from './help.js';
import type { ExecutionContext, OHMateRuntime, ToolResult } from '../runtime/index.js';

export interface ConsoleIO { read: (prompt: string, signal: AbortSignal) => Promise<string | null>; write: (text: string) => void }
interface Selection { files: string[]; writePaths: string[]; allowedTools: string[]; sessionId?: string; modelId?: string }
const HELP = '/models, /trae [absolute executable path], /model <id>, /files <comma-separated paths>, /write <comma-separated paths>, /tools <comma-separated IDs>, /session <id>, /execute <toolId> <JSON>, /approve <taskId> [planId], /exit\n';
const CONSOLE_COMMANDS = ['/help', '/models', '/trae', '/model', '/files', '/write', '/tools', '/session', '/execute', '/approve', '/exit'];
export function completeConsoleLine(line: string, toolIds: string[] = []): [string[], string] {
  const value = String(line ?? '');
  if (!value.startsWith('/')) { return [[], value]; }
  if (!value.includes(' ')) { return [CONSOLE_COMMANDS.filter((item) => item.startsWith(value)), value]; }
  if (/^\/execute\s/.test(value)) {
    const prefix = value.split(/\s+/).at(-1) ?? '';
    return [toolIds.filter((id) => id.startsWith(prefix)), value];
  }
  return [[], value];
}

async function command(line: string, runtime: OHMateRuntime, context: ExecutionContext, selection: Selection, io: ConsoleIO): Promise<void> {
  const [name, ...rest] = line.slice(1).split(' '), value = rest.join(' ').trim();
  if (name === 'help') { io.write(HELP); return; }
  if (name === 'models' || name === 'trae') {
    io.write(renderReceipt(await runtime.execute(name === 'models' ? 'model.list' : 'model.trae-cli',
      name === 'trae' && value ? { executable: value } : {}, context)));
    return;
  }
  if (name === 'files' || name === 'tools' || name === 'write') {
    selection[name === 'files' ? 'files' : name === 'write' ? 'writePaths' : 'allowedTools'] = value ? value.split(',').map((item) => item.trim()) : [];
    io.write(`${name}: ${value || '(empty)'}\n`); return;
  }
  if (name === 'session' || name === 'model') { selection[name === 'session' ? 'sessionId' : 'modelId'] = value || undefined; return; }
  if (name === 'approve') {
    const [id, planIdArg] = value.split(/\s+/).filter(Boolean);
    if (!id) { throw new Error('Usage: /approve <taskId> [planId]'); }
    const task = (await runtime.execute('task.show', { id }, context)).data as
      { sessionId?: string; plan?: { planId?: string } };
    const planId = planIdArg ?? task.plan?.planId;
    if (!planId) { throw new Error('Task has no pending approval plan'); }
    if (task.sessionId) { selection.sessionId = task.sessionId; }
    io.write(renderReceipt(await runtime.execute('task.approve', { id, planId, wait: true }, context)));
    if (task.sessionId) { io.write(`已批准并执行。发送新消息将继续会话 ${task.sessionId.slice(0, 8)}。\n`); }
    return;
  }
  if (name !== 'execute' || !rest[0]) { throw new Error('Unknown console command; use /help'); }
  const input = rest.slice(1).join(' ').trim();
  io.write(renderReceipt(await runtime.execute(rest[0], input ? JSON.parse(input) : {}, context)));
}

async function prompt(text: string, runtime: OHMateRuntime, context: ExecutionContext, selection: Selection, io: ConsoleIO): Promise<void> {
  const input = { ...selection, prompt: text };
  const preview = await new ContextService(context, runtime.registry).preview(input);
  if (!preview.model) { io.write(renderReceipt(await runtime.execute('agent.run', input, context))); return; }
  io.write(`${JSON.stringify(preview, null, 2)}\n`);
  const approval = await io.read(`Send this context to ${preview.model.id}? [y/N] `, context.abortSignal);
  if (approval?.toLowerCase() !== 'y') { io.write('Context was not sent.\n'); return; }
  const receipt = await runtime.execute('task.submit', { toolId: 'agent.run', input: { ...input, previewHash: preview.hash }, wait: true }, context);
  io.write(renderReceipt(receipt));
  const task = receipt.data as { sessionId?: string };
  if (task.sessionId) { selection.sessionId = task.sessionId; }
}

export async function runConsole(runtime: OHMateRuntime, context: ExecutionContext, io: ConsoleIO): Promise<ToolResult> {
  const selection: Selection = { files: [], writePaths: [], allowedTools: [] };
  io.write(`OHMate CLI · ${context.projectRoot ?? context.cwd}\n${HELP}`);
  while (!context.abortSignal.aborted) {
    const line = await io.read('ohmate> ', context.abortSignal);
    if (line === null || line.trim() === '/exit') { break; }
    if (!line.trim()) { continue; }
    try {
      if (line.startsWith('/')) { await command(line, runtime, context, selection, io); }
      else { await prompt(line, runtime, context, selection, io); }
    } catch (error) { io.write(`CONSOLE_INPUT_INVALID: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  return { exitCode: context.abortSignal.aborted ? 130 : 0, data: { sessionId: selection.sessionId ?? null } };
}

export async function openConsole(runtime: OHMateRuntime, context: ExecutionContext, input: ReadStream, output: WriteStream): Promise<ToolResult> {
  const reader = createInterface({
    input, output, terminal: true, historySize: 200, removeHistoryDuplicates: true,
    completer: (line: string) => completeConsoleLine(line, runtime.registry.list().map((spec) => spec.id)),
  });
  const cancel = new AbortController(), force = new AbortController();
  const current = { ...context, abortSignal: AbortSignal.any([context.abortSignal, cancel.signal]),
    forceSignal: context.forceSignal ? AbortSignal.any([context.forceSignal, force.signal]) : force.signal };
  let closed = false, promptActive = false, idleInterrupts = 0, lastSignal = 0, lastIdle = 0;
  reader.once('close', () => { closed = true; });
  const interrupt = () => {
    const now = Date.now();
    if (now - lastSignal < 150) { return; }
    lastSignal = now;
    if (!promptActive) { if (cancel.signal.aborted) { force.abort(); } else { cancel.abort(); } return; }
    idleInterrupts = now - lastIdle < 2000 ? idleInterrupts + 1 : 1;
    lastIdle = now;
    if (idleInterrupts >= 2) { output.write('\n'); cancel.abort(); return; }
    output.write('\n再按一次 Ctrl+C 退出，或输入 /exit。\n');
  };
  reader.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  try {
    return await runConsole(runtime, current, {
      read: async (prompt, signal) => {
        if (closed) { return null; }
        promptActive = true;
        try {
          const line = await reader.question(prompt, { signal });
          idleInterrupts = 0;
          return line;
        } catch (error) {
          if (closed || signal.aborted) { return null; }
          throw error;
        } finally { promptActive = false; }
      },
      write: (text) => output.write(text),
    });
  } finally {
    reader.off('SIGINT', interrupt);
    process.off('SIGINT', interrupt);
    reader.close();
  }
}
