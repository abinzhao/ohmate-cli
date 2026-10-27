/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NetworkMockTable } from './network-mock.js';
import { WriteSession } from './write-session.js';
import { hashContract } from './canonical-hash.js';
import type { WriteCommand } from './write-schemas.js';

const api = await import('./network-mock.js').catch(() => ({})) as typeof import('./network-mock.js');
beforeEach(() => {
  expect(api).toHaveProperty('NetworkMockTable');
  expect(api).toHaveProperty('validateMockRules');
});
const identity = { project: 'example', buildId: 'unverified:example:1', device: 'local',
  process: 'process', sessionId: 'session', fingerprint: 'f'.repeat(64) };
const origin = 'https://example.invalid';
const request = { requestId: 'request-1', targetId: 'http-1', origin, method: 'GET',
  path: '/catalog', headers: { accept: 'application/json' }, resourceType: 'fetch', sensitivity: 'ordinary' };
function rules() {
  return { version: '1', targetId: 'http-1', rules: [
    { ruleId: 'fallback', priority: 0, origin, method: 'GET', path: '/catalog', headers: {},
      resourceType: 'fetch', response: { kind: 'fixed', status: 200, headers: { 'content-type': 'text/plain' }, body: 'fallback', delayMs: 0 } },
    { ruleId: 'first', priority: 10, origin, method: 'GET', path: '/catalog', headers: { accept: 'application/json' },
      resourceType: 'fetch', response: { kind: 'fixed', status: 503, headers: { 'content-type': 'application/json' }, body: '{"offline":true}', delayMs: 0 } },
  ] };
}
function command(plan: { planHash: string; payloadHash: string }, epoch: string): WriteCommand {
  return { type: 'write-command', version: '1', commandId: randomUUID(), idempotencyKey: randomUUID(),
    identity, sessionEpoch: epoch, scope: 'network.mock', targetId: 'http-1',
    planHash: plan.planHash, payloadHash: plan.payloadHash, deadline: Date.now() + 60000, ttlMs: 60000 };
}
const sessions: WriteSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) { await session.close(); } vi.useRealTimers(); });
function local() {
  const epoch = randomUUID(), session = new WriteSession(identity, epoch);
  sessions.push(session);
  const table = new api.NetworkMockTable('http-1');
  return { epoch, session, table };
}
async function install(table: NetworkMockTable, session: WriteSession, epoch: string, input = rules()) {
  const plan = table.plan(input, [request]), cmd = command(plan, epoch);
  const review = session.review(cmd); session.confirm(review.reviewId);
  const operation = table.operation(cmd, input, [request]);
  return { plan, cmd, operation, receipt: await session.apply(cmd, operation) };
}

it('validates bounded rules and dry-runs first priority match without retaining response text', () => {
  const table = new api.NetworkMockTable('http-1'), input = rules();
  const plan = table.plan(input, [request, { ...request, requestId: 'miss', path: '/other' }]);
  expect(plan).toMatchObject({ payloadHash: hashContract(input), matches: [
    { requestId: 'request-1', ruleId: 'first', decision: 'mock' },
    { requestId: 'miss', ruleId: null, decision: 'passthrough' },
  ], coverage: 'provided-request-samples-only' });
  expect(JSON.stringify(plan)).not.toContain('offline');
  expect(table.status()).toMatchObject({ active: false, hits: 0 });
  expect(table.evaluate(request)).toBeNull();
});

it('executes the frozen plan and restores the exact prior rule table through local consent', async () => {
  const { epoch, session, table } = local();
  const { receipt, cmd, operation } = await install(table, session, epoch);
  expect(receipt).toMatchObject({ status: 'applied', revocation: 'active' });
  expect(table.evaluate(request)).toMatchObject({ ruleId: 'first', response: { status: 503 } });
  expect(table.status()).toMatchObject({ active: true, hits: 1 });
  expect((await session.apply(cmd, operation)).status).toBe('applied');
  expect(table.status()).toMatchObject({ hits: 1 });
  await session.revoke('disconnected');
  expect(table.evaluate(request)).toBeNull();
  expect(table.status()).toMatchObject({ active: false, hits: 0 });
});

