/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createExecutionContext } from '../runtime/context.js';
import { processIdentity } from '../runtime/process-tree.js';
import { writeWebService } from '../web/web-state.js';
import { workbenchFingerprint } from '../web/workbench-fingerprint.js';
import { pairWorkbench } from './private-pairing.js';

it('revokes an in-flight pairing request when terminal cancellation arrives before its response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-pair-cancellation-')), controller = new AbortController();
  let created: () => void = () => {};
  const ready = new Promise<void>((resolve) => { created = resolve; });
  let held: (() => void) | undefined, revoked = false;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/_ohmate/pair') {
      held = () => response.end('{}'); created(); return;
    }
    if (request.url === '/_ohmate/revoke') {
      revoked = true; response.setHeader('content-type', 'application/json'); response.end('{"revoked":true}'); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data'), abortSignal: controller.signal,
      nonInteractive: false });
    context.privatePairing = async () => { throw new Error('Unexpected private output'); };
    const identity = (await processIdentity(process.pid))!;
    await writeWebService(context.dataDir, { pid: process.pid, identity,
      origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, cwd: root, projectRoot: null,
      controlSecret: 'c'.repeat(64), debugSessionId: '11111111-1111-4111-8111-111111111111',
      startedAt: new Date().toISOString(), workbenchFingerprint: await workbenchFingerprint() });
    const pending = pairWorkbench(context, { buildId: 'fixture-build', device: 'fixture-device',
      process: 'fixture-process', sessionId: 'fixture-recorder', hdcDevice: 'fixture-selected-device' }).catch((error: Error) => error);
    await ready;
    controller.abort();
    const result = await pending;
    expect(revoked).toBe(true);
    expect(result).toMatchObject({ exitCode: 130, data: { code: 'PRIVATE_OUTPUT_FAILED', revoked: true } });
  } finally {
    held?.();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
