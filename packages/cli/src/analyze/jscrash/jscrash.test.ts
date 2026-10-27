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
// Official JS Crash specification, annotations removed; this is not device capture.
const frame = '    at onPageShow entry (entry/src/main/ets/pages/Index.ets:7:13)\n';
const log = 'Device info:XXX\nBuild info:XXX-XXXX\n' +
  'Fingerprint:ed1811f3f5ae13c7262b51aab73ddd01df95b2c64466a204e0d70e6461cf1697\n' +
  'Timestamp:XXXX-XX-XX XX:XX:XX.XXX\nModule name:com.example.myapplication\nVersion:1.0.0\n' +
  'VersionCode:1000000\nPid:579\nUid:0\nReason:TypeError\nError name:TypeError\n' +
  'Error message:Cannot read property c of undefined\nCannot get SourceMap info, dump raw stack:\nStacktrace:\n' + frame;
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface Report {
  analyzer: string; completeness: string; input: { sha256: string; bytes: number; format: string };
  error: { type: string; classificationBasis: string; message: { sha256: string; bytes: number }; code: number | null };
  fields: Record<string, { sha256: string; bytes: number }>;
  fieldSources: Record<string, Source>;
  frames: { ordinal: number; declaredIndex: number | null; functionSha256: string; locationSha256: string;
    line: number; column: number; locationForm: string; source: Source }[];
  summary: { frameCount: number; numberedFrameCount: number; releaseFormCount: number };
  checks: { captureIdentity: string; buildIdentity: string; rootCause: string; sourceMap: string;
    errorCodeMeaning: string; applicationOwnership: string; snapshotAssociation: string };
  coverage: { missingFields: string[]; sections: { name: string; source: Source }[]; rawStackDeclared: boolean;
    fingerprintMeaning: string; rawText: string; supplementaryAnalysis: string };
  candidates: { code: string; evidenceLevel: string; alternatives: string[] }[];
}
async function setup(value: string | Buffer = log) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-jscrash-test-')); roots.push(root);
  const file = join(root, 'capture.log'); await writeFile(file, value);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.jscrash', input, context) };
}
it('registers a read-only JS faultlog subset', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.jscrash')).toMatchObject({ command: ['analyze', 'jscrash'], risk: 'R0',
    requirements: [], idempotency: 'read', recovery: 'verify-and-retry' });
  expect(runtime.registry.get('analyze.jscrash')!.description).toContain('subset');
});
it('binds official declared fields and raw coordinates without establishing build or source identity', async () => {
  const { file, execute } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'jscrash', completeness: 'incomplete',
    input: { sha256: hash(await readFile(file)), bytes: Buffer.byteLength(log), format: 'oh-jscrash-js-stack-subset' },
    error: { type: 'TypeError', classificationBasis: 'reason-and-error-name', code: null,
      message: { sha256: hash('Cannot read property c of undefined'), bytes: 35 } },
    fields: { 'Module name': { sha256: hash('com.example.myapplication') } },
    summary: { frameCount: 1, numberedFrameCount: 0, releaseFormCount: 0 },
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', rootCause: 'not-established',
      sourceMap: 'not-resolved', errorCodeMeaning: 'not-mapped', applicationOwnership: 'not-established', snapshotAssociation: 'not-performed' },
    coverage: { rawStackDeclared: true, fingerprintMeaning: 'fault-clustering-hash-not-build-id', rawText: 'not-persisted' } });
  expect(data.frames[0]).toMatchObject({ ordinal: 0, declaredIndex: null, functionSha256: hash('onPageShow entry'),
    locationSha256: hash('entry/src/main/ets/pages/Index.ets'), line: 7, column: 13, locationForm: 'path' });
  expect(receipt.artifacts).toHaveLength(1);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
  expect(data.candidates[0]).toMatchObject({ code: 'js-error-declared', evidenceLevel: 'single-feature' });
  expect(data.candidates[0].alternatives.length).toBeGreaterThan(1);
});
it('preserves release-form locations, duplicate frames and original numbered order', async () => {
  const text = log.replace(frame, '#00 at onPageShow (entry|har1|1.0.0|src/main/ets/pages/Index.ts:7:13)\n' +
    '#01 at onPageShow (entry|har1|1.0.0|src/main/ets/pages/Index.ts:7:13)\n');
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.summary).toMatchObject({ frameCount: 2, numberedFrameCount: 2, releaseFormCount: 2 });
  expect(data.frames.map(row => row.declaredIndex)).toEqual([0, 1]);
  expect(data.frames[0]).toMatchObject({ locationSha256: hash('entry|har1|1.0.0|src/main/ets/pages/Index.ts'),
    locationForm: 'release-module-path', functionSha256: hash('onPageShow') });
});
it('does not parse supplementary stacks or anchored exception text in HiLog as primary evidence', async () => {
  const text = log + 'HybridStack:\n#00 pc 00000000004a814c /system/lib64/libark_jsruntime.so\n' +
    '========SubmitterStacktrace========\n#00 at private (secret.ts:1:1)\nHiLog:\nError message:private-token\nat fake (fake.ts:1:1)\n';
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.frames).toHaveLength(1);
  expect(data.coverage.sections.map(row => row.name)).toEqual(['HybridStack', 'SubmitterStacktrace', 'HiLog']);
  expect(data.coverage.supplementaryAnalysis).toBe('presence-only');
  expect(JSON.stringify(receipt)).not.toMatch(/private-token|secret\.ts|fake\.ts|Cannot read property|Index\.ets|XXX-XXXX/);
  expect(await readFile(receipt.artifacts[0].path, 'utf8')).not.toMatch(/private-token|secret\.ts|fake\.ts|Cannot read property|Index\.ets/);
});
it.each(['reason', 'name'] as const)('classifies only the remaining declared %s field and reports missing metadata', async kind => {
  const text = 'Error message:x\n' + (kind === 'reason' ? 'Reason:Error\n' : 'Error name:Error\n') + 'Stacktrace:\n' + frame;
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.error.classificationBasis).toBe(kind === 'reason' ? 'reason' : 'error-name');
  expect(data.coverage.missingFields).toContain('Pid'); expect(data.checks.sourceMap).toBe('not-resolved');
});
it('keeps the API code numeric but does not invent Kit meaning or authority', async () => {
  const receipt = await (await setup(log.replace('Stacktrace:', 'Error code:401\nStacktrace:'))).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as Report).error.code).toBe(401); expect((receipt.data as Report).checks.errorCodeMeaning).toBe('not-mapped');
});
it.each(['OutOfMemoryError', 'OOMError', 'BusinessError', 'EvalError', 'TerminationError', 'AggregateError'])(
  'keeps declared %s separate from root cause and heap association', async type => {
    const receipt = await (await setup(log.replaceAll('TypeError', type))).execute(), data = receipt.data as Report;
    expect(receipt.exitCode).toBe(3); expect(data.error.type).toBe(type); expect(data.checks.snapshotAssociation).toBe('not-performed');
    expect(data.checks.rootCause).toBe('not-established');
  });
