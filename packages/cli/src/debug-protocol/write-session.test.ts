/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from './index.js';
import type { Identity } from './index.js';

const identity: Identity = { project: 'fixture-project', buildId: 'fixture-build',
  device: 'fixture-device', process: 'fixture-process', sessionId: 'fixture-session', fingerprint: 'a'.repeat(64) };
const epoch = '00000000-0000-4000-8000-000000000001';
const key = '00000000-0000-4000-8000-000000000002';
const commandId = '00000000-0000-4000-8000-000000000003';
const command = (overrides = {}) => ({ type: 'write-command', version: '1',
  commandId, idempotencyKey: key, identity, sessionEpoch: epoch, scope: 'network.mock',
  targetId: 'fixture-target', planHash: 'b'.repeat(64), payloadHash: 'c'.repeat(64),
  deadline: 1100, ttlMs: 100, ...overrides });

function session() {
  expect(protocol).toHaveProperty('WriteSession');
  vi.useFakeTimers(); vi.setSystemTime(1000);
  return new protocol.WriteSession(identity, epoch);
}
function approve(owner: protocol.WriteSession, input = command()) {
  const review = owner.review(input);
  owner.confirm(review.reviewId);
  return review;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function operation(execute: (signal: AbortSignal) => Promise<unknown>, rollback = async () => {}) {
  return { execute: async (signal: AbortSignal) => { await execute(signal); }, rollback };
}
afterEach(() => { vi.useRealTimers(); });

it('rejects execution without the matching application confirmation', async () => {
  const owner = session(), execute = vi.fn(async () => ({}));
  const receipt = await owner.apply(command(), operation(execute));
  expect(receipt).toMatchObject({ status: 'blocked', error: 'SCOPE_NOT_CONFIRMED', revocation: 'not-needed' });
  expect(execute).not.toHaveBeenCalled();
  await owner.close();
});

it('executes once and returns the original receipt for concurrent and later duplicates', async () => {
  const owner = session(), pending = deferred<void>();
  approve(owner);
  const execute = vi.fn(() => pending.promise), rollback = vi.fn(async () => {});
  const effect = operation(execute, rollback);
  const first = owner.apply(command(), effect), duplicate = owner.apply(command(), effect);
  expect(execute).toHaveBeenCalledTimes(1);
  pending.resolve();
  expect(await first).toEqual(await duplicate);
  expect(await owner.apply(command(), effect)).toEqual(await first);
  expect(execute).toHaveBeenCalledTimes(1);
  await owner.close();
  expect(rollback).toHaveBeenCalledTimes(1);
});

it('binds confirmation to one scope, target, plan and payload', async () => {
  const owner = session(), execute = vi.fn(async () => ({}));
  approve(owner);
  for (const changed of [{ scope: 'ui.highlight' }, { targetId: 'other' },
    { planHash: 'd'.repeat(64) }, { payloadHash: 'e'.repeat(64) }]) {
    const receipt = await owner.apply(command(changed), operation(execute));
    expect(receipt.status).toBe('blocked');
  }
  expect(execute).not.toHaveBeenCalled();
  await owner.close();
});

it('rejects idempotency-key and command-id reuse with different assertions', async () => {
  const owner = session(), execute = vi.fn(async () => ({}));
  approve(owner);
  expect((await owner.apply(command(), operation(execute))).status).toBe('applied');
  expect((await owner.apply(command({ payloadHash: 'e'.repeat(64) }), operation(execute))).error).toBe('COMMAND_CONFLICT');
  expect((await owner.apply(command({ idempotencyKey: '00000000-0000-4000-8000-000000000004' }), operation(execute))).error).toBe('COMMAND_CONFLICT');
  expect(execute).toHaveBeenCalledTimes(1);
  await owner.close();
});

it('refuses a confirmation at its expiry even before timer delivery', async () => {
  const owner = session(), review = owner.review(command());
  vi.setSystemTime(1100);
  expect(() => owner.confirm(review.reviewId)).toThrow('REVIEW_EXPIRED');
  await owner.close();
});

it('checks the deadline synchronously before starting an approved operation', async () => {
  const owner = session(), execute = vi.fn(async () => ({}));
  approve(owner);
  vi.setSystemTime(1100);
  expect((await owner.apply(command(), operation(execute))).error).toBe('COMMAND_EXPIRED');
  expect(execute).not.toHaveBeenCalled();
  await owner.close();
});

it.each(['disconnected', 'background', 'build-changed', 'page-changed', 'locked', 'service-closed'] as const)(
  'revokes active state and cannot restore confirmation after %s', async (reason) => {
    const owner = session(), rollback = vi.fn(async () => {});
    approve(owner);
    await owner.apply(command(), operation(async () => {}, rollback));
    await owner.revoke(reason);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(owner.receipts()[0]).toMatchObject({ status: 'applied', revocation: 'revoked' });
    const execute = vi.fn(async () => ({}));
    const next = command({ commandId: '00000000-0000-4000-8000-000000000005',
      idempotencyKey: '00000000-0000-4000-8000-000000000006' });
    expect((await owner.apply(next, operation(execute))).status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
    await owner.close();
  });

it('TTL restores temporary state and retains the receipt without re-execution', async () => {
  const owner = session(), rollback = vi.fn(async () => {});
  approve(owner);
  const execute = vi.fn(async () => {});
  await owner.apply(command(), operation(execute, rollback));
  await vi.advanceTimersByTimeAsync(100);
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(owner.receipts()[0].revocation).toBe('revoked');
  expect((await owner.apply(command(), operation(execute, rollback))).revocation).toBe('revoked');
  expect(execute).toHaveBeenCalledTimes(1);
  await owner.close();
});

it('invalidates pending work before waiting and restores its late effect', async () => {
  const owner = session(), started = deferred<void>();
  const rollback = vi.fn(async () => {});
  approve(owner);
  let signal!: AbortSignal;
  const running = owner.apply(command(), operation((abort) => { signal = abort; return started.promise; }, rollback));
  const closing = owner.revoke('background');
  expect(signal.aborted).toBe(true);
  expect(owner.status().state).toBe('revoked');
  started.resolve();
  expect(await running).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
  await closing;
  expect(rollback).toHaveBeenCalledTimes(1);
  await owner.close();
});

it('retains failed cleanup, blocks further writes and retries only on explicit revoke', async () => {
  const owner = session();
  let attempts = 0;
  const rollback = vi.fn(async () => { if (++attempts === 1) { throw new Error('private fixture details'); } });
  approve(owner);
  await owner.apply(command(), operation(async () => {}, rollback));
  await owner.revoke('disconnected');
  expect(owner.status()).toMatchObject({ state: 'cleanup-failed', pendingCleanup: 1 });
  expect(owner.receipts()[0]).toMatchObject({ revocation: 'cleanup-failed', error: 'ROLLBACK_FAILED' });
  expect(JSON.stringify(owner.receipts())).not.toContain('private fixture details');
  await owner.revoke('disconnected');
  expect(owner.status().pendingCleanup).toBe(0);
  expect(rollback).toHaveBeenCalledTimes(2);
  await owner.close();
});

it('requires a fresh confirmation for each high-risk command', async () => {
  const owner = session(), input = command({ scope: 'arkweb.console.execute' });
  approve(owner, input);
  expect((await owner.apply(input, { execute: async () => {} })).status).toBe('applied');
  const next = command({ scope: 'arkweb.console.execute',
    commandId: '00000000-0000-4000-8000-000000000005', idempotencyKey: '00000000-0000-4000-8000-000000000006' });
  expect((await owner.apply(next, { execute: async () => {} })).error).toBe('SCOPE_NOT_CONFIRMED');
  await owner.close();
});

it('rejects foreign identity, epoch, malformed and unknown commands before execution', async () => {
  const owner = session(), execute = vi.fn(async () => ({}));
  approve(owner);
  for (const changed of [{ identity: { ...identity, buildId: 'other' } }, { sessionEpoch: key },
    { scope: 'arbitrary.execute' }, { rawBody: 'private' }, { ttlMs: 0 }]) {
    expect((await owner.apply(command(changed), operation(execute))).status).toBe('blocked');
  }
  expect(execute).not.toHaveBeenCalled();
  await owner.close();
});

it('does not persist raw operations or expose mutable receipt references', async () => {
  const owner = session();
  approve(owner);
  await owner.apply(command(), operation(async () => {}));
  const receipt = owner.receipts()[0];
  receipt.identity.buildId = 'mutated';
  expect(owner.receipts()[0].identity.buildId).toBe('fixture-build');
  expect(JSON.stringify(owner.receipts())).not.toContain('rollback');
  await owner.close();
});

it('restores an operation that mutates state then throws without retaining its error text', async () => {
  const owner = session();
  let value = 'original';
  approve(owner);
  const receipt = await owner.apply(command(), {
    execute: async () => { value = 'changed'; throw new Error('private operation body'); },
    rollback: async () => { value = 'original'; },
  });
  expect(value).toBe('original');
  expect(receipt).toMatchObject({ status: 'failed', revocation: 'revoked', error: 'EXECUTION_FAILED' });
  expect(JSON.stringify(receipt)).not.toContain('private operation body');
  await owner.close();
});

it('refuses a temporary write without a registered restore action', async () => {
  const owner = session(), execute = vi.fn(async () => {});
  approve(owner);
  expect((await owner.apply(command(), { execute })).error).toBe('ROLLBACK_REQUIRED');
  expect(execute).not.toHaveBeenCalled();
  await owner.close();
});

it('does not retry late cleanup inside the same revocation', async () => {
  const owner = session(), pending = deferred<void>();
  let attempts = 0;
  const rollback = vi.fn(async () => { if (++attempts === 1) { throw new Error('fixture'); } });
  approve(owner);
  const running = owner.apply(command(), operation(() => pending.promise, rollback));
  const revoking = owner.revoke('background');
  pending.resolve();
  await running; await revoking;
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(owner.status().state).toBe('cleanup-failed');
  await owner.revoke('background');
  expect(rollback).toHaveBeenCalledTimes(2);
  await owner.close();
});

it('checks the review TTL again when native work settles before timer delivery', async () => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  const input = command({ ttlMs: 50 });
  approve(owner, input);
  const running = owner.apply(input, operation(() => pending.promise, rollback));
  vi.setSystemTime(1050);
  pending.resolve();
  expect(await running).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
  expect(rollback).toHaveBeenCalledTimes(1);
  await owner.close();
});

it('does not retry a failing TTL cleanup as a hidden second attempt', async () => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => { throw new Error('fixture'); });
  approve(owner);
  const running = owner.apply(command(), operation(() => pending.promise, rollback));
  await vi.advanceTimersByTimeAsync(100);
  pending.resolve();
  await running;
  await vi.advanceTimersByTimeAsync(0);
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(owner.status().state).toBe('cleanup-failed');
  await owner.close();
});

