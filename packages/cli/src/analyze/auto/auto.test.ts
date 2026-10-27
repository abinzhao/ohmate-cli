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
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Known emitter layouts composed for tests, without actual captures.
const ui = '01-01 10:00:00.000 12 13 I C03900/Ace: [(-2:100000:singleton)] [com.example.private][entry][100000]: window focus\n';
const gc = '01-01 10:00:00.000 12 13 I C04100/ArkCompiler: [gc] [ HPP YoungGC ] 2 (4) -> 1 (4) MB, 1(+0)ms, Memory reach limit\n';
const api = '01-01 10:00:00.000 12 13 E C03900/PrivateTag: error code: 401 private message\n';
const native = 'pid:\t12\t\nprocessName:\tcom.example.private\nthreshold:\t100(KB)\nactualRss:\t200(KB)\nTopPssMemory:\t180(KB)\n\n' +
  'time(s)             PssMemory(KB)        realtime\n' +
  '100 200 2025/01/01 10/00/00\n101 120 2025/01/01 10/00/00\n102 180 2025/01/01 10/00/00\n';
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface AutoData {
  analyzer: string; completeness: string; input: { sha256: string; bytes: number };
  classification: { analyzer: string; basis: string; markers: Source[]; markerCount: number }[];
  selection: string | null; analysis: { analyzer: string; completeness: string; input?: { sha256: string }; inputs?: { sha256: string }[] } | null;
  checks: { rootCause: string; captureIdentity: string; buildIdentity: string; crossAnalyzerAssociation: string; classification: string };
}
async function setup(text: string | Buffer = ui) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-auto-test-')); roots.push(root);
  const file = join(root, 'events.txt'); await writeFile(file, text);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.auto', input, context) };
}
it('registers read-only bounded auto log dispatch with no discovery', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.auto')).toMatchObject({ command: ['analyze', 'auto'], risk: 'R0',
    requirements: [], idempotency: 'read', recovery: 'verify-and-retry' });
});
it.each([[ui, 'ui'], [gc, 'gc'], [api, 'api'], [native, 'nativeleak']] as const)('validates one candidate with its owned analyzer (%s: %s)', async (text, target) => {
  const { file, execute } = await setup(text), receipt = await execute(), data = receipt.data as AutoData;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'auto', completeness: 'incomplete', input: { sha256: hash(await readFile(file)), bytes: Buffer.byteLength(text) },
    selection: target, analysis: { analyzer: target, completeness: 'incomplete' },
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified',
      crossAnalyzerAssociation: 'not-performed', classification: 'markers-not-capture-authentication' } });
  expect(data.classification.map(item => item.analyzer)).toEqual([target]);
  expect(data.classification[0].basis).toBe('raw-log-markers');
  expect(receipt.artifacts).toHaveLength(1);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
  expect(JSON.stringify(receipt)).not.toMatch(/com\.example|PrivateTag|private message/);
});
it('keeps multiple domains as candidates without imposing a parser or causal association', async () => {
  const receipt = await (await setup(ui + gc + api)).execute(), data = receipt.data as AutoData;
  expect(receipt.exitCode).toBe(3); expect(data.selection).toBeNull(); expect(data.analysis).toBeNull();
  expect(data.classification.map(item => item.analyzer).sort()).toEqual(['api', 'gc', 'ui']);
  expect(data.checks.crossAnalyzerAssociation).toBe('not-performed');
  expect(receipt.artifacts).toHaveLength(1);
});
it.each([
  ['Reason:TypeError\nError name:TypeError\n', 'jscrash'],
  ['Reason:Signal:SIGSEGV\n', 'cppcrash'],
  ['Reason:THREAD_BLOCK_6S\n', 'freeze'],
  ['leaked fd nums: 2\n', 'fdleak'],
])('retains incomplete type markers in ambiguous triage (%s: %s)', async (marker, target) => {
  const receipt = await (await setup(marker + ui)).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as AutoData).selection).toBeNull();
  expect((receipt.data as AutoData).classification.some(item => item.analyzer === target)).toBe(true);
});
it.each(['Reason:TypeError\n', 'Reason:Signal:SIGSEGV\n', 'Reason:THREAD_BLOCK_6S\n', 'leaked fd nums: x\n', ui.replace('focus', 'hide')])(
  'does not fall back after a uniquely selected analyzer rejects its input (%s)', async text => {
    const { root, execute } = await setup(text), receipt = await execute();
    expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
    expect(receipt.data).toMatchObject({ message: 'AUTO_ANALYZER_REJECTED' }); expect(await readdir(root)).toEqual(['events.txt']);
  });
