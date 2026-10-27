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
import { ToolProvider } from '../../toolchain/tool-provider.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Documented HiLog envelope and explicit callback error field, composed rather than captured.
const contextLine = '12-27 00:13:20.100 51998 53853 I C01201/com.example/Media: preparing private-uri\n';
const errorLine = '12-27 00:13:24.434 51998 53853 E C01201/com.example/Media: Failed to prepare, error code: 5400102, message: private-token\n';
const log = contextLine + errorLine;
interface Source { line: number; offset: number; bytes: number; sha256: string }
interface Event { code: number; pid: number; tid: number; level: string; domain: string; tagSha256: string;
  timeSha256: string; messageSha256: string; source: Source }
interface Report { analyzer: string; completeness: string; input: { sha256: string; bytes: number; format: string };
  events: Event[]; summary: { eventCount: number; byCode: Record<string, number>; contextLineCount: number };
  sdk: { status: string; module: string; apiVersion: number; declarations: { sha256: string; bytes: number };
    matches: { code: number; category: string; messageSha256: string; source: Source }[]; metadata: { sha256: string }[] } | null;
  checks: { rootCause: string; captureIdentity: string; buildIdentity: string; apiAssociation: string; stateSequence: string };
  candidates: { code: number; evidenceLevel: string; alternatives: string[] }[]; coverage: { rawText: string; sdkMeaning: string } }