it('invalidates consent when the wall clock moves backwards', async () => {
  const owner = session(), execute = vi.fn(async () => {});
  approve(owner);
  vi.setSystemTime(900);
  expect((await owner.apply(command(), operation(execute))).status).toBe('blocked');
  expect(execute).not.toHaveBeenCalled();
  expect(owner.status().state).toBe('revoked');
  await owner.close();
});

it('preserves the execution error after successful cleanup recovery', async () => {
  const owner = session();
  let attempts = 0;
  approve(owner);
  await owner.apply(command(), {
    execute: async () => { throw new Error('fixture execution'); },
    rollback: async () => { if (++attempts === 1) { throw new Error('fixture cleanup'); } },
  });
  expect(owner.receipts()[0].error).toBe('ROLLBACK_FAILED');
  await owner.revoke('background');
  expect(owner.receipts()[0]).toMatchObject({ status: 'failed', error: 'EXECUTION_FAILED', revocation: 'revoked' });
  await owner.close();
});

it('keeps command tombstones at the quota and never executes an evicted duplicate', async () => {
  const owner = session(), execute = vi.fn(async () => {});
  let first: ReturnType<typeof command> | undefined;
  for (let n = 1; n <= 256; n++) {
    const suffix = n.toString(16).padStart(12, '0');
    const input = command({ scope: 'arkweb.console.execute', commandId: `10000000-0000-4000-8000-${suffix}`,
      idempotencyKey: `20000000-0000-4000-8000-${suffix}` });
    first ??= input;
    approve(owner, input);
    expect((await owner.apply(input, { execute })).status).toBe('applied');
  }
  const extra = command({ scope: 'arkweb.console.execute' });
  approve(owner, extra);
  expect((await owner.apply(extra, { execute })).error).toBe('WRITE_QUOTA');
  expect((await owner.apply(first, { execute })).status).toBe('applied');
  expect(execute).toHaveBeenCalledTimes(256);
  await owner.close();
});

