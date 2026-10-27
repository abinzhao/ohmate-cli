/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-patch-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-patch-cli-')), dataDir = join(root, 'data');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function cli(args) {
  const result = spawnSync(process.execPath, [bin, ...args, '--project', root, '--format', 'json'], {
    cwd: root, env: { ...process.env, OHMATE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.trim(), result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.status, receipt.exitCode);
  return receipt;
}
try {
  const before = 'export const value = 1;\n', after = 'export const value = 2;\n';
  await writeFile(join(root, 'main.ts'), before);
  const input = { changes: [{ path: 'main.ts', oldHash: hash(before), text: after }] };
  const task = cli(['task', 'submit', 'workspace.patch', '--payload', JSON.stringify(input), '--wait']).data;
  assert.equal(task.state, 'awaiting-approval');
  assert.equal(task.plan.review.files[0].newHash, hash(after));
  assert.ok(task.plan.review.files[0].diff.includes('+export const value = 2;'));
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), before);
  const approved = cli(['task', 'approve', task.id, task.plan.planId, '--wait']);
  assert.equal(approved.data.state, 'succeeded');
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), after);
  const journal = approved.data.receipt.artifacts[0];
  assert.equal(hash(await readFile(journal.path)), journal.sha256);
  assert.equal(cli(['execute', 'workspace.patch', '--input', JSON.stringify(input), '--approve-plan', task.plan.planId]).exitCode, 4);
  const journalId = approved.data.receipt.data.journalId;
  assert.equal(cli(['workspace', 'recovery', 'inspect', '--journal-id', journalId]).data.files[0].state, 'applied');
  const plan = cli(['workspace', 'recovery', 'restore', '--journal-id', journalId]);
  assert.equal(plan.exitCode, 5);
  const restored = cli(['workspace', 'recovery', 'restore', '--journal-id', journalId, '--approve-plan', plan.data.planId]);
  assert.equal(restored.exitCode, 0);
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), before);
  const preview = cli(['context', 'preview', '--write-paths', 'new.ts']).data;
  assert.deepEqual(preview.writeScope, [{ path: 'new.ts', oldHash: null }]);
  const events = cli(['task', 'events', task.id]).data;
  assert.ok(events.some((event) => event.type === 'patch.file.applied'));
  await mkdir('artifacts/validation', { recursive: true });
  await writeFile(`artifacts/validation/${label}.json`, JSON.stringify({
    status: 'passed', bin, platform: process.platform, node: process.version,
    checks: ['terminal task diff', 'no pre-approval write', 'single approval apply', 'journal hash', 'plan reuse blocked',
      'observed recovery state', 'reviewed restore', 'write-path preview', 'ordered patch event'],
    registry: cli(['capabilities']).data.length, deviceOperations: 'none', cloudRequests: 'none',
  }, null, 2));
  console.log(`CLI patch and reviewed restore passed: ${label}`);
} finally { await rm(root, { recursive: true, force: true }); }
