/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { dependencyChains } from './graph-audit.js';
import type { DependencyGraph, Relationship } from './types.js';

function graph(relationships: Relationship[] = []): DependencyGraph {
  return { schemaVersion: '1.0', analyzerVersion: '1.0', root: '/synthetic-graph', completeness: 'complete',
    components: [], relationships, findings: [], inputs: [],
    usage: { unused: 'not-evaluated', basis: [] },
    checks: { vulnerabilities: 'not-run', licenseValidation: 'not-run', nativeAbi: 'not-run', installedPackages: 'not-read' } };
}
function edge(from: string, to: string, kind: Relationship['kind'] = 'depends-on'): Relationship {
  return { from, to, kind, scope: 'production', evidence: [{ path: `${from}.json`, sha256: 'a'.repeat(64), line: 1 }] };
}
function path(length: number) {
  return Array.from({ length }, (_, index) => edge(`node-${index}`, `node-${index + 1}`));
}

it('preserves all recorded relationship kinds, evidence and distinct upstream paths', () => {
  const ohpm = edge('ohpm-root', 'npm', 'imports'), cloud = edge('cloud-root', 'npm');
  const bridge = edge('npm', 'target', 'native-bridge'), link = edge('target', 'binary', 'links');
  const input = graph([ohpm, cloud, bridge, link]), before = JSON.stringify(input);
  expect(dependencyChains(input, ['binary'])).toEqual({ chains: [[ohpm, bridge, link], [cloud, bridge, link]], truncated: false });
  expect(JSON.stringify(input)).toBe(before);
});

it('retains both paths through a diamond without treating shared ancestry as a cycle', () => {
  const a = edge('root', 'a'), b = edge('root', 'b'), ac = edge('a', 'c'), bc = edge('b', 'c');
  expect(dependencyChains(graph([a, b, ac, bc]), ['c'])).toEqual({ chains: [[a, ac], [b, bc]], truncated: false });
});

it.each([0, 100])('does not report truncation for exactly %i complete root chains', (count) => {
  expect(dependencyChains(graph(), Array.from({ length: count }, (_, index) => `root-${index}`)))
    .toEqual({ chains: Array.from({ length: count }, () => []), truncated: false });
});

it('reports truncation when one more root remains beyond the result budget', () => {
  const result = dependencyChains(graph(), Array.from({ length: 101 }, (_, index) => `root-${index}`));
  expect(result.chains).toHaveLength(100);
  expect(result.truncated).toBe(true);
});

it('caps cyclic results inside one inbound fanout without fabricating upstream roots', () => {
  const relationships = Array.from({ length: 2_100 }, () => edge('cycle', 'cycle'));
  const result = dependencyChains(graph(relationships), ['cycle']);
  expect(result.chains).toHaveLength(100);
  expect(result.truncated).toBe(true);
  expect(result.chains.every((chain) => chain.length === 1 && chain[0].from === chain[0].to)).toBe(true);
});

it('bounds fanout expansion before allocating every predecessor state', () => {
  let observedPredecessors = 0;
  // Endpoint access observes actual predecessor expansion without heap/timing guesses.
  const relationships = Array.from({ length: 10_000 }, (_, index): Relationship => ({
    get from() { observedPredecessors++; return `root-${index}`; }, to: 'target',
    kind: 'depends-on', scope: 'production', evidence: [],
  }));
  const result = dependencyChains(graph(relationships), ['target']);
  expect(observedPredecessors).toBeLessThanOrEqual(2_000);
  expect(result.chains).toHaveLength(100);
  expect(result.chains[0][0].to).toBe('target');
  expect(result.truncated).toBe(true);
});

it('bounds initial matches before materializing every starting state', () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => `root-${index}`);
  let beyondBudget = false;
  Object.defineProperty(ids, 2_000, { get() { beyondBudget = true; return 'root-2000'; } });
  const result = dependencyChains(graph(), ids);
  expect(beyondBudget).toBe(false);
  expect(result.chains).toHaveLength(100);
  expect(result.truncated).toBe(true);
});

it('shares the expansion budget across multiple branching levels', () => {
  let observedPredecessors = 0;
  const observedEdge = (from: string, to: string): Relationship => ({
    get from() { observedPredecessors++; return from; }, to, kind: 'depends-on', scope: 'production', evidence: [],
  });
  const branches = Array.from({ length: 300 }, (_, index) => observedEdge(`branch-${index}`, 'target'));
  const roots = branches.flatMap((_, index) => Array.from({ length: 10 }, (_, parent) =>
    observedEdge(`root-${index}-${parent}`, `branch-${index}`)));
  const result = dependencyChains(graph([...branches, ...roots]), ['target']);
  expect(observedPredecessors).toBeLessThanOrEqual(2_000);
  expect(result.chains).toHaveLength(100);
  expect(result.chains.every((chain) => chain.length === 2 && chain[0].to === chain[1].from)).toBe(true);
  expect(result.truncated).toBe(true);
});

it('returns an exact 32-edge path completely when its upstream endpoint is a root', () => {
  const relationships = path(32);
  expect(dependencyChains(graph(relationships), ['node-32'])).toEqual({ chains: [relationships], truncated: false });
});

it('caps a deeper path at 32 observed contiguous edges and marks it truncated', () => {
  const relationships = path(33), result = dependencyChains(graph(relationships), ['node-33']);
  expect(result.chains).toEqual([relationships.slice(1)]);
  expect(result.truncated).toBe(true);
});

it('ends a cycle with recorded evidence while preserving a separate root path', () => {
  const a = edge('a', 'b'), b = edge('b', 'a'), root = edge('root', 'b', 'imports');
  expect(dependencyChains(graph([a, b, root]), ['b'])).toEqual({ chains: [[b, a], [root]], truncated: true });
});

it('marks the depth budget without recursing through an unbounded path', () => {
  const relationships = path(2_100), result = dependencyChains(graph(relationships), ['node-2100']);
  expect(result.chains).toEqual([relationships.slice(-32)]);
  expect(result.truncated).toBe(true);
});
