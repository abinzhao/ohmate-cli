/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeHub } from './bridge-hub.js';
import { getDebugSpecs } from './index.js';
import type { ForwardDependencies } from './hdc-forward.js';
import { identity } from '../debug-protocol/test-fixtures.js';
import { nativeInput } from '../terminal/native-input.js';

let root: string, hub: BridgeHub, table: string;
let commands: string[][], io: ForwardDependencies;
const target = { project: identity.project, buildId: identity.buildId, device: identity.device,
  process: identity.process, sessionId: identity.sessionId };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-bridge-forward-'));
  table = ''; commands = [];
  io = {
    select: async () => 'owned-device',
    run: async (args) => {
      commands.push(args);
      if (args.includes('rport')) { table = 'owned-device tcp:43210 tcp:43210 [Reverse]'; return 'OK'; }
      if (args.includes('rm')) { table = ''; return 'OK'; }
      return table || '[Empty]';
    },
  };
  hub = new BridgeHub({ dataDir: root, sessionId: randomUUID(), workspaceId: identity.project,
    forwardDependencies: io });
});
afterEach(async () => {
  table = '';
  await hub.close();
  await rm(root, { recursive: true, force: true });
});

it('exposes explicit HDC selection on the private pairing command', () => {
  const pair = getDebugSpecs().find((spec) => spec.id === 'debug.pair')!;
  expect(pair.inputSchema.safeParse({ buildId: target.buildId, device: target.device, process: target.process,
    sessionId: target.sessionId, hdcDevice: 'owned-device' }).success).toBe(true);
  expect(pair.options.some((option) => option.flags.startsWith('--hdc-device'))).toBe(true);
  expect(nativeInput(pair, ['--hdc-device', 'owned-device'])).toEqual({ hdcDevice: 'owned-device' });
});

it('publishes transport evidence without claiming device or build authentication', async () => {
  expect(hub).toHaveProperty('issueHdc');
  const invitation = await hub.issueHdc(target, 'owned-device', 43210);
  expect(hub.status()).toMatchObject({ state: 'pairing', buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
    hdcForward: { state: 'active', port: 43210, authentication: 'unverified' } });
  expect(JSON.stringify(hub.status())).not.toContain(invitation.oneTimeCode);
  expect(JSON.stringify(hub.status())).not.toContain('owned-device');
  await hub.revoke();
  expect(table).toBe('');
  expect(hub.status()).toMatchObject({ state: 'revoked', hdcForward: { state: 'released' } });
});

it('removes a live owned mapping before completing service shutdown', async () => {
  expect(hub).toHaveProperty('issueHdc');
  await hub.issueHdc(target, 'owned-device', 43210);
  await hub.close();
  expect(table).toBe('');
  expect(commands.filter((args) => args.includes('rm'))).toHaveLength(1);
});

it('releases forwarding when a paired connection disconnects', async () => {
  expect(hub).toHaveProperty('issueHdc');
  await hub.issueHdc(target, 'owned-device', 43210);
  await hub.publish({ state: 'disconnected', reason: 'CONNECTION_CLOSED' });
  expect(table).toBe('');
  expect(hub.status()).toMatchObject({ hdcForward: { state: 'released' } });
});

it('keeps a cleanup conflict visible and prevents pairing from bypassing the retained mapping', async () => {
  expect(hub).toHaveProperty('issueHdc');
  await hub.issueHdc(target, 'owned-device', 43210);
  table = 'owned-device tcp:43210 tcp:55555 [Reverse]';
  await expect(hub.revoke()).rejects.toThrow('HDC_FORWARD_CHANGED');
  expect(hub.status()).toMatchObject({ state: 'degraded', reason: 'HDC_FORWARD_CLEANUP_FAILED',
    hdcForward: { state: 'cleanup-failed' } });
  await expect(hub.issue(target)).rejects.toThrow('BRIDGE_BUSY');
  table = 'owned-device tcp:43210 tcp:43210 [Reverse]';
  await hub.revoke();
});

