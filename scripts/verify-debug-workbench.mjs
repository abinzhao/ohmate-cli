/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { on, once } from 'node:events';
import { verifyDebugRender } from './verify-debug-render.mjs';
import { measureDebugRender } from './measure-debug-render.mjs';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm2-readonly-workbench-built', browser = process.argv.includes('--browser');
const history = process.argv.includes('--history');
const problem = process.argv.includes('--problem');
const inspector = process.argv.includes('--inspector');
const batched = process.argv.includes('--batch');
const render = process.argv.includes('--render');
const measure = process.argv.includes('--measure');
assert(!render || (browser && batched && !problem && !inspector), '--render requires --browser --batch without --problem/--inspector');
assert(!measure || (browser && batched && !problem && !inspector), '--measure requires --browser --batch without --problem/--inspector');
assert.match(label, /^[a-z0-9-]+$/);
const root = await mkdtemp('/private/tmp/ohmate-readonly-'), home = join(root, 'home');
const workspace = join(root, 'workspace');
const output = resolve('artifacts/validation', label);
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root,
  OHMATE_DATA_DIR: join(root, 'data'), NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
const browserSession = `ohmate-workbench-${root.split('/').at(-1)}`;
function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error && command === 'agent-browser') {
    const observed = spawnSync(command, ['--session', browserSession, 'eval',
      '({status:document.querySelector(".debug-stream-status")?.textContent,rows:document.querySelectorAll(".debug-event").length,buttons:Array.from(document.querySelectorAll(".debug-workbench button")).map(b=>({text:b.textContent,disabled:b.disabled}))})'],
    { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    console.error('Browser failure state:', observed.stdout.trim() || 'unavailable');
  }
  assert(!result.error, result.error?.message); return result;
}
function cli(args, expected = 0) {
  const result = run(process.execPath, [bin, ...args, '--format', 'json']);
  assert.equal(result.status, expected, 'CLI exit mismatch');
  return JSON.parse(result.stdout);
}
function browse(args) {
  const result = run('agent-browser', ['--session', browserSession, ...args]);
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
function ref(name, role = 'button') {
  const snapshot = browse(['snapshot', '-i']);
  const match = snapshot.match(new RegExp(`${role} "${name}" \\[[^\\]]*\\bref=(e\\d+)\\]`));
  assert(match, `Missing ${role}: ${name}`);
  return `@${match[1]}`;
}
function click(name, role = 'button') {
  // This browser version does not scroll offscreen refs before clicking.
  browse(['scrollintoview', ref(name, role)]);
  browse(['click', ref(name, role)]);
}
function selectStream(streamId) {
  browse(['scrollintoview', ref('事件流', 'combobox')]);
  browse(['select', ref('事件流', 'combobox'), streamId]);
}
function privateInvitation(args) {
  const python = `import os,pty,select,subprocess,sys,time,json,errno
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
data=b''
deadline=time.monotonic()+20
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   if not chunk: break
   data+=chunk
  elif p.poll() is not None: break
 if p.poll() is None: p.wait(timeout=2)
 print(json.dumps({'exit':p.returncode,'text':data.decode()}))
finally:
 if p.poll() is None: p.kill(); p.wait()
 os.close(master)`;
  const result = run('python3', ['-c', python, process.execPath, bin, ...args]);
  assert.equal(result.status, 0);
  const capture = JSON.parse(result.stdout);
  assert.equal(capture.exit, 0, 'Private TTY entry failed');
  const line = capture.text.split(/\r?\n/).find((text) => text.startsWith('{"endpoint":'));
  assert(line, 'Private TTY invitation missing');
  return JSON.parse(line);
}
async function savedText(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? savedText(join(path, entry.name)) : readFile(join(path, entry.name), 'utf8')))).join('');
}

