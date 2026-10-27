/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm1-project-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-project-cli-')), dataDir = join(root, 'private');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function cli(args, project) {
  const result = spawnSync(process.execPath, [bin, ...args, ...project ? ['--project', project] : [], '--format', 'json'], {
    cwd: root, env: { ...process.env, OHMATE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.trim(), result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(result.status, receipt.exitCode, result.stderr);
  return receipt;
}
try {
  const app = join(root, 'AcceptanceApp');
  const request = join(root, 'create-request.json');
  await writeFile(request, JSON.stringify({ appName: 'AcceptanceApp', apiLevel: '22', deviceTypes: ['phone', 'tablet'] }));
  const plan = cli(['create', '--input-file', request]);
  assert.equal(plan.exitCode, 5, JSON.stringify(plan.data));
  assert.ok(plan.data.review.files.some((file) => file.path === 'AGENTS.md'));
  assert.ok(plan.data.review.files.some((file) => file.path.endsWith('Index.ets') && file.diff.includes('@Entry')));
  await assert.rejects(readFile(join(app, 'build-profile.json5')), { code: 'ENOENT' });
  const created = cli(['create', '--input-file', request, '--approve-plan', plan.data.planId]);
  assert.equal(created.exitCode, 0, JSON.stringify(created.data));
  assert.equal(created.data.verification.test, 'not-run');
  assert.equal(cli(['doctor'], app).exitCode, 0);
  assert.equal(cli(['project', 'inspect'], app).data.modules[0].name, 'entry');
  const manifest = created.artifacts[0];
  assert.equal(hash(await readFile(manifest.path)), manifest.sha256);
  const path = 'AppScope/app.json5', file = join(app, path);
  const before = await readFile(file, 'utf8');
  const editFile = join(root, 'edit-request.json');
  await writeFile(editFile, JSON.stringify({ path, edits: [{ field: ['app', 'versionCode'], value: 1000001 }] }));
  const editedPlan = cli(['config', 'edit', '--input-file', editFile], app);
  assert.equal(editedPlan.exitCode, 5, JSON.stringify(editedPlan.data));
  assert.equal(editedPlan.data.review.fields[0].before, 1000000);
  assert.equal(await readFile(file, 'utf8'), before);
  const edited = cli(['config', 'edit', '--input-file', editFile, '--approve-plan', editedPlan.data.planId], app);
  assert.equal(edited.exitCode, 0, JSON.stringify(edited.data));
  assert.equal(await readFile(file, 'utf8'), before.replace('1000000', '1000001'));
  assert.equal(cli(['config', 'validate', '--path', path], app).exitCode, 0);
  assert.equal(cli(['config', 'inspect', '--path', path], app).data.value.app.versionCode, 1000001);
  const journalId = edited.data.journalId;
  const restore = cli(['workspace', 'recovery', 'restore', '--journal-id', journalId], app);
  assert.equal(restore.exitCode, 5);
  assert.equal(cli(['workspace', 'recovery', 'restore', '--journal-id', journalId, '--approve-plan', restore.data.planId], app).exitCode, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(cli(['create', '--input-file', request]).exitCode, 4);
  await mkdir('artifacts/validation', { recursive: true });
  await writeFile(`artifacts/validation/${label}.json`, JSON.stringify({
    status: 'passed', bin, platform: process.platform, node: process.version,
    checks: ['structured input file', 'actual template diff', 'no target before approval', 'approved create', 'generated AGENTS',
      'post-create doctor and project', 'creation manifest hash', 'field diff', 'byte preservation', 'config inspection',
      'config validation', 'reviewed journal restore', 'nonempty target rejected'],
    registry: cli(['capabilities']).data.length, appBuild: 'not-run', appTest: 'not-run', deviceOperations: 'none', cloudRequests: 'none',
  }, null, 2));
  console.log(`Built CLI project creation/configuration verified: ${label}`);
} finally { await rm(root, { recursive: true, force: true }); }
