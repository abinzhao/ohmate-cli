/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm1-config-r1-built';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const root = await mkdtemp(join(tmpdir(), 'ohmate-config-cli-')), dataDir = join(root, 'private');
const home = join(root, 'home'), app = join(root, 'ConfigAcceptance');
await mkdir(home);
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, OHMATE_DATA_DIR: dataDir,
  NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
  DEVECO_CLI_DISABLE_UPDATE: 'all', DEVECO_CLI_DISABLE_TELEMETRY: '1' };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function cli(args, project) {
  const result = spawnSync(process.execPath, [bin, ...args, ...project ? ['--project', project] : [], '--format', 'json'], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.trim(), result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(result.status, receipt.exitCode, result.stderr);
  return receipt;
}
let origin, cookie, csrf;
async function api(path, input) {
  const response = await fetch(`${origin}/api/v1/${path}`, {
    method: input === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json',
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-ohmate-csrf': csrf } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function requestFile(input) {
  const file = join(root, 'edit.json');
  await writeFile(file, JSON.stringify(input));
  return file;
}
try {
  const create = ['create', '--app-name', 'ConfigAcceptance', '--api-level', '22', '--device-types', 'phone'];
  const planned = cli(create);
  assert.equal(planned.exitCode, 5, JSON.stringify(planned.data));
  assert.equal(cli([...create, '--approve-plan', planned.data.planId]).exitCode, 0);
  const path = 'entry/src/main/module.json5', before = await readFile(join(app, path), 'utf8');
  const request = { path, edits: [{ operation: 'add', field: ['module', 'requestPermissions'], value: [{ name: 'ohos.permission.INTERNET' }] }] };
  const file = await requestFile(request), plan = cli(['config', 'edit', '--input-file', file], app);
  assert.equal(plan.exitCode, 5, JSON.stringify(plan.data));
  assert.equal(plan.data.review.fields[0].beforeExists, false);
  assert.equal(await readFile(join(app, path), 'utf8'), before);
  assert.equal(cli(['config', 'edit', '--input-file', file, '--approve-plan', plan.data.planId], app).exitCode, 0);
  assert.equal(cli(['config', 'validate', '--path', path], app).exitCode, 0);
  const opened = cli(['ui', '--no-open'], app);
  assert.equal(opened.exitCode, 0, JSON.stringify(opened.data));
  origin = opened.data.origin;
  const ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.equal(connected.status, 200);
  cookie = connected.headers.get('set-cookie').split(';')[0]; csrf = (await api('bootstrap')).csrf;
  assert.deepEqual((await api('capabilities')).data, cli(['capabilities']).data);
  const inspection = await api('tasks', { toolId: 'config.inspect', input: { path }, projectRoot: app, wait: true });
  assert.equal(inspection.data.state, 'succeeded');
  assert.deepEqual(inspection.data.receipt.data, cli(['config', 'inspect', '--path', path], app).data);
  const removal = await api('tasks', { toolId: 'config.edit', input: { path, edits: [{ operation: 'remove', field: ['module', 'requestPermissions'] }] }, projectRoot: app, wait: true });
  assert.equal(removal.data.state, 'awaiting-approval');
  const approved = await api(`tasks/${removal.data.id}/approve`, { planId: removal.data.plan.planId, wait: true });
  assert.equal(approved.data.state, 'succeeded', JSON.stringify(approved.data));
  assert.deepEqual(cli(['task', 'show', removal.data.id], app).data, approved.data);
  assert.equal(cli(['config', 'inspect', '--path', path], app).data.value.module.requestPermissions, undefined);
  const rulePath = 'entry/obfuscation-rules.txt', rulesBefore = '\ufeff# retain comments\r\n-disable-obfuscation # old switch\r\n-keep-property-name oldName, keptName # old list\r\n';
  await writeFile(join(app, rulePath), rulesBefore);
  const ruleInput = { path: rulePath, edits: [
    { operation: 'remove', option: '-disable-obfuscation' },
    { operation: 'add', option: '-enable-property-obfuscation' },
    { operation: 'remove', option: '-keep-property-name', values: ['oldName'] },
    { operation: 'add', option: '-keep-property-name', values: ['newName'] },
  ] };
  const rulesTask = await api('tasks', { toolId: 'config.edit', input: ruleInput, projectRoot: app, wait: true });
  assert.equal(rulesTask.data.state, 'awaiting-approval');
  const rulesApplied = await api(`tasks/${rulesTask.data.id}/approve`, { planId: rulesTask.data.plan.planId, wait: true });
  assert.equal(rulesApplied.data.state, 'succeeded', JSON.stringify(rulesApplied.data));
  const rulesAfter = await readFile(join(app, rulePath), 'utf8');
  assert.ok(rulesAfter.startsWith('\ufeff')); assert.ok(rulesAfter.includes('# old switch'));
  assert.equal(cli(['config', 'validate', '--path', rulePath], app).exitCode, 0);
  let official = { validation: 'not-run' };
  if (process.env.OHMATE_ARKGUARD_RESOLVER) {
    const resolverPath = resolve(process.env.OHMATE_ARKGUARD_RESOLVER);
    const { ObConfigResolver, MergedConfig } = createRequire(import.meta.url)(resolverPath);
    const resolver = new ObConfigResolver({}, () => {}, false), merged = new MergedConfig();
    resolver.handleConfigContent(rulesAfter, merged, join(app, rulePath));
    assert.equal(merged.options.disableObfuscation, false);
    assert.equal(merged.options.enablePropertyObfuscation, true);
    assert.deepEqual(merged.reservedPropertyNames.sort(), ['keptName', 'newName']);
    official = { validation: 'official-local-rule-parser', resolverSha256: hash(await readFile(resolverPath)),
      whitelist: merged.reservedPropertyNames, dependencyMerge: 'not-run', releaseBuild: 'not-run' };
  }
  const journalId = rulesApplied.data.receipt.data.journalId;
  const restore = cli(['workspace', 'recovery', 'restore', '--journal-id', journalId], app);
  assert.equal(restore.exitCode, 5);
  assert.equal(cli(['workspace', 'recovery', 'restore', '--journal-id', journalId, '--approve-plan', restore.data.planId], app).exitCode, 0);
  assert.equal(await readFile(join(app, rulePath), 'utf8'), rulesBefore);
  await writeFile(join(app, rulePath), '-extra-options strip-language-default\n');
  assert.equal(cli(['config', 'validate', '--path', rulePath], app).exitCode, 3);
  const events = await fetch(`${origin}/api/v1/tasks/${rulesTask.data.id}/events?after=0`, { headers: { cookie } });
  assert.ok((await events.text()).includes('event: end'));
  assert.equal(cli(['ui', 'stop']).exitCode, 0); origin = undefined;
  const result = { status: 'passed', bin, platform: process.platform, node: process.version,
    cliFieldAdd: true, webFieldRemove: true, webRuleEdit: true, sharedTaskReceipt: true, sse: true, immutableRuleRecovery: true,
    ruleInputHash: hash(rulesBefore), ruleOutputHash: hash(rulesAfter), official, devices: 'not-operated', cloud: 'not-contacted' };
  await mkdir('artifacts/validation', { recursive: true });
  await writeFile(`artifacts/validation/${label}.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  if (origin) { cli(['ui', 'stop']); }
  await rm(root, { recursive: true, force: true });
}
