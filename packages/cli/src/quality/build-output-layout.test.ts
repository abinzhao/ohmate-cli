/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, symlink, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectBuildOutputLayout, type BuildOutputLayout } from './build-output-layout.js';
import { collectBuildEvidence, snapshotBuildArtifacts } from './build-artifacts.js';
import { Project } from '../utils/project.js';
import { digest } from './evidence.js';

let root: string, observations: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-output-layout-'));
  observations = join(root, 'observations'); await mkdir(observations);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function record(paths: unknown[], overrides = {}) {
  const started = { version: 1, completion: 'path-method-return', phase: 'started', pid: process.pid, paths: [], missing: [] };
  const closed = { ...started, phase: 'closed', paths, ...overrides };
  await writeFile(join(observations, randomUUID() + '.jsonl'), JSON.stringify(started) + '\n' + JSON.stringify(closed) + '\n');
}
const modulePath = (path: string) => ({ scope: 'module', product: 'default', target: 'default', modulePath: join(root, 'entry'), path });

it('rejects noncanonical paths before inspecting ancestors hidden by dot segments', async () => {
  await record([modulePath(root + '/unresolved/../build/outputs')]);
  expect(await collectBuildOutputLayout(observations, root)).toMatchObject({ invalid: true, paths: [] });
});

it('rejects sibling-prefix escapes and sensitive output paths', async () => {
  await record([modulePath(root + '-sibling/build'), modulePath(join(root, '.ssh', 'out'))]);
  const layout = await collectBuildOutputLayout(observations, root);
  expect(layout.invalid).toBe(true); expect(layout.paths).toEqual([]);
});

it('rejects symlinked output directories without reading their contents', async () => {
  const privatePath = join(root, '.ssh'); await mkdir(privatePath);
  await writeFile(join(privatePath, 'secret.hap'), 'PRIVATE_OUTPUT_FIXTURE');
  await symlink(privatePath, join(root, 'linked'));
  await record([modulePath(join(root, 'linked'))]);
  const layout = await collectBuildOutputLayout(observations, root);
  expect(layout).toMatchObject({ invalid: true, paths: [] });
  expect(JSON.stringify(layout)).not.toContain('PRIVATE_OUTPUT_FIXTURE');
});

it('requires a matching closed observation and keeps missing coverage explicit', async () => {
  await record([modulePath(join(root, 'build', 'custom'))], { pid: process.pid + 1 });
  expect(await collectBuildOutputLayout(observations, root)).toMatchObject({ invalid: true, binding: 'not-observed' });
});

it('bounds observation file counts', async () => {
  for (let index = 0; index < 65; index++) { await record([]); }
  expect(await collectBuildOutputLayout(observations, root)).toMatchObject({
    invalid: true, paths: [], missing: expect.arrayContaining(['build-output-file-budget']),
  });
});

it('bounds aggregate paths across independently closed observations', async () => {
  const path = modulePath(join(root, 'build/custom'));
  await record(Array.from({ length: 128 }, () => path)); await record([path]);
  const result = await collectBuildOutputLayout(observations, root);
  expect(result).toMatchObject({ invalid: true, missing: expect.arrayContaining(['build-output-observation-unreadable']) });
});

it('deduplicates valid observed paths while retaining an incomplete binding', async () => {
  const path = modulePath(join(root, 'build', 'custom'));
  await record([path]); await record([path]);
  expect(await collectBuildOutputLayout(observations, root)).toMatchObject({
    binding: 'observed-partial', invalid: false,
    paths: [{ ...path, modulePath: 'entry', path: 'build/custom' }], missing: ['full-final-output-layout'],
  });
});

async function target() {
  await mkdir(join(root, 'entry'));
  await writeFile(join(root, 'build-profile.json5'), '{"app":{"products":[{"name":"default"}]},"modules":[{"name":"entry","srcPath":"entry"}]}');
  return { project: Project.discover(root), product: 'default', modules: ['entry@default'], isProduct: false,
    model: { root, modules: [{ name: 'entry', path: join(root, 'entry'), type: 'entry' }] } };
}
async function output(path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
}
const layout = (path: string): BuildOutputLayout => ({ binding: 'observed-partial', invalid: false, missing: ['full-final-output-layout'],
  paths: [{ scope: 'module', product: 'default', target: 'default', modulePath: 'entry', path }] });

