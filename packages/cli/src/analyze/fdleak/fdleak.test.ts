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
// Huawei Reliability Technology Lab Skill 1.4 documented format, not a live capture.
const snapshot = 'time: 2024/06/27 11:55:28\npid: 1380\nprocess: process1\nleaked fd nums: 1831\n' +
  'Leaked fd Top 10:\n1337    ashmem\n259     socket\n119     dmabuf\n48      eventfd\n42      sync_file\n17      eventpoll\n3       /dev/null\n';
const stack = 'LOGGER_MEMCHECK_FD_STACK_INFO\npid: 1380\nget stack time: 2024/06/17 19:16:48\n' +
  '==============================FdTrack Stack==============================\n' +
  'num 8272 bt [/system/lib64/libfdleak_tracker.so+0x1fb58] [/system/lib/ld-musl-aarch64.so.1+0x1d3154]\n';
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface Report {
  analyzer: string; completeness: string; input: { sha256: string; bytes: number; format: string };
  snapshot: { count: number; pid: number | null; processSha256: string | null; timeSha256: string | null; source: Source };
  fdTop: { count: number; kind: string; nameSha256: string; shareOfSnapshot: number | null; source: Source }[];
  dirTop: { count: number; nameSha256: string; source: Source }[];
  allocation: { pid: number | null; snapshotPidRelation: string;
    stacks: { count: number; frames: { moduleSha256: string; offsetHex: string }[]; source: Source }[] };
  summary: { snapshotCount: number; fdTopSum: number; fdTopRemainder: number; stackCount: number; maxAllocationCount: number };
  checks: { captureIdentity: string; buildIdentity: string; runtimeVersion: string; rootCause: string; leakDiagnosis: string;
    symbols: string; detailAssociation: string };
  coverage: { ignoredLines: number; detailSections: string[]; allocationMetric: string; callDirection: string };
  candidates: { code: string; evidenceLevel: string }[];
}
async function setup(value: string | Buffer = snapshot) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-fdleak-test-')); roots.push(root);
  const file = join(root, 'capture.log'); await writeFile(file, value);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.fdleak', input, context) };
}
it('registers a read-only bounded FD log subset', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.fdleak')).toMatchObject({ command: ['analyze', 'fdleak'], risk: 'R0', requirements: [],
    idempotency: 'read', recovery: 'verify-and-retry' });
  expect(runtime.registry.get('analyze.fdleak')!.description).toContain('subset');
});
it('binds the documented stock snapshot and partial top list without proving a leak', async () => {
  const { execute, file } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'fdleak', completeness: 'incomplete',
    input: { sha256: hash(await readFile(file)), bytes: Buffer.byteLength(snapshot), format: 'fd-log-skill-1.4-subset' },
    snapshot: { count: 1831, pid: 1380, processSha256: hash('process1'), timeSha256: hash('2024/06/27 11:55:28') },
    summary: { snapshotCount: 1831, fdTopSum: 1825, fdTopRemainder: 6, stackCount: 0, maxAllocationCount: 0 },
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', leakDiagnosis: 'not-established', symbols: 'not-resolved', detailAssociation: 'not-performed' } });
  expect(data.fdTop[0]).toMatchObject({ count: 1337, kind: 'ashmem', nameSha256: hash('ashmem'), shareOfSnapshot: 1337 / 1831 });
  expect(data.fdTop[6]).toMatchObject({ kind: 'file-path', nameSha256: hash('/dev/null') });
  expect(receipt.artifacts).toHaveLength(1);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
});
it('keeps allocation counts separate from stock and retains right-to-left raw frame ordering', async () => {
  const receipt = await (await setup(snapshot + stack)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.allocation).toMatchObject({ pid: 1380, snapshotPidRelation: 'matches-declared-pid' });
  expect(data.allocation.stacks[0]).toMatchObject({ count: 8272, frames: [
    { moduleSha256: hash('/system/lib64/libfdleak_tracker.so'), offsetHex: '0x1fb58' },
    { moduleSha256: hash('/system/lib/ld-musl-aarch64.so.1'), offsetHex: '0x1d3154' },
  ] });
  expect(data.coverage).toMatchObject({ allocationMetric: 'ten-minute-all-allocations-including-closed', callDirection: 'right-to-left' });
  expect(data.summary.maxAllocationCount).toBe(8272); expect(data.snapshot.count).toBe(1831);
  expect(data.candidates).toContainEqual(expect.objectContaining({ code: 'fd-allocation-hotspot', evidenceLevel: 'single-feature' }));
});
it('does not associate a different tracked PID with the snapshot', async () => {
  const receipt = await (await setup(snapshot + stack.replace('pid: 1380', 'pid: 12326'))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).allocation.snapshotPidRelation).toBe('different-declared-pid');
  expect((receipt.data as Report).checks.rootCause).toBe('not-established');
});
it('admits a bare zero snapshot without inventing identity, top ratios or stacks', async () => {
  const receipt = await (await setup('leaked fd nums: 0\nLeaked fd Top 10:\n0 socket\n')).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.snapshot.pid).toBeNull();
  expect(data.fdTop[0].shareOfSnapshot).toBeNull(); expect(data.allocation.snapshotPidRelation).toBe('unavailable');
});
it('hashes paths and ignored metadata, while leaving whole-system details unassociated', async () => {
  const text = snapshot + 'Dir Type Top 10:\n5 /data/private/customer.db\n' +
    'Process socket info:\nProcessName ProcessID Fd inode PeerTid\nsecret.app 1400 55 4444 2\n' +
    'token=secret-value\n' + stack.replace('libfdleak_tracker.so', 'private_customer.so');
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.dirTop[0]).toMatchObject({ count: 5, nameSha256: hash('/data/private/customer.db') });
  expect(data.coverage.detailSections).toEqual(['socket']);
  expect(JSON.stringify(receipt)).not.toMatch(/customer\.db|secret\.app|secret-value|private_customer|process1|2024\//);
  expect(await readFile(receipt.artifacts[0].path, 'utf8')).not.toMatch(/customer\.db|secret\.app|secret-value|private_customer|process1|2024\//);
});
it('records exact CRLF and final unterminated line byte ranges and hashes', async () => {
  const text = (snapshot + stack).replaceAll('\n', '\r\n').trimEnd(), receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3);
  const data = receipt.data as Report, bytes = Buffer.from(text);
  for (const entry of [data.snapshot, ...data.fdTop, ...data.allocation.stacks]) {
    const raw = bytes.subarray(entry.source.offset, entry.source.offset + entry.source.bytes);
    expect(hash(raw)).toBe(entry.source.sha256);
    expect(entry.source.line).toBe(bytes.subarray(0, entry.source.offset).toString().split('\n').length);
  }
});
const invalid = [
  ['', 'empty'], ['Node file descriptor count: 10', 'wrong format'], [stack, 'no stock count'],
  ['leaked fd nums: -1', 'negative'], ['leaked fd nums: 1.5', 'fraction'], ['leaked fd nums: 1e5', 'scientific'],
  ['leaked fd nums: 9007199254740992', 'overflow'], ['leaked fd nums: 10 extra', 'extra text'],
  [snapshot + 'leaked fd nums: 1831\n', 'duplicate snapshot'], [snapshot.replace('pid: 1380', 'pid: invalid'), 'bad pid'],
  [snapshot.replace('1337    ashmem', '1832 ashmem'), 'count over total'],
  [snapshot.replace('1337    ashmem', '1337 socket'), 'duplicate top name'],
  [snapshot.replace('1337    ashmem', '-1 ashmem'), 'bad row'], [snapshot.replace('1337    ashmem', '1.5 ashmem'), 'fraction row'],
  [snapshot + 'Leaked fd Top 10:\n1 pipe', 'duplicate section'],
  [snapshot + 'Dir Type Top 10:\n2 socket', 'not a directory path'],
  [snapshot + stack.replace('0x1fb58', '0xzz'), 'bad offset'],
  [snapshot + stack.replace('] [', '] trailing ['), 'frame junk'],
  [snapshot + stack.replace('8272', '9007199254740992'), 'allocation overflow'],
  [snapshot + stack.replace('FdTrack Stack', 'Future Stack'), 'missing stack delimiter'],
  [snapshot + stack.replace('pid: 1380', 'pid: -1'), 'bad stack pid'],
  ['\ufeff' + snapshot, 'BOM'], [snapshot + '\0', 'NUL'],
] as const;
it.each(invalid)('rejects %s (%s) without publishing partial evidence', async value => {
  const { root, execute } = await setup(value), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^FD_/) });
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('rejects invalid UTF-8 rather than decoding replacement characters', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(snapshot), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it.each([
  'leaked fd nums: 1\nLeaked fd Top 10:\n',
  snapshot + 'Dir Type Top 10:\n',
  snapshot + 'LOGGER_MEMCHECK_FD_STACK_INFO\npid: 1380\n',
  snapshot + stack.split('\n').slice(0, 4).join('\n'),
])('rejects declared sections truncated before their data', async text => {
  const receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects a report that exceeds its separate artifact byte budget', async () => {
  const text = snapshot + stack.split('\n').slice(0, 4).join('\n') + '\n' +
    ('num 1 bt ' + '[/system/test.so+0x1] '.repeat(32) + '\n').repeat(10000);
  const receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: 'FD_REPORT_LIMIT' });
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('refuses %s input paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.log');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/capture.log'); }
  if (kind === 'secret') { target = join(root, 'credentials.log'); await writeFile(target, snapshot); }
  if (kind === 'extension') { target = join(root, 'capture.json'); await writeFile(target, snapshot); }
  const receipt = await execute({ log: target });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: 'FD_INPUT_UNSAFE' });
});
it.each(['bytes', 'lines', 'line-bytes', 'stacks', 'frames', 'top'] as const)('refuses excessive %s before publication', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'lines') { await writeFile(file, snapshot + 'x\n'.repeat(100000)); }
  if (kind === 'line-bytes') { await writeFile(file, snapshot + 'x'.repeat(16385)); }
  if (kind === 'stacks') { await writeFile(file, snapshot + stack + stack.split('\n')[4].concat('\n').repeat(10000)); }
  if (kind === 'frames') { await writeFile(file, snapshot + stack.split('\n').slice(0, 4).join('\n') +
    '\nnum 1 bt ' + '[/system/test.so+0x1] '.repeat(33)); }
  if (kind === 'top') { await writeFile(file, 'leaked fd nums: 20\nLeaked fd Top 10:\n' +
    Array.from({ length: 11 }, (_, i) => `1 /path/${i}`).join('\n')); }
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('keeps all repeated stacks in an artifact and bounds the receipt', async () => {
  const text = snapshot + stack + stack.split('\n')[4].concat('\n').repeat(9999);
  const receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
  expect(receipt.data).toMatchObject({ stacksLocation: 'report-artifact', summary: { stackCount: 10000 }, report: receipt.artifacts[0] });
  expect((receipt.data as Report).allocation.stacks).toBeUndefined();
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8')).allocation.stacks).toHaveLength(10000);
});
it('observes cancellation during yielded parsing without retaining any artifact', async () => {
  const { root, file, runtime, context } = await setup(snapshot + stack + stack.split('\n')[4].concat('\n').repeat(9999));
  const controller = new AbortController();
  const pending = runtime.execute('analyze.fdleak', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort();
  expect((await pending).exitCode).toBe(130); expect(await readdir(root)).toEqual(['capture.log']);
});
it('observes parser cancellation after the first bounded yield', async () => {
  const { parseFDLog } = await import('./log.js'), controller = new AbortController();
  const pending = parseFDLog(Buffer.from(snapshot + stack + stack.split('\n')[4].concat('\n').repeat(9999)), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects unknown schema options', async () => {
  const { file, execute } = await setup();
  const receipt = await execute({ log: file, symbols: 'automatic' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('exposes the same evidence through the actual terminal parser', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  try {
    const code = await runTerminal(['analyze', 'fdleak', '--log', file, '--format', 'json'],
      { stdout: text => { output += text; }, stderr: () => undefined });
    expect(code).toBe(3); expect(JSON.parse(output).data.input.sha256).toBe(hash(await readFile(file)));
  } finally { vi.unstubAllEnvs(); }
});
