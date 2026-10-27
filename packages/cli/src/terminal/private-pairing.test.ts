/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { runTerminal } from './terminal-adapter.js';
import { readWebService } from '../web/web-state.js';

let root: string;
afterEach(async () => {
  if (root) {
    const context = await createExecutionContext({ dataDir: join(root, 'data') });
    await (await createRuntime()).execute('debug.stop', {}, context);
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'ohmate-pair-tty-'));
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  const stdout: string[] = [], privateText: string[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as WriteStream;
  output.on('data', (chunk) => privateText.push(chunk.toString()));
  const io = { stdin: input, output, stdout: (text: string) => stdout.push(text), stderr: () => undefined };
  const argv = ['debug', 'pair', '--buildId', 'peer-build', '--device', 'peer-device', '--process', 'peer-process', '--sessionId', 'peer-session'];
  return { stdout, privateText, io, argv };
}

it('writes private pairing only in human interactive mode and never through ordinary stdout', async () => {
  const { stdout, privateText, io, argv } = await fixture();
  expect(await runTerminal(['debug', 'start', '--format', 'json'], io)).toBe(0);
  stdout.length = 0;
  expect(await runTerminal(argv, io)).toBe(0);
  const privateEnvelope = JSON.parse(privateText.join(''));
  expect(Buffer.from(privateEnvelope.invitation.oneTimeCode, 'base64')).toHaveLength(32);
  expect(stdout.join('')).not.toContain(privateEnvelope.invitation.oneTimeCode);
});

it.each(['--format-json', '--non-interactive', '--no-output-tty', '--no-input-tty'])('blocks private pairing in %s before starting a service', async (mode) => {
  const { privateText, io, argv } = await fixture();
  if (mode === '--format-json') { argv.push('--format', 'json'); }
  if (mode === '--non-interactive') { argv.push(mode); }
  if (mode === '--no-output-tty') { Object.assign(io.output, { isTTY: false }); }
  if (mode === '--no-input-tty') { Object.assign(io.stdin, { isTTY: false }); }
  expect(await runTerminal(argv, io)).toBe(5);
  expect(privateText).toEqual([]);
  expect(await readWebService(join(root, 'data'))).toBeNull();
});

it('handles a terminal stream write error and revokes without an unhandled error event', async () => {
  const { io, argv } = await fixture();
  expect(await runTerminal(['debug', 'start', '--format', 'json'], io)).toBe(0);
  io.output = Object.assign(new Writable({ write(_chunk, _encoding, callback) {
    callback(new Error('TEST_TERMINAL_FAILURE'));
  } }), { isTTY: true }) as unknown as WriteStream;
  expect(await runTerminal(argv, io)).toBe(6);
  const context = await createExecutionContext({ dataDir: join(root, 'data') });
  expect((await (await createRuntime()).execute('debug.status', {}, context)).data).toMatchObject({
    debugSession: { bridge: { state: 'revoked' } },
  });
});