it('blocks another overlay until the existing restore finishes', async () => {
  const owner = session(), cleanup = deferred<void>();
  approve(owner);
  await owner.apply(command(), operation(async () => {}, () => cleanup.promise));
  const next = command({ commandId: '00000000-0000-4000-8000-000000000005',
    idempotencyKey: '00000000-0000-4000-8000-000000000006' });
  approve(owner, next);
  const execute = vi.fn(async () => {});
  expect((await owner.apply(next, operation(execute))).error).toBe('WRITE_BUSY');
  const closing = owner.close();
  expect(execute).not.toHaveBeenCalled();
  cleanup.resolve();
  await closing;
});

it('reports local consent as unauthenticated and does not authorize a device', async () => {
  const owner = session();
  approve(owner);
  expect(owner.status()).toMatchObject({ authentication: 'not-authenticated', consent: 'application-local-memory-only' });
  await owner.close();
});

it('does not report a pending native operation as applied', async () => {
  const owner = session(), pending = deferred<void>();
  approve(owner);
  const running = owner.apply(command(), operation(() => pending.promise));
  expect(owner.receipts()[0].status).toBe('running');
  pending.resolve();
  expect((await running).status).toBe('applied');
  await owner.close();
});

it('revokes a pending effect if clock rollback is first observed at completion', async () => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  approve(owner);
  const running = owner.apply(command(), operation(() => pending.promise, rollback));
  vi.setSystemTime(900);
  pending.resolve();
  expect(await running).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
  expect(rollback).toHaveBeenCalledTimes(1);
  await owner.close();
});

