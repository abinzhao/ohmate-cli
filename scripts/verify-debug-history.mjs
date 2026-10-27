/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const assets = resolve(process.argv[2] ?? 'apps/web');
const output = resolve(process.argv[3] ?? '/private/tmp/ohmate-debug-history-result.json');
const root = await mkdtemp('/private/tmp/ohmate-history-ui-');
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
const browser = `ohmate-history-${root.split('/').at(-1)}`;
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const streams = Array.from({ length: 22 }, (_, index) => ({
  streamId: id(index + 1), integrity: 'verified', through: index + 1, active: index === 21,
}));
streams[3] = { streamId: id(4), integrity: 'corrupt', active: false, code: 'JOURNAL_CORRUPT' };
let preferred = id(22), blocked, entered, release, opened = false;
let staleEntered, staleRelease, staleBlocked;
const session = () => ({ id: id(100), cwd: root, projectRoot: null, state: 'serving',
  startedAt: '2026-10-24T00:00:00Z', bridge: { state: 'connected', streamId: preferred, ackThrough: 22 } });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<link rel="stylesheet" href="/styles.css"><div id="page-title"></div><div id="composer-dock"></div>
        <div id="result-panel"></div><div id="toast-root"></div><main id="canvas"></main>
        <script type="module">import {debugView} from './debug.js'; await debugView(${JSON.stringify({ cwd: root, projectRoot: null })});</script>`);
    } else if (url.pathname.startsWith('/api/v1/')) {
      res.setHeader('Content-Type', 'application/json');
      let result;
      if (url.pathname.endsWith('/status')) result = { exitCode: 0, data: { debugSession: session() } };
      else if (url.pathname.endsWith('/sessions')) result = { exitCode: 0, data: [session()] };
      else if (url.pathname.endsWith('/streams')) {
        const after = url.searchParams.get('after');
        if (after && blocked) { entered(); await blocked; }
        result = { streams: after ? streams.slice(20) : streams.slice(0, 20),
          nextCursor: after ? id(22) : id(20), hasMore: !after };
      } else if (url.pathname.endsWith('/events')) {
        const streamId = url.pathname.split('/').at(-2), number = Number(streamId.slice(-12));
        if (streamId === id(3) && staleBlocked) { staleEntered(); await staleBlocked; }
        if (streamId === id(4)) { res.statusCode = 409; result = { code: 'JOURNAL_CORRUPT' }; }
        else result = { events: [{ index: number, clock: { segment: 1, mergeable: true },
          event: { channel: 'hidebug', payload: { summary: `Fixture stream ${number}` } } }],
          through: number, nextCursor: number, hasMore: false };
      } else throw Error('Unexpected fixture route');
      res.end(JSON.stringify(result));
    } else {
      const name = url.pathname.slice(1);
      assert(['debug.js', 'inspector.js', 'problem.js', 'api.js', 'view.js', 'styles.css'].includes(name));
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(join(assets, name)));
    }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ code: error.message })); }
});
async function browse(args) {
  return (await promisify(execFile)('agent-browser', ['--session', browser, ...args], { env, timeout: 10_000 })).stdout;
}
async function ref(name, role = 'button') {
  const match = (await browse(['snapshot', '-i'])).match(new RegExp(`${role} "${name}" \\[[^\\]]*\\bref=(e\\d+)\\]`));
  assert(match, `Missing ${role}: ${name}`); return `@${match[1]}`;
}
async function click(name) { await browse(['scrollintoview', await ref(name)]); await browse(['click', await ref(name)]); }
async function select(number) {
  await browse(['scrollintoview', await ref('事件流', 'combobox')]);
  await browse(['select', await ref('事件流', 'combobox'), id(number)]);
}
async function state() {
  return JSON.parse(await browse(['eval', '({selected:document.getElementById("debug-stream").value,options:Array.from(document.getElementById("debug-stream").options).map(o=>o.value),moreDisabled:Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="更多事件流").disabled,status:document.querySelector(".debug-stream-status").textContent,events:Array.from(document.querySelectorAll(".debug-event p")).map(p=>p.textContent)})']));
}
async function observe(predicate) {
  const deadline = Date.now() + 3000;
  let seen;
  do {
    seen = await state();
    if (predicate(seen)) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`UI completion missing: ${JSON.stringify(seen)}`);
}
async function requestStarted(promise) {
  const timer = new AbortController();
  try {
    await Promise.race([promise, delay(3000, undefined, { signal: timer.signal }).then(() => assert.fail('Fixture request did not start'))]);
  } finally { timer.abort(); }
}
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await browse(['open', origin]); opened = true;
  const initial = await observe((seen) => seen.selected === id(22) && seen.events[0] === 'Fixture stream 22');
  assert.equal(initial.options.length, 22, 'Preferred stream outside the first page is not reachable');
  preferred = id(1); await browse(['open', origin]);
  await observe((seen) => seen.options.length === 20 && seen.selected === id(1) && !seen.moreDisabled);
  const started = new Promise((resolve) => { entered = resolve; });
  blocked = new Promise((resolve) => { release = resolve; });
  await click('更多事件流'); await requestStarted(started);
  await select(2); await observe((seen) => seen.events[0] === 'Fixture stream 2');
  release();
  const more = await observe((seen) => seen.options.length === 22);
  assert.equal(more.selected, id(2)); assert.equal(new Set(more.options).size, 22);
  const stale = new Promise((resolve) => { staleEntered = resolve; });
  staleBlocked = new Promise((resolve) => { staleRelease = resolve; });
  await select(3); await requestStarted(stale);
  await select(2); await observe((seen) => seen.events[0] === 'Fixture stream 2');
  staleRelease();
  await browse(['wait', '--fn', `performance.getEntriesByType("resource").some(e=>e.name.includes("${id(3)}/events?")&&e.responseEnd>0)`]);
  assert.deepEqual((await state()).events, ['Fixture stream 2']);
  await select(4); await observe((seen) => seen.status.includes('JOURNAL_CORRUPT') && seen.events.length === 0);
  await select(1); await observe((seen) => seen.events[0] === 'Fixture stream 1');
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ status: 'passed', assets, preferredOutsideFirstPage: true,
    selectionDuringIndexRead: true, staleEventPage: true, corruptArchiveRecovery: true,
    producer: 'synthetic-browser-fixture', devicesProbed: false }, null, 2) + '\n');
  console.log(`History UI validation passed: ${output}`);
} finally {
  release?.(); staleRelease?.();
  if (opened) await browse(['close']);
  await new Promise((resolve) => server.close(resolve));
}
