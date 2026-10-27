/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import * as api from '../runtime/index.js';
import { runTerminal } from '../terminal/terminal-adapter.js';
import { agentSpecs } from '../agent/agent-tools.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import { TaskManager } from '../tasks/task-manager.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-mock-command-'));
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const origin = 'https://example.invalid';
const rule = { ruleId: 'offline', priority: 1, origin, method: 'GET', path: '/catalog',
  resourceType: 'fetch', headers: {}, response: { kind: 'fixed', status: 503,
    headers: { 'content-type': 'text/plain' }, body: 'SYNTHETIC_MOCK_BODY', delayMs: 0 } };
const rules = { version: '1', targetId: 'http-1', rules: [rule] };
const sample = { requestId: 'request-1', targetId: 'http-1', origin, method: 'GET', path: '/catalog',
  resourceType: 'fetch', headers: {}, sensitivity: 'ordinary' };
async function environment() {
  return { runtime: await createRuntime(),
    context: await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }) };
}

it('exposes all five commands in the shared Registry and exports the local table API', async () => {
  const { runtime } = await environment();
  for (const id of ['mock.validate', 'mock.plan', 'mock.apply', 'mock.status', 'mock.revoke']) {
    expect(runtime.registry.get(id)).toHaveProperty('adapter', 'native');
  }
  expect(api).toHaveProperty('NetworkMockTable');
  expect(api).toHaveProperty('MockRulesSchema');
  expect(api).toHaveProperty('validateMockRules');
  for (const id of ['mock.validate', 'mock.plan', 'mock.apply', 'mock.status', 'mock.revoke']) {
    expect(() => agentSpecs(runtime, [id])).toThrow();
  }
});

it('validates and dry-runs sample matches while keeping raw bodies out of receipts and files', async () => {
  const { runtime, context } = await environment();
  const checked = await runtime.execute('mock.validate', { rules }, context);
  expect(checked).toMatchObject({ exitCode: 0, data: { payloadHash: hashContract(rules), ruleCount: 1 } });
  const planned = await runtime.execute('mock.plan', { rules, samples: [sample] }, context);
  expect(planned).toMatchObject({ exitCode: 0, data: { mode: 'offline', plan: {
    coverage: 'provided-request-samples-only', matches: [{ requestId: 'request-1', ruleId: 'offline', decision: 'mock' }],
  } } });
  expect(JSON.stringify([checked, planned])).not.toContain(rule.response.body);
  expect(await readdir(root)).toEqual([]);
});

it('returns unavailable remote status instead of asserting zero active rules', async () => {
  const { runtime, context } = await environment();
  const receipt = await runtime.execute('mock.status', {}, context);
  expect(receipt).toMatchObject({ exitCode: 3, data: { available: false, active: null, hits: null,
    reason: 'DEVICE_BUILD_UNVERIFIED' } });
});

it('refuses remote apply and revoke without creating desktop approval or persisting payload', async () => {
  const { runtime, context } = await environment();
  const command = { type: 'write-command', version: '1', commandId: randomUUID(), idempotencyKey: randomUUID(),
    identity: { project: 'example', buildId: 'unverified:example:1', device: 'local', process: 'process',
      sessionId: 'session', fingerprint: 'a'.repeat(64) }, sessionEpoch: randomUUID(), scope: 'network.mock',
    targetId: 'http-1', planHash: 'f'.repeat(64), payloadHash: hashContract(rules), deadline: Date.now() + 60000, ttlMs: 60000 };
  const applied = await runtime.execute('mock.apply', { command, rules, samples: [sample] }, context);
  const revoked = await runtime.execute('mock.revoke', { targetId: 'http-1' }, context);
  expect(applied).toMatchObject({ exitCode: 5, data: { code: 'DEVICE_BUILD_UNVERIFIED' } });
  expect(revoked).toMatchObject({ exitCode: 5, data: { code: 'DEVICE_BUILD_UNVERIFIED' } });
  expect(JSON.stringify([applied, revoked])).not.toContain(rule.response.body);
  expect(await readdir(root)).toEqual([]);
});