it('coalesces overlapping revocations without turning them into implicit cleanup retries', async () => {
  const owner = session(), cleanup = deferred<void>();
  const rollback = vi.fn(async () => { await cleanup.promise; throw new Error('fixture cleanup'); });
  approve(owner);
  await owner.apply(command(), operation(async () => {}, rollback));
  const first = owner.revoke('background');
  await Promise.resolve(); await Promise.resolve();
  const second = owner.revoke('disconnected');
  cleanup.resolve();
  await first; await second;
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(owner.status().state).toBe('cleanup-failed');
  await owner.close();
});

const invalidClocks = [NaN, Infinity, -Infinity, 1000.5, -0.5, Number.MAX_SAFE_INTEGER + 1];
const clockChanges = [...invalidClocks, 900];
const observers = ['status', 'receipts'] as const;

it.each(invalidClocks)('rejects a session created with invalid clock %s after valid time returns', async (clock) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  const owner = new protocol.WriteSession(identity, epoch);
  time.mockRestore();
  const execute = vi.fn(async () => {});
  try {
    expect(owner.status().state).toBe('revoked');
    expect(() => approve(owner)).toThrow('WRITE_SESSION_REVOKED');
    expect((await owner.apply(command(), operation(execute))).status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
  } finally { await owner.close(); }
});

it.each(invalidClocks)('rejects invalid clock %s before dispatch without reviving the old confirmation', async (clock) => {
  const owner = session(), execute = vi.fn(async () => {});
  approve(owner);
  const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  let receipt;
  try { receipt = await owner.apply(command(), operation(execute)); }
  finally { time.mockRestore(); }
  try {
    expect(receipt!.status).toBe('blocked');
    expect(owner.status().state).toBe('revoked');
    expect((await owner.apply(command(), operation(execute))).status).toBe('blocked');
    expect(() => approve(owner)).toThrow('WRITE_SESSION_REVOKED');
    expect(execute).not.toHaveBeenCalled();
  } finally { await owner.close(); }
});

