/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime, type Receipt } from '../runtime/index.js';
import { TaskManager } from '../tasks/task-manager.js';

let root: string;
const original = "{\r\n  // Keep SDK comment.\r\n  app: { bundleName: 'com.example.demo', versionCode: 1, },\r\n  label: 'Unchanged', /* Tail comment */\r\n}\r\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-config-'));
  await mkdir(join(root, 'AppScope'));
  await writeFile(join(root, 'build-profile.json5'), '{ app: { products: [{ name: "default" }] }, modules: [] }\n');
  await writeFile(join(root, 'AppScope/app.json5'), original);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return { context, runtime: await createRuntime() };
}
function planId(receipt: Receipt) { return (receipt.data as { planId: string }).planId; }

it('reads configuration with content identity without rewriting it', async () => {
  const { context, runtime } = await fixture();
  const result = await runtime.execute('config.inspect', { path: 'AppScope/app.json5' }, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ path: 'AppScope/app.json5', value: { app: { versionCode: 1 } }, inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await readFile(join(root, 'AppScope/app.json5'), 'utf8')).toBe(original);
});

it('reviews field changes, preserves unrelated bytes, and restores using the shared journal', async () => {
  const { context, runtime } = await fixture();
  const input = { path: 'AppScope/app.json5', edits: [{ field: ['app', 'versionCode'], value: 2 }] };
  const manager = new TaskManager(runtime, context);
  const task = await manager.submit('config.edit', input, true);
  expect(task.state).toBe('awaiting-approval');
  expect(task.plan?.review).toMatchObject({ fields: [{ field: ['app', 'versionCode'], before: 1, after: 2 }], files: [{ path: input.path }] });
  expect(await readFile(join(root, input.path), 'utf8')).toBe(original);
  const applied = await manager.approve(task.id, task.plan!.planId, true);
  expect(applied.state).toBe('succeeded');
  expect(await readFile(join(root, input.path), 'utf8')).toBe(original.replace('versionCode: 1', 'versionCode: 2'));
  const journalId = (applied.receipt?.data as { journalId: string }).journalId;
  const restore = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect(restore.exitCode).toBe(5);
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, { ...context, policy: { ...context.policy, approvedPlan: planId(restore) } })).exitCode).toBe(0);
  expect(await readFile(join(root, input.path), 'utf8')).toBe(original);
});

it('blocks duplicate decoded keys, missing fields and overlapping edits before creating a plan', async () => {
  const { context, runtime } = await fixture();
  const path = 'AppScope/app.json5';
  for (const edits of [
    [{ field: ['missing'], value: 2 }],
    [{ field: ['app'], value: {} }, { field: ['app', 'versionCode'], value: 3 }],
    [{ field: ['label'], value: 'A' }, { field: ['label'], value: 'B' }],
  ]) {
    expect((await runtime.execute('config.edit', { path, edits }, context)).exitCode).toBe(4);
  }
  await writeFile(join(root, path), '{app:{versionCode:1, "versionCode":2}}');
  expect((await runtime.execute('config.edit', { path, edits: [{ field: ['app', 'versionCode'], value: 3 }] }, context)).exitCode).toBe(4);
});