it.each(['payloadHash', 'planHash', 'targetId', 'scope'] as const)('rejects a changed %s before admitting rules', (key) => {
  const table = new api.NetworkMockTable('http-1'), input = rules(), plan = table.plan(input, [request]);
  const cmd = { ...command(plan, randomUUID()), [key]: key.endsWith('Hash') ? '0'.repeat(64) : 'other' };
  expect(() => table.operation(cmd, input, [request])).toThrow();
  expect(table.status()).toMatchObject({ active: false });
});

it('freezes payload before caller mutation and returns defensive response copies', async () => {
  const { epoch, session, table } = local(), input = rules(), plan = table.plan(input, [request]);
  const cmd = command(plan, epoch), operation = table.operation(cmd, input, [request]);
  input.rules[1].response.body = 'mutated';
  session.confirm(session.review(cmd).reviewId);
  expect((await session.apply(cmd, operation)).status).toBe('applied');
  const result = table.evaluate(request)!;
  expect(result.response).toHaveProperty('body', '{"offline":true}');
  if (result.response.kind === 'fixed') { result.response.body = 'changed result'; }
  expect(table.evaluate(request)!.response).toHaveProperty('body', '{"offline":true}');
  expect(JSON.stringify(session.receipts())).not.toContain('offline');
});

it.each(['authentication', 'payment', 'upload', 'delete', 'unknown'])('never mocks a %s request', async (sensitivity) => {
  const { epoch, session, table } = local();
  await install(table, session, epoch);
  const sample = { ...request, sensitivity };
  expect(table.plan(rules(), [sample]).matches[0]).toMatchObject({ decision: 'blocked', reason: 'SENSITIVE_REQUEST' });
  expect(table.evaluate(sample)).toBeNull();
});

it.each(['/auth', '/payments', '/upload', '/delete', '/%61uth', '/login/token'])('refuses a sensitive path %s', (path) => {
  const input = rules(); input.rules[0].path = path;
  expect(() => api.validateMockRules(input)).toThrow();
});

it.each([
  { origin: 'https://user:secret@example.invalid' }, { origin: origin + '/' },
  { path: '/a/../catalog' }, { path: '/catalog?token=example' }, { path: '/a%2fb' },
  { headers: { authorization: 'EXAMPLE' } }, { method: 'DELETE' }, { resourceType: 'websocket' },
])('rejects unsafe matching fields %#', (change) => {
  const input = rules(); Object.assign(input.rules[0], change);
  expect(() => api.validateMockRules(input)).toThrow();
});

it('rejects response secrets, duplicate IDs, and total UTF8 quota overflow', () => {
  const input = rules();
  Object.assign(input.rules[0].response.headers, { 'set-cookie': 'EXAMPLE' });
  expect(() => api.validateMockRules(input)).toThrow();
  const duplicate = rules(); duplicate.rules[1].ruleId = duplicate.rules[0].ruleId;
  expect(() => api.validateMockRules(duplicate)).toThrow();
  const huge = rules(); huge.rules[0].response.body = '字'.repeat(30000);
  expect(() => api.validateMockRules(huge)).toThrow();
  const total = rules();
  total.rules = Array.from({ length: 5 }, (_, i) => ({ ...total.rules[0], ruleId: 'rule-' + i,
    response: { ...total.rules[0].response, body: 'a'.repeat(65536) } }));
  expect(() => api.validateMockRules(total)).toThrow();
});

it('rejects an old reviewed revision without overwriting a newer table', async () => {
  const { epoch, session, table } = local(), input = rules();
  const plan = table.plan(input, [request]), cmd = command(plan, epoch), stale = table.operation(cmd, input, [request]);
  const other = local();
  await install(table, other.session, other.epoch);
  session.confirm(session.review(cmd).reviewId);
  expect((await session.apply(cmd, stale)).status).toBe('failed');
  expect(table.evaluate(request)).toHaveProperty('ruleId', 'first');
});

