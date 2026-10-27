/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { IdentitySchema } from '../debug-protocol/domain-schemas.js';
import { PairingInvitationSchema } from '../debug-protocol/security.js';
import { acquireDataLock } from '../runtime/execution-lock.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import { readWebService, type WebServiceRecord } from '../web/web-state.js';
import { workbenchFingerprint } from '../web/workbench-fingerprint.js';
import { HdcSelectorSchema } from './hdc-forward.js';

export const PairTargetSchema = IdentitySchema.omit({ project: true, fingerprint: true }).extend({ hdcDevice: HdcSelectorSchema.optional() });
type Target = ReturnType<typeof PairTargetSchema.parse>;

async function request(record: WebServiceRecord, action: 'pair' | 'revoke', context: ExecutionContext, target?: Target) {
  const peer = target ? IdentitySchema.omit({ project: true, fingerprint: true }).parse({
    buildId: target.buildId, device: target.device, process: target.process, sessionId: target.sessionId,
  }) : undefined;
  const response = await fetch(`${record.origin}/_ohmate/${action}`, {
    method: 'POST', redirect: 'error',
    headers: { 'x-ohmate-control': record.controlSecret, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: context.cwd, projectRoot: context.projectRoot, fingerprint: record.workbenchFingerprint,
      ...(peer ? { target: { ...peer, project: context.workspaceId }, ...(target?.hdcDevice ? { hdcDevice: target.hdcDevice } : {}) } : {}) }),
    signal: action === 'pair' ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(target?.hdcDevice ? 25_000 : 5000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) { throw new Error('PAIRING_CONTROL_REJECTED'); }
  return response.json();
}

export async function pairWorkbench(context: ExecutionContext, target: Target): Promise<ToolResult> {
  if (!context.privatePairing || context.policy.nonInteractive || context.taskId) {
    return { exitCode: 5, data: { code: 'PRIVATE_TTY_REQUIRED' } };
  }
  const release = await acquireDataLock(context.dataDir, 'web-lifecycle');
  try {
    const record = await readWebService(context.dataDir);
    if (!record) { return { exitCode: 5, data: { code: 'WORKBENCH_NOT_RUNNING' } }; }
    if (record.cwd !== context.cwd || record.projectRoot !== context.projectRoot) {
      return { exitCode: 5, data: { code: 'WORKBENCH_SCOPE_CHANGED' } };
    }
    if (!record.workbenchFingerprint || record.workbenchFingerprint !== await workbenchFingerprint()) {
      return { exitCode: 5, data: { code: 'WORKBENCH_CODE_CHANGED' } };
    }
    let invitation: ReturnType<typeof PairingInvitationSchema.parse> | undefined;
    try {
      invitation = PairingInvitationSchema.parse(await request(record, 'pair', context, target));
      if (context.abortSignal.aborted) { throw new Error('CANCELLED'); }
      await context.privatePairing(JSON.stringify({ endpoint: record.origin.replace('http:', 'ws:') + '/bridge/v1', invitation }));
    } catch (error) {
      if (!invitation && !context.abortSignal.aborted) { throw error; }
      let revoked = false;
      try { await request(record, 'revoke', context); revoked = true; } catch { /* Keep cleanup failure visible without returning the invitation. */ }
      return { exitCode: context.abortSignal.aborted ? 130 : 6, data: { code: 'PRIVATE_OUTPUT_FAILED', revoked } };
    }
    return { exitCode: 0, data: { state: 'pairing', debugSessionId: record.debugSessionId,
      expiresAt: invitation.expiresAt, fingerprint: invitation.handshake.identity.fingerprint,
      buildVerification: 'unverified', deviceProvenance: 'peer-asserted' } };
  } finally { await release(); }
}
