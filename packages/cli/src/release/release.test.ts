/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { analyzeDependencies } from '../dependency/index.js';
import { cycloneDx } from '../dependency/sbom.js';

let root: string;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-release-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(path: string, text: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
}
async function setup() {
  await put('build-profile.json5', JSON.stringify({ app: { products: [{ name: 'default' }] },
    modules: [{ name: 'phone', srcPath: './products/phone', targets: [{ name: 'default' }] }] }));
  await put('AppScope/app.json5', '{"app":{"bundleName":"org.example.release","versionCode":1}}');
  await put('oh-package.json5', '{"name":"fixture","version":"1.0.0"}');
  await put('products/phone/oh-package.json5', '{"name":"phone","version":"1.0.0"}');
  await put('products/phone/src/main/module.json5', '{"module":{"name":"phone","type":"entry","abilities":[{"name":"Main","exported":true}]}}');
  await put('products/phone/build-profile.json5', JSON.stringify({
    buildOption: { debuggable: false, nativeLib: { debugSymbol: { strip: true } } },
    buildOptionSet: [{ name: 'release', arkOptions: { obfuscation: { ruleOptions: { enable: true, files: ['./obfuscation-rules.txt'] } } } }],
  }));
  await put('products/phone/obfuscation-rules.txt', '-enable-toplevel-obfuscation\n');
  await put('products/phone/src/main/ets/Main.ets', "const greeting = 'Hello';\n");
  return { runtime: await createRuntime(), context: await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private'), locale: 'zh-CN' }) };
}
async function hap(extra: Record<string, string | Buffer> = {}, debuggable = false) {
  const zip = new AdmZip();
  zip.addFile('module.json', Buffer.from(JSON.stringify({ app: { bundleName: 'org.example.release', debuggable },
    module: { name: 'phone', type: 'entry' } })));
  zip.addFile('ets/modules.abc', Buffer.from('fixture bytecode, no semantic purity claim'));
  for (const [path, bytes] of Object.entries(extra)) { zip.addFile(path, Buffer.from(bytes)); }
  await put('products/phone/build/default/outputs/default/phone.hap', zip.toBuffer());
  return 'products/phone/build/default/outputs/default/phone.hap';
}
async function manifest(path: string, buildMode = 'release', kind = 'hap') {
  const source = 'products/phone/src/main/ets/Main.ets';
  const value = { schemaVersion: '1.0', completeness: 'incomplete', product: 'default', modules: ['phone@default'], buildMode,
    inputs: [{ path: source, sha256: hash(await readFile(join(root, source))) }],
    artifacts: [{ path: join(root, path), sha256: hash(await readFile(join(root, path))), kind }],
    sourceDrift: [], missing: ['full-compiler-input-closure'], tools: {}, dependencies: { components: [], relationships: [], inputs: [] } };
  await put('build/manifest.json', JSON.stringify(value)); return 'build/manifest.json';
}
async function app(nestedDebug = false) {
  const inner = new AdmZip();
  inner.addFile('module.json', Buffer.from(JSON.stringify({
    app: { bundleName: 'org.example.release', debug: nestedDebug, buildMode: nestedDebug ? 'debug' : 'release' },
    module: { name: 'phone', type: 'entry' },
  })));
  inner.addFile('ets/modules.abc', Buffer.from('fixture bytecode'));
  const outer = new AdmZip();
  outer.addFile('phone.hap', inner.toBuffer());
  outer.addFile('pack.info', Buffer.from('{"summary":{}}'));
  await put('build/outputs/default/phone.app', outer.toBuffer());
  return 'build/outputs/default/phone.app';
}
interface Report { ready: boolean; gates: { id: string; status: string; findings: { code: string; evidence: unknown[] }[] }[]; inputs: unknown[] }
const gate = (data: unknown, id: string) => (data as Report).gates.find((item) => item.id === id)!;

it('registers fourteen evidence gates and never treats missing release artifacts as a pass', async () => {
  const s = await setup(), result = await s.runtime.execute('release.verify', {}, s.context);
  expect(result.exitCode).toBe(3); expect((result.data as Report).ready).toBe(false);
  expect((result.data as Report).gates).toHaveLength(14);
  expect(gate(result.data, 'release.build-mode').status).toBe('incomplete');
});

it('reads a real ZIP HAP and its bound build manifest but preserves missing semantic producer evidence', async () => {
  const s = await setup(), path = await hap(), m = await manifest(path);
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(result.exitCode).toBe(3);
  expect(gate(result.data, 'release.build-mode').status).toBe('passed');
  expect(gate(result.data, 'release.package-content').status).toBe('passed');
  expect(gate(result.data, 'release.permissions').status).toBe('incomplete');
  expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: 'release-report', sha256: expect.any(String) }));
});