it('rejects unsafe rules before dry-run and does not expose arbitrary resource files', async () => {
  const { runtime, context } = await environment();
  const invalid = { ...rules, rules: [{ ...rule, response: { kind: 'file', path: '/EXAMPLE_PRIVATE' } }] };
  const receipt = await runtime.execute('mock.validate', { rules: invalid }, context);
  expect(receipt.exitCode).toBe(4);
  expect(JSON.stringify(receipt)).not.toContain('/EXAMPLE_PRIVATE');
  expect(await readdir(root)).toEqual([]);
});

it('uses the public input-file terminal entry and leaves its file unchanged', async () => {
  const path = join(root, 'mock.json');
  const text = JSON.stringify({ rules, samples: [sample] });
  await writeFile(path, text);
  let output = '';
  const exit = await runTerminal(['mock', 'plan', '--input-file', path, '--format', 'json'],
    { stdout: (chunk) => { output += chunk; }, stderr: (chunk) => { output += chunk; } });
  expect(exit).toBe(0);
  expect(JSON.parse(output)).toHaveProperty('data.plan.matches.0.ruleId', 'offline');
  expect(output).not.toContain(rule.response.body);
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(await readdir(root)).toEqual(['mock.json']);
});

it('keeps mock bodies out of durable background task inputs', async () => {
  const { runtime, context } = await environment(), manager = new TaskManager(runtime, context);
  for (const id of ['mock.validate', 'mock.plan', 'mock.apply', 'mock.status', 'mock.revoke']) {
    await expect(manager.submit(id, { rules, samples: [sample] }, false))
      .rejects.toThrow('Service lifecycle requires a dedicated control entry');
  }
  expect(await readdir(root)).toEqual([]);
});

it('supports deterministic templates through Registry and terminal while exposing only response hashes', async () => {
  const response = { kind: 'template', status: 202, headers: { 'content-type': 'text/plain' },
    template: 'mock {{test.value}}', variables: { 'test.value': 'SYNTHETIC_TEMPLATE_VALUE' }, delayMs: 0 };
  const templated = { ...rules, rules: [{ ...rule, response }] };
  const { runtime, context } = await environment();
  expect(api).toHaveProperty('renderMockResponse');
  const receipt = await runtime.execute('mock.validate', { rules: templated }, context);
  expect(receipt).toMatchObject({ exitCode: 0, data: { supported: expect.arrayContaining(['template']),
    responses: [{ kind: 'template', bodyHash: hashContract('mock SYNTHETIC_TEMPLATE_VALUE') }] } });
  expect(receipt).toHaveProperty('data.unsupported', ['file', 'chunks', 'stream']);
  expect(JSON.stringify(receipt)).not.toContain(response.variables['test.value']);
  const path = join(root, 'template.json'), text = JSON.stringify({ rules: templated, samples: [sample] });
  await writeFile(path, text);
  let output = '';
  expect(await runTerminal(['mock', 'plan', '--input-file', path, '--format', 'json'],
    { stdout: (chunk) => { output += chunk; }, stderr: (chunk) => { output += chunk; } })).toBe(0);
  expect(JSON.parse(output)).toHaveProperty('data.plan.responses.0.bodyHash', hashContract('mock SYNTHETIC_TEMPLATE_VALUE'));
  expect(output).not.toContain(response.template);
  expect(output).not.toContain(response.variables['test.value']);
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(await readdir(root)).toEqual(['template.json']);
});

it.each(['{{request.header}}', '{{test.missing}}', '{{test.value}'])('returns a bounded invalid receipt for template %s', async (template) => {
  const { runtime, context } = await environment();
  const templated = { ...rules, rules: [{ ...rule, response: { kind: 'template', status: 202,
    headers: {}, template, variables: { 'test.value': 'SYNTHETIC_PRIVATE_VALUE' }, delayMs: 0 } }] };
  const receipt = await runtime.execute('mock.validate', { rules: templated }, context);
  expect(receipt.exitCode).toBe(4);
  expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
  expect(JSON.stringify(receipt)).not.toContain(template);
  expect(await readdir(root)).toEqual([]);
});
