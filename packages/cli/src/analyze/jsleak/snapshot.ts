/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { SNAPSHOT_LIMITS, type SnapshotGraph, type SnapshotGroup, type SnapshotPath, type SnapshotSummary,
  type SnapshotDelta } from './types.js';

const NODE_TYPES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native',
  'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'];
const EDGE_TYPES = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];
const NODE_FIELDS = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(): never { throw new Error('HEAPSNAPSHOT_SCHEMA_UNSUPPORTED'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { invalid(); }
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) { invalid(); }
  return value;
}
function exact(value: unknown, expected: unknown): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) { invalid(); }
}
async function checkpoint(index: number, signal: AbortSignal): Promise<void> {
  if (index % 8192 === 0) { await setImmediate(undefined, { signal }); }
  signal.throwIfAborted();
}
function metadata(value: unknown) {
  const root = object(value), snapshot = object(root.snapshot), meta = object(snapshot.meta);
  if ('version' in root || 'version' in snapshot || 'version' in meta) { invalid(); }
  exact(meta.node_fields, NODE_FIELDS);
  exact(meta.node_types, [NODE_TYPES, 'string', 'number', 'number', 'number', 'number', 'number']);
  exact(meta.edge_fields, ['type', 'name_or_index', 'to_node']);
  exact(meta.edge_types, [EDGE_TYPES, 'string_or_number', 'node']);
  const nodeCount = integer(snapshot.node_count, SNAPSHOT_LIMITS.nodes), edgeCount = integer(snapshot.edge_count, SNAPSHOT_LIMITS.edges);
  integer(snapshot.trace_function_count);
  if (nodeCount === 0 || !Array.isArray(root.nodes) || root.nodes.length !== nodeCount * 7 ||
    !Array.isArray(root.edges) || root.edges.length !== edgeCount * 3 ||
    !Array.isArray(root.strings) || root.strings.length > SNAPSHOT_LIMITS.strings) { invalid(); }
  return { nodes: root.nodes, edges: root.edges, strings: root.strings, nodeCount, edgeCount };
}
async function validateStrings(values: unknown[], signal: AbortSignal): Promise<string[]> {
  let bytes = 0;
  for (let index = 0; index < values.length; index++) {
    await checkpoint(index, signal);
    const value = values[index];
    if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) { invalid(); }
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > SNAPSHOT_LIMITS.stringBytes) { invalid(); }
  }
  return values as string[];
}
async function validateNodes(values: unknown[], strings: string[], edges: number, signal: AbortSignal) {
  const starts = new Uint32Array(values.length / 7 + 1), ids = new Set<number>();
  let selfBytes = 0;
  for (let index = 0; index < starts.length - 1; index++) {
    await checkpoint(index, signal);
    const offset = index * 7, type = integer(values[offset], NODE_TYPES.length - 1);
    integer(values[offset + 1], strings.length - 1);
    const id = integer(values[offset + 2]), size = integer(values[offset + 3]), count = integer(values[offset + 4], edges);
    integer(values[offset + 5]); integer(values[offset + 6], 2);
    if (ids.has(id) || (index === 0 && type !== 9)) { invalid(); }
    ids.add(id); selfBytes += size;
    if (!Number.isSafeInteger(selfBytes) || starts[index] + count > edges) { invalid(); }
    starts[index + 1] = starts[index] + count;
  }
  if (starts.at(-1) !== edges) { invalid(); }
  return starts;
}
async function validateEdges(values: unknown[], strings: string[], nodes: number, signal: AbortSignal): Promise<number[]> {
  for (let offset = 0; offset < values.length; offset += 3) {
    await checkpoint(offset, signal);
    const type = integer(values[offset], EDGE_TYPES.length - 1);
    integer(values[offset + 1], type === 1 || type === 4 ? Number.MAX_SAFE_INTEGER : strings.length - 1);
    const target = integer(values[offset + 2], nodes * 7 - 1);
    if (target % 7 !== 0) { invalid(); }
  }
  return values as number[];
}
export async function parseSnapshot(bytes: Buffer, signal: AbortSignal): Promise<SnapshotGraph> {
  signal.throwIfAborted();
  if (bytes.length > SNAPSHOT_LIMITS.fileBytes) { invalid(); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { invalid(); }
  const source = metadata(parsed), strings = await validateStrings(source.strings, signal);
  const edgeStarts = await validateNodes(source.nodes, strings, source.edgeCount, signal);
  const edges = await validateEdges(source.edges, strings, source.nodeCount, signal);
  return { nodes: source.nodes as number[], edges, strings, edgeStarts };
}
async function strongPaths(graph: SnapshotGraph, signal: AbortSignal) {
  const count = graph.nodes.length / 7, parents = new Int32Array(count).fill(-1);
  const parentEdges = new Int32Array(count).fill(-1), queue = new Uint32Array(count);
  parents[0] = 0; queue[0] = 0;
  let end = 1, excludedEdges = 0;
  for (let head = 0; head < end; head++) {
    await checkpoint(head, signal);
    const node = queue[head];
    for (let edge = graph.edgeStarts[node]; edge < graph.edgeStarts[node + 1]; edge++) {
      if (edge % 8192 === 0) { await checkpoint(edge, signal); }
      const type = graph.edges[edge * 3], target = graph.edges[edge * 3 + 2] / 7;
      if (type === 5 || type === 6) { continue; }
      if (parents[target] !== -1) { continue; }
      parents[target] = node; parentEdges[target] = edge; queue[end++] = target;
    }
  }
  for (let offset = 0; offset < graph.edges.length; offset += 3) {
    if (offset % 8192 === 0) { await checkpoint(offset, signal); }
    if (graph.edges[offset] === 5 || graph.edges[offset] === 6) { excludedEdges++; }
  }
  return { parents, parentEdges, reachableNodes: end, excludedEdges };
}
function pathTo(nodeIndex: number, parents: Int32Array, edges: Int32Array): SnapshotGroup['representative'] {
  const path: SnapshotPath[] = [];
  let node = nodeIndex;
  while (path.length < SNAPSHOT_LIMITS.pathNodes) {
    path.push({ nodeIndex: node, edgeIndex: node === 0 ? null : edges[node] });
    if (node === 0) { return { nodeIndex, path: path.reverse(), truncated: false }; }
    node = parents[node];
  }
  return { nodeIndex, path: path.reverse(), truncated: true };
}
async function aggregate(graph: SnapshotGraph, parents: Int32Array, edges: Int32Array, signal: AbortSignal) {
  const groups = new Map<string, SnapshotGroup>(), names = new Map<number, string>();
  let selfBytes = 0, reachableSelfBytes = 0;
  for (let index = 0; index < parents.length; index++) {
    await checkpoint(index, signal);
    const offset = index * 7, size = graph.nodes[offset + 3]; selfBytes += size;
    if (parents[index] === -1) { continue; }
    reachableSelfBytes += size;
    const type = NODE_TYPES[graph.nodes[offset]], nameIndex = graph.nodes[offset + 1];
    const nameHash = names.get(nameIndex) ?? hash(graph.strings[nameIndex]); names.set(nameIndex, nameHash);
    const key = `${type}:${nameHash}`, existing = groups.get(key);
    if (existing) { existing.count++; existing.selfBytes += size; continue; }
    if (groups.size >= SNAPSHOT_LIMITS.groups) { throw new Error('HEAPSNAPSHOT_GROUP_LIMIT'); }
    groups.set(key, { type, nameHash, count: 1, selfBytes: size, representative: pathTo(index, parents, edges) });
  }
  return { selfBytes, reachableSelfBytes, groups: [...groups.values()].sort((a, b) =>
    b.selfBytes - a.selfBytes || a.type.localeCompare(b.type) || a.nameHash.localeCompare(b.nameHash)) };
}
export async function summarizeSnapshot(bytes: Buffer, signal: AbortSignal): Promise<SnapshotSummary> {
  const graph = await parseSnapshot(bytes, signal), paths = await strongPaths(graph, signal);
  const summary = await aggregate(graph, paths.parents, paths.parentEdges, signal);
  return { sha256: hash(bytes), bytes: bytes.length, format: 'v8-json-layout-7',
    nodeCount: graph.nodes.length / 7, edgeCount: graph.edges.length / 3,
    reachableNodes: paths.reachableNodes, excludedEdges: paths.excludedEdges, ...summary };
}
export function compareSnapshots(before: SnapshotSummary, after: SnapshotSummary): SnapshotDelta[] {
  const deltas = new Map<string, SnapshotDelta>();
  for (const [summary, sign] of [[before, -1], [after, 1]] as const) {
    for (const group of summary.groups) {
      const key = `${group.type}:${group.nameHash}`, delta = deltas.get(key) ??
        { type: group.type, nameHash: group.nameHash, countDelta: 0, selfBytesDelta: 0 };
      delta.countDelta += sign * group.count; delta.selfBytesDelta += sign * group.selfBytes; deltas.set(key, delta);
    }
  }
  return [...deltas.values()].sort((a, b) =>
    b.selfBytesDelta - a.selfBytesDelta || a.type.localeCompare(b.type) || a.nameHash.localeCompare(b.nameHash));
}
