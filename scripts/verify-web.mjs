/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm1-web-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-web-verify-')), dataDir = join(root, 'data');
await mkdir(join(root, 'AppScope'));
await writeFile(join(root, 'AppScope/app.json5'), '{app:{bundleName:"com.example.webfixture",versionCode:1,versionName:"1.0"}}');
await writeFile(join(root, 'build-profile.json5'), '{app:{products:[]},modules:[]}');
await writeFile(join(root, 'README.md'), '# Public verification fixture\n');
function cli(args) {
  const result = spawnSync(process.execPath, [bin, ...args, '--format', 'json'], {
    cwd: root, env: { ...process.env, OHMATE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout.trim());
}
const opened = cli(['ui', '--no-open']);
assert.equal(opened.exitCode, 0, JSON.stringify(opened.data));
const origin = opened.data.origin;
let cookie, csrf;
async function api(path, input) {
  const response = await fetch(`${origin}/api/v1/${path}`, {
    method: input === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json',
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-ohmate-csrf': csrf } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15_000),
  });
  return response;
}
const ticket = new URL(opened.data.url).hash.slice('#access='.length);
try {
  const connected = await api('connect', { ticket });
  assert.equal(connected.status, 200);
  cookie = connected.headers.get('set-cookie').split(';')[0];
  csrf = (await (await api('bootstrap')).json()).csrf;
  assert.equal((await fetch(`${origin}/api/v1/tasks`)).status, 401);
  const catalog = await (await api('capabilities')).json();
  assert.deepEqual(catalog.data, cli(['capabilities']).data);
  const submitted = await (await api('tasks', { toolId: 'doctor', input: {}, wait: true })).json();
  assert.equal(submitted.data.state, 'succeeded');
  assert.deepEqual(cli(['task', 'show', submitted.data.id]).data, submitted.data);
  const events = await (await api(`tasks/${submitted.data.id}/events?after=1`)).text();
  assert.ok(events.includes('event: end'));
  assert.ok(!events.includes('id: 1\n'));
  assert.equal((await api('execute', { toolId: 'project.register', input: { path: root } })).status, 200);
  const html = await (await fetch(origin)).text();
  assert.ok(html.includes('新任务') && html.includes('我的应用') && html.includes('成果与报告'));
  const assets = ['styles.css', 'app.js', 'api.js', 'view.js', 'panels.js', 'tasks.js'];
  const hashes = {};
  for (const name of assets) {
    const response = await fetch(`${origin}/${name}`);
    assert.equal(response.status, 200);
    hashes[name] = createHash('sha256').update(await response.text()).digest('hex');
  }
  const artifact = { status: 'passed', bin, node: process.version, registry: catalog.data.length,
    runtimeAndCliTaskEqual: true, sseCursor: true, authentication: true, bundledAssetHashes: hashes,
    platform: process.platform, realDevices: 'not-operated', cloudModels: 'not-contacted' };
  const output = process.env.OHMATE_WEB_VALIDATION_OUTPUT ?? `artifacts/validation/${label}.json`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(artifact, null, 2));
  if (process.env.OHMATE_WEB_KEEP === '1') {
    const browser = cli(['ui', '--no-open']);
    const info = process.env.OHMATE_BROWSER_INFO ?? '/tmp/ohmate-web-browser.json';
    await writeFile(info, JSON.stringify({ root, dataDir, bin, url: browser.data.url, origin }), { mode: 0o600 });
    console.log(JSON.stringify({ ...artifact, browserReady: true, info }));
  } else {
    assert.equal(cli(['ui', 'stop']).exitCode, 0);
    assert.deepEqual(cli(['ui', 'status']).data, { state: 'stopped' });
    console.log(JSON.stringify(artifact));
  }
} catch (error) { cli(['ui', 'stop']); throw error; }