it('cleans a just-created mapping when shutdown arrives during acquisition', async () => {
  expect(hub).toHaveProperty('issueHdc');
  let created: () => void = () => {};
  const started = new Promise<void>((resolve) => { created = resolve; });
  let proceed: () => void = () => {};
  const barrier = new Promise<void>((resolve) => { proceed = resolve; });
  const run = io.run;
  io.run = async (args, signal) => {
    const result = await run(args, signal);
    if (args.includes('rport')) { created(); await barrier; }
    return result;
  };
  const issuing = hub.issueHdc(target, 'owned-device', 43210);
  await started;
  const closing = hub.close();
  proceed();
  await expect(issuing).rejects.toThrow('BRIDGE_CLOSED');
  await closing;
  expect(table).toBe('');
});

it('expires an unused HDC invitation and releases its mapping without waiting for a frame', async () => {
  await hub.close();
  let expired: (status: ReturnType<BridgeHub['status']>) => void = () => {};
  const observed = new Promise<ReturnType<BridgeHub['status']>>((resolve) => { expired = resolve; });
  hub = new BridgeHub({ dataDir: root, sessionId: randomUUID(), workspaceId: identity.project,
    forwardDependencies: io, pairingTtlMs: 100,
    onStatus: async (status) => { if (status.state === 'expired') { expired(status); } } });
  await hub.issueHdc(target, 'owned-device', 43210);
  const status = await observed;
  expect(table).toBe('');
  expect(status).toMatchObject({ state: 'expired', reason: 'PAIRING_EXPIRED', hdcForward: { state: 'released' } });
});

it('retains incomplete creation in the service so revoke can clean it after the device returns', async () => {
  const run = io.run;
  let created = false;
  io.run = async (args, signal) => {
    if (created && args.join(' ') === 'fport ls') { throw new Error('fixture lost connection'); }
    const result = await run(args, signal);
    if (args.includes('rport')) { created = true; }
    return result;
  };
  const failure = await hub.issueHdc(target, 'owned-device', 43210).catch((error: Error) => error);
  io.run = run;
  try {
    expect(hub.status()).toMatchObject({ state: 'degraded', reason: 'HDC_FORWARD_CLEANUP_REQUIRED',
      hdcForward: { state: 'cleanup-failed' } });
    await expect(hub.issue(target)).rejects.toThrow('BRIDGE_BUSY');
    await hub.revoke();
    expect(table).toBe('');
  } finally {
    if (failure instanceof Error && 'owner' in failure) { await (failure.owner as { close(): Promise<void> }).close(); }
  }
});

it('persists released transport status before completing shutdown', async () => {
  await hub.close();
  const saved: ReturnType<BridgeHub['status']>[] = [];
  hub = new BridgeHub({ dataDir: root, sessionId: randomUUID(), workspaceId: identity.project,
    forwardDependencies: io, onStatus: async (status) => { saved.push(structuredClone(status)); } });
  await hub.issueHdc(target, 'owned-device', 43210);
  await hub.close();
  expect(saved.at(-1)).toMatchObject({ state: 'disconnected', hdcForward: { state: 'released' } });
});

it('joins concurrent shutdown callers until the owned rule is removed', async () => {
  await hub.issueHdc(target, 'owned-device', 43210);
  let entered: () => void = () => {}, proceed: () => void = () => {};
  const removing = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { proceed = resolve; });
  const run = io.run;
  io.run = async (args, signal) => {
    if (args.includes('rm')) { entered(); await barrier; }
    return run(args, signal);
  };
  const first = hub.close();
  await removing;
  let secondDone = false;
  const second = hub.close().then(() => { secondDone = true; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(secondDone).toBe(false);
  } finally {
    proceed();
    await Promise.all([first, second]);
  }
  expect(table).toBe('');
});
