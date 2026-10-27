/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalState } from '../agent/local-state.js';
import { processIdentity } from '../runtime/process-tree.js';
import type { WebServiceRecord } from '../web/web-state.js';
import { IdentitySchema } from '../debug-protocol/domain-schemas.js';
import { BridgeStatusSchema } from './bridge-status.js';
import type { BridgeStatus } from './bridge-status.js';

const sessionSchema = z.strictObject({
  id: z.string().uuid(), schemaVersion: z.literal('1.0'),
  state: z.enum(['serving', 'disconnected', 'stopped']),
  projectRoot: z.string().nullable(), cwd: z.string(),
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  pid: z.number().int().positive(), serviceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(), stoppedAt: z.iso.datetime().nullable(),
  target: IdentitySchema.nullable(),
  bridge: z.union([BridgeStatusSchema, z.strictObject({ state: z.literal('unavailable'), reason: z.literal('KIT_TRANSPORT_NOT_IMPLEMENTED') })]),
});
export type DebugSession = z.infer<typeof sessionSchema>;

export async function createDebugSession(dataDir: string, record: WebServiceRecord, bridge?: BridgeStatus): Promise<DebugSession> {
  const session: DebugSession = {
    id: record.debugSessionId ?? randomUUID(), schemaVersion: '1.0', state: 'serving', projectRoot: record.projectRoot, cwd: record.cwd,
    origin: record.origin, pid: record.pid, serviceIdentity: record.identity, startedAt: record.startedAt,
    stoppedAt: null, target: null, bridge: bridge ?? { state: 'unavailable', reason: 'KIT_TRANSPORT_NOT_IMPLEMENTED' },
  };
  return new LocalState(dataDir).update(`debug-${session.id}`, sessionSchema, session, () => session);
}
export async function readDebugSession(dataDir: string, id: string): Promise<DebugSession> {
  z.string().uuid().parse(id);
  const session = await new LocalState(dataDir).read(`debug-${id}`, sessionSchema);
  if (session.id !== id) { throw new Error('Debug session identity mismatch'); }
  return session.state !== 'stopped' && await processIdentity(session.pid) !== session.serviceIdentity
    ? { ...session, state: 'disconnected' } : session;
}
export async function listDebugSessions(dataDir: string): Promise<DebugSession[]> {
  const names = await new LocalState(dataDir).names('debug-');
  if (names.length > 1000) { throw new Error('Debug session listing exceeds 1000 entries'); }
  const result: DebugSession[] = [];
  for (const name of names.sort()) { result.push(await readDebugSession(dataDir, name.slice('debug-'.length))); }
  return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}
export async function stopDebugSession(dataDir: string, record: WebServiceRecord): Promise<void> {
  if (!record.debugSessionId) { return; }
  await new LocalState(dataDir).update(`debug-${record.debugSessionId}`, sessionSchema, undefined, (session) => {
    if (session.id !== record.debugSessionId || session.serviceIdentity !== record.identity || session.pid !== record.pid) {
      throw new Error('Debug session owner mismatch');
    }
    return { ...session, state: 'stopped' as const, stoppedAt: new Date().toISOString() };
  });
}

export async function updateDebugBridge(dataDir: string, record: WebServiceRecord, bridge: BridgeStatus): Promise<void> {
  if (!record.debugSessionId) { throw new Error('Debug session missing'); }
  await new LocalState(dataDir).update(`debug-${record.debugSessionId}`, sessionSchema, undefined, (session) => {
    if (session.id !== record.debugSessionId || session.serviceIdentity !== record.identity || session.pid !== record.pid ||
      session.state === 'stopped') { throw new Error('Debug session owner mismatch'); }
    return { ...session, target: bridge.target, bridge: BridgeStatusSchema.parse(bridge) };
  });
}