it('derives immutable JSON, SARIF and HTML from the same final-package facts without upgrading missing purity evidence', async () => {
  const s = await setup(), path = await hap({}, true);
  const result = await s.runtime.execute('release.verify', { manifest: await manifest(path) }, s.context);
  expect(result.exitCode).toBe(1);
  const report = result.artifacts!.find(item => item.kind === 'release-report')!;
  const sarif = result.artifacts!.find(item => item.kind === 'release-purity-sarif');
  const html = result.artifacts!.find(item => item.kind === 'release-purity-html');
  expect(sarif).toBeDefined(); expect(html).toBeDefined();
  const facts = JSON.parse(await readFile(report.path, 'utf8'));
  const value = JSON.parse(await readFile(sarif!.path, 'utf8'));
  expect(value).toMatchObject({ version: '2.1.0', runs: [{ properties: { reportHash: report.sha256, ready: false } }] });
  expect(value.runs[0].results.map((item: { ruleId: string }) => item.ruleId)).toContain('release.build-mode');
  expect(facts.purityEvidence).toMatchObject({ finalArtifacts: [{ sha256: hash(await readFile(join(root, path))) }],
    toolchain: { version: null, binding: 'manifest-declared-only' },
    coreOnlyBaseline: { status: 'unverified' } });
  const text = await readFile(html!.path, 'utf8');
  expect(text).toContain(report.sha256); expect(text).toContain('DEBUGGABLE_PACKAGE');
  expect(hash(await readFile(sarif!.path))).toBe(sarif!.sha256);
  expect(hash(await readFile(html!.path))).toBe(html!.sha256);
});

it('finds SourceMap, credentials, absolute paths and debug metadata without extracting an archive', async () => {
  const s = await setup(), path = await hap({ 'ets/sourceMaps.map': '{"sources":["/Users/developer/work/Main.ets"]}',
    'resources/rawfile/test.crt': 'fixture certificate bytes' }, true);
  const result = await s.runtime.execute('release.verify', { artifacts: [path], manifest: await manifest(path) }, s.context);
  expect(result.exitCode).toBe(1);
  expect(gate(result.data, 'release.package-content').findings.map((f) => f.code)).toEqual(expect.arrayContaining(['PACKAGED_SOURCEMAP', 'PACKAGED_CERTIFICATE', 'PACKAGED_HOST_PATH']));
  expect(gate(result.data, 'release.build-mode').status).toBe('failed');
  expect(JSON.stringify(result.data)).not.toContain('fixture certificate bytes');
  expect(JSON.stringify(result.data)).not.toContain('/Users/developer/work');
});

it('detects literal debug APIs and sensitive logs while ignoring comments and arbitrary string content', async () => {
  const s = await setup();
  await put('products/phone/src/main/ets/Main.ets',
    "// WebviewController.setWebDebuggingAccess(true)\nconst example = 'MockServer';\nwebview.WebviewController.setWebDebuggingAccess(true);\nconsole.info('token=' + token);\n");
  const path = await hap(), result = await s.runtime.execute('release.verify', { manifest: await manifest(path) }, s.context);
  expect(gate(result.data, 'release.web-debug').findings).toHaveLength(1);
  expect(gate(result.data, 'release.sensitive-logs').status).toBe('failed');
  expect(result.exitCode).toBe(1);
});

it('rejects mismatched artifact and source identities instead of checking an unrelated release', async () => {
  const s = await setup(), path = await hap(), m = await manifest(path);
  await put('products/phone/src/main/ets/Main.ets', 'changed source\n');
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(gate(result.data, 'release.build-identity').status).toBe('failed');
  await put(path, 'replaced artifact');
  expect((await s.runtime.execute('release.verify', { manifest: m }, s.context)).exitCode).toBe(4);
});

