/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../runtime/index.js';
import { startWebServer } from '../web/web-server.js';
import { agentSpecs } from '../agent/agent-tools.js';
import { WriteScopeSchema } from '../debug-protocol/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-write-policy-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('describes local write schemas through Registry without authorizing any scope', async () => {
  const context = await api.createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await api.createRuntime();
  const receipt = await runtime.execute('debug.protocol', {}, context);
  expect(receipt.exitCode).toBe(0);
  const data = receipt.data as { mode: string; writes: {
    scopes: { scope: string; available: boolean; reason: string; risk: string }[]; schemas: object;
  } };
  expect(data.mode).toBe('readonly');
  expect(data).toHaveProperty('writes');
  expect(data.writes.scopes.map((item) => item.scope)).toEqual(WriteScopeSchema.options);
  expect(data.writes.scopes.every((item) => !item.available && item.reason === 'DEVICE_BUILD_UNVERIFIED')).toBe(true);
  expect(data.writes.scopes.find((item) => item.scope === 'arkweb.console.execute')?.risk).toBe('R3');
  expect(data.writes.schemas).toHaveProperty('command');
  expect(data.writes.schemas).toHaveProperty('receipt');
  expect(() => agentSpecs(runtime, ['debug.protocol'])).toThrow();
});

it('serves the same unavailable policy through authenticated HTTP', async () => {
  const context = await api.createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await api.createRuntime(), server = await startWebServer(runtime, context);
  try {
    const path = `${server.origin}/api/v1/debug/protocol`;
    expect((await fetch(path)).status).toBe(401);
    const response = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const receipt = await (await fetch(path, { headers: { cookie } })).json();
    expect(receipt.exitCode).toBe(0);
    const data = receipt.data;
    expect(data).toEqual((await runtime.execute('debug.protocol', {}, context)).data);
    expect(data).toHaveProperty('writes.authentication', 'unavailable');
    expect(data.writes).toMatchObject({ mode: 'application-local', authenticationRecovery: 'disabled',
      consoleTermination: 'not-guaranteed', maxCommandsPerSession: 256, maxTtlMs: 600000 });
  } finally { await server.close(); }
  await expect(fetch(server.origin)).rejects.toThrow();
});

it('exports the local consent owner and strict schemas from the import-safe Runtime API', () => {
  expect(api).toHaveProperty('WriteSession');
  expect(api).toHaveProperty('WriteCommandSchema');
  expect(api).toHaveProperty('WriteReceiptSchema');
  expect(api).toHaveProperty('describeWriteProtocol');
});