it('retains failed cleanup responsibility and does not overwrite a newer owner', async () => {
  const { epoch, session, table } = local();
  await install(table, session, epoch);
  const other = local(); await install(table, other.session, other.epoch);
  await session.revoke('background');
  expect(session.status()).toMatchObject({ state: 'cleanup-failed', pendingCleanup: 1 });
  expect(table.evaluate(request)).toHaveProperty('ruleId', 'first');
  await other.session.close();
  expect(table.evaluate(request)).toBeNull();
  await session.close();
  expect(session.status()).toMatchObject({ pendingCleanup: 0 });
  expect(table.status()).toMatchObject({ active: false });
});

it('returns rules only until the confirmed deadline and invalidates on clock rollback', async () => {
  vi.useFakeTimers(); vi.setSystemTime(2000000000000);
  const { epoch, session, table } = local();
  await install(table, session, epoch);
  vi.setSystemTime(Date.now() + 60001);
  expect(table.evaluate(request)).toBeNull();
  await session.close();
  const next = local(); await install(next.table, next.session, next.epoch);
  vi.setSystemTime(Date.now() - 1);
  expect(next.table.evaluate(request)).toBeNull();
  vi.setSystemTime(Date.now() + 2);
  expect(next.table.evaluate(request)).toBeNull();
});

it('keeps explicit timeout/network-error responses distinct without executing producer code', () => {
  const input = rules();
  const timeout = { ...input, rules: [{ ...input.rules[0], response: { kind: 'timeout', delayMs: 200 } }] };
  const error = { ...input, rules: [{ ...input.rules[0], response: { kind: 'network-error', delayMs: 0 } }] };
  expect(api.validateMockRules(timeout).rules[0].response.kind).toBe('timeout');
  expect(api.validateMockRules(error).rules[0].response.kind).toBe('network-error');
  expect(() => api.validateMockRules({ ...input, rules: [{ ...input.rules[0], response: { kind: 'template', body: 'process.exit()' } }] })).toThrow();
});

it('does not revive an expired outer scope when restoring a newer scope', async () => {
  vi.useFakeTimers(); vi.setSystemTime(2000000000000);
  const { epoch, session, table } = local();
  await install(table, session, epoch);
  vi.setSystemTime(Date.now() + 60001);
  const other = local(); await install(table, other.session, other.epoch);
  await other.session.close();
  expect(table.evaluate(request)).toBeNull();
});

it('stops immediately when the owning AbortSignal is invalidated', async () => {
  const { epoch, session, table } = local();
  await install(table, session, epoch);
  const closing = session.revoke('disconnected');
  expect(table.evaluate(request)).toBeNull();
  await closing;
});

it('matches exact origin, target, header, resource type and stable ties only', async () => {
  const { epoch, session, table } = local(), input = rules();
  input.rules[0].priority = 10;
  await install(table, session, epoch, input);
  expect(table.evaluate(request)).toHaveProperty('ruleId', 'fallback');
  for (const change of [
    { origin: 'https://other.invalid' }, { targetId: 'other' }, { resourceType: 'xhr' }, { path: '/Catalog' },
  ]) { expect(table.evaluate({ ...request, ...change })).toBeNull(); }
  await session.close();
  const next = local(); await install(next.table, next.session, next.epoch);
  expect(next.table.evaluate({ ...request, headers: { accept: 'text/plain' } })).toHaveProperty('ruleId', 'fallback');
});

it('rejects extra fields, duplicate samples and unbounded sample sets before planning', () => {
  const table = new api.NetworkMockTable('http-1');
  expect(() => table.plan({ ...rules(), script: 'EXAMPLE' }, [request])).toThrow();
  expect(() => table.plan(rules(), [request, request])).toThrow();
  expect(() => table.plan(rules(), Array.from({ length: 129 }, (_, i) => ({ ...request, requestId: 'r-' + i })))).toThrow();
  expect(() => table.plan(rules(), [{ ...request, body: 'EXAMPLE' }])).toThrow();
});
