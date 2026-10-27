/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const source = resolve(process.argv[2] ?? 'artifacts/validation/m1-scan-docs-r2-built');
const output = resolve(process.argv[3] ?? 'artifacts/validation/m1-scan-docs-browser');
const owner = await mkdtemp(join(tmpdir(), 'ohmate-report-browser-')), profile = join(owner, 'chrome');
await mkdir(profile); await mkdir(output, { recursive: true });
const reports = {};
for (const [route, name, kind] of [['/scan', 'negative-scan', 'scan-html'], ['/docs', 'docs-generated', 'docs-html']]) {
  const receipt = JSON.parse(await readFile(join(source, `${name}.json`), 'utf8'));
  const artifact = receipt.artifacts.find((item) => item.kind === kind);
  const extension = 'html';
  reports[route] = await readFile(join(source, `${name}-${kind}-${artifact.sha256}.${extension}`));
}
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank',
], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: owner, TMPDIR: owner } });
const closed = new Promise((resolve_) => chrome.once('close', resolve_));
const checks = [];
let socket, sequence = 0;
const pending = new Map(), errors = [];
function call(method, params = {}) {
  return new Promise((resolve_, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 8000);
    pending.set(id, { resolve: resolve_, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined); return result.result.value;
}
try {
  const deadline = Date.now() + 15_000;
  let browserPort;
  for (;;) {
    const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null);
    if (active) { browserPort = Number(active.split('\n')[0]); break; }
    assert.ok(Date.now() < deadline, 'Private Chrome did not expose its test port');
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
  const tabs = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve_, reject) => { socket.addEventListener('open', resolve_, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') { errors.push(data.params.exceptionDetails.text); }
    const request = pending.get(data.id);
    if (request) { pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(data.error) : request.resolve(data.result); }
  });
  await call('Runtime.enable');
  const { frameTree } = await call('Page.getFrameTree');
  for (const route of ['/scan', '/docs']) {
    await call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: reports[route].toString('utf8') });
    const readyDeadline = Date.now() + 8000;
    while (!(await evaluate(`document.title === ${JSON.stringify(route === '/scan' ? 'OHMate Scan' : 'OHMate API')}`))) {
      assert.ok(Date.now() < readyDeadline, 'Report did not render');
      await new Promise((resolve_) => setTimeout(resolve_, 25));
    }
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      const parsed = await evaluate('({title:document.title,width:innerWidth,scroll:document.documentElement.scrollWidth,rows:document.querySelectorAll("tbody tr").length,entries:document.querySelectorAll("article").length,scripts:document.scripts.length})');
      assert.equal(parsed.width, width, JSON.stringify(parsed));
      assert.ok(parsed.scroll <= parsed.width, JSON.stringify(parsed));
      assert.equal(parsed.scripts, 0);
      assert.ok(route === '/scan' ? parsed.rows === 5 : parsed.entries === 2, JSON.stringify(parsed));
      const file = join(output, `${route.slice(1)}-${width}.png`);
      const image = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(file, Buffer.from(image.data, 'base64')); checks.push({ route, width, ...parsed, screenshot: file });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', source, privateBrowser: true,
    driver: 'test-owned Chrome CDP document content', navigation: 'unverified',
    fallbackReason: 'agent-browser 0.27.0 and direct CDP navigation timed out; isolated offline doctor passed', checks }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', checks: checks.length }));
} finally {
  socket?.close();
  chrome.kill('SIGTERM'); await closed;
  await rm(owner, { recursive: true, force: true });
}
