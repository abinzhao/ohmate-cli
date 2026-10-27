/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { posix } from 'node:path';
import { finding, record, string } from './types.js';
import { addRelationship, bindLocalVersion, declarations, drift, localModule, lockedComponent, unresolved } from './package-graph.js';
import type { DependencyComponent, DependencyGraph, PackageManifest, SourceFile } from './types.js';
import type { DependencyResolution } from './ohpm-lock.js';

interface NpmLock { file: SourceFile; nodes: Map<string, DependencyComponent> }
function nameAt(locator: string) { return locator.split('node_modules/').at(-1)!; }
function workspaceNode(file: SourceFile, locator: string, all: PackageManifest[]) {
  return all.find((owner) => owner.ecosystem === 'npm' && owner.directory === posix.join(posix.dirname(file.path), locator))?.node;
}
function readLock(file: SourceFile, all: PackageManifest[], graph: DependencyGraph): NpmLock {
  const nodes = new Map<string, DependencyComponent>(), packages = record(file.value?.packages);
  if (![2, 3].includes(Number(file.value?.lockfileVersion)) || !file.value?.packages) {
    finding(graph, file, 'LOCK_VERSION_UNSUPPORTED', 'npm supports v2/v3 packages locks; this format has not been interpreted', true, 'info');
    return { file, nodes };
  }
  for (const [locator, value] of Object.entries(packages)) {
    const data = record(value);
    if (data.link === true) { continue; }
    const workspace = workspaceNode(file, locator, all);
    if (workspace) { bindLocalVersion(graph, workspace, file, string(data.version) ?? null); nodes.set(locator, workspace); continue; }
    if (!/(?:^|\/)node_modules\//.test(locator) || posix.normalize(locator) !== locator || locator.includes('\\')) {
      finding(graph, file, 'LOCK_PACKAGE_UNRESOLVED', 'Nonstandard npm package locator is unavailable', true, 'info'); continue;
    }
    const node = lockedComponent('npm', file, locator, data, string(data.name) ?? nameAt(locator));
    nodes.set(locator, node); graph.components.push(node);
    if (!node.version) { finding(graph, file, 'LOCK_VERSION_MISSING', 'Locked package version is unavailable', true, 'info'); }
    if (data.hasInstallScript === true) { finding(graph, file, 'INSTALL_SCRIPT', `Locked package ${node.name} has an install script`); }
  }
  for (const [locator, value] of Object.entries(packages)) {
    const data = record(value);
    if (data.link !== true) { continue; }
    const target = string(data.resolved), node = target ? nodes.get(target) : undefined;
    if (node) { nodes.set(locator, node); }
    else { finding(graph, file, 'LOCK_LINK_UNRESOLVED', 'Workspace link target is unavailable', true, 'info'); }
  }
  return { file, nodes };
}
function resolveNpm(lock: NpmLock, locator: string, name: string) {
  let directory = locator;
  while (true) {
    if (posix.basename(directory) !== 'node_modules') {
      const found = lock.nodes.get(posix.join(directory, 'node_modules', name));
      if (found) { return found; }
    }
    if (!directory || directory === '.') { return undefined; }
    directory = posix.dirname(directory);
  }
}
function addTransitives(lock: NpmLock, graph: DependencyGraph) {
  for (const [locator, value] of Object.entries(record(lock.file.value?.packages))) {
    const node = lock.nodes.get(locator);
    if (!node || node.origin === 'manifest' || record(value).link === true) { continue; }
    for (const dep of declarations(record(value))) {
      const target = resolveNpm(lock, locator, dep.name);
      if (target) { addRelationship(graph, node.id, target.id, dep.scope, lock.file, dep.spec); }
      else if (dep.scope !== 'peer' && dep.scope !== 'optional') {
        finding(graph, lock.file, 'LOCK_TRANSITIVE_UNRESOLVED', `Transitive dependency cannot be resolved for ${node.name}`, true, 'info');
      }
    }
  }
}
async function select(owner: PackageManifest, name: string, spec: string | undefined, lock: NpmLock | undefined, all: PackageManifest[], graph: DependencyGraph) {
  const locator = lock ? posix.relative(posix.dirname(lock.file.path), owner.directory) : '';
  if (lock && !Object.hasOwn(record(lock.file.value?.packages), locator)) {
    return unresolved(graph, owner, name, spec, 'NPM_WORKSPACE_NOT_LOCKED');
  }
  const locked = lock ? resolveNpm(lock, locator, name) : undefined;
  if (locked && spec) {
    const entry = record(record(lock!.file.value?.packages)[locator]);
    const declared = Object.fromEntries(declarations(entry).map((item) => [item.name, item.spec]))[name];
    await drift(graph, owner.file, name, spec, locked.version, declared);
    return locked;
  }
  const local = spec ? localModule(owner, name, spec, all, graph) : undefined;
  return local ?? unresolved(graph, owner, name, spec, owner.lock ? 'LOCK_DEPENDENCY_UNRESOLVED' : 'LOCK_MISSING');
}
export async function addNpm(all: PackageManifest[], graph: DependencyGraph, resolutions: DependencyResolution) {
  const locks = new Map<SourceFile, NpmLock>();
  for (const owner of all.filter((item) => item.ecosystem === 'npm')) {
    if (owner.lock && !locks.has(owner.lock)) {
      const lock = readLock(owner.lock, all, graph); locks.set(owner.lock, lock); addTransitives(lock, graph);
    }
    const resolved = new Map<string, DependencyComponent>();
    for (const dep of declarations(owner.value)) {
      const target = await select(owner, dep.name, dep.spec, owner.lock ? locks.get(owner.lock) : undefined, all, graph);
      resolved.set(dep.name, target); addRelationship(graph, owner.node.id, target.id, dep.scope, owner.file, dep.spec);
    }
    resolutions.set(owner.node.id, resolved);
  }
}
