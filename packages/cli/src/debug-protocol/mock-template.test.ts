/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as api from './network-mock.js';
import { hashContract } from './canonical-hash.js';
import { WriteSession } from './write-session.js';

const response = { kind: 'template', status: 202, headers: { 'content-type': 'text/plain' },
  template: 'hello {{test.name}} / {{test.name}}', variables: { 'test.name': 'SYNTHETIC_VALUE' }, delayMs: 0 };
const rules = (value: object = response) => ({ version: '1', targetId: 'http-1', rules: [{
  ruleId: 'template-rule', priority: 1, origin: 'https://example.invalid', method: 'GET', path: '/catalog',
  resourceType: 'fetch', headers: {}, response: value,
}] });
const sample = { requestId: 'sample', targetId: 'http-1', origin: 'https://example.invalid', method: 'GET',
  path: '/catalog', resourceType: 'fetch', headers: {}, sensitivity: 'ordinary' };
const render = (value: object): unknown => {
  expect(api).toHaveProperty('renderMockResponse');
  return (api as typeof api & { renderMockResponse: (value: object) => unknown }).renderMockResponse(value);
};

it('renders explicit test variables once and preserves replacement tokens as inert text', () => {
  const variables = { 'test.name': '$& $` ${process.exit()} {{test.other}}' };
  expect(render({ ...response, variables })).toEqual({ kind: 'fixed', status: 202,
    headers: response.headers, body: 'hello ' + variables['test.name'] + ' / ' + variables['test.name'], delayMs: 0 });
  expect(render({ ...response, template: 'literal', variables: {} })).toHaveProperty('body', 'literal');
  expect(render({ ...response, template: '{{test.name}}', variables: { 'test.name': '' } })).toHaveProperty('body', '');
});

it.each([
  { template: '{{test.missing}}' }, { template: '{{request.header}}' }, { template: '{{process.exit()}}' },
  { template: '{{test.name}' }, { template: 'test.name}}' }, { template: '{{{{test.name}}}}' },
  { variables: { 'test.name': 'x', 'test.unused': 'y' } }, { variables: { '__proto__': 'x' } },
  { variables: { 'test.name': 1 } }, { variables: { 'test.name': '\ud800' } },
  { template: '\ud800' }, { body: 'EXTRA_BODY' }, { path: '/EXAMPLE_PRIVATE' }, { script: 'EXAMPLE_CODE' },
])('rejects ambiguous syntax, implicit context and undeclared data %#', (change) => {
  expect(() => api.validateMockRules(rules({ ...response, ...change }))).toThrow();
});

it('enforces UTF8, variable, reference, rendered-body and complete-table budgets', () => {
  const invalid = [
    { ...response, template: '字'.repeat(5500), variables: {} },
    { ...response, variables: { 'test.name': '字'.repeat(700) } },
    { ...response, template: '{{test.name}}'.repeat(65) },
    { ...response, template: '{{test.name}}'.repeat(33), variables: { 'test.name': 'x'.repeat(2048) } },
    { ...response, variables: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['test.v' + i, 'x'])),
      template: Array.from({ length: 17 }, (_, i) => '{{test.v' + i + '}}').join('') },
  ];
  for (const item of invalid) { expect(() => api.validateMockRules(rules(item))).toThrow(); }
  const boundary = { ...response, template: '{{test.name}}'.repeat(32), variables: { 'test.name': 'x'.repeat(2048) } };
  expect(render(boundary)).toHaveProperty('body', 'x'.repeat(65536));
  const table = rules({ ...response, template: 'x'.repeat(16000), variables: {} });
  table.rules = Array.from({ length: 17 }, (_, i) => ({ ...table.rules[0], ruleId: 'r-' + i }));
  expect(() => api.validateMockRules(table)).toThrow();
  const expanded = rules(boundary);
  expanded.rules = Array.from({ length: 5 }, (_, i) => ({ ...expanded.rules[0], ruleId: 'r-' + i }));
  expect(() => api.validateMockRules(expanded)).toThrow();
});

it('rejects HEAD with a rendered body while permitting an explicit empty template', () => {
  const invalid = rules(); invalid.rules[0].method = 'HEAD';
  expect(() => api.validateMockRules(invalid)).toThrow();
  const empty = rules({ ...response, template: '{{test.name}}', variables: { 'test.name': '' } });
  empty.rules[0].method = 'HEAD';
  expect(api.validateMockRules(empty).rules[0].response.kind).toBe('template');
});

it('binds the rendered body hash to dry-run and returns a frozen fixed response only after local consent', async () => {
  const table = new api.NetworkMockTable('http-1'), input = rules(), epoch = randomUUID();
  const plan = table.plan(input, [sample]);
  expect(plan).toHaveProperty('responses.0.bodyHash', hashContract('hello SYNTHETIC_VALUE / SYNTHETIC_VALUE'));
  const changed = table.plan(rules({ ...response, variables: { 'test.name': 'OTHER' } }), [sample]);
  expect(changed.payloadHash).not.toBe(plan.payloadHash);
  expect(changed.planHash).not.toBe(plan.planHash);
  expect(JSON.stringify(plan)).not.toContain('SYNTHETIC_VALUE');
  const identity = { project: 'example', buildId: 'unverified:example:1', device: 'local', process: 'test',
    sessionId: 'session', fingerprint: 'a'.repeat(64) };
  const session = new WriteSession(identity, epoch);
  const command = { type: 'write-command', version: '1', commandId: randomUUID(), idempotencyKey: randomUUID(),
    identity, sessionEpoch: epoch, scope: 'network.mock', targetId: 'http-1', payloadHash: plan.payloadHash,
    planHash: plan.planHash, deadline: Date.now() + 60000, ttlMs: 60000 };
  try {
    const operation = table.operation(command, input, [sample]);
    response.variables['test.name'] = 'CALLER_MUTATION';
    expect(table.evaluate(sample)).toBeNull();
    session.confirm(session.review(command).reviewId);
    expect((await session.apply(command, operation)).status).toBe('applied');
    const value = table.evaluate(sample);
    expect(value).toHaveProperty('response.kind', 'fixed');
    expect(value).toHaveProperty('response.body', 'hello SYNTHETIC_VALUE / SYNTHETIC_VALUE');
    expect(JSON.stringify(session.receipts())).not.toContain('SYNTHETIC_VALUE');
    await session.revoke('disconnected');
    expect(table.evaluate(sample)).toBeNull();
  } finally {
    response.variables['test.name'] = 'SYNTHETIC_VALUE';
    await session.close();
  }
});
