/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('OHMate terminal entry', () => {
  it('reads explicit bounded public JSON input files and rejects ambiguous or linked inputs', async () => {
    const { runTerminal } = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'ohmate-input-'));
    roots.push(root);
    vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
    const file = join(root, 'request.json');
    await writeFile(file, '{}');
    const chunks: string[] = [], io = { stdout: (text: string) => chunks.push(text), stderr: () => undefined };
    expect(await runTerminal(['execute', 'capabilities', '--input-file', file, '--format', 'json'], io)).toBe(0);
    expect(JSON.parse(chunks.splice(0).join('')).command).toBe('capabilities');
    expect(await runTerminal(['execute', 'capabilities', '--input', '{}', '--input-file', file, '--format', 'json'], io)).toBe(2);
    chunks.splice(0);
    await writeFile(file, '{"password":"EXAMPLE_ONLY"}');
    expect(await runTerminal(['execute', 'capabilities', '--input-file', file, '--format', 'json'], io)).toBe(2);
    expect(chunks.splice(0).join('')).not.toContain('EXAMPLE_ONLY');
    await symlink(file, join(root, 'linked.json'));
    expect(await runTerminal(['execute', 'capabilities', '--input-file', join(root, 'linked.json'), '--format', 'json'], io)).toBe(2);
    chunks.splice(0);
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    expect(await runTerminal(['execute', 'capabilities', '--input-file', file, '--format', 'json'], io)).toBe(2);
  });

  it('prints one JSON envelope and preserves an error exit code', async () => {
    const { runTerminal } = await import('./index.js');
    const chunks: string[] = [];
    const code = await runTerminal(['unknown-command', '--format', 'json'], {
      stdout: (text) => chunks.push(text), stderr: () => undefined,
    });
    expect(code).toBe(2);
    const result = JSON.parse(chunks.join(''));
    expect(result.exitCode).toBe(2);
    expect(result.status).toBe('error');
  });

  it('generates upstream leaf help without running the action', async () => {
    const { runTerminal } = await import('./index.js');
    const chunks: string[] = [];
    expect(await runTerminal(['ui', 'layout', '--help'], {
      stdout: (text) => chunks.push(text), stderr: () => undefined,
    })).toBe(0);
    expect(chunks.join('')).toContain('ohmatecli ui layout');
    expect(chunks.join('')).toContain('--device');
  });

  it('normalizes --web into the ui command and rejects command combinations', async () => {
    const { parseTerminalArguments, normalizeTerminalArguments } = await import('./arguments.js');
    const parsed = parseTerminalArguments(['--web', '--no-open', '--project', '/app']);
    expect(parsed.web).toBe(true);
    expect(parsed.args).toEqual(['--no-open']);
    expect(parsed.context.projectRoot).toBe('/app');
    normalizeTerminalArguments(parsed);
    expect(parsed.args).toEqual(['ui', '--no-open']);
    const bad = parseTerminalArguments(['--web', 'doctor']);
    expect(() => normalizeTerminalArguments(bad)).toThrow(/--web/);
    const plain = parseTerminalArguments(['doctor']);
    normalizeTerminalArguments(plain);
    expect(plain.args).toEqual(['doctor']);
  });

  it('uses the invoked binary name in help and documents --web', async () => {
    const { runTerminal } = await import('./index.js');
    vi.stubEnv('OHMATE_BIN_NAME', 'ohc');
    const chunks: string[] = [];
    const io = { stdout: (text: string) => chunks.push(text), stderr: () => undefined };
    expect(await runTerminal(['--help'], io)).toBe(0);
    const rootHelp = chunks.splice(0).join('');
    expect(rootHelp).toContain('Usage: ohc');
    expect(rootHelp).toContain('--web');
    expect(await runTerminal(['--web', '--help'], io)).toBe(0);
    const webHelp = chunks.splice(0).join('');
    expect(webHelp).toContain('ohc ui');
    expect(webHelp).toContain('--no-open');
  });

  it('rejects --web combined with another command before starting a workbench', async () => {
    const { runTerminal } = await import('./index.js');
    const chunks: string[] = [];
    expect(await runTerminal(['--web', 'doctor', '--format', 'json'], {
      stdout: (text: string) => chunks.push(text), stderr: () => undefined,
    })).toBe(2);
    expect(JSON.parse(chunks.join('')).data.code).toBe('ARGUMENTS_INVALID');
  });

  it('generates native arguments from ToolSpec and exposes task commands in help', async () => {
    const { runTerminal } = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'ohmate-terminal-'));
    roots.push(root);
    vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
    const chunks: string[] = [];
    const io = { stdout: (text: string) => chunks.push(text), stderr: () => undefined };
    expect(await runTerminal(['--help'], io)).toBe(0);
    expect(chunks.splice(0).join('')).toContain('task');
    expect(await runTerminal(['task', 'submit', 'capabilities', '--wait', '--payload', '{}', '--format', 'json', '--project', root], io)).toBe(0);
    const task = JSON.parse(chunks.splice(0).join('')).data;
    expect(task.state).toBe('succeeded');
    expect(await runTerminal(['task', 'show', task.id, '--format', 'json'], io)).toBe(0);
    expect(JSON.parse(chunks.splice(0).join('')).data.id).toBe(task.id);
    expect(await runTerminal(['task', 'events', task.id, '--after', '1', '--format', 'ndjson'], io)).toBe(0);
    const events = chunks.splice(0).join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.every((event) => event.taskId === task.id && event.sequence > 1)).toBe(true);
    expect(await runTerminal(['task', 'show', task.id, '--unexpected', '--format', 'json'], io)).toBe(2);
  });
});