it('preserves current evidence and reports missing output when an artifact becomes a symlink', async () => {
  const selected = await target(), paths = layout('build/custom');
  const before = await snapshotBuildArtifacts(selected, paths);
  await output('build/safe-source', 'PRIVATE_OUTPUT_FIXTURE');
  await mkdir(join(root, 'build/custom'), { recursive: true });
  await symlink(join(root, 'build/safe-source'), join(root, 'build/custom/file.hap'));
  const result = await collectBuildEvidence(selected, before, paths);
  expect(result).toMatchObject({ complete: false, artifacts: [], missing: expect.arrayContaining(['entry@default', 'build-output-unreadable:entry@default']) });
  expect(await readFile(join(root, 'build/safe-source'), 'utf8')).toBe('PRIVATE_OUTPUT_FIXTURE');
});

it('never assigns one observed directory to two facets from a shared extension alone', async () => {
  const selected = await target(); selected.modules.push('entry@other');
  const paths = layout('build/custom'); paths.paths.push({ ...paths.paths[0], scope: 'module', modulePath: 'entry', target: 'other' });
  const before = await snapshotBuildArtifacts(selected, paths);
  await output('build/custom/file.hap', 'ambiguous artifact');
  const result = await collectBuildEvidence(selected, before, paths);
  expect(result).toMatchObject({ complete: false, missing: ['entry@default', 'entry@other'],
    artifactEvidence: [expect.objectContaining({ sha256: digest('ambiguous artifact') })] });
});

it('collects the direct product APP without traversing official symbol directory links', async () => {
  const selected = { ...await target(), isProduct: true }, paths = layout('build/module');
  paths.paths.push({ scope: 'product', product: 'default', path: 'build/product' });
  const before = await snapshotBuildArtifacts(selected, paths);
  await output('build/module/entry.hap', 'fresh module');
  await output('build/product/product.app', 'fresh product');
  await output('build/module/symbol/release/metadata.json', 'symbol metadata');
  await mkdir(join(root, 'build/product/symbol/release'), { recursive: true });
  await symlink(join(root, 'build/module/symbol/release'), join(root, 'build/product/symbol/release/entry'));
  const result = await collectBuildEvidence(selected, before, paths);
  expect(result).toMatchObject({ complete: true, missing: [] });
  expect(result.artifacts).toEqual(expect.arrayContaining([
    { path: join(root, 'build/product/product.app'), kind: 'app', sha256: digest('fresh product') },
  ]));
  expect(result.artifacts).toHaveLength(2);
});

it('does not attribute an APP in an unobserved child directory to the product output root', async () => {
  const selected = { ...await target(), isProduct: true }, paths = layout('build/module');
  paths.paths.push({ scope: 'product', product: 'default', path: 'build/product' });
  const before = await snapshotBuildArtifacts(selected, paths);
  await output('build/module/entry.hap', 'fresh module');
  await output('build/product/unobserved/other.app', 'foreign product');
  const result = await collectBuildEvidence(selected, before, paths);
  expect(result).toMatchObject({ complete: false, missing: ['product-app'] });
  expect(result.artifacts.map(item => item.kind)).toEqual(['hap']);
});

it.each(['file-link', 'directory-link', 'hardlink'])('refuses a direct product %s without using it as fresh APP evidence', async (kind) => {
  const selected = { ...await target(), isProduct: true }, paths = layout('build/module');
  paths.paths.push({ scope: 'product', product: 'default', path: 'build/product' });
  const before = await snapshotBuildArtifacts(selected, paths);
  await output('build/module/entry.hap', 'fresh module');
  await output('build/source/product.app', 'linked product');
  await mkdir(join(root, 'build/product'), { recursive: true });
  if (kind === 'directory-link') { await symlink(join(root, 'build/source'), join(root, 'build/product/link')); }
  else if (kind === 'hardlink') { await link(join(root, 'build/source/product.app'), join(root, 'build/product/product.app')); }
  else { await symlink(join(root, 'build/source/product.app'), join(root, 'build/product/product.app')); }
  const result = await collectBuildEvidence(selected, before, paths);
  expect(result).toMatchObject({ complete: false, missing: expect.arrayContaining(['product-app', 'build-output-unreadable:product-app']) });
  expect(result.artifacts.map(item => item.kind)).toEqual(['hap']);
  expect(await readFile(join(root, 'build/source/product.app'), 'utf8')).toBe('linked product');
});
