/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withTraeProcess } from './trae-cli.js';
import { processIdentity } from '../runtime/process-tree.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });

it('runs an explicitly selected Node script with spaces without relying on POSIX shebang execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-process-')); roots.push(root);
  const script = join(root, 'model script.mjs');
  await writeFile(script, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  let cwd = '';
  const text = await withTraeProcess(script, ['models', '--json'], undefined, async (child, closed, directory) => {
    cwd = directory; let output = ''; child.on('error', () => {});
    child.stdout!.on('data', chunk => { output += chunk; });
    await closed;
    expect(child.exitCode).toBe(0); return output;
  });
  expect(JSON.parse(text)).toEqual({ args: ['models', '--json'], cwd });
  await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds cancellation of a process that ignores SIGTERM and waits for closure before removing its directory', async () => {
  const controller = new AbortController();
  let cwd = '', pid = 0, closedAtReturn = false;
  const running = withTraeProcess(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);'], controller.signal,
  async (child, closed, directory) => {
    cwd = directory; pid = child.pid!;
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    controller.abort();
    await closed; closedAtReturn = true;
  });
  // The watchdog is failure cleanup, not the product cancellation mechanism.
  const watchdog = setTimeout(() => { try { if (pid > 0) { process.kill(pid, 'SIGKILL'); } } catch { /* already closed */ } }, 2500);
  try {
    const started = Date.now(); await running;
    expect(Date.now() - started).toBeLessThan(2400);
    expect(closedAtReturn).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { clearTimeout(watchdog); controller.abort(); await running; }
});

it.skipIf(process.platform === 'win32')('cancels owned descendants as well as the stdio parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-tree-')); roots.push(root);
  const marker = join(root, 'child.pid'), controller = new AbortController();
  let descendant = 0;
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(process.argv[1],String(child.pid));console.log('ready');setInterval(()=>{},1000);`;
  const running = withTraeProcess(process.execPath, ['-e', code, marker], controller.signal, async (child, closed) => {
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    descendant = Number(await readFile(marker, 'utf8')); controller.abort(); await closed;
  });
  const watchdog = setTimeout(() => { try { if (descendant > 0) { process.kill(descendant, 'SIGKILL'); } } catch { /* already closed */ } }, 2500);
  try { const started = Date.now(); await running; expect(Date.now() - started).toBeLessThan(2400); }
  finally { clearTimeout(watchdog); controller.abort(); await running; }
  const state = await new Promise<string>(resolve => {
    const check = spawn('ps', ['-p', String(descendant), '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; check.stdout.on('data', chunk => { output += chunk; }); check.once('close', () => resolve(output.trim()));
  });
  expect(state === '' || state.startsWith('Z')).toBe(true);
});

it.skipIf(process.platform === 'win32')('cleans an owned descendant that outlives its stdio parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-orphan-')); roots.push(root);
  const marker = join(root, 'child.pid'), controller = new AbortController();
  let descendant = 0;
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],
      {stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>{fs.writeFileSync(process.argv[1],String(child.pid));console.log('ready');});
    setInterval(()=>{},1000);`;
  try {
    await withTraeProcess(process.execPath, ['-e', code, marker], controller.signal, async (child, closed) => {
      await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
      descendant = Number(await readFile(marker, 'utf8')); controller.abort(); await closed;
    });
    expect(await processIdentity(descendant)).toBeNull();
  } finally {
    controller.abort();
    try { if (descendant > 0) { process.kill(descendant, 'SIGKILL'); } } catch { /* already closed */ }
  }
});
