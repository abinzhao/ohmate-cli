/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BridgeHub } from './bridge-hub.js';
import type { BridgeStatus } from './bridge-status.js';

let hub: BridgeHub, sessionId: string, streamId: string;
let persist: (status: BridgeStatus) => Promise<void>;
beforeEach(() => {
  sessionId = randomUUID(); streamId = randomUUID();
  persist = async () => {};
  hub = new BridgeHub({ dataDir: '/unused-notification-test', sessionId, workspaceId: 'notification-test',
    onStatus: (status) => persist(status) });
});
afterEach(async () => { vi.useRealTimers(); await hub.close().catch(() => {}); });
function watch(stream = streamId, session = sessionId) {
  expect(hub, 'the owned bridge has no commit notification subscription').toHaveProperty('watch');
  return hub.watch(session, stream)!;
}

it('wakes only after the status publication completes', async () => {
  const subscription = watch();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  persist = async () => { enter(); await blocked; };
  const controller = new AbortController();
  let woken = false;
  const waiting = subscription.wait(controller.signal).then(() => { woken = true; });
  const publishing = hub.publish({ streamId, state: 'connected', ackThrough: 1 });
  try {
    await entered;
    await Promise.resolve();
    expect(woken).toBe(false);
    expect(hub.status().ackThrough).toBe(0);
  } finally { release(); }
  await publishing; await waiting;
  expect(woken).toBe(true);
  expect(hub.status().ackThrough).toBe(1);
  subscription.close();
});

it('latches a commit between initial read and wait and coalesces many commits without payload queues', async () => {
  vi.useFakeTimers();
  const subscription = watch(), signal = new AbortController().signal;
  for (let ackThrough = 1; ackThrough <= 100; ackThrough++) { await hub.publish({ streamId, ackThrough }); }
  await subscription.wait(signal);
  expect(vi.getTimerCount()).toBe(0);
  let woken = false;
  const waiting = subscription.wait(signal).then(() => { woken = true; });
  await Promise.resolve();
  expect(woken).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await hub.publish({ streamId, ackThrough: 101 });
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
  subscription.close();
});

it('isolates sessions and streams while notifying both sides of a stream replacement', async () => {
  vi.useFakeTimers();
  expect(watch(streamId, randomUUID())).toBeUndefined();
  const first = watch(), secondId = randomUUID(), second = watch(secondId);
  let firstWoken = false, secondWoken = false;
  const controller = new AbortController();
  const a = first.wait(controller.signal).then(() => { firstWoken = true; });
  const b = second.wait(controller.signal).then(() => { secondWoken = true; });
  await hub.publish({ streamId, state: 'connected', ackThrough: 1 });
  await a;
  expect(firstWoken).toBe(true); expect(secondWoken).toBe(false);
  const next = first.wait(controller.signal);
  await hub.publish({ streamId: secondId, state: 'connected', ackThrough: 0 });
  await next; await b;
  expect(secondWoken).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  first.close(); second.close();
});

it('does not publish a commit notification when status persistence fails', async () => {
  vi.useFakeTimers();
  const subscription = watch(), controller = new AbortController();
  let woken = false;
  const waiting = subscription.wait(controller.signal).then(() => { woken = true; });
  persist = async () => { throw new Error('injected status failure'); };
  await expect(hub.publish({ streamId, ackThrough: 1 })).rejects.toThrow('injected status failure');
  await Promise.resolve();
  expect(woken).toBe(false);
  expect(hub.status()).toMatchObject({ ackThrough: 0, reason: 'STATUS_PERSISTENCE_FAILED' });
  controller.abort(); await waiting;
  expect(vi.getTimerCount()).toBe(0);
  subscription.close();
});

it('rechecks external writes and integrity after one second even with no bridge notification', async () => {
  vi.useFakeTimers();
  const subscription = watch(), signal = new AbortController().signal;
  let woken = false;
  const waiting = subscription.wait(signal).then(() => { woken = true; });
  await vi.advanceTimersByTimeAsync(999); expect(woken).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await waiting;
  expect(woken).toBe(true); expect(vi.getTimerCount()).toBe(0);
  subscription.close();
});

it.each(['abort', 'subscription', 'hub'] as const)('removes pending waits and timers on %s close', async (action) => {
  vi.useFakeTimers();
  const subscription = watch(), controller = new AbortController();
  const waiting = subscription.wait(controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  if (action === 'abort') { controller.abort(); }
  else if (action === 'subscription') { subscription.close(); }
  else { await hub.close(); }
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
  subscription.close();
  await hub.publish({ streamId, ackThrough: 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not install a wait for an already aborted signal or accept subscribers after shutdown', async () => {
  vi.useFakeTimers();
  const subscription = watch(), controller = new AbortController();
  controller.abort(); await subscription.wait(controller.signal);
  expect(vi.getTimerCount()).toBe(0);
  subscription.close(); subscription.close();
  await hub.close(); expect(watch()).toBeUndefined();
});