let started = false, ws, channel, frames, browserOpened = false, lastEvent, renderEvents = 0, measuredEvents = 0;
try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 }); await mkdir(output, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const first = cli(['debug', 'start']); started = true;
  const { origin, debugSession, url } = first.data;
  const args = ['debug', 'pair', '--buildId', 'fixture-unverified', '--device', 'node-fixture',
    '--process', 'fixture-process', '--sessionId', 'fixture-session'];
  assert.equal(cli(args, 5).data.code, 'PRIVATE_TTY_REQUIRED');
  if (browser) {
    browse(['open', url]); browserOpened = true;
    assert.match(browse(['get', 'title']), /OHMate/);
    browse(['eval', '(()=>{window.__OHMATE_QA_ERRORS=[];addEventListener("error",e=>window.__OHMATE_QA_ERRORS.push(e.message));addEventListener("unhandledrejection",e=>window.__OHMATE_QA_ERRORS.push(String(e.reason)));return true})()']);
    browse(['set', 'viewport', '1280', '900']);
    click('调试', 'link');
    assert(browse(['snapshot', '-s', '#canvas']).includes('未配对'));
    if (problem) {
      assert(browse(['snapshot', '-i']).includes('校验并查看问题包'), 'Offline problem import entry is missing');
      assert(browse(['snapshot', '-i']).includes('导出选定事件流'), 'Fixed-cut problem export entry is missing');
    }
    if (history) {
      assert.equal(JSON.parse(browse(['eval', '!!document.getElementById("debug-stream")'])), true, 'Historical stream selector missing');
    }
  }
  const require = createRequire(bin), runtimePath = require.resolve('@ohmate/cli-common');
  const api = await import(pathToFileURL(runtimePath).href);
  const { default: WebSocket } = await import(pathToFileURL(createRequire(runtimePath).resolve('ws')).href);
  const envelope = privateInvitation(args), invitation = envelope.invitation;
  assert.equal(Buffer.from(invitation.oneTimeCode, 'base64').length, 32);
  const client = api.createPairingClient(invitation, { appConfirmed: true });
  ws = new WebSocket(envelope.endpoint, 'ohmate-readonly-v1'); frames = on(ws, 'message');
  await once(ws, 'open');
  const next = async () => JSON.parse((await frames.next()).value[0].toString());
  ws.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  ws.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: ready.sessionEpoch,
    ...(batched ? { eventBatch: 'events-v1' } : {}) })));
  const confirmed = channel.open(await next());
  assert.equal(confirmed.type, 'connected');
  if (batched) { assert.equal(confirmed.eventBatch, 'events-v1'); }
  function makeEvent(sequence, changes = {}) {
    return { ...invitation.handshake.identity, protocolVersion: '1.1', channelVersion: '1.0',
      sessionEpoch: ready.sessionEpoch, sequence, messageId: `event-${sequence}`, channel: 'hilog', type: 'event',
      capability: 'hilog.read', clockId: 'fixture-clock', bootId: 'fixture-boot',
      wallTimeUtc: '2026-10-24T00:00:00Z', monotonicNs: String(sequence), offsetUncertaintyMs: 5,
      payload: { level: 'info', summary: `Fixture event ${sequence} token=EXAMPLE_SECRET sample@example.test` },
      redaction: { policyId: 'fixture', fieldsRemoved: 0 }, ...changes };
  }
  async function sendBatch(events) {
    ws.send(JSON.stringify(channel.seal(batched ? { type: 'event-batch', version: '1', events } : events[0])));
    assert.equal(channel.open(await next()).ackThrough, events.at(-1).sequence);
    lastEvent = events.at(-1);
  }
  async function send(sequence, changes = {}) { await sendBatch([makeEvent(sequence, changes)]); }
  for (let first = 1; first <= 102; first += batched ? 32 : 1) {
    await sendBatch(Array.from({ length: Math.min(batched ? 32 : 1, 103 - first) }, (_, n) => makeEvent(first + n)));
  }
  const shown = cli(['debug', 'show', debugSession.id]), streamId = shown.data.bridge.streamId;
  const page = cli(['debug', 'events', debugSession.id, '--stream', streamId, '--limit', '100']);
  assert.equal(page.data.nextCursor, 100); assert.equal(page.data.through, 102); assert.equal(page.data.hasMore, true);
  assert(!JSON.stringify(shown).includes(invitation.oneTimeCode));
  if (browser) {
    click('刷新调试状态');
    browse(['wait', '--text', '游标 100 / 102']);
    click('下一页');
    browse(['wait', '--text', '游标 102 / 102']);
    assert(browse(['snapshot', '-s', '#canvas']).includes('button "下一页" [disabled'));
    click('跟随新事件');
    await send(103); browse(['wait', '--text', '已保存游标 103']);
    const htmlEvent = '<img src=x onerror="window.OHMATE_UNSAFE=1">';
    await send(104, { channel: 'ui', capability: 'ui.read', payload: { windowId: 'fixture-window', nodeCount: 1, summary: htmlEvent } });
    browse(['wait', '--text', 'MEMORY_ONLY']);
    assert(browse(['snapshot', '-s', '#canvas']).includes('已提交事件 104 条'), 'Live committed count is stale');
    assert(JSON.parse(browse(['eval', 'document.getElementById("debug-stream").selectedOptions[0].textContent'])).includes('104 条'),
      'Selected stream count is stale');
    const pixels = JSON.parse(browse(['eval', '({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,injected:!!window.OHMATE_UNSAFE,events:document.querySelectorAll(".debug-event:not(.problem-event)").length})']));
    assert.equal(pixels.overflow, false); assert.equal(pixels.injected, false); assert(pixels.events <= 100);
    browse(['screenshot', join(output, 'desktop.png')]);
    browse(['set', 'viewport', '390', '844']); browse(['screenshot', join(output, 'mobile.png')]);
    const small = JSON.parse(browse(['eval', '({overflow:document.documentElement.scrollWidth>innerWidth,canvasOverflow:document.getElementById("canvas").scrollWidth>document.getElementById("canvas").clientWidth})']));
    assert.equal(small.overflow, false); assert.equal(small.canvasOverflow, false);
    if (render) { renderEvents = await verifyDebugRender({ browse, click, sendBatch, makeEvent, output }); }
    if (measure) {
      if (!render) { click('暂停跟随'); click('刷新调试状态'); browse(['wait', '--text', '游标 100 / 104']); }
      measuredEvents = await measureDebugRender({ browse, click, sendBatch, makeEvent, output, after: 104 + renderEvents });
    }
  }
  const closed = once(ws, 'close'); ws.close(); await closed;
  if (browser) {
    click('刷新调试状态');
    browse(['wait', '--text', '已断开']);
    assert(browse(['snapshot', '-s', '#canvas']).includes('button "跟随新事件" [disabled'));
  }
  const final = cli(['debug', 'show', debugSession.id]);
  assert.equal(final.data.bridge.state, 'disconnected');
  if (inspector) {
    const selected = ['debug', 'inspect', debugSession.id, '--stream', streamId];
    const catalog = cli(['debug', 'inspectors']).data;
    assert.equal(catalog.inspectors.length, 17);
    const first = cli([...selected, '--channel', 'hilog', '--limit', '100']).data;
    assert.equal(first.events.length, 100); assert.equal(first.nextCursor, 100);
    assert.equal(first.inspector.coverageLevel, 'summary-only');
    assert.equal(first.source, 'peer-reported'); assert.equal(first.clockCalibration, 'not-calibrated');
    const remaining = cli([...selected, '--channel', 'hilog', '--after', '100', '--through', String(first.through)]).data;
    assert.equal(remaining.events.length, browser ? 3 : 2); assert.equal(remaining.hasMore, false);
    const empty = cli([...selected, '--channel', 'hidebug']).data;
    assert.equal(empty.availability, 'not-captured'); assert.deepEqual(empty.events, []);
    assert.equal(cli([...selected, '--channel', 'hilog', '--through', String(first.through + 1)], 4).exitCode, 4);
    if (browser) {
      click('查看通道摘要'); browse(['wait', '--text', '本通道未采集']);
      browse(['scrollintoview', ref('查看通道', 'combobox')]);
      browse(['select', ref('查看通道', 'combobox'), 'hilog']);
      browse(['wait', '--text', '本页 100 条']);
      click('下一页通道记录'); browse(['wait', '--text', '本页 3 条']);
      assert(browse(['snapshot', '-i']).includes('button "下一页通道记录" [disabled'));
      browse(['scrollintoview', ref('查看通道', 'combobox')]);
      browse(['select', ref('查看通道', 'combobox'), 'ui']);
      browse(['wait', '--text', '本通道 1 条']);
      assert.equal(JSON.parse(browse(['eval', 'document.querySelectorAll(".inspector-event").length'])), 1);
      assert(browse(['snapshot', '-s', '.debug-inspector']).includes('MEMORY_ONLY'));
      for (const [width, height, name] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
        browse(['set', 'viewport', String(width), String(height)]);
        browse(['scrollintoview', ref('查看通道', 'combobox')]);
        assert.equal(JSON.parse(browse(['eval', 'document.documentElement.scrollWidth>innerWidth'])), false);
        browse(['screenshot', join(output, `inspector-${name}.png`)]);
      }
    }
  }
  let problemValidated = false;
  if (problem) {
    assert(browser, '--problem requires --browser');
    browse(['set', 'viewport', '1280', '900']);
    click('导出选定事件流');
    browse(['wait', '--text', '请确认这次操作的范围']);
    assert(browse(['snapshot', '-s', '#canvas']).includes('问题包导出范围'), 'Export preview is not visible');
    browse(['eval', 'document.querySelector(".approval-inline").scrollIntoView({block:"start"})']);
    browse(['screenshot', join(output, 'problem-approval-desktop.png')]);
    click('确认此计划并执行');
    browse(['wait', '--text', '工具执行成功']);
    const tasks = await new api.TaskStore(env.OHMATE_DATA_DIR).list();
    const exported = tasks.find((task) => task.toolId === 'debug.problem.export' && task.state === 'succeeded');
    assert(exported, 'Approved background problem export did not finish');
    const path = exported.receipt.data.path;
    assert.equal(cli(['replay', 'verify', '--path', path]).data.count, 104);
    assert.equal(cli(['replay', 'verify', '--path', path, '--build-id', 'fixture-unverified']).exitCode, 0);
    assert.equal(cli(['replay', 'verify', '--path', path, '--build-id', 'wrong-build'], 4).data.message, 'PROBLEM_IDENTITY_MISMATCH');
    click('调试', 'link'); browse(['wait', '--text', '校验并查看问题包']);
    browse(['fill', ref('问题包本机路径', 'textbox'), path]);
    click('校验并查看问题包');
    browse(['wait', '--text', '离线游标 100 / 104']);
    click('下一页离线记录'); browse(['wait', '--text', '离线游标 104 / 104']);
    assert(browse(['snapshot', '-i']).includes('button "下一页离线记录" [disabled'));
    assert(browse(['snapshot', '-s', '#canvas']).includes('未恢复认证'));
    browse(['fill', ref('问题包本机路径', 'textbox'), join(root, 'missing.ohmate-problem.zip')]);
    click('校验并查看问题包'); browse(['wait', '--text', '问题包读取未完成']);
    assert.equal(JSON.parse(browse(['eval', 'document.querySelectorAll(".problem-event").length'])), 0);
    browse(['fill', ref('问题包本机路径', 'textbox'), path]);
    click('校验并查看问题包'); browse(['wait', '--text', '离线游标 100 / 104']);
    const AdmZip = createRequire(runtimePath)('adm-zip');
    const future = new AdmZip(await readFile(path)), manifest = JSON.parse(future.getEntry('manifest.json').getData().toString());
    manifest.schemaVersion = '2.0'; future.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const futurePath = join(root, 'future.ohmate-problem.zip');
    await writeFile(futurePath, future.toBuffer(), { mode: 0o600 });
    browse(['fill', ref('问题包本机路径', 'textbox'), futurePath]);
    click('校验并查看问题包'); browse(['wait', '--text', '主版本不兼容']);
    assert.equal(JSON.parse(browse(['eval', 'document.querySelectorAll(".problem-event").length'])), 0);
    assert(browse(['snapshot', '-i']).includes('button "下一页离线记录" [disabled'));
    browse(['fill', ref('问题包本机路径', 'textbox'), path]);
    click('校验并查看问题包'); browse(['wait', '--text', '离线游标 100 / 104']);
    browse(['set', 'viewport', '390', '844']);
    browse(['eval', 'document.getElementById("problem-title").scrollIntoView({block:"start"})']);
    assert.equal(JSON.parse(browse(['eval', 'document.documentElement.scrollWidth>innerWidth'])), false);
    browse(['screenshot', join(output, 'problem-mobile.png')]);
    browse(['set', 'viewport', '1280', '900']);
    browse(['eval', 'document.getElementById("problem-title").scrollIntoView({block:"start"})']);
    browse(['screenshot', join(output, 'problem-desktop.png')]);
    problemValidated = true;
  }
  let historicalStreams = 1;
  if (history) {
    async function reconnect(resume) {
      channel.close(); await frames.return();
      const envelope = privateInvitation(args), client = api.createPairingClient(envelope.invitation, { appConfirmed: true });
      ws = new WebSocket(envelope.endpoint, 'ohmate-readonly-v1');
      frames = on(ws, 'message', { signal: AbortSignal.timeout(10_000) }); await once(ws, 'open');
      ws.send(JSON.stringify(client.request())); channel = client.finish(await next());
      const greeting = channel.open(await next());
      ws.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: greeting.sessionEpoch,
        ...(batched ? { eventBatch: 'events-v1' } : {}), ...(resume ? { resume } : {}) })));
      const connected = channel.open(await next());
      assert.equal(connected.type, resume ? 'resumed' : 'connected');
      return { epoch: greeting.sessionEpoch, invitation: envelope.invitation, connected };
    }
    const resumed = await reconnect({ streamId, previousEpoch: ready.sessionEpoch, resumeFrom: lastEvent.sequence });
    assert.equal(resumed.connected.ackThrough, lastEvent.sequence - 1);
    ws.send(JSON.stringify(channel.seal({ ...lastEvent, sessionEpoch: resumed.epoch })));
    assert.equal(channel.open(await next()).ackThrough, lastEvent.sequence);
    const appended = { ...lastEvent, sessionEpoch: resumed.epoch, sequence: lastEvent.sequence + 1,
      messageId: 'resumed-new-event', monotonicNs: String(BigInt(lastEvent.monotonicNs) + 1n),
      channel: 'hidebug', capability: 'hidebug.read', payload: { metric: 'pssBytes', value: 1024 } };
    ws.send(JSON.stringify(channel.seal(appended)));
    assert.equal(channel.open(await next()).ackThrough, appended.sequence);
    let closed = once(ws, 'close'); ws.close(); await closed;
    const fresh = await reconnect();
    ws.send(JSON.stringify(channel.seal({ ...appended, ...fresh.invitation.handshake.identity,
      sessionEpoch: fresh.epoch, sequence: 1, messageId: 'fresh-stream-event', monotonicNs: '1' })));
    assert.equal(channel.open(await next()).ackThrough, 1);
    closed = once(ws, 'close'); ws.close(); await closed;
    const listing = cli(['debug', 'streams', debugSession.id]);
    historicalStreams = listing.data.streams.length;
    assert.equal(historicalStreams, 2);
    assert.deepEqual(listing.data.streams.map((item) => item.through).sort((a, b) => a - b), [1, appended.sequence]);
    if (browser) {
      click('刷新调试状态');
      browse(['wait', '--text', '日志校验通过']);
      const choices = JSON.parse(browse(['eval', 'Array.from(document.getElementById("debug-stream").options).map(item=>item.value)']));
      assert.equal(choices.length, 2);
      selectStream(choices.find((id) => id !== streamId));
      browse(['wait', '--text', '游标 1 / 1']);
      assert.equal(JSON.parse(browse(['eval', 'document.querySelectorAll(".debug-event:not(.problem-event)").length'])), 1);
      selectStream(streamId);
      browse(['wait', '--text', `游标 100 / ${appended.sequence}`]);
      assert(browse(['snapshot', '-s', '#canvas']).includes('button "跟随新事件" [disabled'));
      browse(['screenshot', join(output, 'history-mobile.png')]);
    }
  }
  const disk = await savedText(env.OHMATE_DATA_DIR);
  assert(!disk.includes(invitation.oneTimeCode)); assert(!disk.includes('EXAMPLE_SECRET'));
  cli(['debug', 'stop']); started = false;
  const retained = cli(['debug', 'events', debugSession.id, '--stream', streamId, '--after', '100', '--limit', '100']);
  assert.equal(retained.data.through, (browser ? 104 : 102) + renderEvents + measuredEvents + Number(history));
  if (history) {
    const restarted = cli(['debug', 'start']); started = true;
    assert.notEqual(restarted.data.debugSession.id, debugSession.id);
    assert.equal(restarted.data.debugSession.bridge.authentication, 'unpaired');
    assert.equal(cli(['debug', 'streams', debugSession.id]).data.streams.length, 2);
    cli(['debug', 'stop']); started = false;
  }
  if (browser) { assert.deepEqual(JSON.parse(browse(['eval', 'window.__OHMATE_QA_ERRORS'])), []); }
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, platform: process.platform,
    entry: bin, privateTtyPairing: true, redirectedPairingBlocked: true, invitationNotPersisted: true,
    actualEncryptedNetwork: true, producer: 'node-fixture', buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
    events: retained.data.through, durablePageCursor: page.data.nextCursor, browser, eventBatch: batched, devicesProbed: false,
    inspectorValidated: inspector, renderValidated: render, browserRenderMeasured: measure,
    historicalStreams, persistedResume: history, authenticationRestored: false, problemValidated,
    limitations: ['ArkTS Kit and HDC not verified', 'Only macOS/Chrome validated'] }, null, 2) + '\n');
  console.log(`Readonly workbench validation passed: ${output}`);
} finally {
  channel?.close(); if (frames) { await frames.return(); } ws?.terminate();
  if (started) { cli(['debug', 'stop']); }
  if (browserOpened) { browse(['close']); }
}