async function setup(value: string | Buffer = log) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-api-test-')); roots.push(root);
  const file = join(root, 'capture.log'); await writeFile(file, value);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
  return { root, file, context, runtime, execute: (input: unknown = { log: file }) => runtime.execute('analyze.api', input, context) };
}
it('registers a read-only offline API log subset without automatic SDK or device discovery', async () => {
  const { runtime } = await setup();
  expect(runtime.registry.get('analyze.api')).toMatchObject({ command: ['analyze', 'api'], risk: 'R0',
    requirements: [], idempotency: 'read', recovery: 'verify-and-retry' });
  expect(runtime.registry.get('analyze.api')!.description).toContain('subset');
});
it('binds raw error declarations and context counts without retaining message, tag or time', async () => {
  const { file, execute } = await setup(), receipt = await execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data).toMatchObject({ analyzer: 'api', completeness: 'incomplete', sdk: null,
    input: { sha256: hash(await readFile(file)), bytes: Buffer.byteLength(log), format: 'hilog-explicit-error-code-subset' },
    summary: { eventCount: 1, byCode: { '5400102': 1 }, contextLineCount: 1 },
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified',
      apiAssociation: 'not-established', stateSequence: 'not-analyzed' },
    coverage: { rawText: 'not-persisted', sdkMeaning: 'not-requested' } });
  expect(data.events[0]).toMatchObject({ code: 5400102, pid: 51998, tid: 53853, level: 'E', domain: '01201',
    tagSha256: hash('com.example/Media'), timeSha256: hash('12-27 00:13:24.434'),
    messageSha256: hash('Failed to prepare, error code: 5400102, message: private-token') });
  expect(data.candidates[0]).toMatchObject({ code: 5400102, evidenceLevel: 'single-feature' });
  expect(data.candidates[0].alternatives.length).toBeGreaterThan(1);
  expect(JSON.parse(await readFile(receipt.artifacts[0].path, 'utf8'))).toEqual(data);
  expect(hash(await readFile(receipt.artifacts[0].path))).toBe(receipt.artifacts[0].sha256);
  expect(JSON.stringify(receipt)).not.toMatch(/com\.example|private-uri|private-token|Failed to prepare|00:13:24/);
});
it.each(['code: 201', 'code=201', 'error code: 201', 'Error code: 201'])('reads only explicit %s markers', async marker => {
  const receipt = await (await setup(errorLine.replace('error code: 5400102', marker))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).events[0].code).toBe(201);
});
it('keeps repeated codes and multiple process declarations separate without causal association', async () => {
  const text = log + errorLine.replace('51998 53853 E', '2 3 F') + errorLine.replace('5400102', '801');
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.summary).toMatchObject({ eventCount: 3, byCode: { '5400102': 2, '801': 1 } });
  expect(data.events.map(event => event.pid)).toEqual([51998, 2, 51998]);
  expect(data.checks.apiAssociation).toBe('not-established');
});
it('ignores ordinary numbers, HTTP status and lower-level code text as context', async () => {
  const text = contextLine + errorLine.replace('error code: 5400102', 'HTTP status: 401; line 5400102') +
    errorLine.replace(' E ', ' W ') + errorLine;
  const receipt = await (await setup(text)).execute(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.summary).toMatchObject({ eventCount: 1, contextLineCount: 3 });
});
it('retains exact CRLF event ranges including a final unterminated line', async () => {
  const text = log.replaceAll('\n', '\r\n').trimEnd(), receipt = await (await setup(text)).execute();
  expect(receipt.exitCode).toBe(3);
  const bytes = Buffer.from(text);
  for (const event of (receipt.data as Report).events) {
    expect(hash(bytes.subarray(event.source.offset, event.source.offset + event.source.bytes))).toBe(event.source.sha256);
    expect(event.source.line).toBe(bytes.subarray(0, event.source.offset).toString().split('\n').length);
  }
});
const invalid = [
  ['', 'empty'], ['error code: 5400102', 'bare code'], [contextLine, 'context only'],
  [errorLine.replace(' E ', ' I '), 'lower level only'], [errorLine.replace('C01201/', 'Cxyz/'), 'bad domain'],
  [errorLine.replace('51998', '0'), 'zero pid'], [errorLine.replace('53853', '9007199254740992'), 'unsafe tid'],
  [errorLine.replace('12-27', '13-27'), 'bad month'], [errorLine.replace('00:13', '25:13'), 'bad hour'],
  [errorLine.replace('error code: 5400102', 'code: 0'), 'success code'],
  [errorLine.replace('5400102', '-1'), 'negative code'], [errorLine.replace('5400102', '01'), 'leading zero'],
  [errorLine.replace('5400102', '1.5'), 'fraction'], [errorLine.replace('5400102', '9e2'), 'exponent'],
  [errorLine.replace('5400102', '0x201'), 'hex'], [errorLine.replace('5400102', '9007199254740992'), 'overflow'],
  [errorLine.replace('5400102', 'unknown'), 'non-number'], [errorLine.replace('5400102', ''), 'missing code'],
  [errorLine + errorLine.replace('5400102', '201, code: 202'), 'ambiguous code'],
  [errorLine + errorLine.replace('5400102', '201, code: 201'), 'duplicate code'],
  [log + 'Generated by HiviewDFX@OpenHarmony\nReason:TypeError\n', 'mixed crash'],
  [log + '[truncated]\n', 'truncation'], [log + '...\n', 'ellipsis'], ['\ufeff' + log, 'BOM'], [log + '\0', 'NUL'],
] as const;
it.each(invalid)('refuses unsupported input (%s: %s) before any partial publication', async text => {
  const { root, execute } = await setup(text), receipt = await execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^API_/) });
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('rejects invalid UTF-8 rather than replacement decoding', async () => {
  const receipt = await (await setup(Buffer.concat([Buffer.from(log), Buffer.from([0xff])]))).execute();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it.each(['symlink', 'hardlink', 'directory', 'parent', 'secret', 'extension'] as const)('refuses %s inputs', async kind => {
  const { root, file, execute } = await setup(); let target = join(root, 'unsafe.log');
  if (kind === 'symlink') { await symlink(file, target); }
  if (kind === 'hardlink') { await link(file, target); }
  if (kind === 'directory') { await mkdir(target); }
  if (kind === 'parent') { await symlink(root, join(root, 'alias')); target = join(root, 'alias/capture.log'); }
  if (kind === 'secret') { target = join(root, 'credentials.log'); await writeFile(target, log); }
  if (kind === 'extension') { target = join(root, 'capture.json'); await writeFile(target, log); }
  const receipt = await execute({ log: target });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: 'API_INPUT_UNSAFE' });
});
it.each(['bytes', 'lines', 'line-bytes', 'events', 'tag'] as const)('bounds %s before publication', async kind => {
  const { file, execute } = await setup();
  if (kind === 'bytes') { await truncate(file, 16 * 1024 * 1024 + 1); }
  if (kind === 'lines') { await writeFile(file, log + contextLine.repeat(100000)); }
  if (kind === 'line-bytes') { await writeFile(file, log + 'x'.repeat(16385)); }
  if (kind === 'events') { await writeFile(file, errorLine.repeat(1025)); }
  if (kind === 'tag') { await writeFile(file, errorLine.replace('com.example/Media', 'x'.repeat(1025))); }
  const receipt = await execute(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('keeps the maximum admitted events within the shared receipt budget', async () => {
  const receipt = await (await setup(errorLine.repeat(1024))).execute();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).summary.eventCount).toBe(1024);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024 * 1024);
});
it('cancels without creating a report', async () => {
  const { root, file, context, runtime } = await setup(log + contextLine.repeat(10000)), controller = new AbortController();
  const pending = runtime.execute('analyze.api', { log: file }, { ...context, abortSignal: controller.signal });
  controller.abort(); expect((await pending).exitCode).toBe(130);
  expect(await readdir(root)).toEqual(['capture.log']);
});
it('parses at cancellable yields without persisting partial evidence', async () => {
  const { parseAPILog } = await import('./log.js'), controller = new AbortController();
  const pending = parseAPILog(Buffer.from(log + contextLine.repeat(10000)), controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it.each(['../secret', '@ohos.media/../../secret', '@ohos.media.d.ts', '@kit.MediaKit'])('refuses SDK module path %s', async sdkModule => {
  const { file, execute } = await setup(), receipt = await execute({ log: file, sdkModule });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('refuses implicit device, source and attachment discovery parameters', async () => {
  const { file, execute } = await setup(), receipt = await execute({ log: file, device: 'automatic', source: 'automatic' });
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
});
it('uses the shared terminal parser and bounded JSON receipt', async () => {
  const { root, file } = await setup(); let output = '';
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'data'));
  const exit = await runTerminal(['analyze', 'api', '--log', file, '--format', 'json'],
    { stdout: text => { output += text; }, stderr: () => undefined });
  expect(exit).toBe(3); expect(JSON.parse(output).data.input.sha256).toBe(hash(await readFile(file)));
});
const declarations = 'declare namespace media {\n/**\n * @throws { BusinessError } 5400101 - No memory. Return by promise.\n' +
  ' * @throws { BusinessError } 5400102 - Operation not allowed. Returned by promise.\n' +
  ' * @throws { BusinessError } 201 - Permission denied.\n' +
  ' * @throws { BusinessError } 5400102 Operation not allowed. Returned by callback.\n' +
  ' * @throws { BusinessError } 5400102 - Unclassified private-sdk-description.\n */\n function play(): void;\n}\n';
async function sdkSetup(value = declarations) {
  const fixture = await setup(errorLine + errorLine.replace('5400102', '5400101'));
  const base = join(fixture.root, 'studio/Contents/sdk/default'), api = join(base, 'openharmony/ets/api');
  await mkdir(api, { recursive: true });
  const pkg = join(base, 'sdk-pkg.json'), ets = join(base, 'openharmony/ets/oh-uni-package.json');
  await writeFile(pkg, '{"data":{"apiVersion":"26","platformVersion":"26.0.0","version":"26.0.0.105"}}');
  await writeFile(ets, '{"apiVersion":"26","platformVersion":"26.0.0","version":"26.0.0.105"}');
  const declaration = join(api, '@ohos.multimedia.media.d.ts'); await writeFile(declaration, value);
  vi.spyOn(ToolProvider, 'new').mockResolvedValue(ToolProvider.fromIDE(join(fixture.root, 'studio')));
  return { ...fixture, declaration, pkg, ets,
    executeSDK: () => fixture.execute({ log: fixture.file, sdkModule: '@ohos.multimedia.media' }) };
}
it('binds current SDK declarations by raw hashes and keeps code categories as unassociated candidates', async () => {
  const { declaration, executeSDK, pkg, ets } = await sdkSetup(), receipt = await executeSDK(), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3);
  expect(data.sdk).toMatchObject({ status: 'declaration-candidates', module: '@ohos.multimedia.media', apiVersion: 26,
    declarations: { sha256: hash(await readFile(declaration)), bytes: Buffer.byteLength(declarations) } });
  expect(data.sdk!.metadata.map(item => item.sha256)).toEqual([hash(await readFile(pkg)), hash(await readFile(ets))]);
  expect(data.sdk!.matches.map(item => [item.code, item.category])).toEqual([
    [5400101, 'no-memory'], [5400102, 'operation-not-allowed'], [5400102, 'operation-not-allowed'], [5400102, 'unclassified'] ]);
  expect(data.coverage.sdkMeaning).toBe('declaration-candidates-only');
  expect(data.checks.apiAssociation).toBe('not-established');
  expect(data.checks.rootCause).toBe('not-established');
  expect(JSON.stringify(receipt)).not.toMatch(/private-sdk-description|function play|No memory|Operation not allowed|studio\/Contents/);
  const bytes = await readFile(declaration);
  for (const row of data.sdk!.matches) {
    expect(hash(bytes.subarray(row.source.offset, row.source.offset + row.source.bytes))).toBe(row.source.sha256);
    expect(row.source.line).toBe(bytes.subarray(0, row.source.offset).toString().split('\n').length);
  }
});
it('keeps unmatched codes unknown and does not infer API meaning from a domain or code prefix', async () => {
  const { file, execute } = await sdkSetup();
  await writeFile(file, errorLine.replace('5400102', '9200'));
  const receipt = await execute({ log: file, sdkModule: '@ohos.multimedia.media' }), data = receipt.data as Report;
  expect(receipt.exitCode).toBe(3); expect(data.sdk!.status).toBe('code-not-declared');
  expect(data.sdk!.matches).toEqual([]); expect(data.checks.apiAssociation).toBe('not-established');
});
it.each(['api-version', 'platform-version', 'package-version', 'metadata-json', 'missing-metadata', 'missing-module',
  'declaration-symlink', 'declaration-hardlink', 'metadata-symlink', 'BOM', 'truncated-comment', 'sdk-bytes', 'sdk-matches'] as const)(
  'rejects %s SDK evidence without publishing a log-only fallback', async kind => {
    const { declaration, executeSDK, ets } = await sdkSetup();
    if (kind === 'api-version') { await writeFile(ets, '{"apiVersion":25,"platformVersion":"26.0.0","version":"26.0.0.105"}'); }
    if (kind === 'platform-version') { await writeFile(ets, '{"apiVersion":26,"platformVersion":"25.0.0","version":"26.0.0.105"}'); }
    if (kind === 'package-version') { await writeFile(ets, '{"apiVersion":26,"platformVersion":"26.0.0","version":"26.0.0.104"}'); }
    if (kind === 'metadata-json') { await writeFile(ets, '{'); }
    if (kind === 'missing-metadata') { await rm(ets); }
    if (kind === 'missing-module') { await rm(declaration); }
    if (kind === 'declaration-symlink') { await rm(declaration); await symlink(ets, declaration); }
    if (kind === 'declaration-hardlink') { await link(declaration, declaration + '.copy'); }
    if (kind === 'metadata-symlink') { await rm(ets); await symlink(declaration, ets); }
    if (kind === 'BOM') { await writeFile(declaration, '\ufeff' + declarations); }
    if (kind === 'truncated-comment') { await writeFile(declaration, declarations.replace(' */', '')); }
    if (kind === 'sdk-bytes') { await truncate(declaration, 4 * 1024 * 1024 + 1); }
    if (kind === 'sdk-matches') { await writeFile(declaration, '/**\n' + ' * @throws { BusinessError } 5400102 - Operation not allowed.\n'.repeat(513) + ' */\n'); }
    const receipt = await executeSDK(); expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
    expect(receipt.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringMatching(/^API_SDK_/) });
  });
it('cancels while scanning a bounded SDK declaration file without publishing', async () => {
  const { readAPISDK } = await import('./sdk.js'), { runtime, context, file } = await sdkSetup();
  const provider = await ToolProvider.new(), controller = new AbortController();
  const pending = readAPISDK('@ohos.multimedia.media', new Set([5400102]), provider, controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const stopped = await runtime.execute('analyze.api', { log: file }, { ...context, abortSignal: controller.signal });
  expect(stopped.exitCode).toBe(130);
});
it.each(['constructor', '__proto__', 'toString'])('keeps SDK description %s unclassified', async description => {
  const { executeSDK } = await sdkSetup('/**\n * @throws { BusinessError } 5400102 - ' + description + '.\n */\n');
  const receipt = await executeSDK();
  expect(receipt.exitCode).toBe(3); expect((receipt.data as Report).sdk!.matches[0].category).toBe('unclassified');
});
it('rejects array-valued API versions even when both metadata files coerce to the same number', async () => {
  const { pkg, ets, executeSDK } = await sdkSetup();
  await writeFile(pkg, '{"data":{"apiVersion":["26"],"platformVersion":"26.0.0","version":"26.0.0.105"}}');
  await writeFile(ets, '{"apiVersion":["26"],"platformVersion":"26.0.0","version":"26.0.0.105"}');
  const receipt = await executeSDK();
  expect(receipt.exitCode).toBe(4); expect(receipt.artifacts).toEqual([]);
  expect(receipt.data).toMatchObject({ message: 'API_SDK_METADATA_UNSUPPORTED' });
});
