/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { dirname, posix } from 'node:path';
import { loadSemver } from '../utils/semver.js';
import { sha256 } from '../agent/context-files.js';
import { evidence, finding, record, string } from './types.js';
import type { DependencyComponent, DependencyGraph, PackageManifest, Scope, SourceFile } from './types.js';

export function componentId(ecosystem: string, path: string, locator = '') { return `${ecosystem}:${sha256(`${path}\0${locator}`).slice(0, 32)}`; }
const scopes: [string, Scope][] = [['dependencies', 'production'], ['devDependencies', 'development'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer'], ['dynamicDependencies', 'dynamic']];
export function declarations(value: Record<string, unknown>) {
  return scopes.flatMap(([field, scope]) => Object.entries(record(value[field])).map(([name, spec]) => ({ name, spec: string(spec), scope })));
}
function lockFor(file: SourceFile, ecosystem: 'ohpm' | 'npm', files: SourceFile[]) {
  const dir = dirname(file.path) === '.' ? '' : dirname(file.path);
  if (ecosystem === 'ohpm') {
    const root = files.find((item) => item.path === 'oh-package-lock.json5');
    if (record(root?.value?.meta).enableUnifiedLockfile === true) { return root; }
    return files.find((item) => item.path === posix.join(dir, 'oh-package-lock.json5'));
  }
  let directory = dir;
  while (true) {
    const lock = files.find((item) => item.path === posix.join(directory, 'npm-shrinkwrap.json')) ??
      files.find((item) => item.path === posix.join(directory, 'package-lock.json'));
    if (lock) { return lock; }
    if (!directory || directory === '.') { return undefined; }
    directory = dirname(directory);
  }
}
export function manifests(files: SourceFile[], graph: DependencyGraph): PackageManifest[] {
  return files.filter((file) => /(?:^|\/)(?:oh-package\.json5|package\.json)$/.test(file.path)).map((file) => {
    const ecosystem = file.path.endsWith('oh-package.json5') ? 'ohpm' : 'npm', value = file.value!;
    const node: DependencyComponent = { id: componentId(ecosystem, file.path), ecosystem, kind: 'module', origin: 'manifest',
      name: string(value.name) ?? dirname(file.path), version: string(value.version) ?? null, path: file.path, evidence: [evidence(file)], license: string(value.license) };
    graph.components.push(node);
    if (ecosystem === 'npm' && Object.keys(record(value.scripts)).some((name) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(name))) {
      finding(graph, file, 'INSTALL_SCRIPT', 'Manifest contains installation lifecycle scripts; execution has not been assessed');
    }
    return { file, ecosystem, node, value, directory: dirname(file.path), lock: lockFor(file, ecosystem, files) };
  });
}
export function addRelationship(graph: DependencyGraph, from: string, to: string, scope: Scope, file: SourceFile, declared?: string) {
  graph.relationships.push({ from, to, scope, kind: 'depends-on', evidence: [evidence(file)], ...(declared ? { declared } : {}) });
}
export function unresolved(graph: DependencyGraph, owner: PackageManifest, name: string, spec: string | undefined, code: string) {
  const node: DependencyComponent = { id: componentId(owner.ecosystem, owner.file.path, `${name}@${spec}`), name, version: null,
    ecosystem: owner.ecosystem, kind: 'package', origin: 'declaration', path: owner.file.path, evidence: [evidence(owner.file)] };
  if (!graph.components.some((item) => item.id === node.id)) { graph.components.push(node); }
  finding(graph, owner.file, code, 'Declared dependency cannot be reproduced from the available evidence', true, 'info');
  return node;
}
export function localModule(owner: PackageManifest, name: string, spec: string, all: PackageManifest[], graph: DependencyGraph) {
  if (!spec.startsWith('file:') && !spec.startsWith('workspace:')) { return undefined; }
  const directory = posix.normalize(posix.join(owner.directory, spec.slice(5)));
  if (spec.startsWith('file:') && (directory === '..' || directory.startsWith('../') || spec.slice(5).startsWith('/') || spec.includes('\\'))) {
    return unresolved(graph, owner, name, spec, 'LOCAL_DEPENDENCY_OUTSIDE_SCOPE');
  }
  const module = all.find((item) => item.ecosystem === owner.ecosystem && (spec.startsWith('workspace:') ? item.node.name === name : item.directory === directory));
  return module?.node ?? unresolved(graph, owner, name, spec, 'LOCAL_DEPENDENCY_UNRESOLVED');
}
export async function drift(graph: DependencyGraph, file: SourceFile, name: string, declared: string, version: string | null, lockedSpec?: string): Promise<void> {
  const semver = version === null ? undefined : await loadSemver();
  if ((lockedSpec !== undefined && lockedSpec !== declared) ||
    (version !== null && semver !== undefined && semver.valid(version) && semver.validRange(declared) &&
      !semver.satisfies(version, declared))) {
    finding(graph, file, 'LOCK_MANIFEST_DRIFT', `Manifest and lock disagree for ${name}`);
  }
}
export function bindLocalVersion(graph: DependencyGraph, node: DependencyComponent, file: SourceFile, version: string | null) {
  if (!version) { return; }
  const declared = node.declaredVersion === undefined ? node.version : node.declaredVersion;
  node.declaredVersion = declared;
  if (node.versionSource === 'lock' && node.version !== version) {
    finding(graph, file, 'LOCAL_LOCK_VERSION_CONFLICT', `Different lock contexts disagree for local module ${node.name}`, true, 'info'); return;
  }
  if (declared && declared !== version) { finding(graph, file, 'LOCK_MANIFEST_DRIFT', `Locked local version and source manifest disagree for ${node.name}`); }
  node.version = version; node.versionSource = 'lock';
  if (!node.evidence.some((item) => item.path === file.path)) { node.evidence.push(evidence(file)); }
}
export function lockedComponent(ecosystem: 'ohpm' | 'npm', file: SourceFile, locator: string, data: Record<string, unknown>, name: string): DependencyComponent {
  return { id: componentId(ecosystem, file.path, locator), name, version: string(data.version) ?? null, ecosystem, kind: 'package', origin: 'lock',
    path: file.path, locator, license: string(data.license), integrity: string(data.integrity), evidence: [evidence(file)] };
}
