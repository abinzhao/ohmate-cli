/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { evidence, finding, record, string } from './types.js';
import { addRelationship, bindLocalVersion, declarations, drift, localModule, lockedComponent, unresolved } from './package-graph.js';
import type { DependencyComponent, DependencyGraph, PackageManifest, SourceFile } from './types.js';

export type DependencyResolution = Map<string, Map<string, DependencyComponent>>;
function packageName(key: string) { return key.slice(0, key.indexOf('@', key.startsWith('@') ? 1 : 0)); }
function supported(file: SourceFile, graph: DependencyGraph) {
  if (file.value?.lockfileVersion === 3 && file.value.packages && file.value.specifiers) { return true; }
  finding(graph, file, 'LOCK_VERSION_UNSUPPORTED', 'OHPM supports only the observed v3 specifiers/packages lock contract', true, 'info');
  return false;
}
function lookup(lock: SourceFile, nodes: Map<string, DependencyComponent>, name: string, spec: string) {
  const key = string(record(lock.value?.specifiers)[`${name}@${spec}`]);
  const direct = key ? nodes.get(key) : nodes.get(`${name}@${spec}`);
  if (direct) { return direct; }
  const candidates = [...nodes.values()].filter((node) => node.name === name);
  return candidates.length === 1 ? candidates[0] : undefined;
}
function readLock(file: SourceFile, graph: DependencyGraph) {
  const nodes = new Map<string, DependencyComponent>();
  for (const [key, value] of Object.entries(record(file.value?.packages))) {
    const data = record(value), name = string(data.name) ?? packageName(key);
    if (!name) { finding(graph, file, 'LOCK_PACKAGE_INVALID', 'Package identity is missing', true, 'info'); continue; }
    const node = lockedComponent('ohpm', file, key, data, name);
    nodes.set(key, node); graph.components.push(node);
  }
  for (const [key, node] of nodes) {
    for (const dep of declarations(record(record(file.value?.packages)[key]))) {
      const target = dep.spec ? lookup(file, nodes, dep.name, dep.spec) : undefined;
      if (target) { addRelationship(graph, node.id, target.id, dep.scope, file, dep.spec); }
      else { finding(graph, file, 'LOCK_TRANSITIVE_UNRESOLVED', `Transitive dependency cannot be resolved for ${node.name}`, true, 'info'); }
    }
  }
  return nodes;
}
async function selectDependency(owner: PackageManifest, name: string, spec: string | undefined, all: PackageManifest[],
  graph: DependencyGraph, nodes: Map<string, DependencyComponent> | undefined) {
  if (spec) {
    const local = localModule(owner, name, spec, all, graph);
    if (local) {
      const locked = owner.lock && nodes ? lookup(owner.lock, nodes, name, spec.replace(/^file:/, '')) : undefined;
      if (local.kind === 'module' && locked) { bindLocalVersion(graph, local, owner.lock!, locked.version); }
      return local;
    }
    const found = owner.lock && nodes ? lookup(owner.lock, nodes, name, spec) : undefined;
    if (found) {
      if (!Object.hasOwn(record(owner.lock!.value?.specifiers), `${name}@${spec}`)) {
        finding(graph, owner.file, 'LOCK_MANIFEST_DRIFT', `OHPM lock has no mapping for the declared specifier of ${name}`);
      }
      await drift(graph, owner.file, name, spec, found.version); return found;
    }
  }
  return unresolved(graph, owner, name, spec, owner.lock ? 'LOCK_DEPENDENCY_UNRESOLVED' : 'LOCK_MISSING');
}
export async function addOhpm(all: PackageManifest[], graph: DependencyGraph, resolutions: DependencyResolution) {
  const locks = new Map<SourceFile, Map<string, DependencyComponent>>();
  for (const owner of all.filter((item) => item.ecosystem === 'ohpm')) {
    if (owner.lock && !locks.has(owner.lock)) { locks.set(owner.lock, supported(owner.lock, graph) ? readLock(owner.lock, graph) : new Map()); }
    const resolved = new Map<string, DependencyComponent>();
    for (const dep of declarations(owner.value)) {
      const target = await selectDependency(owner, dep.name, dep.spec, all, graph, owner.lock ? locks.get(owner.lock) : undefined);
      resolved.set(dep.name, target); addRelationship(graph, owner.node.id, target.id, dep.scope, owner.file, dep.spec);
    }
    resolutions.set(owner.node.id, resolved);
  }
  for (const node of graph.components.filter((item) => item.ecosystem === 'ohpm' && item.origin === 'lock' && !item.version)) {
    graph.findings.push({ code: 'LOCK_VERSION_MISSING', severity: 'info', confidence: 'observed', incomplete: true,
      message: 'Locked package version is unavailable', evidence: node.evidence.length ? node.evidence : [evidence(all[0].file)] });
  }
}