it.each(observers.flatMap(observer => clockChanges.map(clock => ({ observer, clock }))))(
  '$observer first observes clock $clock and invalidates pending effects before settlement', async ({ observer, clock }) => {
    const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
    let signal!: AbortSignal;
    approve(owner);
    const execute = vi.fn((abort: AbortSignal) => { signal = abort; return pending.promise; });
    const running = owner.apply(command(), operation(execute, rollback));
    const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
    let aborted: boolean, observedState: string, cleanup: number;
    try {
      owner[observer]();
      aborted = signal.aborted;
      observedState = owner.status().state;
      cleanup = owner.status().pendingCleanup;
    } finally { time.mockRestore(); pending.resolve(); }
    const receipt = await running;
    try {
      expect(aborted!).toBe(true);
      expect(observedState!).toBe('revoked');
      expect(cleanup!).toBe(1);
      expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked', error: 'WRITE_REVOKED' });
      expect(await owner.apply(command(), operation(execute, rollback))).toEqual(receipt);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(() => approve(owner)).toThrow('WRITE_SESSION_REVOKED');
    } finally { await owner.close(); }
  });

it.each(observers)('%s observes command TTL before timer delivery and retains native ownership', async (observer) => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  let signal!: AbortSignal;
  const input = command({ ttlMs: 50 });
  approve(owner, input);
  const execute = vi.fn((abort: AbortSignal) => { signal = abort; return pending.promise; });
  const running = owner.apply(input, operation(execute, rollback));
  vi.setSystemTime(1050);
  owner[observer]();
  const aborted = signal.aborted, cleanup = owner.status().pendingCleanup;
  expect(rollback).not.toHaveBeenCalled();
  pending.resolve();
  const receipt = await running;
  try {
    expect(aborted).toBe(true);
    expect(cleanup).toBe(1);
    expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
    expect(await owner.apply(input, operation(execute, rollback))).toEqual(receipt);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  } finally { await owner.close(); }
});

it.each(observers)('%s observes the ten-minute session deadline before timer delivery', async (observer) => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  let signal!: AbortSignal;
  const input = command({ deadline: 1000000, ttlMs: 600000 });
  approve(owner, input);
  const running = owner.apply(input, operation((abort) => { signal = abort; return pending.promise; }, rollback));
  vi.setSystemTime(601000);
  owner[observer]();
  const aborted = signal.aborted, state = owner.status().state;
  expect(rollback).not.toHaveBeenCalled();
  pending.resolve();
  const receipt = await running;
  try {
    expect(aborted).toBe(true);
    expect(state).toBe('revoked');
    expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
    const next = command({ deadline: 2000000 });
    expect(() => owner.review(next)).toThrow('COMMAND_EXPIRED');
    expect(rollback).toHaveBeenCalledTimes(1);
  } finally { await owner.close(); }
});

it.each(observers)('%s expires an applied temporary effect and never retries failed cleanup while polling', async (observer) => {
  const owner = session(), failed = deferred<void>();
  const rollback = vi.fn(async () => { failed.resolve(); throw new Error('private restore detail'); });
  approve(owner);
  const execute = vi.fn(async () => {});
  await owner.apply(command(), operation(execute, rollback));
  vi.setSystemTime(1100);
  owner[observer]();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const attempts = rollback.mock.calls.length;
  const time = vi.spyOn(Date, 'now').mockReturnValue(NaN);
  try {
    for (let n = 0; n < 4; n++) {
      owner.status(); owner.receipts();
      await owner.apply(command(), operation(execute, rollback));
      await Promise.resolve();
    }
  } finally { time.mockRestore(); }
  try {
    expect(attempts).toBe(1);
    await failed.promise;
    expect(owner.status()).toMatchObject({ state: 'cleanup-failed', pendingCleanup: 1 });
    expect(owner.receipts()[0]).toMatchObject({ status: 'applied', revocation: 'cleanup-failed', error: 'ROLLBACK_FAILED' });
    expect(JSON.stringify(owner.receipts())).not.toContain('private restore detail');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await owner.revoke('disconnected');
    expect(rollback).toHaveBeenCalledTimes(2);
  } finally { await owner.close(); }
});

