/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Project } from '../utils/project.js';
import { evidenceFile, privateEvidenceName, type FileEvidence } from './evidence.js';
import { emptyBuildOutputLayout, safeBuildOutputPath, type BuildOutputLayout } from './build-output-layout.js';

interface ArtifactTarget {
  project: Project; product: string; modules: string[]; isProduct: boolean;
  assembleType?: string;
  model: { root: string; modules: { name: string; path: string; type: string }[] };
}
interface OutputDirectory { path: string; spec: string; kind: string; scope: 'module' | 'product'; }
interface ArtifactSnapshot { files: Map<string, FileEvidence>; directories: Set<string>; missing: string[]; entries: number; }
function outputDirectories(target: ArtifactTarget, layout: BuildOutputLayout): OutputDirectory[] {
  const specs = target.isProduct ? target.modules : [...new Set([...target.modules, ...target.model.modules.map((item) => `${item.name}@default`)])];
  const directories: OutputDirectory[] = specs.flatMap((spec) => {
    const [name, selected = 'default'] = spec.split('@'), module = target.model.modules.find((item) => item.name === name)!;
    const kind = !target.isProduct && target.assembleType ? target.assembleType.slice('assemble'.length).toLowerCase()
      : module.type === 'har' ? 'har' : module.type === 'shared' ? 'hsp' : 'hap';
    const modulePath = relative(target.model.root, module.path).split(sep).join('/');
    const observed = layout.paths.filter((item) => item.scope === 'module' && item.modulePath === modulePath &&
      item.target === selected && item.product === target.product);
    const paths = observed.length ? observed.map((item) => resolve(target.model.root, item.path))
      : [join(module.path, 'build', target.product, 'outputs', selected)];
    return paths.map((path) => ({ spec, path, kind, scope: 'module' as const }));
  });
  if (target.isProduct) {
    const observed = layout.paths.filter((item) => item.scope === 'product' && item.product === target.product);
    const paths = observed.length ? observed.map((item) => resolve(target.model.root, item.path))
      : [join(target.model.root, 'build', 'outputs', target.product)];
    directories.push(...paths.map((path) => ({ path, spec: 'product-app', kind: 'app', scope: 'product' as const })));
  }
  return directories;
}
async function scanArtifacts(root: string, directory: OutputDirectory, snapshot: ArtifactSnapshot) {
  await safeBuildOutputPath(root, directory.path);
  let entries;
  try { entries = await readdir(directory.path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
  for (const entry of entries) {
    if (++snapshot.entries > 10000) { throw new Error('Build output entry budget'); }
    if (privateEvidenceName.test(entry.name) || /^(?:local\.properties|\.ohpmrc)$/i.test(entry.name)) { continue; }
    const file = join(directory.path, entry.name);
    if (entry.isSymbolicLink()) { throw new Error('Symlink build output'); }
    // Official product symbol subtrees contain links; only direct artifacts belong to this observed output path.
    if (!entry.isDirectory() && (directory.scope === 'product' ? ['.app'] : ['.hap', '.hsp', '.har']).includes(extname(file))) {
      snapshot.files.set(file, await evidenceFile(root, file));
    }
  }
}
export async function snapshotBuildArtifacts(target: ArtifactTarget, layout = emptyBuildOutputLayout()): Promise<ArtifactSnapshot> {
  const snapshot: ArtifactSnapshot = { files: new Map(), directories: new Set(), missing: [], entries: 0 };
  for (const directory of outputDirectories(target, layout)) {
    try {
      await safeBuildOutputPath(target.model.root, directory.path);
      snapshot.directories.add(directory.path);
      await scanArtifacts(target.model.root, directory, snapshot);
    } catch { snapshot.missing.push(`build-output-unreadable:${directory.spec}`); }
  }
  return snapshot;
}
export async function collectBuildEvidence(target: ArtifactTarget, before: ArtifactSnapshot, layout = emptyBuildOutputLayout()) {
  const after = await snapshotBuildArtifacts(target, layout), targets = outputDirectories(target, layout);
  const artifactEvidence: { path: string; sha256: string; kind: string; status: string; previous: FileEvidence | null; current: FileEvidence }[] = [];
  for (const [path, current] of after.files) {
    const previous = before.files.get(path);
    const fresh = !previous || current.sha256 !== previous.sha256 || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs;
    const known = targets.some((item) => before.directories.has(item.path) && dirname(path) === item.path);
    artifactEvidence.push({ path, sha256: current.sha256, kind: extname(path).slice(1),
      status: !known ? 'baseline-unavailable' : fresh ? 'fresh' : 'reused-unverified', previous: previous ?? null, current });
  }
  const requested = targets.filter((item) => item.scope === 'product' || target.modules.includes(item.spec));
  const missing = requested.filter((target) => targets.filter((item) => item.spec === target.spec).length !== 1 ||
    targets.some((item) => item.path === target.path && item.spec !== target.spec) ||
    !artifactEvidence.some((item) => item.kind === target.kind && item.status === 'fresh' && dirname(item.path) === target.path)).map((item) => item.spec);
  missing.push(...before.missing, ...after.missing);
  return { artifacts: artifactEvidence.map(({ path, sha256, kind }) => ({ path, sha256, kind })),
    artifactEvidence, missing: [...new Set(missing)], complete: !missing.length && !layout.invalid };
}
