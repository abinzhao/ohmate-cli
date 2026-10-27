/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { isMainModule } from '../runtime/entry-detection.js';
import { startWebServer } from './web-server.js';
import { clearWebService, writeWebService, type WebServiceRecord } from './web-state.js';
import { secret } from './http-security.js';
import { createDebugSession, stopDebugSession, updateDebugBridge } from '../debug/debug-state.js';
import { randomUUID } from 'node:crypto';
import { workbenchFingerprint } from './workbench-fingerprint.js';

const configuration = z.strictObject({
  dataDir: z.string(), cwd: z.string(), projectRoot: z.string().nullable(),
  locale: z.enum(['zh-CN', 'en-US']), port: z.number().int().min(0).max(65535),
  workbenchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  devAutoPair: z.boolean().default(false),
});
export async function runWebWorker(argv: string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== '--configuration') { throw new Error('Invalid Web worker arguments'); }
  const config = configuration.parse(JSON.parse(argv[1]));
  if (await workbenchFingerprint() !== config.workbenchFingerprint) { throw new Error('Web worker code changed before startup'); }
  const context = await createExecutionContext({ ...config, projectRoot: config.projectRoot ?? undefined });
  const identity = await processIdentity(process.pid);
  if (!identity) { throw new Error('Cannot identify Web worker process'); }
  const controlSecret = secret();
  const debugSessionId = randomUUID();
  const owner: { record?: WebServiceRecord } = {};
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const stop = () => { void server.close().catch(() => { process.exitCode = 6; }); };
  const server = await startWebServer(await createRuntime(), context, {
    port: config.port, controlSecret, debugSessionId, workbenchFingerprint: config.workbenchFingerprint,
    devAutoPair: config.devAutoPair,
    onBridgeStatus: async (status) => {
      if (!owner.record) { throw new Error('Debug worker is not ready'); }
      await updateDebugBridge(config.dataDir, owner.record, status);
    },
    onClose: async () => {
      for (const name of signals) { process.off(name, stop); }
      if (!owner.record) { return; }
      try { await stopDebugSession(config.dataDir, owner.record); }
      finally { await clearWebService(config.dataDir, owner.record); }
    },
  });
  // The control capability is only stored in the private service record, never argv/events.
  const record: WebServiceRecord = { origin: server.origin, pid: process.pid, identity, cwd: context.cwd, projectRoot: context.projectRoot,
    startedAt: new Date().toISOString(), controlSecret, debugSessionId, workbenchFingerprint: config.workbenchFingerprint };
  await createDebugSession(config.dataDir, record, server.bridgeStatus());
  owner.record = record;
  await writeWebService(config.dataDir, record);
  for (const name of signals) { process.on(name, stop); }
  process.send?.({ ready: true });
  process.disconnect?.();
}
if (isMainModule(import.meta.url)) { await runWebWorker(process.argv.slice(2)); }
