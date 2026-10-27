/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-scan-docs-r1-built';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const output = resolve('artifacts/validation', label), root = await mkdtemp(join(tmpdir(), 'ohmate-scan-docs-cli-'));
const home = join(root, 'home'), dataDir = join(root, 'private'), app = join(root, 'QualityAcceptance');
await mkdir(home); await mkdir(output, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  OHMATE_DATA_DIR: dataDir, NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'),
  DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function cli(args, project = app) {
  const child = spawnSync(process.execPath, [bin, ...args, '--project', project, '--format', 'json'], {
    cwd: root, env, encoding: 'utf8', shell: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.error, undefined); assert.ok(child.stdout.trim(), child.stderr);
  const receipt = JSON.parse(child.stdout); assert.equal(child.status, receipt.exitCode, child.stderr); return receipt;
}
function approve(args, project) {
  const planned = cli(args, project); assert.equal(planned.exitCode, 5, JSON.stringify(planned.data));
  return cli([...args, '--approve-plan', planned.data.planId], project);
}
async function archive(name, receipt) {
  await writeFile(join(output, `${name}.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  for (const artifact of receipt.artifacts) {
    const bytes = await readFile(artifact.path); assert.equal(hash(bytes), artifact.sha256);
    await writeFile(join(output, `${name}-${artifact.kind}-${artifact.sha256}.${artifact.path.endsWith('.html') ? 'html' : 'json'}`), bytes, { flag: 'wx' });
  }
}
let webOpened = false;
try {
  assert.equal(approve(['create', '--app-name', 'QualityAcceptance', '--api-level', '22'], root).exitCode, 0);
  const directory = join(app, 'entry/src/main/ets'), positiveFile = 'entry/src/main/ets/PublicApi.ts';
  await writeFile(join(directory, 'PublicApi.ts'), `/** Public acceptance API. */
export class PublicApi {
  /** Return the acceptance value. */
  public answer(): number { return 42; }
  private internal(): void {}
}
`);
  await writeFile(join(directory, 'negative.ts'), 'export function unsafe(value: any): any { return value; }\n');
  await writeFile(join(app, 'acceptance-linter.json5'), '{files:["**/*.ts"],ruleSet:["plugin:@typescript-eslint/recommended"],rules:{"@typescript-eslint/no-explicit-any":"error"}}');
  const scanArgs = ['scan', '--files', positiveFile, '--domains', 'official', '--config', 'acceptance-linter.json5'];
  const positive = cli(scanArgs); await archive('positive-scan', positive);
  assert.equal(positive.exitCode, 0, JSON.stringify(positive.data));
  const negative = cli(['scan', '--files', 'entry/src/main/ets/negative.ts', '--domains', 'official', '--config', 'acceptance-linter.json5']);
  await archive('negative-scan', negative); assert.equal(negative.exitCode, 1, JSON.stringify(negative.data));
  assert.ok(negative.data.findings.some((finding) => finding.ruleId === '@typescript-eslint/no-explicit-any'));
  assert.equal(negative.data.invocations[0].toolExitCode, 4);
  const incomplete = cli(['scan', '--files', positiveFile]); await archive('partial-scan', incomplete);
  assert.equal(incomplete.exitCode, 3); assert.equal(incomplete.data.coverage.completeness, 'incomplete');
  assert.equal(cli(['scan', '--files', positiveFile, '--modules', 'missing']).exitCode, 4);
  const generated = cli(['docs', 'generate', '--files', positiveFile]); await archive('docs-generated', generated);
  assert.equal(generated.exitCode, 0, JSON.stringify(generated.data));
  assert.deepEqual(generated.data.model.entries.map((entry) => entry.name), ['PublicApi', 'PublicApi.answer']);
  const baseline = generated.artifacts.find((item) => item.kind === 'docs-ai-json').path;
  const checked = cli(['docs', 'check', '--files', positiveFile, '--baseline', baseline]); await archive('docs-checked', checked);
  assert.equal(checked.exitCode, 0, JSON.stringify(checked.data));
  assert.equal(checked.data.modelHash, generated.data.modelHash);
  await writeFile(join(directory, 'DeclarationApi.ts'), `/** Declaration API. */
export class DeclarationApi {
  /** Read a typed value. */
  value(v: string): string;
  value(v: number): number;
  value(v: string | number): string | number { return v; }
  private secret(): void {}
}
/** Default API. */
export default class {
  /** Return the default value. */
  answer(): number { return 42; }
}
/** Read a typed function value. */
export function readValue(v: string): string;
export function readValue(v: number): number;
export function readValue(v: string | number): string | number { return v; }
`);
  const exportedFile = 'entry/src/main/ets/PublicExports.ts';
  await writeFile(join(directory, 'PublicExports.ts'), "export { DeclarationApi as AliasApi, default as DefaultApi, readValue as readPublic } from './DeclarationApi';\nexport * from './DeclarationApi';\n");
  const semantic = cli(['docs', 'generate', '--files', exportedFile]); await archive('docs-semantic', semantic);
  assert.equal(semantic.exitCode, 0, JSON.stringify(semantic.data));
  assert.deepEqual(semantic.data.model.entries.map((entry) => entry.name),
    ['AliasApi', 'AliasApi.value', 'DeclarationApi', 'DeclarationApi.value', 'DefaultApi', 'DefaultApi.answer', 'readPublic', 'readValue']);
  assert.equal(semantic.data.coverage.arkts, 'official-with-compiler-exports');
  assert.ok(semantic.data.compiler.reads.some((entry) => entry.path.endsWith('/DeclarationApi.ts') && entry.sha256));
  assert.ok(semantic.data.model.entries.find((entry) => entry.name === 'AliasApi.value').signature.includes('value(v: string): string\nvalue(v: number): number'));
  const semanticBaseline = semantic.artifacts.find((item) => item.kind === 'docs-ai-json').path;
  const semanticChecked = cli(['docs', 'check', '--files', exportedFile, '--baseline', semanticBaseline]);
  await archive('docs-semantic-checked', semanticChecked); assert.equal(semanticChecked.exitCode, 0);
  await writeFile(join(directory, 'NotModule.ts'), 'const hidden = 1;\n');
  await writeFile(join(directory, 'InvalidExports.ts'), "export * from './NotModule';\n");
  const invalidExports = cli(['docs', 'generate', '--files', 'entry/src/main/ets/InvalidExports.ts']);
  await archive('docs-invalid-exports', invalidExports); assert.equal(invalidExports.exitCode, 6);
  assert.ok(invalidExports.data.compiler.diagnostics.some((entry) => entry.code === 2306));
  assert.ok(!invalidExports.artifacts.some((entry) => entry.kind === 'docs-ai-json'));
  await rm(join(directory, 'NotModule.ts')); await rm(join(directory, 'InvalidExports.ts'));
  const opened = cli(['ui', '--no-open']); assert.equal(opened.exitCode, 0); webOpened = true;
  const origin = opened.data.origin, ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200); const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  for (const [toolId, input, expected] of [
    ['scan', { files: [positiveFile], domains: ['official'], config: 'acceptance-linter.json5' }, positive],
    ['docs.check', { files: [positiveFile], baseline }, checked],
  ]) {
    const response = await fetch(`${origin}/api/v1/tasks`, { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
      body: JSON.stringify({ toolId, input, projectRoot: app, wait: true }) });
    assert.equal(response.status, 200); const web = await response.json();
    await archive(`web-${toolId}`, web.data.receipt);
    assert.equal(web.data.state, 'succeeded', JSON.stringify(web.data));
    if (toolId === 'scan') { assert.deepEqual(web.data.receipt.data.findings, expected.data.findings); }
    else { assert.deepEqual(web.data.receipt.data.model, expected.data.model); }
  }
  assert.equal(cli(['ui', 'stop']).exitCode, 0); webOpened = false;
  let hvigorEvidence = null;
  if (!process.argv.includes('--without-hvigor')) {
    await rm(join(directory, 'negative.ts'));
    const built = approve(['build', 'run', '--install']); await archive('official-build', built); assert.equal(built.exitCode, 0, JSON.stringify(built.data));
    const tools = cli(['build', 'plan']).data.tools, original = await readFile(join(app, 'hvigorfile.ts'), 'utf8');
    const integrated = approve(['integrate', 'hvigor']); assert.equal(integrated.exitCode, 0);
    const attached = await readFile(join(app, 'hvigorfile.ts'), 'utf8');
    const inputs = { ohmatecliScan: { files: [positiveFile], domains: ['official'], config: 'acceptance-linter.json5' },
      ohmatecliDocs: { files: [positiveFile], baseline } };
    const configured = approve(['workspace', 'patch', '--input', JSON.stringify({ changes: [
      { path: 'hvigorfile.ts', oldHash: hash(attached), text: attached.replace('ohmatePlugin()', `ohmatePlugin(${JSON.stringify(inputs)})`) },
    ] })]); assert.equal(configured.exitCode, 0);
    await mkdir(join(app, 'node_modules/@ohmate'), { recursive: true });
    await symlink(process.argv[4] && !process.argv[4].startsWith('--') ? resolve(process.argv[4]) : resolve('packages/cli'), join(app, 'node_modules/@ohmate/cli-common'), 'dir');
    const officialEnv = { ...env, PATH: [dirname(tools.tools.java.path), dirname(tools.tools.node.path), env.PATH].join(delimiter),
      JAVA_HOME: dirname(dirname(tools.tools.java.path)), DEVECO_SDK_HOME: tools.sdkPath, HVIGOR_USER_HOME: join(home, '.hvigor'), OHPM_HOME: join(home, '.ohpm') };
    for (const task of ['ohmatecliScan', 'ohmatecliDocs']) {
      const child = spawnSync(tools.tools.node.path, [tools.tools.hvigor.path, '--mode', 'project', task, '-p', 'product=default', '-p', 'buildMode=debug', '--no-daemon'],
        { cwd: app, env: officialEnv, encoding: 'utf8', shell: false, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      const raw = `${child.stdout}\n${child.stderr}`; await writeFile(join(output, `${task}.log`), raw, { flag: 'wx' });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, raw);
      assert.ok(raw.includes('"exitCode":0') && raw.includes('"adapter":"native"'));
    }
    assert.equal(approve(['workspace', 'recovery', 'restore', '--journal-id', configured.data.journalId]).exitCode, 0);
    assert.equal(approve(['workspace', 'recovery', 'restore', '--journal-id', integrated.data.journalId]).exitCode, 0);
    assert.equal(await readFile(join(app, 'hvigorfile.ts'), 'utf8'), original);
    hvigorEvidence = { scanPassed: true, docsPassed: true, taskSpecificScope: true, byteExactRecovery: true };
  }
  const result = { status: 'passed', bin, platform: process.platform, studioVersion: positive.data.tools.version,
    officialNegativeExit: 4, negativeFindings: negative.data.findings.length, partialScanNotCertified: true,
    docsModelHash: generated.data.modelHash, publicApis: generated.data.model.entries.length, privateMethodExcluded: true,
    semanticExportApis: semantic.data.model.entries.length, sdkFrontend: semantic.data.compiler.compiler.packageVersion,
    reexportsAndOverloads: true, anonymousDefaultExport: true, compilerInputClosure: 'not-established',
    invalidExportsRejected: true,
    webCliAgreement: true, hvigor: hvigorEvidence, devices: 'not-operated', cloud: 'not-contacted' };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
} finally {
  if (webOpened) { cli(['ui', 'stop']); }
  await rm(root, { recursive: true, force: true });
}
