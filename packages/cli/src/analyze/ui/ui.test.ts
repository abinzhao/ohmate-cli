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
// Public 5.0.3 emitter layout composed for tests, without actual capture.
const event = (status = 'foreground', current = -2, tracked = 100000, reason = 'singleton', instance = 100000) =>
  `01-01 10:00:00.000 12 13 I C03900/Ace: [(${current}:${tracked}:${reason})] [com.example.private][entry][${instance}]: window ${status}\n`;
const sample = event('destroy') + event('background', 100000, 100000, 'scope', 100001);
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface UIData {
  analyzer: string; completeness: string;
  input: { sha256: string; bytes: number; format: string };
  events: { status: string; currentId: number; trackedId: number; reason: string; instanceId: number;
    pid: number; tid: number; bundleSha256: string; moduleSha256: string; timeSha256: string;
    source: Source; prefix: { kind: string; sourceLine: number | null } }[];
  summary: { eventCount: number; byStatus: Record<string, number>; contextRangeEventCount: number };
  checks: { rootCause: string; captureIdentity: string; buildIdentity: string; runtimeVersion: string;
    lifecycleState: string; crossEventAssociation: string; responsibility: string };
  candidates: { code: string; eventCount: number; evidenceLevel: string; alternatives: string[] }[];
}
async function setup(text: string | Buffer = sample) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-ui-analysis-')); roots.push(root);
  const file = join(root, 'events.txt'); await writeFile(file, text);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.ui', input, context) };
}
it('registers offline UI event analysis as a read-only bounded subset', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.ui')).toMatchObject({ command: ['analyze', 'ui'], risk: 'R0',
    requirements: [], idempotency: 'read', recovery: 'verify-and-retry' });
});
it('binds raw events without certifying lifecycle state or cross-event causality', async () => {
  const { file, execute } = await setup(), receipt = await execute(), data = receipt.data as UIData;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'ui', completeness: 'incomplete',
    input: { sha256: hash(await readFile(file)), bytes: Buffer.byteLength(sample), format: 'ace-window-lifecycle-5.0.3-subset' },
    summary: { eventCount: 2, byStatus: { destroy: 1, background: 1 }, contextRangeEventCount: 1 },
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified',
      runtimeVersion: 'unverified', lifecycleState: 'not-inferred', crossEventAssociation: 'not-performed', responsibility: 'undetermined' } });
  expect(data.events[0]).toMatchObject({ status: 'destroy', currentId: -2, trackedId: 100000,
    reason: 'singleton', instanceId: 100000, pid: 12, tid: 13, bundleSha256: hash('com.example.private'),
    moduleSha256: hash('entry'), timeSha256: hash('01-01 10:00:00.000'), prefix: { kind: 'release', sourceLine: null } });
  expect(data.candidates[0]).toMatchObject({ code: 'context-id-in-ui-instance-range', evidenceLevel: 'single-feature', eventCount: 1 });
  expect(data.candidates[0].alternatives.length).toBeGreaterThan(1);
  expect(JSON.stringify(receipt)).not.toMatch(/com\.example|01-01 10:00|entry/);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
});
it.each(['focus', 'unfocus', 'foreground', 'background', 'destroy'])('preserves the %s notification without inventing a fault', async status => {
  const receipt = await (await setup(event(status))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).events[0].status).toBe(status);
  expect((receipt.data as UIData).candidates).toEqual([]);
});
it.each(['scope', 'active', 'default', 'singleton', 'foreground', 'undefined'])('uses the producer reason %s', async reason => {
  const receipt = await (await setup(event('focus', -2, 100000, reason))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).events[0].reason).toBe(reason);
});
it('accepts instance zero and signed int32 context declarations', async () => {
  const receipt = await (await setup(event('focus', -2147483648, 2147483647, 'undefined', 0))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).events[0]).toMatchObject({
    currentId: -2147483648, trackedId: 2147483647, instanceId: 0 });
});
it('retains debug source coordinates separately from capture/build evidence', async () => {
  const text = event('focus').replace('[(-2:100000:singleton)]', '[ui_content_impl.cpp(2214)-(-2:100000:singleton)]');
  const receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3);
  expect((receipt.data as UIData).events[0].prefix).toEqual({ kind: 'debug', sourceLine: 2214 });
  expect((receipt.data as UIData).checks.buildIdentity).toBe('unverified');
});
it('counts context lines without inferring state, transition, time or frequency', async () => {
  const text = 'public context\n' + event('background') + '\n' + event('focus').replace('10:00:00.000', '09:00:00.000');
  const receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3); expect(receipt.data).toMatchObject({ contextLineCount: 2,
    summary: { eventCount: 2 }, checks: { lifecycleState: 'not-inferred' } });
});
it('preserves duplicate observed notifications instead of claiming unique instances', async () => {
  const receipt = await (await setup(event() + event())).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).summary.eventCount).toBe(2);
});
it.each([[99999, 0], [100000, 1], [999999, 1], [1000000, 0]] as const)('bounds the documented context feature %d', async (id, count) => {
  const receipt = await (await setup(event('foreground', id, id, 'scope'))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).summary.contextRangeEventCount).toBe(count);
});
it('preserves CRLF, multibyte context and final-line byte ranges', async () => {
  const text = ('公开上下文\n' + sample).replaceAll('\n', '\r\n').trimEnd();
  const receipt = await (await setup(text)).execute(), bytes = Buffer.from(text);
  expect(receipt.exitCode).toBe(3);
  for (const item of (receipt.data as UIData).events) {
    expect(hash(bytes.subarray(item.source.offset, item.source.offset + item.source.bytes))).toBe(item.source.sha256);
    expect(item.source.line).toBe(bytes.subarray(0, item.source.offset).toString().split('\n').length);
  }
});
const invalid = [
  ['', 'empty'], ['unrelated\n', 'wrong type'], [sample.replaceAll('C03900', 'C03901'), 'wrong domain'],
  [sample.replaceAll('/Ace:', '/AceText:'), 'wrong tag'], [sample.replaceAll(' I C', ' E C'), 'wrong level'],
  [sample.replace('scope', 'scoped'), 'document source mismatch'], [sample.replace('singleton', 'unknown'), 'unknown reason'],
  [sample.replace('destroy', 'hide'), 'unknown status'], [sample.replace('window destroy', 'window'), 'truncated event'],
  [sample.replace('window destroy', 'window destroy appended private text'), 'appended text'],
  [sample.replace('100001', '-1'), 'negative instance'], [sample.replace('-2:', '2147483648:'), 'int32 overflow'],
  [sample.replace('100001', '9007199254740992'), 'unsafe integer'], [sample.replace('-2:', '-0:'), 'negative zero'],
  [sample.replace('12 13', '0 13'), 'zero pid'], [sample.replace('12 13', '12 9007199254740992'), 'unsafe tid'],
  [sample.replace('01-01', '02-30'), 'invalid date'], [sample.replace('10:00', '25:00'), 'invalid clock'],
  [sample.replace('com.example.private', 'x'.repeat(1025)), 'name limit'],
  [sample.replace('entry', ''), 'missing module'], [sample.replace('[(100000:100000:scope)]', '[unknown.cpp(1)-(100000:100000:scope)]'), 'unknown debug file'],
  [sample.replace('[(-2:100000:singleton)]', '[ui_content_impl.cpp(0)-(-2:100000:singleton)]'), 'zero debug coordinate'],
  [sample + 'Reason:Signal:SIGSEGV\n', 'mixed crash'], [sample + 'Generated by HiviewDFX\n', 'faultlog envelope'],
  [sample + '...\n', 'ellipsis'], [sample + '[truncated]\n', 'truncation'],
  ['\ufeff' + sample, 'BOM'], [sample + '\0', 'NUL'],
] as const;
it.each(invalid)('rejects unsupported UI input (%s: %s) before publication', async text => {
  const { root, execute } = await setup(text), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^UI_ANALYSIS_/) });
  expect(await readdir(root)).toEqual(['events.txt']);
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('rejects %s input paths', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.txt');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/events.txt'); }
  if (kind === 'secret') { target = join(root, 'credentials.txt'); await writeFile(target, sample); }
  if (kind === 'extension') { target = join(root, 'events.json'); await writeFile(target, sample); }
  const receipt = await execute({ log: target }); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: 'UI_ANALYSIS_INPUT_UNSAFE' });
});
it.each(['bytes', 'line-bytes', 'lines', 'events'] as const)('bounds %s before publishing', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'line-bytes') { await writeFile(file, sample + ' '.repeat(16385)); }
  if (kind === 'lines') { await writeFile(file, sample + '\n'.repeat(100000)); }
  if (kind === 'events') { await writeFile(file, event().repeat(1025)); }
  const receipt = await execute(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('bounds the maximum admitted events in the shared receipt budget', async () => {
  const receipt = await (await setup(event().repeat(1024))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as UIData).events).toHaveLength(1024);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
});
it('rejects invalid UTF8 without replacement decoding', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(sample), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('rejects automatic device, screenshot or directory discovery', async () => {
  const { file, execute } = await setup();
  const receipt = await execute({ log: file, device: 'automatic', directory: 'automatic', screenshot: 'automatic' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('cancels before publication', async () => {
  const { root, file, runtime, context } = await setup(), controller = new AbortController();
  const pending = runtime.execute('analyze.ui', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort(); expect((await pending).exitCode).toBe(130); expect(await readdir(root)).toEqual(['events.txt']);
});
it('rejects a lifecycle record cut before its window marker without publishing remaining events', async () => {
  const { root, execute } = await setup(event() + event().replace('window foreground\n', 'win'));
  const receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(await readdir(root)).toEqual(['events.txt']);
});
it('cancels during bounded parser yields', async () => {
  const { parseUIEvents } = await import('./parser.js'), controller = new AbortController();
  const pending = parseUIEvents(Buffer.from(event().repeat(1024)), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('uses the shared terminal parser', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  const exit = await runTerminal(['analyze', 'ui', '--log', file, '--format', 'json'],
    { stdout: text => { output += text; }, stderr: () => undefined });
  expect(exit).toBe(3); expect(JSON.parse(output).data.input.sha256).toBe(hash(await readFile(file)));
});
