/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectCompilerObservations } from './compiler-observations.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-host-evidence-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('shares the observation entry budget across actual compiler invocations', async () => {
  const directory = join(root, 'observations');
  await mkdir(directory);
  for (let index = 0; index < 2; index++) {
    const record = { version: 1, pid: 1, configuration: { entryModuleName: 'entry' }, files: [], probes: [],
      resolutions: Array.from({ length: 6000 }, () => ({
        containingFile: join(root, 'Index.ets'), containingScope: 'project',
        resolvedFile: join(root, 'Dependency.ets'), resolvedScope: 'project',
      })), hosts: [], drift: [], missing: [] };
    await writeFile(join(directory, `${randomUUID()}.jsonl`),
      JSON.stringify({ ...record, phase: 'started', resolutions: [] }) + '\n' +
      JSON.stringify({ ...record, phase: 'closed' }) + '\n');
  }
  const result = await collectCompilerObservations(directory, root, join(root, 'sdk'));
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-observation-total-budget');
  expect(result.resolutions.length).toBeLessThanOrEqual(10000);
});
it.each(['entries', 'bytes'])('shares the Host text %s budget across compiler invocations', async (budget) => {
  const directory = join(root, 'observations');
  await mkdir(directory);
  for (let index = 0; index < 2; index++) {
    const textReads = Array.from({ length: budget === 'entries' ? 6000 : 5 }, () => ({
      scope: 'project', path: join(root, 'Input.ets'), method: 'readFile', textSha256: 'a'.repeat(64),
      utf8Size: budget === 'bytes' ? 8 * 1024 * 1024 : 0, binding: 'host-text-only', readObserved: false,
    }));
    const record = { version: 1, pid: 1, configuration: {}, files: [], probes: [], resolutions: [], hosts: [],
      textReads, drift: [], missing: [] };
    await writeFile(join(directory, `${randomUUID()}.jsonl`),
      JSON.stringify({ ...record, phase: 'started', textReads: [] }) + '\n' +
      JSON.stringify({ ...record, phase: 'closed' }) + '\n');
  }
  const result = await collectCompilerObservations(directory, root, join(root, 'sdk'));
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-observation-total-budget');
  expect(result.textReads.length).toBeLessThanOrEqual(6000);
});
it.each(['binding', 'representation'])('rejects unavailable Host text %s without reading a replacement file', async (invalid) => {
  const directory = join(root, 'observations');
  await mkdir(directory);
  const textReads = [{ scope: 'project', path: join(root, 'Absent.ets'), method: 'readFile', textSha256: 'a'.repeat(64),
    utf8Size: 1, binding: invalid === 'representation' ? 'decoded-filesystem-text' : 'host-text-only',
    readObserved: invalid === 'binding' }];
  const record = { version: 1, pid: 1, configuration: {}, files: [], probes: [], resolutions: [], hosts: [],
    textReads, drift: [], missing: [] };
  await writeFile(join(directory, `${randomUUID()}.jsonl`),
    JSON.stringify({ ...record, phase: 'started', textReads: [] }) + '\n' +
    JSON.stringify({ ...record, phase: 'closed' }) + '\n');
  const result = await collectCompilerObservations(directory, root, join(root, 'sdk'));
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain(invalid === 'binding' ? 'host-text-read-binding-unavailable' : 'host-text-representation-mismatch');
  expect(result.files).toEqual([]);
});
