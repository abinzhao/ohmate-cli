/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectorCatalog, inspectorDescription } from '../packages/cli/src/debug/inspector-catalog.ts';
import { createRuntime } from '../packages/cli/src/runtime/index.ts';

const assets = resolve(process.argv[2] ?? 'apps/web');
const output = resolve(process.argv[3] ?? '/private/tmp/ohmate-inspector-ui-r1');
assert(existsSync(join(assets, 'inspector.js')), 'Web channel Inspector is missing');
const root = await mkdtemp('/private/tmp/ohmate-inspector-ui-');
const browserHome = join(root, 'browser'), work = join(root, 'work');
await mkdir(browserHome); await mkdir(work); await mkdir(output, { recursive: true });
const env = { PATH: process.env.PATH, HOME: browserHome, TMPDIR: root };
const browser = `inspector-${root.slice(-6)}`;
const id = '00000000-0000-4000-8000-000000000001', streamId = '00000000-0000-4000-8000-000000000002';
const session = { id, cwd: work, projectRoot: null, state: 'stopped', startedAt: '2026-10-24T00:00:00Z',
  bridge: { state: 'disconnected', streamId, ackThrough: 205 } };
const toolCatalog = (await createRuntime()).registry.describe().filter((tool) => ['debug.inspect', 'debug.start'].includes(tool.id));
let fail = false, opened = false, block, entered, release, blockNext = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/styles.css"><div id="page-title"></div><div id="composer-dock"></div>
        <div id="result-panel"></div><div id="toast-root"></div><dialog id="dialog"></dialog><main id="canvas"></main>
        <button type="button" data-command-picker onclick="window.showTools()">选择本地命令</button>
        <script type="module">import {debugView} from './debug.js'; import {tools} from './panels.js';
        window.toolState={allowedTools:[]}; window.showTools=()=>tools(window.toolState,${JSON.stringify(toolCatalog)});
        await debugView(${JSON.stringify({ cwd: work, projectRoot: null })});</script>`);
    } else if (url.pathname.startsWith('/api/v1/')) {
      res.setHeader('Content-Type', 'application/json');
      let result;
      if (url.pathname.endsWith('/status')) result = { exitCode: 0, data: { debugSession: session } };
      else if (url.pathname.endsWith('/sessions')) result = { exitCode: 0, data: [session] };
      else if (url.pathname.endsWith('/streams')) result = { streams: [{ streamId, integrity: 'verified', through: 205 }],
        nextCursor: streamId, hasMore: false };
      else if (url.pathname.endsWith('/events')) result = { events: [], through: 205, nextCursor: 205, hasMore: false };
      else if (url.pathname.endsWith('/inspectors')) result = inspectorCatalog();
      else if (url.pathname.includes('/inspect/')) {
        const channel = url.pathname.split('/').at(-1), after = Number(url.searchParams.get('after') ?? 0);
        if (blockNext && channel === 'hidebug') { blockNext = false; entered(); await block; }
        if (fail) { res.statusCode = 409; res.end(JSON.stringify({ code: 'JOURNAL_CORRUPT' })); return; }
        const matches = channel === 'hidebug' ? Array.from({ length: 102 }, (_, n) => ({ index: (n + 1) * 2,
          clock: { segment: 1 }, event: { channel, payload: { metric: 'pssBytes', value: n + 1 } } })) :
          channel === 'ui' ? [{ index: 1, clock: { segment: 1 },
            event: { channel, payload: { windowId: 'window', nodeCount: 3, summary: '[MEMORY_ONLY]' } } }] : [];
        const remaining = matches.filter((record) => record.index > after), events = remaining.slice(0, 100);
        const hasMore = remaining.length > events.length;
        result = { inspector: inspectorDescription(channel), availability: matches.length ? 'recorded' : 'not-captured',
          source: 'peer-reported', samplingRate: null, clockCalibration: 'not-calibrated', events,
          count: matches.length, through: 205, snapshotHash: 'a'.repeat(64), nextCursor: hasMore ? events.at(-1).index : 205, hasMore };
      } else throw Error('Unexpected fixture route');
      res.end(JSON.stringify(result));
    } else {
      const name = url.pathname.slice(1);
      assert(['debug.js', 'inspector.js', 'problem.js', 'panels.js', 'api.js', 'view.js', 'styles.css'].includes(name));
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(join(assets, name)));
    }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ code: error.message })); }
});
async function browse(args) {
  return (await promisify(execFile)('agent-browser', ['--session', browser, ...args], { env, cwd: root, timeout: 10_000 })).stdout;
}
async function ref(name, role = 'button') {
  const snapshot = await browse(['snapshot', '-i']);
  const match = snapshot.match(new RegExp(`${role} "${name}" \\[[^\\]]*\\bref=(e\\d+)\\]`));
  assert(match, `Missing ${role}: ${name}\n${snapshot}`); return `@${match[1]}`;
}
async function click(name) { await browse(['scrollintoview', await ref(name)]); await browse(['click', await ref(name)]); }
async function select(channel) {
  await browse(['scrollintoview', await ref('查看通道', 'combobox')]);
  await browse(['select', await ref('查看通道', 'combobox'), channel]);
}
async function state() {
  return JSON.parse(await browse(['eval', `({channel:document.getElementById("inspector-channel")?.value,
    status:document.querySelector(".inspector-status")?.textContent,
    rows:Array.from(document.querySelectorAll(".inspector-event")).map(e=>e.textContent),
    next:document.getElementById("inspector-next")?.disabled,
    text:document.querySelector(".debug-inspector")?.textContent})`]));
}
async function observe(predicate) {
  const deadline = Date.now() + 3000;
  let seen;
  do { seen = await state(); if (predicate(seen)) return seen; } while (Date.now() < deadline);
  assert.fail(`Inspector UI completion missing: ${JSON.stringify(seen)}`);
}
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await browse(['open', `http://127.0.0.1:${server.address().port}`]); opened = true;
  await click('查看通道摘要');
  const first = await observe((seen) => seen.rows.length === 100 && seen.channel === 'hidebug' && !seen.next);
  assert(first.text.includes('getPss') && first.text.includes('接口参考'));
  await click('下一页通道记录');
  const next = await observe((seen) => seen.rows.length === 2 && seen.next);
  assert(next.status.includes('205'));
  await select('hilog');
  const empty = await observe((seen) => seen.status.includes('未采集') && seen.rows.length === 0);
  assert(!empty.text.includes('"value":0'));
  const started = new Promise((resolve) => { entered = resolve; });
  block = new Promise((resolve) => { release = resolve; }); blockNext = true;
  await select('hidebug');
  const timer = new AbortController();
  try {
    await Promise.race([started, delay(3000, undefined, { signal: timer.signal }).then(() => assert.fail('Inspector request did not start'))]);
  } finally { timer.abort(); }
  await select('ui'); await observe((seen) => seen.rows.length === 1 && seen.rows[0].includes('[MEMORY_ONLY]'));
  release();
  await browse(['wait', '--fn', `performance.getEntriesByType("resource").filter(e=>e.name.includes("/inspect/hidebug?")&&e.responseEnd>0).length>=3`]);
  assert.equal((await state()).channel, 'ui');
  assert.equal((await state()).rows.length, 1);
  fail = true; await select('hidebug'); await observe((seen) => seen.status.includes('JOURNAL_CORRUPT') && seen.rows.length === 0);
  fail = false; await click('刷新通道截点'); await observe((seen) => seen.rows.length === 100);
  await select('ui'); await observe((seen) => seen.rows.length === 1);
  const layouts = [];
  for (const [width, height, name] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
    await browse(['set', 'viewport', String(width), String(height)]);
    await browse(['scrollintoview', await ref('查看通道', 'combobox')]);
    const dimensions = JSON.parse(await browse(['eval', '({width:innerWidth,scroll:document.documentElement.scrollWidth})']));
    assert(dimensions.scroll <= dimensions.width, `${name} layout overflows`);
    await browse(['screenshot', join(output, `${name}.png`)]);
    layouts.push({ name, ...dimensions });
  }
  const errors = await browse(['errors']);
  assert(!errors.includes('Error:'), errors);
  await browse(['scrollintoview', '[data-command-picker]']);
  await click('选择本地命令'); await click('debug inspect · R0');
  assert((await browse(['snapshot', '-i'])).includes('加入助手可调用工具'), 'Inspector cannot be selected for the Web Agent');
  await click('加入助手可调用工具');
  assert.deepEqual(JSON.parse(await browse(['eval', 'window.toolState.allowedTools'])), ['debug.inspect']);
  await click('选择本地命令'); await click('debug start · R0');
  assert((await browse(['snapshot'])).includes('在终端使用此入口'), 'Lifecycle tool lost its dedicated-entry gate');
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', assets, fixedCutPagination: true,
    emptyState: true, lateResponse: true, corruptionRecovery: true, memoryOnly: true, webAgentSelection: true, layouts,
    producer: 'synthetic-browser-fixture', devicesProbed: false, errors }, null, 2) + '\n');
  console.log(`Inspector UI validation passed: ${output}`);
} finally {
  release?.();
  if (opened) await browse(['close']);
  await new Promise((resolve) => server.close(resolve));
}