it('preserves the existing legal count-only FD subset', async () => {
  const receipt = await (await setup('leaked fd nums: 2\n')).execute();
  expect(receipt.exitCode).toBe(3); expect(receipt.data).toMatchObject({ selection: 'fdleak',
    analysis: { analyzer: 'fdleak', snapshot: { count: 2 }, completeness: 'incomplete' } });
});
it('recognizes the supported BUSINESS spelling as a freeze marker in ambiguous triage', async () => {
  const receipt = await (await setup('Reason:BUSINESS_THREAD_BLOCK_6S\n' + ui)).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as AutoData).selection).toBeNull();
  expect((receipt.data as AutoData).classification.map(item => item.analyzer)).toEqual(['freeze', 'ui']);
});
it.each(['OOMError', 'EvalError'])('recognizes the existing JS parser type %s', async type => {
  const receipt = await (await setup('Reason:' + type + '\n' + ui)).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as AutoData).selection).toBeNull();
  expect((receipt.data as AutoData).classification.map(item => item.analyzer)).toEqual(['jscrash', 'ui']);
});
it.each([
  ['Reason:TypeError\nError name:TypeError\nError message:private\nStacktrace:\n    at callback (entry/src/main/ets/pages/Index.ets:7:13)\n', 'jscrash'],
  ['Reason:Signal:SIGSEGV(SI_USER)@0x00001e99 from:7833:0\nFault thread info:\nTid:12, Name:private\n' +
    '#00 pc 000a8a94 /system/lib/ld-musl-arm.so.1(3753ef9108517347d1a03e903b3a5dbf)\n', 'cppcrash'],
  ['Pid:12\nUid:0\nReason:THREAD_BLOCK_6S\n***\nstart time: 2025/06/28-14:08:34:318\n' +
    'DOMAIN = AAFWK\nEVENTNAME = THREAD_BLOCK_3S\nTIMESTAMP = 2025/06/28-14:08:34:310\n' +
    'PID = 12\nUID = 0\nTID = 12\nMSG =\nFault time:2025/06/28-14:08:34\nApp main thread is not response!\n' +
    'Tid:12, Name:private\n#00 pc 000000000000186c [shmm](__kernel_gettimeofday+72)\n', 'freeze'],
] as const)('dispatches validated primary faultlogs through the existing parser (%s: %s)', async (text, target) => {
  const { file, execute } = await setup(text), receipt = await execute(), data = receipt.data as AutoData;
  expect(receipt.exitCode).toBe(3); expect(data.selection).toBe(target);
  expect(data.analysis).toMatchObject({ analyzer: target, input: { sha256: hash(await readFile(file)) }, completeness: 'incomplete' });
  expect(receipt.artifacts).toHaveLength(1);
});
it('rejects byte drift between classification and analyzer admission and cleans owned derived files', async () => {
  const { file, root, execute } = await setup(), module = await import('../ui/adapter.js'), original = module.analyzeUI;
  vi.spyOn(module, 'analyzeUI').mockImplementation(async (input, context) => {
    await writeFile(file, ui.replace('focus', 'destroy')); return original(input, context);
  });
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: 'AUTO_INPUT_CHANGED' }); expect(await readdir(root)).toEqual(['events.txt']);
});
it('preserves marker line ranges over multibyte text, CRLF and final lines', async () => {
  const text = ('公开上下文\n' + ui + gc).replaceAll('\n', '\r\n').trimEnd(), bytes = Buffer.from(text);
  const receipt = await (await setup(text)).execute(); expect(receipt.exitCode).toBe(3);
  for (const candidate of (receipt.data as AutoData).classification) {
    for (const source of candidate.markers) {
      expect(hash(bytes.subarray(source.offset, source.offset + source.bytes))).toBe(source.sha256);
      expect(source.line).toBe(bytes.subarray(0, source.offset).toString().split('\n').length);
    }
  }
});
it('keeps at most 32 marker references while preserving the observed marker count', async () => {
  const receipt = await (await setup(ui.repeat(1024) + gc)).execute(), data = receipt.data as AutoData;
  expect(receipt.exitCode).toBe(3);
  expect(data.classification.find(item => item.analyzer === 'ui')).toMatchObject({ markerCount: 1024, markers: Array(32).fill(expect.any(Object)) });
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
});
it('projects a large selected report while preserving every event in the final artifact', async () => {
  const receipt = await (await setup(gc.repeat(10000))).execute();
  expect(receipt.exitCode).toBe(3); expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
  expect(receipt.data).toMatchObject({ selection: 'gc', analysisLocation: 'report-artifact' });
  const full = JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'));
  expect(full.analysis.events).toHaveLength(10000);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
  expect(JSON.stringify(receipt)).not.toMatch(/ohmate-auto-stage/);
});
it.each([
  ['', 'empty'], ['unknown\n', 'unrecognized'], ['{"nodes":[]}\n', 'JSON'], ['Reason:NewError\n', 'unknown type'],
  [ui + '...\n', 'truncation'], [ui + '[truncated]\n', 'marker'],
  ['\ufeff' + ui, 'BOM'], [ui + '\0', 'NUL'],
])('rejects unsupported auto inputs (%s: %s)', async text => {
  const receipt = await (await setup(text)).execute(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: expect.stringMatching(/^AUTO_/) });
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('rejects %s paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.txt');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/events.txt'); }
  if (kind === 'secret') { target = join(root, 'credentials.txt'); await writeFile(target, ui); }
  if (kind === 'extension') { target = join(root, 'snapshot.heapsnapshot'); await writeFile(target, ui); }
  const receipt = await execute({ log: target }); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: 'AUTO_INPUT_UNSAFE' });
});
it.each(['bytes', 'line-bytes', 'lines'] as const)('bounds %s before publication', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'line-bytes') { await writeFile(file, ui + ' '.repeat(16385)); }
  if (kind === 'lines') { await writeFile(file, ui + '\n'.repeat(100000)); }
  const receipt = await execute(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects noncanonical UTF8', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(ui), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects unrequested attachment or SDK discovery', async () => {
  const { file, execute } = await setup();
  const receipt = await execute({ log: file, directory: 'automatic', device: 'automatic', sdkModule: '@ohos.url' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('cancels before publication', async () => {
  const { root, file, runtime, context } = await setup(), controller = new AbortController();
  const pending = runtime.execute('analyze.auto', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort(); expect((await pending).exitCode).toBe(130); expect(await readdir(root)).toEqual(['events.txt']);
});
it('cancels during bounded classification yields', async () => {
  const { classifyLog } = await import('./classify.js'), controller = new AbortController();
  const pending = classifyLog(Buffer.from(ui.repeat(1024)), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('retains cancellation after selected parsing and cleans its owned derived files', async () => {
  const { root, file, context, runtime } = await setup(), controller = new AbortController();
  const module = await import('../ui/adapter.js'), original = module.analyzeUI;
  vi.spyOn(module, 'analyzeUI').mockImplementation(async (input, ctx) => {
    const result = await original(input, ctx); controller.abort(); return result;
  });
  const receipt = await runtime.execute('analyze.auto', { log: file }, { ...context, abortSignal: controller.signal });
  expect(receipt.exitCode).toBe(130); expect(receipt.artifacts).toEqual([]); expect(await readdir(root)).toEqual(['events.txt']);
});
it('uses the shared terminal parser', async () => {
  const { root, file } = await setup(); let output = ''; vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  const exit = await runTerminal(['analyze', 'auto', '--log', file, '--format', 'json'],
    { stdout: text => { output += text; }, stderr: () => undefined });
  expect(exit).toBe(3); expect(JSON.parse(output).data.selection).toBe('ui');
});
