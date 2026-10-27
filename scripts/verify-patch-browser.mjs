/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const owner = await mkdtemp(join(tmpdir(), 'ohmate-patch-browser-'));
const infoFile = join(owner, 'service.json'), discovery = join(owner, 'discovery.json');
const flags = process.argv.slice(2).filter((value) => value.startsWith('--'));
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const bin = resolve(positional[0] ?? 'packages/cli-wrapper/cli.js');
const touchMode = flags.includes('--touch');
const label = positional[1] ?? (touchMode ? 'web-touch-built' : 'm1-patch-web-built');
const browserArtifacts = process.env.OHMATE_BROWSER_ARTIFACTS ??
  (positional[1] ? `artifacts/validation/${label}-browser` : touchMode ? join(owner, 'artifacts') : undefined);
const webValidation = process.env.OHMATE_WEB_VALIDATION_OUTPUT ?? (touchMode ? join(owner, 'web.json') : undefined);
const env = { ...process.env, OHMATE_WEB_KEEP: '1', OHMATE_BROWSER_INFO: infoFile, OHMATE_BROWSER_DISCOVERY: discovery,
  ...(browserArtifacts ? { OHMATE_BROWSER_ARTIFACTS: browserArtifacts } : {}),
  ...(webValidation ? { OHMATE_WEB_VALIDATION_OUTPUT: webValidation } : {}) };
let chrome, info, stopped;
async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    process.platform === 'win32' && process.env.PROGRAMFILES ?
      join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : undefined,
    process.platform === 'win32' && process.env['PROGRAMFILES(X86)'] ?
      join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe') : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA ?
      join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) { return candidate; }
  }
  throw new Error('Chrome executable not found; set CHROME_BIN');
}
try {
  const prepared = spawnSync(process.execPath, ['scripts/verify-web.mjs', bin, label], { env, encoding: 'utf8', timeout: 45_000 });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  info = JSON.parse(await readFile(infoFile, 'utf8'));
  if (process.argv.includes('--deps')) {
    await writeFile(join(info.root, 'oh-package.json5'), '{"name":"browser-fixture","version":"1.0.0"}\n');
  }
  const profile = join(owner, 'chrome');
  chrome = spawn(await chromeExecutable(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, info.url,
  ], { stdio: 'ignore' });
  stopped = new Promise((resolve) => chrome.once('exit', resolve));
  const deadline = Date.now() + 15_000;
  let port;
  while (!port) {
    assert.ok(Date.now() < deadline, 'Test-owned Chrome did not start');
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((text) => text.split('\n')[0]).catch(() => null);
    if (!port) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  await writeFile(discovery, JSON.stringify({ tabs }), { mode: 0o600 });
  const mode = process.argv.includes('--touch') ? '--touch' :
    process.argv.includes('--debug') ? '--debug' : process.argv.includes('--deps') ? '--deps' : '--patch';
  const checked = spawnSync(process.execPath, ['scripts/verify-web-browser.mjs', mode], { env, encoding: 'utf8', timeout: 45_000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  console.log(checked.stdout);
} finally {
  if (chrome) { chrome.kill('SIGTERM'); await stopped; }
  if (info) {
    const ended = spawnSync(process.execPath, [bin, 'ui', 'stop', '--format', 'json'], {
      cwd: info.root, env: { ...process.env, OHMATE_DATA_DIR: info.dataDir }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(ended.status, 0, ended.stderr);
    await rm(info.root, { recursive: true, force: true });
  }
  await rm(owner, { recursive: true, force: true });
}