it('a duplicate apply observes clock rollback without dispatching a second native call', async () => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  let signal!: AbortSignal;
  approve(owner);
  const execute = vi.fn((abort: AbortSignal) => { signal = abort; return pending.promise; });
  const running = owner.apply(command(), operation(execute, rollback));
  vi.setSystemTime(900);
  const duplicate = owner.apply(command(), operation(execute, rollback));
  const aborted = signal.aborted;
  vi.setSystemTime(1000);
  pending.resolve();
  const receipt = await running;
  try {
    expect(aborted).toBe(true);
    expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked' });
    expect(await duplicate).toEqual(receipt);
    expect(await owner.apply(command(), operation(execute, rollback))).toEqual(receipt);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  } finally { await owner.close(); }
});

it.each(invalidClocks)('rejects clock %s first observed at confirmation', async (clock) => {
  const owner = session(), review = owner.review(command());
  const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  let confirmed = false;
  try { try { owner.confirm(review.reviewId); confirmed = true; } catch { /* Expected denial. */ } }
  finally { time.mockRestore(); }
  try {
    expect(confirmed).toBe(false);
    expect(owner.status().state).toBe('revoked');
    expect(() => owner.confirm(review.reviewId)).toThrow('REVIEW_UNAVAILABLE');
  } finally { await owner.close(); }
});

it.each(invalidClocks)('rejects clock %s first observed at review', async (clock) => {
  const owner = session(), time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  let reviewed = false;
  try { try { owner.review(command()); reviewed = true; } catch { /* Expected denial. */ } }
  finally { time.mockRestore(); }
  try {
    expect(reviewed).toBe(false);
    expect(owner.status().state).toBe('revoked');
    expect(() => approve(owner)).toThrow('WRITE_SESSION_REVOKED');
  } finally { await owner.close(); }
});

it.each(invalidClocks)('invalidates an effect when clock %s is first observed at completion', async (clock) => {
  const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
  approve(owner);
  const running = owner.apply(command(), operation(() => pending.promise, rollback));
  const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  pending.resolve();
  let receipt;
  try { receipt = await running; } finally { time.mockRestore(); }
  try {
    expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked', error: 'WRITE_REVOKED' });
    expect(owner.status().state).toBe('revoked');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(() => approve(owner)).toThrow('WRITE_SESSION_REVOKED');
  } finally { await owner.close(); }
});

const scopes = protocol.WriteScopeSchema.options;
const lifecycleReasons = ['disconnected', 'background', 'build-changed', 'page-changed', 'locked', 'service-closed'] as const;
it.each(scopes.flatMap(scope => lifecycleReasons.map(reason => ({ scope, reason }))))(
  '$scope retains a cancelled receipt after $reason, including concurrent and later duplicates', async ({ scope, reason }) => {
    const owner = session(), pending = deferred<void>(), rollback = vi.fn(async () => {});
    const input = command({ scope });
    approve(owner, input);
    let signal!: AbortSignal;
    const execute = vi.fn((abort: AbortSignal) => { signal = abort; return pending.promise; });
    const effect = operation(execute, rollback), running = owner.apply(input, effect);
    const duplicate = owner.apply(input, effect), revoking = owner.revoke(reason);
    const aborted = signal.aborted, responsibility = owner.status().pendingCleanup;
    expect(rollback).not.toHaveBeenCalled();
    pending.resolve();
    const receipt = await running;
    await revoking;
    try {
      expect(aborted).toBe(true);
      expect(responsibility).toBe(1);
      expect(receipt).toMatchObject({ status: 'cancelled', revocation: 'revoked', error: 'WRITE_REVOKED' });
      expect(await duplicate).toEqual(receipt);
      expect(await owner.apply(input, effect)).toEqual(receipt);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(owner.status().pendingCleanup).toBe(0);
      expect(() => approve(owner, input)).toThrow('WRITE_SESSION_REVOKED');
    } finally { await owner.close(); }
  });