it('does not certify a debug build when its HAP debuggable field is false', async () => {
  const s = await setup(), path = await hap();
  const result = await s.runtime.execute('release.verify', { manifest: await manifest(path, 'debug') }, s.context);
  expect(gate(result.data, 'release.build-mode').status).toBe('failed'); expect(result.exitCode).toBe(1);
});

async function boundSbom(s: Awaited<ReturnType<typeof setup>>, mutate?: (value: ReturnType<typeof cycloneDx>) => void) {
  const path = await manifest(await hap()), value = JSON.parse(await readFile(join(root, path), 'utf8'));
  value.dependencies = await analyzeDependencies(s.context);
  const document = cycloneDx(value.dependencies);
  mutate?.(document);
  const bytes = JSON.stringify(document);
  await put('build/sbom.json', bytes);
  value.sbom = { path: 'build/sbom.json', sha256: hash(bytes), format: 'cyclonedx', scope: 'dependency-inventory' };
  await put(path, JSON.stringify(value));
  return path;
}

it('verifies manifest-bound SBOM bytes and inventory without certifying production closure', async () => {
  const s = await setup(), m = await boundSbom(s);
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ ready: false, sbom: { status: 'verified-inventory', scope: 'dependency-inventory' } });
  const identity = gate(result.data, 'release.build-identity') as ReturnType<typeof gate> & { missing: string[] };
  expect(identity.missing).not.toContain('manifest-bound-sbom');
  expect(identity.missing).toContain('production-sbom-closure');
});

it('rejects SBOM byte drift even when the package and source hashes still match', async () => {
  const s = await setup(), m = await boundSbom(s);
  await put('build/sbom.json', '{}');
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(result.exitCode).toBe(1);
  expect(gate(result.data, 'release.build-identity').findings.map(item => item.code)).toContain('BUILD_SBOM_DRIFT');
});

it.each(['components', 'dependencies'] as const)('rejects a hash-bound SBOM with omitted %s', async field => {
  const s = await setup(), m = await boundSbom(s, value => { value[field] = []; });
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(result.exitCode).toBe(1);
  expect(gate(result.data, 'release.build-identity').findings.map(item => item.code)).toContain('BUILD_SBOM_INVENTORY_MISMATCH');
});

it.each(['missing', 'malformed', 'linked', 'private', 'outside'])('rejects %s bound SBOM evidence safely', async mode => {
  const s = await setup(), m = await boundSbom(s), value = JSON.parse(await readFile(join(root, m), 'utf8'));
  if (mode === 'missing') { await rm(join(root, 'build/sbom.json')); }
  if (mode === 'malformed') { await put('build/sbom.json', '{invalid'); value.sbom.sha256 = hash('{invalid'); }
  if (mode === 'linked') {
    await put('build/other.json', await readFile(join(root, 'build/sbom.json')));
    await rm(join(root, 'build/sbom.json')); await symlink(join(root, 'build/other.json'), join(root, 'build/sbom.json'));
  }
  if (mode === 'private') { value.sbom.path = '.env'; }
  if (mode === 'outside') { value.sbom.path = '../outside.json'; }
  await put(m, JSON.stringify(value));
  const result = await s.runtime.execute('release.verify', { manifest: m }, s.context);
  expect(result.exitCode).toBe(1);
  expect(gate(result.data, 'release.build-identity').findings.map(item => item.code)).toContain('BUILD_SBOM_UNAVAILABLE');
});

it('checks the debug and buildMode fields emitted by the actual DevEco 26 package producer', async () => {
  const s = await setup(), path = await hap({ 'module.json': JSON.stringify({
    app: { bundleName: 'org.example.release', debug: true, buildMode: 'debug' }, module: { name: 'phone', type: 'entry' },
  }) });
  const result = await s.runtime.execute('release.verify', { manifest: await manifest(path) }, s.context);
  expect(gate(result.data, 'release.build-mode').status).toBe('failed');
  expect(gate(result.data, 'release.build-mode').findings.map((f) => f.code)).toContain('PACKAGED_BUILD_MODE_MISMATCH');
});

