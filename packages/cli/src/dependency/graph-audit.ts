/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { DependencyGraph, Relationship } from './types.js';

function duplicates(graph: DependencyGraph) {
  const groups = new Map<string, typeof graph.components>();
  for (const node of graph.components.filter((item) => item.origin === 'lock' && item.version)) {
    const key = `${node.ecosystem}:${node.name}`;
    groups.set(key, [...groups.get(key) ?? [], node]);
  }
  for (const [key, nodes] of groups) {
    if (new Set(nodes.map((node) => node.version)).size < 2) { continue; }
    graph.findings.push({ code: 'DUPLICATE_VERSIONS', severity: 'warning', confidence: 'observed',
      message: `Multiple locked versions exist for ${key}`, components: nodes.map((node) => node.id), evidence: nodes.flatMap((node) => node.evidence) });
  }
}
function binaryConflicts(graph: DependencyGraph) {
  const groups = new Map<string, typeof graph.components>();
  for (const node of graph.components.filter((item) => item.origin === 'binary')) {
    groups.set(node.name, [...groups.get(node.name) ?? [], node]);
  }
  for (const nodes of groups.values()) {
    if (new Set(nodes.map((node) => node.evidence[0].sha256)).size < 2) { continue; }
    graph.findings.push({ code: 'NATIVE_BINARY_NAME_CONFLICT', severity: 'warning', confidence: 'inferred',
      message: 'Referenced libraries share a basename but have different raw bytes; runtime loader selection remains unverified',
      components: nodes.map((node) => node.id), evidence: nodes.flatMap((node) => node.evidence) });
  }
}
function cycleFindings(graph: DependencyGraph) {
  const outgoing = new Map<string, Relationship[]>(), visited = new Set<string>();
  for (const edge of graph.relationships.filter((item) => item.kind === 'depends-on' || item.kind === 'links')) {
    outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
  }
  for (const node of graph.components) {
    if (visited.has(node.id)) { continue; }
    const active = new Set<string>(), stack = [{ id: node.id, index: 0, via: null as Relationship | null }];
    while (stack.length) {
      const current = stack.at(-1)!;
      active.add(current.id); visited.add(current.id);
      const next = outgoing.get(current.id)?.[current.index++];
      if (!next) { active.delete(current.id); stack.pop(); continue; }
      if (active.has(next.to)) {
        const start = stack.findIndex((item) => item.id === next.to);
        const edges = [...stack.slice(start + 1).map((item) => item.via!), next];
        graph.findings.push({ code: 'DEPENDENCY_CYCLE', severity: 'warning', confidence: 'observed', message: 'Recorded dependency relationships contain a cycle',
          components: stack.slice(start).map((item) => item.id), evidence: edges.flatMap((edge) => edge.evidence) });
      } else if (!visited.has(next.to)) { stack.push({ id: next.to, index: 0, via: next }); }
    }
  }
}
export function auditGraph(graph: DependencyGraph) {
  duplicates(graph); binaryConflicts(graph); cycleFindings(graph);
  for (const node of graph.components.filter((item) => item.origin === 'lock')) {
    if (!node.integrity) { graph.findings.push({ code: 'INTEGRITY_UNAVAILABLE', severity: 'info', confidence: 'observed',
      message: 'Lock metadata does not provide package integrity; package archives were not read', evidence: node.evidence, components: [node.id] }); }
    if (!node.license) { graph.findings.push({ code: 'LICENSE_UNAVAILABLE', severity: 'info', confidence: 'observed',
      message: 'License metadata is absent; actual LICENSE files were not read', evidence: node.evidence, components: [node.id] }); }
  }
  graph.completeness = graph.findings.some((item) => item.incomplete) ? 'incomplete' : 'complete';
}
export function dependencyChains(graph: DependencyGraph, ids: string[]) {
  const chains: Relationship[][] = [], pending = ids.slice(0, 2_000).map((id) => ({ id, edges: [] as Relationship[], seen: new Set([id]) }));
  // Count all admitted states, including starting matches, before allocating paths.
  let truncated = ids.length > 2_000, admitted = pending.length;
  while (pending.length) {
    if (chains.length >= 100) { truncated = true; break; }
    const current = pending.shift()!;
    let hasInbound = false;
    for (const edge of graph.relationships) {
      if (edge.to !== current.id) { continue; }
      hasInbound = true;
      if (chains.length >= 100) { truncated = true; break; }
      if (current.edges.length >= 32) { chains.push(current.edges); truncated = true; break; }
      if (admitted >= 2_000) { truncated = true; break; }
      const from = edge.from, edges = [edge, ...current.edges];
      if (current.seen.has(from)) { chains.push(edges); truncated = true; continue; }
      pending.push({ id: from, edges, seen: new Set([...current.seen, from]) });
      admitted++;
    }
    if (!hasInbound) { chains.push(current.edges); }
  }
  return { chains, truncated };
}