it('handles JSON5 quoted keys, comments and array values while validating generated semantics', async () => {
  const { context, runtime } = await fixture();
  const path = 'AppScope/app.json5';
  const text = "{ 'a\\u0070p': { list: [ 0x10, /* kept */ +2, ], note: 'value,}: //', }, }\n";
  await writeFile(join(root, path), text);
  const input = { path, edits: [{ field: ['app', 'list', 1], value: 3 }, { field: ['app', 'note'], value: 'New text' }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  const result = await readFile(join(root, path), 'utf8');
  expect(JSON5.parse(result)).toEqual({ app: { list: [16, 3], note: 'New text' } });
  expect(result).toContain('/* kept */');
  expect(result).toContain("'a\\u0070p'");
});

it('invalidates the field approval when another writer changes the original', async () => {
  const { context, runtime } = await fixture();
  const input = { path: 'AppScope/app.json5', edits: [{ field: ['app', 'versionCode'], value: 2 }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  const concurrent = original.replace('versionCode: 1', 'versionCode: 3');
  await writeFile(join(root, input.path), concurrent);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(5);
  expect(await readFile(join(root, input.path), 'utf8')).toBe(concurrent);
});

it('preserves a UTF-8 byte order mark in the edited file and recovery evidence', async () => {
  const { context, runtime } = await fixture();
  const text = `\ufeff${original}`, path = 'AppScope/app.json5';
  await writeFile(join(root, path), text);
  const input = { path, edits: [{ field: ['app', 'versionCode'], value: 2 }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  const applied = await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } });
  expect(applied.exitCode).toBe(0);
  expect(await readFile(join(root, path), 'utf8')).toBe(text.replace('versionCode: 1', 'versionCode: 2'));
  const journalId = (applied.data as { journalId: string }).journalId;
  expect((await runtime.execute('workspace.recovery.inspect', { journalId }, context)).exitCode).toBe(0);
});

it('reports malformed syntax and blocks secret material and non-configuration paths', async () => {
  const { context, runtime } = await fixture();
  const path = 'AppScope/app.json5';
  await writeFile(join(root, path), '{ app: ');
  const result = await runtime.execute('config.validate', { path }, context);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ valid: false, findings: [{ code: 'CONFIG_SYNTAX_INVALID' }] });
  await writeFile(join(root, path), '{ app: { password: "EXAMPLE_ONLY" } }');
  const denied = await runtime.execute('config.inspect', { path }, context);
  expect(denied.exitCode).toBe(4);
  expect(JSON.stringify(denied)).not.toContain('EXAMPLE_ONLY');
  await writeFile(join(root, 'source.ts'), '{}');
  expect((await runtime.execute('config.inspect', { path: 'source.ts' }, context)).exitCode).toBe(4);
});

it('adds object fields with explicit operations while preserving existing CRLF comments and bytes', async () => {
  const { context, runtime } = await fixture();
  const path = 'AppScope/app.json5';
  const input = { path, edits: [
    { operation: 'add', field: ['app', 'versionName'], value: '2.0.0' },
    { operation: 'add', field: ['display name'], value: 'Demo' },
  ] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((planned.data as { review: unknown }).review).toMatchObject({ fields: [
    { operation: 'add', field: ['app', 'versionName'], beforeExists: false, afterExists: true, after: '2.0.0' },
    { operation: 'add', field: ['display name'], beforeExists: false, after: 'Demo' },
  ] });
  expect(await readFile(join(root, path), 'utf8')).toBe(original);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  const result = await readFile(join(root, path), 'utf8');
  expect(JSON5.parse(result)).toEqual({ app: { bundleName: 'com.example.demo', versionCode: 1, versionName: '2.0.0' }, label: 'Unchanged', 'display name': 'Demo' });
  expect(result).toContain("// Keep SDK comment.\r\n");
  expect(result).toContain("bundleName: 'com.example.demo', versionCode: 1,");
  expect(result).toContain("label: 'Unchanged', /* Tail comment */");
  expect(result.replace(/\r\n/g, '')).not.toContain('\n');
});

it.each([
  ["{ /* before */ a: 1, /* between */ b: 2, /* tail */ }", ['a'], { b: 2 }],
  ["{ /* before */ a: 1, /* between */ b: 2 /* tail */ }", ['b'], { a: 1 }],
  ["{ /* before */ a: 1, /* tail */ }", ['a'], {}],
  ["{ /* before */ a: 1 /* tail */ }", ['a'], {}],
  ["{ list: [ /* before */ 1, /* between */ 2, /* tail */ ] }", ['list', 1], { list: [1] }],
  ["{ list: [ /* before */ 1 /* tail */ ] }", ['list', 0], { list: [] }],
] as [string, (string | number)[], unknown][])('removes a field without discarding adjacent comments: %s', async (text, field, expected) => {
  const { context, runtime } = await fixture(), path = 'AppScope/app.json5';
  await writeFile(join(root, path), text);
  const input = { path, edits: [{ operation: 'remove', field }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  const applied = await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } });
  expect(applied.exitCode).toBe(0);
  const result = await readFile(join(root, path), 'utf8');
  expect(JSON5.parse(result)).toEqual(expected);
  for (const comment of text.match(/\/\*.*?\*\//g) ?? []) { expect(result).toContain(comment); }
  const journalId = (applied.data as { journalId: string }).journalId;
  const restore = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, { ...context, policy: { ...context.policy, approvedPlan: planId(restore) } })).exitCode).toBe(0);
  expect(await readFile(join(root, path), 'utf8')).toBe(text);
});

it.each([
  ['{ list: [1, /* keep */ 2] }', ['list', 0], { list: [0, 1, 2] }],
  ['{ list: [1, /* keep */ 2,] }', ['list', 2], { list: [1, 2, 0] }],
  ['{ list: [/* keep */] }', ['list', 0], { list: [0] }],
  ['{ item: {/* keep */} }', ['item', 'new'], { item: { new: 0 } }],
] as [string, (string | number)[], unknown][])('inserts at an original array index or an existing empty object: %s', async (text, field, expected) => {
  const { context, runtime } = await fixture(), path = 'AppScope/app.json5';
  await writeFile(join(root, path), text);
  const input = { path, edits: [{ operation: 'add', field, value: 0 }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  const result = await readFile(join(root, path), 'utf8');
  expect(JSON5.parse(result)).toEqual(expected);
  expect(result).toContain('/* keep */');
});

it('uses original indices for multiple array removals and insertions in one review', async () => {
  const { context, runtime } = await fixture(), path = 'AppScope/app.json5';
  await writeFile(join(root, path), '{list:[0, /* retained */ 1, 2, 3], other:[4,5]}');
  const input = { path, edits: [
    { operation: 'remove', field: ['list', 1] }, { operation: 'remove', field: ['list', 3] },
    { operation: 'add', field: ['other', 0], value: 6 }, { operation: 'add', field: ['other', 2], value: 7 },
  ] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  const result = await readFile(join(root, path), 'utf8');
  expect(JSON5.parse(result)).toEqual({ list: [0, 2], other: [6, 4, 5, 7] });
  expect(result).toContain('/* retained */');
});

it('blocks unsafe or ambiguous structural edits before approval', async () => {
  const { context, runtime } = await fixture(), path = 'AppScope/app.json5';
  for (const edits of [
    [{ operation: 'add', field: ['app', 'versionCode'], value: 2 }],
    [{ operation: 'add', field: ['missing', 'child'], value: 2 }],
    [{ operation: 'remove', field: ['missing'] }],
    [{ operation: 'remove', field: ['label'], value: null }],
    [{ operation: 'add', field: ['__proto__'], value: {} }],
    [{ operation: 'remove', field: ['app'] }, { field: ['app', 'versionCode'], value: 2 }],
    [{ operation: 'add', field: ['new'], value: 1 }, { operation: 'add', field: ['new'], value: 2 }],
    [{ operation: 'add', field: ['password'], value: 'EXAMPLE_ONLY' }],
  ]) {
    const result = await runtime.execute('config.edit', { path, edits }, context);
    expect(result.exitCode).toBe(4);
    expect(await readFile(join(root, path), 'utf8')).toBe(original);
    expect(JSON.stringify(result)).not.toContain('EXAMPLE_ONLY');
  }
});