it('checks nested module metadata in a real APP package', async () => {
  const s = await setup(), path = await app();
  const result = await s.runtime.execute('release.verify', { manifest: await manifest(path, 'release', 'app') }, s.context);
  expect(result.exitCode).toBe(3);
  expect(gate(result.data, 'release.build-mode').status).toBe('passed');
  expect(gate(result.data, 'release.package-content').status).toBe('passed');
});

it('rejects a nested debug module inside a real APP package', async () => {
  const s = await setup(), path = await app(true);
  const result = await s.runtime.execute('release.verify', { manifest: await manifest(path, 'release', 'app') }, s.context);
  expect(result.exitCode).toBe(1);
  expect(gate(result.data, 'release.build-mode').status).toBe('failed');
});

it.each([true, false])('retains helper lexical gaps and checks packaged debug=%s', async debuggable => {
  const s = await setup(), path = await hap({}, debuggable);
  const helper = 'products/phone/tools/runtime.mjs';
  await put(helper, await readFile('kit/ohmatekit/tools/runtime.mjs'));
  const result = await s.runtime.execute('release.verify', { artifacts: [path] }, s.context);
  expect(result.exitCode).toBe(debuggable ? 1 : 3);
  expect(gate(result.data, 'release.build-mode').status).toBe(debuggable ? 'failed' : 'incomplete');
  for (const id of ['release.web-debug', 'release.kit-core', 'release.probes', 'release.debug-writes', 'release.sensitive-logs']) {
    const item = gate(result.data, id) as ReturnType<typeof gate> & { missing: string[] };
    expect(item.missing).toContain(helper + ':source-lexical-coverage');
  }
  expect(result.data).toMatchObject({ ready: false, verification: 'static-and-package-evidence' });
});

it('rejects explicit unrelated artifacts, unsafe inputs and unknown module selections', async () => {
  const s = await setup(), path = await hap(), m = await manifest(path);
  await put('other.hap', await readFile(join(root, path))); await put('.env', 'placeholder');
  await symlink(join(root, path), join(root, 'linked.hap'));
  for (const input of [{ manifest: m, artifacts: ['other.hap'] }, { artifacts: ['linked.hap'] },
    { manifest: '.env' }, { artifacts: ['../outside.hap'] }, { modules: ['missing'] }, { product: 'missing' }]) {
    expect((await s.runtime.execute('release.verify', input, s.context)).exitCode).toBe(4);
  }
});

it('refuses malformed HAP data and archive traversal names', async () => {
  const s = await setup(); await put('invalid.hap', 'not a ZIP');
  expect((await s.runtime.execute('release.verify', { artifacts: ['invalid.hap'] }, s.context)).exitCode).toBe(4);
  const zip = new AdmZip(); zip.addFile('evil/file.txt', Buffer.from('payload'));
  const buffer = zip.toBuffer(), name = Buffer.from('evil/file.txt'), replacement = Buffer.from('../x/file.txt');
  for (let index = buffer.indexOf(name); index >= 0; index = buffer.indexOf(name, index + replacement.length)) { replacement.copy(buffer, index); }
  await put('traversal.hap', buffer);
  expect((await s.runtime.execute('release.verify', { artifacts: ['traversal.hap'] }, s.context)).exitCode).toBe(4);
});

it('rejects a malformed native ELF rather than reporting package-content success', async () => {
  const s = await setup(), path = await hap({ 'libs/arm64-v8a/libbroken.so': Buffer.from([0x7f, 0x45, 0x4c, 0x46]) });
  expect((await s.runtime.execute('release.verify', { manifest: await manifest(path) }, s.context)).exitCode).toBe(4);
});

it('applies the decode budget across all selected packages, not independently per package', async () => {
  const s = await setup(), zip = new AdmZip();
  zip.addFile('resources/rawfile/payload.bin', Buffer.alloc(24 * 1024 * 1024));
  const bytes = zip.toBuffer(), artifacts = ['build/one.hap', 'build/two.hap', 'build/three.hap'];
  for (const path of artifacts) { await put(path, bytes); }
  expect((await s.runtime.execute('release.verify', { artifacts }, s.context)).exitCode).toBe(4);
});

