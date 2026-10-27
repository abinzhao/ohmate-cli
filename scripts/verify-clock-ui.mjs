/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const assets = resolve(process.argv[2] ?? 'apps/web');
const output = resolve(process.argv[3] ?? '/private/tmp/ohmate-clock-ui-r1');
const root = await mkdtemp('/private/tmp/ohmate-clock-ui-');
await mkdir(output, { recursive: true });
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
const browser = `clock-${root.slice(-6)}`;
const records = [
  { index: 1, clock: { segment: 1, mergeable: true }, event: { channel: 'hidebug', payload: { summary: 'Legacy' } } },
  { index: 2, clock: { segment: 2, mergeable: true, alignment: { status: 'calibrated', uncertaintyNs: '4006000' } },
    event: { channel: 'hidebug', payload: { summary: 'Measured' } } },
  { index: 3, clock: { segment: 3, mergeable: false, alignment: { status: 'expired' } },
    event: { channel: 'hidebug', payload: { summary: 'Expired' } } },
];
const id = '00000000-0000-4000-8000-000000000001';
const session = { id, cwd: root, projectRoot: null, startedAt: '2026-10-24T00:00:00Z',
  state: 'stopped', bridge: { state: 'disconnected', streamId: id, ackThrough: 3 } };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css">
        <div id="page-title"></div><div id="composer-dock"></div><div id="result-panel"></div><div id="toast-root"></div>
        <main id="canvas"></main><script type="module">import {debugView} from './debug.js';
        await debugView(${JSON.stringify({ cwd: root, projectRoot: null })});</script>`);
      return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      res.setHeader('content-type', 'application/json');
      let value;
      if (url.pathname.endsWith('/status')) { value = { exitCode: 0, data: { debugSession: session } }; }
      else if (url.pathname.endsWith('/sessions')) { value = { exitCode: 0, data: [session] }; }
      else if (url.pathname.endsWith('/streams')) { value = { streams: [{ streamId: id, integrity: 'verified', through: 3 }], hasMore: false }; }
      else if (url.pathname.endsWith('/events')) { value = { events: records, through: 3, nextCursor: 3, hasMore: false }; }
      else { throw Error('unexpected route'); }
      res.end(JSON.stringify(value));
      return;
    }
    const name = url.pathname.slice(1);
    assert(['debug.js', 'inspector.js', 'problem.js', 'api.js', 'view.js', 'styles.css'].includes(name));
    res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(await readFile(join(assets, name)));
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
async function browse(args) {
  return (await promisify(execFile)('agent-browser', ['--session', browser, ...args], { env, cwd: root, timeout: 10000 })).stdout;
}
let opened = false;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await browse(['open', `http://127.0.0.1:${server.address().port}`]); opened = true;
  await browse(['wait', '--fn', 'document.querySelectorAll(".debug-event").length===3']);
  const text = JSON.parse(await browse(['eval', 'Array.from(document.querySelectorAll(".debug-event-heading")).map(e=>e.textContent)']));
  assert(text[0].includes('未校准') && !text[0].includes('可合并'), 'Legacy mergeable must not imply calibration');
  assert(text[1].includes('往返测量') && text[1].includes('4.006'), 'Measured uncertainty must be visible');
  assert(text[2].includes('已过期') && !text[2].includes('可合并'), 'Expired sample must remain segmented');
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    await browse(['set', 'viewport', String(width), String(height)]);
    assert.equal(JSON.parse(await browse(['eval', 'document.documentElement.scrollWidth<=innerWidth'])), true);
    await browse(['screenshot', join(output, `${width}.png`), '--full']);
  }
  assert.equal((await browse(['errors'])).trim(), '');
  await writeFile(join(output, 'result.json'), JSON.stringify({
    status: 'passed', assets, headings: text, sizes: [1280, 390], source: 'browser-fixture', devicesProbed: false,
  }, null, 2) + '\n');
  console.log(`Clock UI validation passed: ${output}`);
} finally {
  if (opened) { await browse(['close']); }
  await new Promise((resolve) => server.close(resolve));
}
