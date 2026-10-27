/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe('OHMate runtime boundary', () => {
  it('can be imported without argv parsing, process mutation, timers or writes', async () => {
    const cwd = process.cwd();
    const args = [...process.argv];
    const mkdir = vi.spyOn(fs, 'mkdir');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('unexpected exit');
    });
    const timer = vi.spyOn(globalThis, 'setInterval');
    const network = vi.spyOn(globalThis, 'fetch');
    const runtime = await import('./index.js');
    expect(runtime.createRuntime).toBeTypeOf('function');
    expect(process.argv).toEqual(args);
    expect(process.cwd()).toBe(cwd);
    expect(mkdir).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('registers the complete upstream command tree including UI and protocol leaves', async () => {
    const { createRuntime } = await import('./index.js');
    const runtime = await createRuntime();
    const paths = runtime.registry.list().map((spec) => spec.command.join(' '));
    for (const command of [
      'build', 'build clean', 'run', 'update', 'device list', 'emulator start',
      'auth login', 'skills add', 'log', 'create', 'init', 'serve mcp',
      'serve lsp', 'docs search', 'ui layout', 'ui text', 'check compat',
      'signature generate', 'verify', 'verify screenshot', 'doctor',
    ]) {
      expect(paths).toContain(command);
    }
    expect(runtime.registry.list().find((spec) => spec.command.join(' ') === 'build clean')?.risk).toBe('R3');
    expect(runtime.registry.list().find((spec) => spec.command.join(' ') === 'device list')?.risk).toBe('R0');
  });

  it('doctor is read-only and reports missing project markers without requiring an IDE', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmate-m0-'));
    roots.push(root);
    const { createRuntime, createExecutionContext } = await import('./index.js');
    const context = await createExecutionContext({ cwd: root, dataDir: path.join(root, 'data') });
    const runtime = await createRuntime();
    const result = await runtime.execute('doctor', {}, context);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('passed');
    expect(result.schemaVersion).toBe('1.0');
    expect(result.command).toBe('doctor');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    ]));
    expect(await fs.readdir(root)).toEqual([]);
    expect(context.policy.telemetry).toBe(false);
  });

  it('rejects unknown input and returns one stable result model', async () => {
    const { createRuntime, createExecutionContext } = await import('./index.js');
    const runtime = await createRuntime();
    const context = await createExecutionContext({ cwd: os.tmpdir() });
    const invalid = await runtime.execute('doctor', { unrelated: true }, context);
    expect(invalid.exitCode).toBe(4);
    expect(invalid.status).toBe('invalid');
    const unknown = await runtime.execute('not-registered', {}, context);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.status).toBe('error');
  });
});
