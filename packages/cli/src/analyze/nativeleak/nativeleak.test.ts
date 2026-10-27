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
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// OpenHarmony 5.0.3 emitter layout, composed for tests rather than captured.
const row = (time: number, value: number, clock = '2025/01/01 10/00/00') => `${time}                 ${value}                 ${clock}\n`;
const header = 'pid:\t12\t\nprocessName:\tcom.example.private\nthreshold:\t100(KB)\nactualRss:\t200(KB)\nTopPssMemory:\t180(KB)\n\n' +
  'time(s)             PssMemory(KB)        realtime\n';
const sample = header + row(100, 200) + row(101, 120) + row(102, 180);
const smapsHeader = '                                    Shared      Shared      Private     Private\n' +
  '        Size         Rss         Pss       Clean       Dirty       Clean       Dirty        Swap     SwapPss      Counts    Name\n';
const smaps = smapsHeader +
  '1000  200  120  0  0  0  200  50  30  1                  [anon:native_heap:jemalloc]\n' +
  '1000  200  60  0  0  0  200  20  10  1                  [anon:ArkTS Heap]\n' +
  '2000  400  220  0  0  0  400  70  40  2                  Summary\n';
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface Report {
  analyzer: string; completeness: string;
  inputs: { role: string; sha256: string; bytes: number; format: string }[];
  sample: { pid: number; processNameSha256: string; fields: Record<string, { value: number | string; source: Source }>;
    header: Source; rows: { valueKiB: number; metric: string; monotonicSeconds: number; realtimeSha256: string; source: Source }[];
    trend: { metric: string; startKiB: number; endKiB: number; peakKiB: number; deltaKiB: number; deltaPercent: number | null;
      durationSeconds: number; direction: string; rowCount: number } };
  smaps: { headers: Source[]; rows: { category: string; nameSha256: string; values: number[]; source: Source }[];
    summary: { values: number[]; source: Source }; totals: { pssKiB: number; swapPssKiB: number; combinedKiB: number };
    shares: { category: string; numeratorKiB: number; denominatorKiB: number; percent: number | null }[] } | null;
  checks: { rootCause: string; leakDiagnosis: string; captureIdentity: string; buildIdentity: string;
    crossInputAssociation: string; allocationLifetime: string };
  candidates: { evidenceLevel: string; alternatives: string[] }[];
}
async function setup(value: string | Buffer = sample) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-native-test-')); roots.push(root);
  const file = join(root, 'sample.txt'); await writeFile(file, value);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { sample: file }) => runtime.execute('analyze.nativeleak', input, context) };
}
it('registers an offline read-only Native memory subset without discovery', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.nativeleak')).toMatchObject({ command: ['analyze', 'nativeleak'], risk: 'R0',
    requirements: [], idempotency: 'read', recovery: 'verify-and-retry' });
});
it('binds raw declarations without assigning individual RSS/PSS identities', async () => {
  const { file, execute } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'nativeleak', completeness: 'incomplete', smaps: null,
    inputs: [{ role: 'sample', sha256: hash(await readFile(file)), bytes: Buffer.byteLength(sample), format: 'hiview-native-sample-5.0.3-subset' }],
    sample: { pid: 12, processNameSha256: hash('com.example.private'),
      trend: { metric: 'mixed-memory-series', startKiB: 200, endKiB: 180, peakKiB: 200, deltaKiB: -20,
        deltaPercent: -10, durationSeconds: 2, direction: 'mixed', rowCount: 3 } },
    checks: { rootCause: 'not-established', leakDiagnosis: 'not-established', captureIdentity: 'unverified',
      buildIdentity: 'unverified', crossInputAssociation: 'not-performed', allocationLifetime: 'not-analyzed' } });
  expect(data.sample.rows.map(item => item.metric)).toEqual(Array(3).fill('rss-or-pss-plus-swap-pss-unidentified'));
  expect(data.sample.rows.map(item => item.valueKiB)).toEqual([200, 120, 180]);
  expect(data.candidates[0].evidenceLevel).toBe('single-feature'); expect(data.candidates[0].alternatives.length).toBeGreaterThan(1);
  expect(JSON.stringify(receipt)).not.toMatch(/com\.example|2025\/01\/01|10\/00\/00/);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
});
it('keeps smaps PSS and SwapPss separate and validates its combined Summary', async () => {
  const { root, file, execute } = await setup(), maps = join(root, 'smaps.txt'); await writeFile(maps, smaps);
  const receipt = await execute({ sample: file, smaps: maps }), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.smaps).toMatchObject({ totals: { pssKiB: 180, swapPssKiB: 40, combinedKiB: 220 },
    shares: [{ category: 'native-heap', numeratorKiB: 150, denominatorKiB: 220, percent: 150 / 220 * 100 },
      { category: 'arkts-heap', numeratorKiB: 70, denominatorKiB: 220, percent: 70 / 220 * 100 }] });
  expect(data.smaps!.rows).toHaveLength(2); expect(data.smaps!.rows[0].nameSha256).toBe(hash('[anon:native_heap:jemalloc]'));
  expect(data.checks.crossInputAssociation).toBe('not-performed');
  expect(JSON.stringify(receipt)).not.toMatch(/native_heap:jemalloc|anon:ArkTS/);
});
it('preserves exact CRLF and unterminated final-line ranges', async () => {
  const text = sample.replaceAll('\n', '\r\n').trimEnd(), mapsText = smaps.replaceAll('\n', '\r\n').trimEnd();
  const { root, file, execute } = await setup(text), maps = join(root, 'maps.txt'); await writeFile(maps, mapsText);
  const receipt = await execute({ sample: file, smaps: maps }), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  for (const [bytes, sources] of [
    [Buffer.from(text), [data.sample.header, ...Object.values(data.sample.fields).map(item => item.source), ...data.sample.rows.map(item => item.source)]],
    [Buffer.from(mapsText), [...data.smaps!.headers, ...data.smaps!.rows.map(item => item.source), data.smaps!.summary.source]],
  ] as const) {
    for (const source of sources) {
      expect(hash(bytes.subarray(source.offset, source.offset + source.bytes))).toBe(source.sha256);
      expect(source.line).toBe(bytes.subarray(0, source.offset).toString().split('\n').length);
    }
  }
});
it.each([
  [[0, 0], 'stable', null], [[0, 180], 'nondecreasing', null], [[180, 120], 'nonincreasing', -100 / 3],
  [[120, 180, 140], 'mixed', 100 / 6],
] as const)('reports observed values %j without classifying a leak', async (values, direction, percent) => {
  const text = header + row(100, values[0]) + values.map((value, index) => row(index + 101, value)).join('');
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.sample.trend.direction).toBe(direction);
  if (percent === null) { expect(data.sample.trend.deltaPercent).toBeNull(); }
  else { expect(data.sample.trend.deltaPercent).toBeCloseTo(percent); }
  expect(data.checks.leakDiagnosis).toBe('not-established');
});
it('allows same-second monotonic declarations without inventing rates', async () => {
  const receipt = await (await setup(header + row(100, 200) + row(100, 120) + row(100, 180))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).sample.trend.durationSeconds).toBe(0);
});
const invalid = [
  ['', 'empty'], [smaps, 'wrong type'], [sample + sample, 'concatenation'],
  [sample.replace('pid:\t12', 'pid:\t0'), 'zero pid'], [sample.replace('12\t', '9007199254740992\t'), 'unsafe pid'],
  [sample.replace('threshold:\t100(KB)', 'SoftThreshold:\t100(MB)'), 'unknown layout'],
  [sample.replace('actualRss:\t200(KB)\n', ''), 'missing baseline declaration'],
  [sample.replace('processName:\tcom.example.private\n', ''), 'missing process'],
  [sample.replace('threshold:\t100(KB)', 'threshold:\t1e2(KB)'), 'exponent'],
  [sample.replace('threshold:\t100(KB)', 'threshold:\t-1(KB)'), 'negative threshold'],
  [sample.replace('TopPssMemory:\t180(KB)', 'TopPssMemory:\t9007199254740992(KB)'), 'unsafe threshold'],
  [sample.replace('PssMemory(KB)', 'TotalMem(KB)'), 'unknown columns'],
  [sample.replace(row(102, 180), ''), 'insufficient PSS rows'],
  [sample.replace(row(102, 180), row(99, 180)), 'time reversal'],
  [sample.replace('2025/01/01 10/00/00', '2025/02/30 10/00/00'), 'bad date'],
  [sample.replace('2025/01/01 10/00/00', '2025/01/01 25/00/00'), 'bad clock'],
  [sample.replace(row(102, 180), row(102, 180).replace('180', '1.5')), 'fractional memory'],
  [sample.replace(row(102, 180), row(102, 180).replace('180', '~')), 'missing value'],
  [sample + '[truncated]\n', 'truncation'], [sample + '...\n', 'ellipsis'],
  [sample + 'Reason:Signal:SIGSEGV\n', 'mixed crash'], ['\ufeff' + sample, 'BOM'], [sample + '\0', 'NUL'],
  [sample.replace('threshold:\t100(KB)', 'threshold:\t100(KB)\nthreshold:\t100(KB)'), 'duplicate field'],
  [sample.replace('com.example.private', 'x'.repeat(1025)), 'process budget'],
] as const;
it.each(invalid)('rejects unsupported sample (%s: %s) without partial artifacts', async text => {
  const { root, execute } = await setup(text), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^NATIVELEAK_/) });
  expect(await readdir(root)).toEqual(['sample.txt']);
});
it.each([
  ['', 'empty'], [smaps.replace('Shared      Shared', 'Private     Shared'), 'wrong top header'],
  [smaps.replace('SwapPss', 'SwapPSS'), 'unknown header'], [smaps.replace('220  0', '260  0'), 'double-counted summary'],
  [smaps.replace('Summary', 'Other'), 'missing summary'], [smaps + smaps, 'duplicate table'],
  [smaps.replace('60  0', '-1  0'), 'negative'], [smaps.replace('60  0', '9e2  0'), 'exponent'],
  [smaps.replace('[anon:ArkTS Heap]', '[anon:native_heap:jemalloc]'), 'duplicate names'],
  [smaps.replace('[anon:ArkTS Heap]', 'x'.repeat(1025)), 'name budget'],
  [smaps.replace('60  0', '9007199254740992  0'), 'unsafe integer'],
  [smaps + '[truncated]\n', 'truncated'], ['\ufeff' + smaps, 'BOM'],
] as const)('rejects malformed smaps (%s: %s) without a sample-only fallback', async (text, kind) => {
  const { root, file, execute } = await setup(), maps = join(root, 'smaps.txt'); await writeFile(maps, text);
  const receipt = await execute({ sample: file, smaps: maps });
  expect(receipt.exitCode, kind).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: expect.stringMatching(/^NATIVELEAK_/) });
  expect((await readdir(root)).sort()).toEqual(['sample.txt', 'smaps.txt']);
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('rejects %s input paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.txt');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/sample.txt'); }
  if (kind === 'secret') { target = join(root, 'credentials.txt'); await writeFile(target, sample); }
  if (kind === 'extension') { target = join(root, 'sample.pkl'); await writeFile(target, sample); }
  const receipt = await execute({ sample: target });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: 'NATIVELEAK_INPUT_UNSAFE' });
});
it.each(['bytes', 'line-bytes', 'rows', 'lines'] as const)('bounds %s in sample inputs', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'line-bytes') { await writeFile(file, sample + ' '.repeat(16385)); }
  if (kind === 'rows') { await writeFile(file, header + Array.from({ length: 1025 }, (_, i) => row(i, 100)).join('')); }
  if (kind === 'lines') { await writeFile(file, sample + '\n'.repeat(100000)); }
  const receipt = await execute(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('keeps maximum sample and smaps records in the shared receipt budget', async () => {
  const text = header + Array.from({ length: 1024 }, (_, i) => row(i, 100)).join('');
  const { root, file, execute } = await setup(text), maps = join(root, 'smaps.txt');
  await writeFile(maps, smapsHeader + Array.from({ length: 1024 }, (_, i) => `1  1  1  0  0  0  1  0  0  1  unknown-${i}\n`).join('') +
    '1024  1024  1024  0  0  0  1024  0  0  1024  Summary\n');
  const receipt = await execute({ sample: file, smaps: maps });
  expect(receipt.exitCode).toBe(3); expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
  expect((receipt.data as Report).smaps!.rows).toHaveLength(1024);
});
it('rejects invalid UTF8 rather than replacement decoding', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(sample), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects discovery and companion pickle parameters', async () => {
  const { file, execute } = await setup();
  const receipt = await execute({ sample: file, directory: 'automatic', trace: 'automatic', device: 'automatic' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('cancels before publication', async () => {
  const { root, file, runtime, context } = await setup(), controller = new AbortController();
  const pending = runtime.execute('analyze.nativeleak', { sample: file }, { ...context, abortSignal: controller.signal });
  controller.abort(); expect((await pending).exitCode).toBe(130); expect(await readdir(root)).toEqual(['sample.txt']);
});
it('cancels during sample parsing at bounded yields', async () => {
  const { parseNativeSample } = await import('./sample.js'), controller = new AbortController();
  const pending = parseNativeSample(Buffer.from(header + Array.from({ length: 1024 }, (_, i) => row(i, 100)).join('')), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it.each(['rows', 'sum', 'bytes', 'UTF8', 'link', 'counts'] as const)('rejects smaps %s failures without fallback', async kind => {
  const { root, file, execute } = await setup(), maps = join(root, 'smaps.txt');
  let text = smaps;
  if (kind === 'rows') {
    text = smapsHeader + Array.from({ length: 1025 }, (_, i) => `1  1  1  0  0  0  1  0  0  1  name-${i}\n`).join('') +
      '1025  1025  1025  0  0  0  1025  0  0  1025  Summary\n';
  }
  if (kind === 'sum') {
    text = smapsHeader + '1  1  9007199254740991  0  0  0  1  0  1  1  unknown\n' +
      '1  1  9007199254740991  0  0  0  1  0  1  1  Summary\n';
  }
  if (kind === 'counts') { text = smaps.replace('40  2', '40  3'); }
  await writeFile(maps, text);
  if (kind === 'bytes') { await truncate(maps, 16 * 1024 * 1024 + 1); }
  if (kind === 'UTF8') { await writeFile(maps, Buffer.concat([Buffer.from(smaps), Buffer.from([0xff])])); }
  if (kind === 'link') { await rm(maps); await symlink(file, maps); }
  const receipt = await execute({ sample: file, smaps: maps });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('cancels while scanning smaps records', async () => {
  const { parseNativeSmaps } = await import('./smaps.js'), controller = new AbortController();
  const pending = parseNativeSmaps(Buffer.from(smaps), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('uses only exact declared memory tags and preserves unknown names as hashes', async () => {
  const { root, file, execute } = await setup(), maps = join(root, 'maps.txt');
  const names = ['[anon]', '/dev/ashmem/private-image', 'anon_inode:dev/ashmem/private-image', 'libmemtracker.so'];
  await writeFile(maps, smapsHeader + names.map(name => `1  1  1  0  0  0  1  0  0  1  ${name}\n`).join('') +
    '4  4  4  0  0  0  4  0  0  4  Summary\n');
  const receipt = await execute({ sample: file, smaps: maps }), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.smaps!.rows.map(item => item.category)).toEqual(['anon', 'ashmem', 'ashmem', 'unclassified']);
  expect(data.checks.leakDiagnosis).toBe('not-established');
  expect(JSON.stringify(receipt)).not.toMatch(/private-image|libmemtracker/);
});
it('uses the shared terminal parser', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  const exit = await runTerminal(['analyze', 'nativeleak', '--sample', file, '--format', 'json'],
    { stdout: text => { output += text; }, stderr: () => undefined });
  expect(exit).toBe(3); expect(JSON.parse(output).data.inputs[0].sha256).toBe(hash(await readFile(file)));
});
it('never assigns individual RSS/PSS identities to the emitter mixed vector, including trimmed history', async () => {
  const receipt = await (await setup(header + row(100, 200) + row(101, 120) + row(102, 300) + row(103, 180))).execute();
  const data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.sample.rows.map(item => item.metric)).toEqual(Array(4).fill('rss-or-pss-plus-swap-pss-unidentified'));
  expect(data.sample.trend).toMatchObject({ metric: 'mixed-memory-series', startKiB: 200, endKiB: 180,
    peakKiB: 300, deltaKiB: -20, deltaPercent: -10, durationSeconds: 3, direction: 'mixed', rowCount: 4 });
});
