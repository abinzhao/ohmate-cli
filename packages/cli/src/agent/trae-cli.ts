/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ModelStore, traeExecutableSchema } from './models.js';
import { stopProcessTree, usesProcessGroups } from '../runtime/process-tree.js';
import { debugLog } from '../utils/logger.js';
import type { ModelConfig } from './models.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';

const LIMIT = 256 * 1024;
const discoverySchema = z.strictObject({ executable: traeExecutableSchema.default('trae-cli') });
const catalogSchema = z.array(z.object({
  name: z.string().min(1).max(200), config_name: z.string().min(1).max(200).optional(),
  context_window: z.number().int().min(1024).max(2_000_000),
})).max(512);

/** Only this owned process sees CLI authentication; raw stderr and RPC errors never leave it. */
export async function withTraeProcess<T>(executable: string, args: string[], signal: AbortSignal | undefined,
  operation: (child: ReturnType<typeof spawn>, closed: Promise<void>, cwd: string) => Promise<T>): Promise<T> {
  if (signal?.aborted) { throw new Error('TRAE_CLI_CANCELLED'); }
  const cwd = await mkdtemp(join(tmpdir(), 'ohmate-model-'));
  let child: ReturnType<typeof spawn>;
  try {
    const script = /\.(?:mjs|cjs|js)$/i.test(executable);
    debugLog(`Executing: ${script ? process.execPath : executable} ${[...(script ? [executable] : []), ...args].join(' ')}`);
    child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args, {
      cwd, shell: false, detached: usesProcessGroups(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: 'error' },
    });
  } catch {
    await rm(cwd, { recursive: true, force: true }); throw new Error('TRAE_CLI_REQUEST_FAILED');
  }
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.on('error', () => {});
  child.stderr!.resume();
  let ended = false;
  void closed.then(() => { ended = true; });
  let force: NodeJS.Timeout | undefined;
  const cancel = () => {
    if (ended) { return; }
    stopProcessTree(child, false);
    force ??= setTimeout(() => { if (!ended) { stopProcessTree(child, true); } }, 1000);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) { cancel(); }
  try { return await operation(child, closed, cwd); }
  finally {
    signal?.removeEventListener('abort', cancel);
    child.stdin!.destroy();
    cancel();
    await closed; clearTimeout(force);
    if (usesProcessGroups() && child.pid) {
      // A descendant can close its stdio and outlive the parent. Do not fall back to a recycled parent PID.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* owned group already closed */ }
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function discoverTraeCliModels(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { executable } = discoverySchema.parse(input);
  const signal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(10_000)]);
  const text = await withTraeProcess(executable, ['models', '--json'], signal, async (child, closed) => {
    const chunks: Buffer[] = []; let bytes = 0, error = false;
    child.on('error', () => { error = true; });
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMIT) { error = true; child.kill(); } else { chunks.push(chunk); }
    });
    await closed;
    if (error || signal.aborted || child.exitCode !== 0) { throw new Error('TRAE_CLI_DISCOVERY_FAILED'); }
    return Buffer.concat(chunks).toString('utf8');
  });
  let models: z.infer<typeof catalogSchema>;
  try { models = catalogSchema.parse(JSON.parse(text)); } catch { throw new Error('TRAE_CLI_CATALOG_INVALID'); }
  const names = models.map(model => model.config_name ?? model.name);
  if (new Set(names).size !== names.length) { throw new Error('TRAE_CLI_CATALOG_INVALID'); }
  if (!models.length) { return { exitCode: 5, data: { code: 'TRAE_MODELS_NOT_EXPOSED', models: [] } }; }
  const configs = models.map((model): ModelConfig => ({
    id: `trae-cli-${createHash('sha256').update(`${executable}\0${model.config_name ?? model.name}`).digest('hex').slice(0, 24)}`,
    api: 'trae-cli', model: model.config_name ?? model.name, executable,
    contextWindow: model.context_window, maxTokens: Math.min(4096, Math.floor(model.context_window / 4)),
  }));
  await new ModelStore(context.dataDir).addDiscovered(configs);
  return { exitCode: 0, data: { models: configs, selectedAutomatically: false, source: 'trae-cli',
    authentication: 'managed-by-trae-cli', actualHostModelCall: 'unverified' } };
}