it('preserves CRLF, unterminated final lines and exact field/stack source hashes', async () => {
  const text = log.replaceAll('\n', '\r\n').trimEnd(), receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3);
  const data = receipt.data as Report, bytes = Buffer.from(text);
  for (const source of [...Object.values(data.fieldSources), ...data.frames.map(row => row.source)]) {
    expect(hash(bytes.subarray(source.offset, source.offset + source.bytes))).toBe(source.sha256);
    expect(source.line).toBe(bytes.subarray(0, source.offset).toString().split('\n').length);
  }
});
const invalid = [
  ['', 'empty'], [frame, 'bare stack'], ['Reason:TypeError\n' + frame, 'no sections'],
  [log.replace('Reason:TypeError\nError name:TypeError\n', ''), 'message does not assert type'],
  [log.replace('Reason:TypeError', 'Reason:Signal:SIGSEGV'), 'native reason'],
  [log.replace('Reason:TypeError', 'Reason:RangeError'), 'type conflict'],
  [log.replaceAll('TypeError', 'FutureError'), 'unknown type'],
  [log.replace('Error message:Cannot read property c of undefined\n', ''), 'message missing'],
  [log + 'Reason:TypeError\n', 'header after primary stack'],
  [log.replace('Pid:579', 'Pid:-1'), 'bad pid'], [log.replace('Uid:0', 'Uid:1.5'), 'bad uid'],
  [log.replace('VersionCode:1000000', 'VersionCode:9007199254740992'), 'version overflow'],
  [log.replace('Stacktrace:', 'Error code:1e3\nStacktrace:'), 'invalid code'],
  [log.replace('Stacktrace:', 'Error code:401\nError code:401\nStacktrace:'), 'duplicate field'],
  [log.replace('Fingerprint:ed1811f3f5ae13c7262b51aab73ddd01df95b2c64466a204e0d70e6461cf1697', 'Fingerprint:bad'), 'bad fingerprint'],
  [log.replace(frame, ''), 'empty primary stack'],
  [log.replace(frame, 'HybridStack:\n#00 pc 00000000001a1 /system/lib.so\n'), 'no JS primary frames'],
  [log.replace(frame, '#00 pc 00000000001a1 /system/lib.so\n'), 'native primary unsupported'],
  [log.replace(frame, frame.trimEnd() + ' trailing\n'), 'frame trailing text'],
  [log.replace(':7:13)', ':9007199254740992:13)'), 'line overflow'],
  [log.replace(':7:13)', ':0:13)'), 'line zero'],
  [log.replace(frame, '#01 ' + frame.trimStart()), 'nonzero first index'],
  [log.replace(frame, '#00 ' + frame.trimStart() + '#02 ' + frame.trimStart()), 'index gap'],
  [log.replace(frame, '#00 ' + frame.trimStart() + frame), 'mixed numbering'],
  [log + 'Stacktrace:\n' + frame, 'duplicate primary section'],
  [log + 'HybridStack:\nx\nHybridStack:\nx\n', 'duplicate supplementary section'],
  [log + 'HiLog:\nx\n' + log, 'concatenated crash'],
  [log.replace('Cannot get SourceMap info, dump raw stack:', 'continued message text'), 'multiline message unsupported'],
  [log.replace('Cannot get SourceMap info, dump raw stack:', 'Cannot get SourceMap info, dump raw stack:\ncontinued message text'), 'unknown error trailer'],
  [log.replace('Stacktrace:', 'Stacktrace:\n...\n'), 'truncated stack marker'],
  ['Reason:Error\nError message:x\nStacktrace:\n' + frame + 'HiLog:\n' + log, 'second envelope after headerless crash'],
  [log + 'Cannot get SourceMap info, dump raw stack:\n', 'marker after primary frame'],
  ['\ufeff' + log, 'BOM'], [log + '\0', 'NUL'],
] as const;
it.each(invalid)('rejects %s (%s) without publishing a partial report', async text => {
  const { root, execute } = await setup(text), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^JSCRASH_/) });
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('rejects invalid UTF-8 without replacement decoding', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(log), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('refuses %s input paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.log');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/capture.log'); }
  if (kind === 'secret') { target = join(root, 'credentials.log'); await writeFile(target, log); }
  if (kind === 'extension') { target = join(root, 'capture.json'); await writeFile(target, log); }
  const receipt = await execute({ log: target });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: 'JSCRASH_INPUT_UNSAFE' });
});
it.each(['bytes', 'lines', 'line-bytes', 'frames', 'name', 'message'] as const)('refuses excessive %s', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'lines') { await writeFile(file, log + 'HiLog:\n' + 'x\n'.repeat(100000)); }
  if (kind === 'line-bytes') { await writeFile(file, log + 'HiLog:\n' + 'x'.repeat(16385)); }
  if (kind === 'frames') { await writeFile(file, log + frame.repeat(256)); }
  if (kind === 'name') { await writeFile(file, log.replace('onPageShow entry', 'x'.repeat(1025))); }
  if (kind === 'message') { await writeFile(file, log.replace('Cannot read property c of undefined', 'x'.repeat(4097))); }
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('admits all 256 primary frames without truncation and bounds the receipt', async () => {
  const receipt = await (await setup(log + frame.repeat(255))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).frames).toHaveLength(256);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
});
it('observes cancellation during yielded parsing without an artifact', async () => {
  const { root, file, runtime, context } = await setup(log + 'HiLog:\n' + 'x\n'.repeat(10000)), controller = new AbortController();
  const pending = runtime.execute('analyze.jscrash', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort(); expect((await pending).exitCode).toBe(130);
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('observes parser cancellation at the first yield', async () => {
  const { parseJSLog } = await import('./log.js'), controller = new AbortController();
  const pending = parseJSLog(Buffer.from(log + 'HiLog:\n' + 'x\n'.repeat(10000)), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects implicit symbol options without writing any evidence', async () => {
  const { file, execute } = await setup(), receipt = await execute({ log: file, sourceMap: 'automatic' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('uses the real terminal parser for the same raw evidence', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  try {
    const code = await runTerminal(['analyze', 'jscrash', '--log', file, '--format', 'json'],
      { stdout: text => { output += text; }, stderr: () => undefined });
    expect(code).toBe(3); expect(JSON.parse(output).data.input.sha256).toBe(hash(await readFile(file)));
  } finally { vi.unstubAllEnvs(); }
});
