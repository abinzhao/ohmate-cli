/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime } from '../../runtime/index.js';
import { runTerminal } from '../../terminal/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function snapshot(count = 1) {
  return {
    snapshot: { meta: {
      node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
      node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native',
        'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'],
      'string', 'number', 'number', 'number', 'number', 'number'],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
    }, node_count: count + 1, edge_count: count, trace_function_count: 0 },
    nodes: [9, 0, 1, 0, count, 0, 0, ...Array.from({ length: count }, (_, i) => [3, 1, i + 2, 32, 0, 0, 0]).flat()],
    edges: Array.from({ length: count }, (_, i) => [2, 2, (i + 1) * 7]).flat(),
    strings: ['', 'SecretPayload-token=must-not-appear', 'secret-edge-name'],
  };
}
interface Summary {
  sha256: string; nodeCount: number; edgeCount: number; reachableNodes: number; excludedEdges: number;
  groups: { type: string; nameHash: string; count: number; selfBytes: number;
    representative: { nodeIndex: number; path: { nodeIndex: number; edgeIndex: number | null }[]; truncated: boolean } }[];
}
interface Report {
  analyzer: string; completeness: string; snapshots: Summary[];
  comparison: { basis: string; groups: { type: string; nameHash: string; countDelta: number; selfBytesDelta: number }[] } | null;
  checks: { captureIdentity: string; buildIdentity: string; retainedSize: string; leakDiagnosis: string; rawheap: string; nativeAssociation: string };
}
async function setup(values: (object | string | Buffer)[] = [snapshot()]) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-jsleak-test-')); roots.push(root);
  const paths: string[] = [];
  for (const [i, value] of values.entries()) {
    const file = join(root, `${i}.heapsnapshot`);
    await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); paths.push(file);
  }
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  return { root, paths, runtime, context, execute: (input: unknown = { snapshots: paths }) => runtime.execute('analyze.jsleak', input, context) };
}
it('registers an offline bounded analyzer without application or device preflight', async () => {
  const { runtime } = await setup(), spec = runtime.registry.get('analyze.jsleak');
  expect(spec).toMatchObject({ command: ['analyze', 'jsleak'], risk: 'R0', requirements: [], idempotency: 'read' });
  expect(spec!.description).toContain('subset');
});
it('reports declared strong reachability and self bytes without leaking snapshot strings', async () => {
  const { paths, execute } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'jsleak', completeness: 'incomplete', comparison: null,
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', retainedSize: 'not-computed',
      leakDiagnosis: 'not-established', rawheap: 'unavailable', nativeAssociation: 'unavailable' } });
  expect(data.snapshots[0]).toMatchObject({ sha256: hash(await readFile(paths[0])), nodeCount: 2, edgeCount: 1,
    reachableNodes: 2, excludedEdges: 0 });
  expect(data.snapshots[0].groups).toContainEqual(expect.objectContaining({ type: 'object',
    nameHash: hash(snapshot().strings[1]), count: 1, selfBytes: 32,
    representative: { nodeIndex: 1, path: [{ nodeIndex: 0, edgeIndex: null }, { nodeIndex: 1, edgeIndex: 0 }], truncated: false } }));
  expect(JSON.stringify(receipt)).not.toContain('SecretPayload');
  expect(JSON.stringify(receipt)).not.toContain('secret-edge-name');
  expect(receipt.artifacts).toHaveLength(1);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
});
it.each([5, 6])('excludes shortcut/weak type %i from reachability and groups', async (edgeType) => {
  const value = snapshot(); value.edges[0] = edgeType;
  const receipt = await (await setup([value])).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.snapshots[0]).toMatchObject({ reachableNodes: 1, excludedEdges: 1 });
  expect(data.snapshots[0].groups.map(group => group.type)).toEqual(['synthetic']);
});
it('finds the shortest nonweak path despite weak and cyclic alternatives', async () => {
  const value = snapshot(3);
  value.snapshot.edge_count = 5; value.nodes[4] = 2; value.nodes[11] = 2; value.nodes[18] = 1;
  value.edges = [6, 2, 21, 2, 2, 7, 2, 2, 14, 2, 2, 0, 2, 2, 21];
  const receipt = await (await setup([value])).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.snapshots[0].reachableNodes).toBe(4);
  expect(data.snapshots[0].groups.find(group => group.type === 'object')!.count).toBe(3);
});
it('compares ordered aggregates without treating local IDs as stable object identities', async () => {
  const after = snapshot(3); after.nodes[9] = 100; after.nodes[16] = 200; after.nodes[23] = 300;
  const receipt = await (await setup([snapshot(), after])).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.comparison).toMatchObject({ basis: 'input-order-aggregate-only' });
  expect(data.comparison!.groups).toContainEqual({ type: 'object', nameHash: hash(after.strings[1]), countDelta: 2, selfBytesDelta: 64 });
  expect(JSON.stringify(data)).not.toContain('survivor');
});
it('retains negative and zero group deltas', async () => {
  const receipt = await (await setup([snapshot(3), snapshot()])).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.comparison!.groups).toContainEqual({ type: 'object', nameHash: hash(snapshot().strings[1]), countDelta: -2, selfBytesDelta: -64 });
  expect(data.comparison!.groups.some(group => group.countDelta === 0 && group.selfBytesDelta === 0)).toBe(true);
});
const mutations: [string, (value: ReturnType<typeof snapshot>) => void][] = [
  ['node count mismatch', value => { value.snapshot.node_count++; }],
  ['edge count mismatch', value => { value.snapshot.edge_count++; }],
  ['truncated node', value => { value.nodes.pop(); }],
  ['truncated edge', value => { value.edges.pop(); }],
  ['misaligned target', value => { value.edges[2] = 1; }],
  ['out of range target', value => { value.edges[2] = 14; }],
  ['negative size', value => { value.nodes[10] = -1; }],
  ['unsafe number', value => { value.nodes[10] = Number.MAX_SAFE_INTEGER + 1; }],
  ['fractional index', value => { value.nodes[8] = 1.5; }],
  ['bad node type', value => { value.nodes[7] = 99; }],
  ['bad edge type', value => { value.edges[0] = 99; }],
  ['bad string index', value => { value.nodes[8] = 3; }],
  ['bad edge name index', value => { value.edges[1] = 3; }],
  ['bad node edge total', value => { value.nodes[4] = 0; }],
  ['duplicate local IDs', value => { value.nodes[9] = 1; }],
  ['non-synthetic root', value => { value.nodes[0] = 3; }],
  ['unknown layout', value => { value.snapshot.meta.node_fields[6] = 'future_field'; }],
  ['unknown type', value => { value.snapshot.meta.node_types[0] = ['future_type']; }],
  ['unknown edge layout', value => { value.snapshot.meta.edge_fields[2] = 'future_target'; }],
  ['wrong field declaration', value => { value.snapshot.meta.edge_types[2] = 'number'; }],
  ['too many nodes', value => { value.snapshot.node_count = 250001; }],
  ['too many edges', value => { value.snapshot.edge_count = 1000001; }],
];
it.each(mutations)('rejects %s without producing a partial analysis', async (_, mutate) => {
  const value = snapshot(); mutate(value);
  const { root, execute } = await setup([value]), receipt = await execute();
  expect(receipt.exitCode).toBe(4);
  expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID' });
  expect(await readdir(root)).toEqual(['0.heapsnapshot']);
});
it.each(['{', '{"snapshot":{},"nodes":[],"edges":[],"strings":[]}', '{"version":99}', 'rawheap-v3'])(
  'rejects malformed or unsupported input %s', async (value) => {
    const receipt = await (await setup([value])).execute();
    expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  });
