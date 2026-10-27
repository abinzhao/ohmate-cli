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
// Official OpenHarmony 5.0.3 documentation example; not a device capture by these tests.
const official = 'C03F00/ArkCompiler: [gc]  [ CompressGC ] 26.1164 (35) -> 7.10049 (10.5) MB, 160.626(+0)ms, Switch to background';
const header = (type = 'HPP YoungGC', duration = '1.25(+2.5)', reason = 'Memory reach limit') =>
  `C03F00/ArkCompiler: [gc]  [ ${type} ] 10 (12) -> 8 (10) MB, ${duration}ms, ${reason}`;
interface Report {
  analyzer: string; completeness: string; input: { sha256: string; bytes: number };
  events: { type: string; heap: string; beforeUsedMiB: number; beforeCommittedMiB: number;
    afterUsedMiB: number; afterCommittedMiB: number; totalGcMs: number; concurrentMarkMs: number | null;
    reason: string; source: { line: number; offset: number; bytes: number; sha256: string } }[];
  summary: { eventCount: number; maxTotalGcMs: number; byType: Record<string, number> };
  candidates: { code: string; evidenceLevel: string; eventCount: number }[];
  checks: { captureIdentity: string; buildIdentity: string; runtimeVersion: string; rootCause: string;
    leakDiagnosis: string; frequency: string; allocationRate: string; verboseAssociation: string };
}
async function setup(value: string | Buffer = official + '\n') {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-gc-test-')); roots.push(root);
  const file = join(root, 'capture.log'); await writeFile(file, value);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.gc', input, context) };
}
it('registers the read-only GC subset without claiming device or full-format availability', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.gc')).toMatchObject({ command: ['analyze', 'gc'], risk: 'R0', requirements: [],
    idempotency: 'read', recovery: 'verify-and-retry' });
  expect(runtime.registry.get('analyze.gc')!.description).toContain('subset');
});
it('binds the official example to raw bytes and independent GC duration fields', async () => {
  const { file, execute } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'gc', completeness: 'incomplete', input: { sha256: hash(await readFile(file)), bytes: 112 },
    summary: { eventCount: 1, maxTotalGcMs: 160.626, byType: { CompressGC: 1 } },
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', leakDiagnosis: 'not-established', frequency: 'not-computed',
      allocationRate: 'not-computed', verboseAssociation: 'not-performed' } });
  expect(data.events[0]).toMatchObject({ type: 'CompressGC', heap: 'local', beforeUsedMiB: 26.1164, beforeCommittedMiB: 35,
    afterUsedMiB: 7.10049, afterCommittedMiB: 10.5, totalGcMs: 160.626, concurrentMarkMs: 0,
    reason: 'Switch to background', source: { line: 1, offset: 0, bytes: 112, sha256: hash(official + '\n') } });
  expect(receipt.artifacts).toHaveLength(1);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
});
it.each(['STWYoungGC', 'HPP EdenGC', 'HPP YoungGC', 'HPP OldGC', 'CompressGC'])('keeps exact local GC type %s', async type => {
  const receipt = await (await setup(header(type))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).events[0]).toMatchObject({ type, heap: 'local', totalGcMs: 1.25, concurrentMarkMs: 2.5 });
  expect((receipt.data as Report).summary.maxTotalGcMs).toBe(1.25);
});
it('keeps SharedGC separate and does not invent an absent concurrent mark duration', async () => {
  const receipt = await (await setup(header('SharedGC', '3.5'))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).events[0]).toMatchObject({ type: 'SharedGC', heap: 'shared', concurrentMarkMs: null });
});
it('uses input order without attributing unrelated verbose fields or mixed threads to a VM', async () => {
  const ignored = 'secret-token=https://private.example/path\nC03F00/ArkCompiler: [gc] BundleName: private.bundle;\n';
  const text = ignored + header() + '\r\n' + 'C03F00/ArkCompiler: OldSpace used: 800KB committed: 900KB\n' + official;
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.events).toHaveLength(2);
  expect(data.events[0].source).toEqual({ line: 3, offset: Buffer.byteLength(ignored), bytes: Buffer.byteLength(header() + '\r\n'),
    sha256: hash(header() + '\r\n') });
  expect(JSON.stringify(receipt)).not.toMatch(/secret-token|private\.example|private\.bundle|OldSpace/);
  expect(JSON.stringify(data)).not.toContain('threadId');
});
it('does not upgrade repeated allocation pressure or increasing post-GC usage into a leak diagnosis', async () => {
  const text = header() + '\n' + header().replace('-> 8 (10)', '-> 9 (10)');
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.candidates).toContainEqual(expect.objectContaining({ code: 'allocation-limit-reported', evidenceLevel: 'single-feature',
    eventCount: 2 }));
  expect(data.checks.leakDiagnosis).toBe('not-established'); expect(data.checks.frequency).toBe('not-computed');
});
it('reports an allocation failure as a candidate rather than an OOM detector finding', async () => {
  const receipt = await (await setup(header('HPP OldGC', '0(+0)', 'Allocate object failed'))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).candidates).toContainEqual(expect.objectContaining({ code: 'allocation-failure-reported',
    evidenceLevel: 'single-feature' }));
  expect((receipt.data as Report).checks.rootCause).toBe('not-established');
});
it('accepts bounded scientific notation emitted by standard stream formatting', async () => {
  const receipt = await (await setup(header().replace('10 (12)', '1e-05 (2e-05)').replace('-> 8 (10)', '-> 0 (2e-05)'))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).events[0].beforeUsedMiB).toBe(0.00001);
});
it('refuses nonzero printed values that underflow to zero', async () => {
  const receipt = await (await setup(official.replace('160.626', '1e-999'))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('settles input cancellation without publishing a partial event report', async () => {
  const { root, file, runtime, context } = await setup((official + '\n').repeat(10000));
  const controller = new AbortController();
  const pending = runtime.execute('analyze.gc', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort();
  expect((await pending).exitCode).toBe(130);
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('observes cancellation after parsing has yielded rather than finishing the entire log', async () => {
  const { parseGCLog } = await import('./log.js'), controller = new AbortController();
  const pending = parseGCLog(Buffer.from((official + '\n').repeat(10000)), controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it.each(['Idle time task', 'Externally triggered', 'Worker Destruction', 'Trigger by JS', 'Trigger by ArkUI',
  'Trigger by AbilityRuntime', 'Trigger by Mem tools', 'Trigger by taskPool', 'Other'])('preserves reason %s without pressure assumptions', async reason => {
  const receipt = await (await setup(header('HPP YoungGC', '0(+0)', reason))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).events[0].reason).toBe(reason);
  expect((receipt.data as Report).candidates).toEqual([]);
});
const invalid = [
  ['', 'empty'], ['Node scavenge 1 ms', 'wrong source'], [official.replace('[gc]', ''), 'missing component'],
  [official.replace('CompressGC', 'FutureGC'), 'unknown type'], [official.replace('Switch to background', 'Future reason'), 'unknown reason'],
  [official.slice(0, -20), 'truncated summary'], [official.replace('160.626', '-1'), 'negative'],
  [official.replace('160.626', 'NaN'), 'NaN'], [official.replace('160.626', 'Infinity'), 'Infinity'],
  [official.replace('160.626', '1e999'), 'overflow'], [official.replace('(35)', '(1)'), 'used over committed'],
  [official.replace('7.10049 (10.5)', '11 (10.5)'), 'after used over committed'],
  [header('SharedGC'), 'wrong shared shape'], [header('HPP YoungGC', '3'), 'wrong local shape'],
  [official + ' token=private', 'appended text'], [official + '\0', 'NUL'],
  [official.replace('MB,', 'KB,'), 'unknown unit'], ['\ufeff' + official, 'BOM'],
  [official.replace('[gc]', '[gc] [gc]'), 'duplicate component'],
] as const;
it.each(invalid)('rejects %s (%s) without producing partial evidence', async (value) => {
  const { root, execute } = await setup(value), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^GC_/) });
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('rejects a malformed later header instead of publishing the earlier valid event', async () => {
  const receipt = await (await setup(official + '\n' + header('FutureGC'))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects invalid UTF-8 without projecting replacement text', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(official), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('refuses %s input paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.log');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/capture.log'); }
  if (kind === 'secret') { target = join(root, 'credentials.log'); await writeFile(target, official); }
  if (kind === 'extension') { target = join(root, 'capture.json'); await writeFile(target, official); }
  const receipt = await execute({ log: target });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: 'GC_INPUT_UNSAFE' });
});
it.each(['bytes', 'lines', 'line-bytes', 'events'] as const)('rejects excessive %s before publication', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'lines') { await writeFile(file, official + '\n' + 'x\n'.repeat(100000)); }
  if (kind === 'line-bytes') { await writeFile(file, official + '\n' + 'x'.repeat(16385)); }
  if (kind === 'events') { await writeFile(file, (official + '\n').repeat(10001)); }
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('keeps every event in a large artifact while bounding the receipt and preserving duplicates', async () => {
  const receipt = await (await setup((official + '\n').repeat(10000))).execute();
  expect(receipt.exitCode).toBe(3);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
  expect(receipt.data).toMatchObject({ eventsLocation: 'report-artifact', summary: { eventCount: 10000 }, report: receipt.artifacts[0] });
  expect((receipt.data as { events?: unknown }).events).toBeUndefined();
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8')).events).toHaveLength(10000);
});
it('does not persist any artifact after cancellation', async () => {
  const { root, file, runtime, context } = await setup();
  const receipt = await runtime.execute('analyze.gc', { log: file }, { ...context, abortSignal: AbortSignal.abort() });
  expect(receipt.exitCode).toBe(130); expect(await readdir(root)).toEqual(['capture.log']);
});
it('rejects unknown options through the shared registry schema', async () => {
  const { file, execute } = await setup();
  const receipt = await execute({ log: file, buildId: 'assumed' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('exposes the same hash and incomplete result through the actual terminal parser', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  try {
    const code = await runTerminal(['analyze', 'gc', '--log', file, '--format', 'json'],
      { stdout: text => { output += text; }, stderr: () => undefined });
    expect(code).toBe(3); expect(JSON.parse(output).data.input.sha256).toBe(hash(await readFile(file)));
  } finally { vi.unstubAllEnvs(); }
});