it('recognizes only explicitly reachable forbidden development dependencies', async () => {
  const s = await setup();
  await put('products/phone/oh-package.json5', '{"name":"phone","version":"1.0.0","dependencies":{"@ohmate/debug-center":"file:../../debug-center"}}');
  await put('debug-center/oh-package.json5', '{"name":"@ohmate/debug-center","version":"1.0.0"}');
  const result = await s.runtime.execute('release.verify', {}, s.context);
  expect(gate(result.data, 'release.dependencies').status).toBe('failed');
  expect(gate(result.data, 'release.kit-core').status).toBe('failed');
});

it('does not scan unselected product sources as selected release evidence', async () => {
  const s = await setup();
  const profile = JSON.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.modules.push({ name: 'pc', srcPath: './products/pc' }); await put('build-profile.json5', JSON.stringify(profile));
  await put('products/pc/src/main/module.json5', '{"module":{"name":"pc","type":"entry"}}');
  await put('products/pc/src/main/ets/Main.ets', 'WebviewController.setWebDebuggingAccess(true);');
  const result = await s.runtime.execute('release.verify', { modules: ['phone'] }, s.context);
  expect(gate(result.data, 'release.web-debug').findings).toHaveLength(0);
});

it('validates HAR consumer option restrictions and leaves absent nameCache correlation incomplete', async () => {
  const s = await setup(); await put('products/phone/consumer-rules.txt', '-enable-property-obfuscation\n');
  await put('products/phone/src/main/module.json5', '{"module":{"name":"phone","type":"har"}}');
  const result = await s.runtime.execute('release.verify', {}, s.context);
  expect(gate(result.data, 'release.arkguard').findings.map((f) => f.code)).toContain('CONSUMER_OBFUSCATION_ENABLE');
  expect(gate(result.data, 'release.symbol-correlation').status).toBe('incomplete');
});

it('generates bilingual manual guidance without launching a signer or publishing a package', async () => {
  const s = await setup(), result = await s.runtime.execute('release.guide', {}, s.context);
  expect(result.exitCode).toBe(3);
  const guide = result.artifacts!.find((a) => a.kind === 'release-guide')!;
  const text = await readFile(guide.path, 'utf8');
  expect(text).toContain('人工'); expect(text).toContain('未就绪');
  expect(result.data).toMatchObject({ performed: [], manualOnly: true });
  const english = await s.runtime.execute('release.guide', {}, { ...s.context, locale: 'en-US' });
  expect(await readFile(english.artifacts!.find((a) => a.kind === 'release-guide')!.path, 'utf8')).toContain('Not ready');
});

it('archives manifest and explicitly selected symbols without overwriting originals or claiming a complete closure', async () => {
  const s = await setup(), path = await hap(), m = await manifest(path), map = 'build/sourceMaps.map';
  await put(map, '{"sources":["products/phone/src/main/ets/Main.ets"]}');
  const before = await readFile(join(root, map));
  const first = await s.runtime.execute('release.artifacts', { manifest: m, symbols: [map] }, s.context);
  expect(first.exitCode).toBe(3);
  const data = first.data as { archive: { originalPath: string; archivedPath: string; sha256: string }[]; completeness: string };
  expect(data.completeness).toBe('incomplete');
  for (const entry of data.archive) { expect(hash(await readFile(entry.archivedPath))).toBe(entry.sha256); }
  expect(await readFile(join(root, map))).toEqual(before);
  const second = await s.runtime.execute('release.artifacts', { manifest: m, symbols: [map] }, s.context);
  expect(second.artifacts!.map((a) => a.path).some((p) => first.artifacts!.some((a) => a.path === p))).toBe(false);
});

it('does not archive certificates or private files even when explicitly selected as symbols', async () => {
  const s = await setup(), path = await hap(), m = await manifest(path); await put('build/test.key', 'placeholder');
  const result = await s.runtime.execute('release.artifacts', { manifest: m, symbols: ['build/test.key'] }, s.context);
  expect(result.exitCode).toBe(4);
});
