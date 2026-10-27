/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime, type Receipt } from '../runtime/index.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-arkguard-'));
  await mkdir(join(root, 'features/public/src/main'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), '{modules:[{name:"public",srcPath:"features/public",targets:[{name:"default"}]}]}');
  await writeFile(join(root, 'features/public/src/main/module.json5'), '{module:{name:"public",type:"har"}}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return { context, runtime: await createRuntime() };
}
function planId(receipt: Receipt) { return (receipt.data as { planId: string }).planId; }

it('inspects actual consumer rules with locations, module identity and an explicit official validation boundary', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/consumer-rules.txt';
  const text = "\ufeff# public ABI\r\n-keep-global-name 'PublicStore', PublicState # keep this\r\n-keep-property-name\r\n  jsonField\r\n";
  await writeFile(join(root, path), text);
  const result = await runtime.execute('config.inspect', { path }, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ path, parser: 'arkguard', role: 'consumer', module: { name: 'public', type: 'har' },
    inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), officialValidation: 'not-run',
    rules: [{ option: '-keep-global-name', values: ['PublicStore', 'PublicState'], line: 2 },
      { option: '-keep-property-name', values: ['jsonField'], line: 3 }],
  });
  expect((await runtime.execute('config.validate', { path }, context)).exitCode).toBe(0);
  expect(await readFile(join(root, path), 'utf8')).toBe(text);
});

it('adds and removes exact whitelist names without losing comments or line endings and restores the reviewed bytes', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/consumer-rules.txt';
  const before = "\ufeff# public ABI\r\n-keep-global-name PublicStore # Keep global\r\n-keep-property-name removedName, keptName # tail\r\n";
  await writeFile(join(root, path), before);
  const input = { path, edits: [
    { operation: 'remove', option: '-keep-property-name', values: ['removedName'] },
    { operation: 'add', option: '-keep-property-name', values: ['newName'] },
  ] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((planned.data as { review: unknown }).review).toMatchObject({ rules: [
    { option: '-keep-property-name', operation: 'remove', values: ['removedName'] },
    { option: '-keep-property-name', operation: 'add', values: ['newName'] },
  ], officialValidation: 'not-run' });
  expect(await readFile(join(root, path), 'utf8')).toBe(before);
  const applied = await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } });
  expect(applied.exitCode).toBe(0);
  const after = await readFile(join(root, path), 'utf8');
  expect(after.startsWith('\ufeff')).toBe(true);
  expect(after).toContain('# public ABI\r\n-keep-global-name PublicStore # Keep global\r\n');
  expect(after).toContain('keptName # tail\r\n');
  expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  expect((await runtime.execute('config.inspect', { path }, context)).data).toMatchObject({
    rules: [{ option: '-keep-global-name', values: ['PublicStore'] }, { option: '-keep-property-name', values: ['keptName'] },
      { option: '-keep-property-name', values: ['newName'] }],
  });
  const journalId = (applied.data as { journalId: string }).journalId;
  const restore = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, { ...context, policy: { ...context.policy, approvedPlan: planId(restore) } })).exitCode).toBe(0);
  expect(await readFile(join(root, path), 'utf8')).toBe(before);
});

it('repairs unsafe consumer switches but refuses to introduce them or certify their existing use', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/consumer-rules.txt';
  const before = '# keep comment\n-enable-property-obfuscation # unsafe for consumers\n-keep-global-name PublicStore\n';
  await writeFile(join(root, path), before);
  const invalid = await runtime.execute('config.validate', { path }, context);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.data).toMatchObject({ valid: false, findings: [{ code: 'ARKGUARD_CONSUMER_OPTION', line: 2 }] });
  const input = { path, edits: [{ operation: 'remove', option: '-enable-property-obfuscation' }] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  expect((await runtime.execute('config.validate', { path }, context)).exitCode).toBe(0);
  const after = await readFile(join(root, path), 'utf8');
  expect(after).toContain('# unsafe for consumers');
  expect((await runtime.execute('config.edit', { path, edits: [{ operation: 'add', option: '-enable-export-obfuscation' }] }, context)).exitCode).toBe(4);
  expect(await readFile(join(root, path), 'utf8')).toBe(after);
});

it('edits supported module switches without implying a Release build or rule merge has run', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/obfuscation-rules.txt';
  await writeFile(join(root, path), '# source rules\n-disable-obfuscation\n');
  const input = { path, edits: [
    { operation: 'remove', option: '-disable-obfuscation' },
    { operation: 'add', option: '-enable-property-obfuscation' },
    { operation: 'add', option: '-keep-property-name', values: ['jsonField'] },
  ] };
  const planned = await runtime.execute('config.edit', input, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('config.edit', input, { ...context, policy: { ...context.policy, approvedPlan: planId(planned) } })).exitCode).toBe(0);
  expect((await runtime.execute('config.validate', { path }, context)).data).toMatchObject({ valid: true,
    officialValidation: 'not-run', effectiveMerge: 'not-run', requiredBuildMode: 'release' });
});

it('reports unsupported ArkGuard directives and blocks edits rather than guessing their argument grammar', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/obfuscation-rules.txt';
  const text = '-extra-options strip-language-default\n-keep-global-name Known\n';
  await writeFile(join(root, path), text);
  const incomplete = await runtime.execute('config.validate', { path }, context);
  expect(incomplete.exitCode).toBe(3);
  expect(incomplete.data).toMatchObject({ valid: null, findings: [{ code: 'ARKGUARD_UNSUPPORTED_OPTION', line: 1 }] });
  expect((await runtime.execute('config.edit', { path, edits: [{ operation: 'add', option: '-keep-global-name', values: ['Other'] }] }, context)).exitCode).toBe(4);
  expect(await readFile(join(root, path), 'utf8')).toBe(text);
});

it('blocks orphan values, empty whitelist directives, invalid filenames and edits outside declared module rules', async () => {
  const { context, runtime } = await fixture(), path = 'features/public/obfuscation-rules.txt';
  for (const text of ['Orphan\n', '-keep-property-name\n', '-keep-file-name **/Index\n']) {
    await writeFile(join(root, path), text);
    expect((await runtime.execute('config.validate', { path }, context)).exitCode).toBe(1);
  }
  await writeFile(join(root, 'obfuscation-rules.txt'), '-keep-global-name Root\n');
  expect((await runtime.execute('config.inspect', { path: 'obfuscation-rules.txt' }, context)).exitCode).toBe(4);
  await writeFile(join(root, path), '-keep-property-name Existing\n');
  for (const edits of [
    [{ operation: 'remove', option: '-keep-property-name', values: ['Missing'] }],
    [{ operation: 'add', option: '-keep-property-name', values: ['Existing'] }],
    [{ operation: 'add', option: '-keep-property-name', values: ['Injected\n-enable-property-obfuscation'] }],
    [{ operation: 'add', option: '-unknown-switch' }],
    [{ operation: 'add', option: '-print-namecache', values: ['somewhere'] }],
    [{ operation: 'remove', option: '-keep-property-name', values: ['Existing'] }, { operation: 'add', option: '-keep-property-name', values: ['Existing'] }],
  ]) { expect((await runtime.execute('config.edit', { path, edits }, context)).exitCode).toBe(4); }
});