it('rejects invalid UTF-8 rather than hashing replacement characters', async () => {
  const value = Buffer.concat([Buffer.from(JSON.stringify(snapshot()).slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]);
  const receipt = await (await setup([value])).execute();
  expect(receipt.exitCode).toBe(4); expect(JSON.stringify(receipt)).not.toContain('SecretPayload');
});
it.each(['symlink', 'hardlink', 'directory'] as const)('rejects %s snapshot sources', async (kind) => {
  const { root, paths, execute } = await setup(), unsafe = join(root, 'unsafe.heapsnapshot');
  if (kind === 'symlink') { await symlink(paths[0], unsafe); }
  if (kind === 'hardlink') { await link(paths[0], unsafe); }
  if (kind === 'directory') { await mkdir(unsafe); }
  const receipt = await execute({ snapshots: [unsafe] });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects symlink parents and secret-named files without reading them', async () => {
  const { root, paths, execute } = await setup();
  await symlink(root, join(root, 'alias'));
  expect((await execute({ snapshots: [join(root, 'alias/0.heapsnapshot')] })).exitCode).toBe(4);
  const secret = join(root, 'credentials.heapsnapshot'); await writeFile(secret, JSON.stringify(snapshot()));
  expect((await execute({ snapshots: [secret] })).exitCode).toBe(4);
});
it('refuses duplicate snapshot paths and unknown input options', async () => {
  const { paths, execute } = await setup();
  expect((await execute({ snapshots: [paths[0], paths[0]] })).exitCode).toBe(4);
  expect((await execute({ snapshots: paths, buildId: 'assumed' })).exitCode).toBe(4);
});
it('does not continue with valid earlier inputs when a later snapshot is invalid', async () => {
  const { root, execute } = await setup([snapshot(), '{']), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(await readdir(root)).toEqual(['0.heapsnapshot', '1.heapsnapshot']);
});
it('does not produce artifacts when already cancelled', async () => {
  const { root, paths, runtime, context } = await setup();
  const receipt = await runtime.execute('analyze.jsleak', { snapshots: paths }, { ...context, abortSignal: AbortSignal.abort() });
  expect(receipt.exitCode).toBe(130); expect(await readdir(root)).toEqual(['0.heapsnapshot']);
});
it('exposes the same hashed report through the real terminal parser', async () => {
  const { root, paths } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  try {
    const exit = await runTerminal(['analyze', 'jsleak', '--snapshots', paths[0], '--format', 'json'],
      { stdout: text => { output += text; }, stderr: () => undefined });
    expect(exit).toBe(3);
    expect(JSON.parse(output).data.snapshots[0].sha256).toBe(hash(await readFile(paths[0])));
    expect(output).not.toContain('SecretPayload');
  } finally { vi.unstubAllEnvs(); }
});
it('marks long strong paths truncated without inventing a root', async () => {
  const value = snapshot(20);
  for (let index = 0; index < 20; index++) {
    value.nodes[index * 7 + 4] = 1; value.nodes[index * 7 + 1] = index;
    value.strings[index] = `SyntheticClass${index}`;
  }
  value.nodes[141] = 20; value.strings[20] = 'LastClass';
  const receipt = await (await setup([value])).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  const last = data.snapshots[0].groups.find(group => group.nameHash === hash('LastClass'))!;
  expect(last.representative.truncated).toBe(true);
  expect(last.representative.path).toHaveLength(16);
  expect(last.representative.path[0].nodeIndex).toBe(5);
  expect(last.representative.path.at(-1)?.nodeIndex).toBe(20);
});
it.each(['surrogate', 'overflow', 'version', 'strings', 'string-bytes'] as const)('rejects %s evidence', async (kind) => {
  const value = snapshot();
  if (kind === 'surrogate') { value.strings[1] = '\ud800'; }
  if (kind === 'overflow') { value.nodes[3] = Number.MAX_SAFE_INTEGER; }
  if (kind === 'version') { Object.assign(value.snapshot, { version: 99 }); }
  if (kind === 'strings') { value.strings = new Array(250001).fill(''); }
  if (kind === 'string-bytes') { value.strings[1] = 'x'.repeat(16 * 1024 * 1024 + 1); }
  const receipt = await (await setup([value])).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects an oversized regular file before reading its content', async () => {
  const { paths, execute } = await setup();
  await truncate(paths[0], 32 * 1024 * 1024 + 1);
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('refuses excessive group allocation rather than publishing a truncated ranking', async () => {
  const value = snapshot(50000);
  value.strings = ['', ...Array.from({ length: 50000 }, (_, index) => `Class${index}`)];
  for (let index = 1; index <= 50000; index++) { value.nodes[index * 7 + 1] = index; }
  const receipt = await (await setup([value])).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('keeps every large-report group in the artifact while bounding the task receipt', async () => {
  const value = snapshot(10000);
  value.strings = ['', ...Array.from({ length: 10000 }, (_, index) => `Class${index}`)];
  for (let index = 1; index <= 10000; index++) { value.nodes[index * 7 + 1] = index; }
  const receipt = await (await setup([value])).execute();
  expect(receipt.exitCode).toBe(3);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
  expect(receipt.data).toMatchObject({ groupsLocation: 'report-artifact', snapshots: [{ groupCount: 10001 }],
    report: receipt.artifacts[0] });
  const report = JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'));
  expect(report.snapshots[0].groups).toHaveLength(10001);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
});
