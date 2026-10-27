/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { on, once } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm2-sustained-smoke-r1';
const durationSeconds = Number(process.argv[4] ?? 15);
const reconfirmSeconds = Number(process.argv[5] ?? 300);
assert.match(label, /^[a-z0-9-]+$/);
assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= 10 && durationSeconds <= 600);
assert(Number.isSafeInteger(reconfirmSeconds) && reconfirmSeconds >= 10 && reconfirmSeconds <= 300);
const output = resolve('artifacts/validation', label);
await mkdir(output, { mode: 0o700 });
const root = await mkdtemp('/private/tmp/ohmate-sustained-'), home = join(root, 'home');
const workspace = join(root, 'workspace'), data = join(root, 'data');
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root,
  OHMATE_DATA_DIR: data, NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
const browserSession = `sustained-${root.split('/').at(-1)}`;
let started = false, browserOpened = false, pair, origin, sessionId, streamId, runtimePath;
let tail = 0, measured = 0, startedAt = 0, stoppedAt = 0, monitor, failure;
const epochs = [], ackSamples = [], browserChecks = [], chunks = [];
let ackFile, browserFile, intervalFile, stopMonitor = false;
let arrivals = 0, rendered = 0, missingSse = 0, maxRows = 0, overflows = 0, lastArrival = 64;
const latency = { dom: [], nextFrame: [], arrival: [], dispatch: [] };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
async function run(command, args) {
  return (await execute(command, args, { cwd: workspace, env, timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024, shell: false })).stdout;
}
async function cli(args) {
  const result = JSON.parse(await run(process.execPath, [bin, ...args, '--format', 'json']));
  assert.equal(result.exitCode, 0, 'Measurement CLI receipt failed');
  return result.data;
}
async function browse(args) { return run('agent-browser', ['--session', browserSession, ...args]); }
async function evaluate(code) { return JSON.parse(await browse(['eval', code])); }
async function click(name, role = 'button') {
  const snapshot = await browse(['snapshot', '-i']);
  const match = snapshot.match(new RegExp(`${role} "${name}" \\[[^\\]]*\\bref=(e\\d+)\\]`));
  assert(match, `Missing measurement ${role}: ${name}`);
  await browse(['scrollintoview', `@${match[1]}`]);
  await browse(['click', `@${match[1]}`]);
}
async function privateInvitation() {
  const python = `import os,pty,select,subprocess,sys,time,json,errno
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
data=b''
try:
 deadline=time.monotonic()+20
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
  const capture = JSON.parse(await run('python3', ['-c', python, process.execPath, bin, 'debug', 'pair',
    '--buildId', 'unverified-sustained-measurement', '--device', 'node-measurement',
    '--process', 'node-process', '--sessionId', 'node-session']));
  assert.equal(capture.exit, 0, 'Private TTY pairing failed');
  const line = capture.text.split(/\r?\n/).find((text) => text.startsWith('{"endpoint":'));
  assert(line, 'Private invitation missing');
  return JSON.parse(line);
}
async function next(current) {
  let timer;
  try {
    const frame = await Promise.race([current.frames.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Encrypted response timed out')), 10_000);
    })]);
    assert(!frame.done, 'Encrypted connection ended before response');
    return JSON.parse(frame.value[0].toString());
  } finally { clearTimeout(timer); }
}
function send(value) { pair.ws.send(JSON.stringify(pair.channel.seal(value))); }
async function clockReply(probe) {
  const t1 = process.hrtime.bigint().toString();
  send({ type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
    clockId: 'node-clock', bootId: 'node-boot', t1, t2: process.hrtime.bigint().toString(), precisionNs: '1000000' });
}
async function connect(api, WebSocket, resume = false) {
  const invitation = await privateInvitation(), client = api.createPairingClient(invitation.invitation, { appConfirmed: true });
  const current = { ws: new WebSocket(invitation.endpoint, 'ohmate-readonly-v1'), invitation: invitation.invitation };
  pair = current; current.frames = on(current.ws, 'message');
  await once(current.ws, 'open');
  current.ws.send(JSON.stringify(client.request())); current.channel = client.finish(await next(current));
  assert.equal(current.channel.limits.maxFrames, 65536);
  assert(current.channel.limits.expiresAt <= Date.now() + 600_000);
  current.epoch = current.channel.open(await next(current)).sessionEpoch;
  const previousEpoch = epochs.at(-1)?.epoch;
  send({ type: 'ready', sessionEpoch: current.epoch, clockSync: 'four-timestamp-v1',
    eventBatch: 'events-v1', retention: 'rolling-v1',
    ...(resume ? { resume: { streamId, previousEpoch, resumeFrom: tail + 1 } } : {}) });
  const confirmed = current.channel.open(await next(current));
  assert.equal(confirmed.type, resume ? 'resumed' : 'connected');
  assert.equal(confirmed.retention, 'rolling-v1'); assert.equal(confirmed.eventBatch, 'events-v1');
  if (resume) { assert.equal(confirmed.ackThrough, tail); assert.equal(confirmed.streamId, streamId); }
  await clockReply(current.channel.open(await next(current)));
  epochs.push({ epoch: current.epoch, previousEpoch, resumeFrom: tail + 1, appConfirmedBy: 'validation-program',
    atMs: startedAt ? performance.now() - startedAt : 0, expiresAt: current.channel.limits.expiresAt,
    maxFrames: current.channel.limits.maxFrames });
  if (!resume) { streamId = (await cli(['debug', 'show', sessionId])).bridge.streamId; }
}
async function disconnect() {
  if (!pair) { return; }
  const current = pair; pair = undefined;
  if (current.ws.readyState !== 3) {
    const closed = once(current.ws, 'close'); current.ws.close(); await closed;
  }
  current.channel?.close(); await current.frames.return();
}
async function batch() {
  const through = tail + 64, producedAt = new Date().toISOString();
  const events = Array.from({ length: 64 }, (_, offset) => {
    const sequence = tail + offset + 1;
    return { ...pair.invitation.handshake.identity, protocolVersion: '1.1', channelVersion: '1.0',
      sessionEpoch: pair.epoch, sequence, messageId: `event-${sequence}`, channel: 'hidebug', type: 'event',
      capability: 'hidebug.read', clockId: 'node-clock', bootId: 'node-boot', wallTimeUtc: producedAt,
      monotonicNs: process.hrtime.bigint().toString(), offsetUncertaintyMs: Number.MAX_SAFE_INTEGER,
      payload: { metric: 'pssBytes', value: sequence }, redaction: { policyId: 'measurement', fieldsRemoved: 0 } };
  });
  const start = performance.now(); send({ type: 'event-batch', version: '1', events });
  let reply = pair.channel.open(await next(pair));
  while (reply.type === 'clock-probe') { await clockReply(reply); reply = pair.channel.open(await next(pair)); }
  assert.equal(reply.type, 'ack'); assert.equal(reply.ackThrough, through); tail = through;
  const sample = { through, atMs: startedAt ? performance.now() - startedAt : 0, ackMs: performance.now() - start };
  if (startedAt) { ackSamples.push(sample); await ackFile.write(JSON.stringify(sample) + '\n'); measured += 64; }
}
function installObserver() {
  const NativeSource = window.EventSource, nativeFrame = window.requestAnimationFrame, nativeCancel = window.cancelAnimationFrame;
  const qa = window.__OHMATE_SUSTAINED = { after: 64, arrivals: new Map(), rows: [], callbacks: new Set(),
    lastSeen: 64, lastRendered: 64, frames: 0, maxRows: 0, overflow: 0, error: null, pendingProductFrames: new Set(), maxPendingFrames: 0 };
  const now = () => performance.timeOrigin + performance.now();
  const push = (row) => {
    if (qa.rows.length >= 8192) { qa.overflow++; return; }
    qa.rows.push(row);
  };
  window.EventSource = class extends NativeSource {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (message) => {
        const record = JSON.parse(message.data);
        if (record.index <= qa.after) { return; }
        if (record.index !== qa.lastSeen + 1 || message.lastEventId !== String(record.index)) {
          qa.error ??= 'SSE sequence or cursor mismatch'; return;
        }
        qa.lastSeen = record.index;
        const sample = { index: record.index, producedAt: Date.parse(record.event.wallTimeUtc), arrivalAt: now() };
        push({ type: 'arrival', ...sample }); qa.arrivals.set(record.index, sample);
        if (qa.arrivals.size > 512) { qa.arrivals.delete(qa.arrivals.keys().next().value); }
      });
      this.addEventListener('gap', (message) => {
        const gap = JSON.parse(message.data);
        if (gap.missingThrough <= qa.lastSeen) { return; }
        if (gap.missingFrom !== qa.lastSeen + 1 || gap.missingThrough !== gap.retainedFrom - 1 ||
          message.lastEventId !== String(gap.missingThrough) || gap.reason !== 'retention-quota') {
          qa.error ??= 'SSE gap mismatch'; return;
        }
        push({ type: 'gap', data: gap }); qa.lastSeen = gap.missingThrough;
      });
      this.addEventListener('fault', () => { qa.error = 'SSE fault'; });
    }
  };
  window.requestAnimationFrame = (callback) => {
    const frame = nativeFrame.call(window, (time) => { qa.pendingProductFrames.delete(frame); callback(time); });
    qa.pendingProductFrames.add(frame); qa.maxPendingFrames = Math.max(qa.maxPendingFrames, qa.pendingProductFrames.size);
    return frame;
  };
  window.cancelAnimationFrame = (frame) => { qa.pendingProductFrames.delete(frame); nativeCancel.call(window, frame); };
  const list = document.querySelector('.debug-workbench > section .debug-event-list');
  qa.observer = new MutationObserver(() => {
    try {
      const records = [...list.querySelectorAll('.debug-event > details > pre')].map((item) => JSON.parse(item.textContent));
      qa.frames++; qa.maxRows = Math.max(qa.maxRows, records.length);
      const domAt = now(), added = [];
      for (const record of records) {
        if (record.index <= qa.after || record.index <= qa.lastRendered) { continue; }
        const arrival = qa.arrivals.get(record.index);
        if (!arrival || record.event.payload.value !== record.index) { throw new Error('DOM/SSE record mismatch'); }
        added.push({ type: 'render', ...arrival, domAt }); qa.lastRendered = record.index;
      }
      if (added.length) {
        const frame = nativeFrame.call(window, () => {
          qa.callbacks.delete(frame); const nextFrameAt = now();
          for (const sample of added) { push({ ...sample, nextFrameAt }); }
        });
        qa.callbacks.add(frame);
      }
    } catch (error) { qa.error ??= error.message; }
  });
  qa.observer.observe(list, { childList: true });
  qa.drain = () => ({ rows: qa.rows.splice(0), lastSeen: qa.lastSeen, lastRendered: qa.lastRendered, frames: qa.frames,
    maxRows: qa.maxRows, overflow: qa.overflow, error: qa.error, maxPendingFrames: qa.maxPendingFrames,
    heapBytes: performance.memory?.usedJSHeapSize ?? null,
    status: document.querySelector('.debug-stream-status').textContent });
  qa.restore = () => {
    qa.observer.disconnect(); window.EventSource = NativeSource;
    window.requestAnimationFrame = nativeFrame; window.cancelAnimationFrame = nativeCancel;
    for (const frame of qa.callbacks) { nativeCancel.call(window, frame); }
    qa.callbacks.clear();
  };
  return true;
}
async function drainBrowser() {
  const chunk = await evaluate('window.__OHMATE_SUSTAINED.drain()');
  await browserFile.write(chunk.rows.map((row) => JSON.stringify(row) + '\n').join(''));
  const { rows, ...check } = chunk; browserChecks.push(check);
  assert.equal(chunk.error, null); assert.equal(chunk.overflow, 0, 'Measurement sample buffer overflow');
  assert(chunk.maxRows <= 100, 'Product DOM bound exceeded');
  assert(chunk.maxPendingFrames <= 1, 'Product scheduled multiple pending frames');
  maxRows = Math.max(maxRows, chunk.maxRows); overflows = chunk.overflow;
  for (const row of rows) {
    if (row.type === 'arrival') {
      assert.equal(row.index, ++lastArrival); arrivals++;
      latency.arrival.push(row.arrivalAt - row.producedAt);
    } else if (row.type === 'render') {
      assert(row.nextFrameAt >= row.domAt && row.domAt >= row.arrivalAt);
      assert(row.domAt - row.producedAt >= -2, 'Same-host clock mismatch');
      rendered++; latency.dom.push(row.domAt - row.producedAt);
      latency.nextFrame.push(row.nextFrameAt - row.producedAt); latency.dispatch.push(row.domAt - row.arrivalAt);
    } else if (row.type === 'gap') {
      assert.equal(row.data.missingFrom, lastArrival + 1);
      missingSse += row.data.missingThrough - row.data.missingFrom + 1; lastArrival = row.data.missingThrough;
    }
  }
  return chunk;
}
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? null;
try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  ackFile = await open(join(output, 'ack.jsonl'), 'wx', 0o600);
  browserFile = await open(join(output, 'browser.jsonl'), 'wx', 0o600);
  intervalFile = await open(join(output, 'intervals.jsonl'), 'wx', 0o600);
  const first = await cli(['debug', 'start']); started = true; origin = first.origin; sessionId = first.debugSession.id;
  runtimePath = createRequire(bin).resolve('@ohmate/cli-common');
  const api = await import(pathToFileURL(runtimePath).href);
  const { default: WebSocket } = await import(pathToFileURL(createRequire(runtimePath).resolve('ws')).href);
  await connect(api, WebSocket); await batch();
  const url = (await cli(['ui', '--no-open'])).url;
  browserOpened = true; await browse(['open', url]); await browse(['set', 'viewport', '1280', '900']);
  await click('调试', 'link'); await browse(['wait', '--text', '游标 64 / 64']);
  await evaluate(`(${installObserver.toString()})()`); await click('跟随新事件');
  await browse(['wait', '--fn', 'window.__OHMATE_SUSTAINED && document.querySelector(".debug-stream-status").textContent.includes("跟随")']);
  startedAt = performance.now();
  monitor = (async () => {
    try {
      while (!stopMonitor) { await delay(2000); if (!stopMonitor) { await drainBrowser(); } }
    } catch (error) { failure = error; }
  })();
  let nextReport = startedAt + 10_000, previousReport = startedAt, previousCount = 0;
  let nextPairAt = startedAt + reconfirmSeconds * 1000;
  while (performance.now() - startedAt < durationSeconds * 1000) {
    if (failure) { throw failure; }
    if (performance.now() >= nextPairAt) {
      // Explicit test-program app confirmation preserves expiry and nonce boundaries.
      stopMonitor = true; await monitor;
      if (failure) { throw failure; }
      await browse(['wait', '--fn', `window.__OHMATE_SUSTAINED.lastSeen === ${tail} && window.__OHMATE_SUSTAINED.lastRendered === ${tail}`]);
      await drainBrowser(); await disconnect();
      await connect(api, WebSocket, true);
      await evaluate(`(window.__OHMATE_SUSTAINED.after = ${tail}, true)`);
      await click('刷新调试状态'); await browse(['wait', '--text', '日志校验通过']);
      await click('跟随新事件');
      await browse(['wait', '--text', `已保存游标 ${tail}`]);
      stopMonitor = false;
      monitor = (async () => {
        try { while (!stopMonitor) { await delay(2000); if (!stopMonitor) { await drainBrowser(); } } }
        catch (error) { failure = error; }
      })();
      nextPairAt += reconfirmSeconds * 1000;
    }
    await batch();
    const now = performance.now();
    if (now >= nextReport) {
      const interval = { through: tail, elapsedMs: now - startedAt, count: measured - previousCount,
        durationMs: now - previousReport, eventsPerSecond: (measured - previousCount) * 1000 / (now - previousReport),
        browserArrivals: arrivals, rendered, producerRssBytes: process.memoryUsage().rss };
      await intervalFile.write(JSON.stringify(interval) + '\n'); chunks.push(interval);
      console.log(JSON.stringify(interval)); previousReport = now; previousCount = measured; nextReport += 10_000;
    }
  }
  stoppedAt = performance.now(); stopMonitor = true; await monitor;
  if (failure) { throw failure; }
  await browse(['wait', '--fn', `window.__OHMATE_SUSTAINED.lastSeen === ${tail} && window.__OHMATE_SUSTAINED.lastRendered === ${tail}`]);
  await drainBrowser(); assert.equal(arrivals + missingSse, measured, 'Unaccounted produced events missing from browser SSE');
  assert.equal(lastArrival, tail); assert(overflows === 0);
  const final = await cli(['debug', 'events', sessionId, '--stream', streamId, '--after', '0', '--limit', '256']);
  assert.equal(final.manifest.schemaVersion, '1.4');
  assert.equal(final.manifest.maxEvents, 4096); assert.equal(final.manifest.maxBytes, 5 * 1024 ** 2);
  assert.equal(final.manifest.buildVerification, 'unverified'); assert.equal(final.manifest.deviceProvenance, 'peer-asserted');
  assert.equal(final.through, tail); assert(final.retainedFrom > 1); assert(final.retainedCount <= 4096);
  assert.equal(final.retainedFrom + final.retainedCount - 1, tail);
  assert.deepEqual(final.gap, { missingFrom: 1, missingThrough: final.retainedFrom - 1, reason: 'retention-quota' });
  const directory = join(data, 'debug-events', sessionId, streamId);
  const checkpoint = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.index, tail); assert.equal(checkpoint.retention.cleanupPending, false);
  let diskBytes = 0;
  for (const name of await readdir(directory)) { diskBytes += (await readFile(join(directory, name))).length; }
  assert(diskBytes <= 5 * 1024 ** 2);
  await click('暂停跟随');
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    await browse(['set', 'viewport', String(width), String(height)]);
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await browse(['screenshot', join(output, `${width}.png`)]);
  }
  assert.equal((await browse(['errors'])).trim(), '');
  const elapsedMs = stoppedAt - startedAt, eventsPerSecond = measured * 1000 / elapsedMs;
  const sourceHashes = {};
  for (const file of ['scripts/measure-debug-sustained.mjs', 'apps/web/debug.js',
    'packages/cli/src/debug/event-journal.ts', 'packages/cli/src/web/debug-events.ts', bin, runtimePath]) {
    sourceHashes[file] = sha(await readFile(file));
  }
  const result = { status: 'measurement-completed', entry: bin, runtimePath, sourceHashes, root,
    node: process.version, platform: process.platform, actualEncryptedNetwork: true, actualBrowserSse: true,
    producer: 'Node-encrypted-loopback', actualKit: false, devicesProbed: false,
    deviceProvenance: 'peer-asserted', buildVerification: 'unverified', authenticationRestored: false,
    requestedDurationSeconds: durationSeconds, reconfirmSeconds, batchSize: 64, pendingAckLimit: 1, elapsedMs, count: measured, eventsPerSecond,
    arrivals, rendered, missingSse, notObservedInDom: arrivals - rendered, maxRows, overflows, browserChecks,
    ackP95Ms: quantile(ackSamples.map((sample) => sample.ackMs), 0.95),
    arrivalP95Ms: quantile(latency.arrival, 0.95), domP95Ms: quantile(latency.dom, 0.95),
    nextFrameP95Ms: quantile(latency.nextFrame, 0.95), sseDispatchToDomP95Ms: quantile(latency.dispatch, 0.95),
    epochs, quotas: { events: 4096, bytes: 5 * 1024 ** 2 }, through: tail,
    retainedFrom: final.retainedFrom, retainedCount: final.retainedCount, diskBytes, intervals: chunks,
    latencyEndpoints: { start: 'event creation before AEAD encryption; same-host UTC quantized to 1 ms',
      arrival: 'real browser EventSource message dispatch', dom: 'MutationObserver after actual list replacement',
      nextFrame: 'following requestAnimationFrame callback; physical display paint not measured' },
    gaLoad: { requiredEventsPerSecond: 1000, requiredDurationSeconds: 600, requiredUiP95Ms: 500,
      desktopBudgetMet: elapsedMs >= 600_000 && eventsPerSecond >= 1000 && rendered === measured && missingSse === 0 &&
        quantile(latency.nextFrame, 0.95) <= 500,
      verified: false, reason: 'Physical paint and actual Kit/device not measured; desktop budget reported separately' } };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { browserChecks: _checks, intervals: _intervals, ...summary } = result;
  console.log(JSON.stringify(summary));
} catch (error) {
  failure = error;
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: error.message, through: tail, measured, arrivals, missingSse,
    rendered, elapsedMs: startedAt ? performance.now() - startedAt : 0, root, browserChecks, epochs }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
  throw error;
} finally {
  stopMonitor = true; await monitor;
  if (browserOpened) {
    await evaluate('window.__OHMATE_SUSTAINED ? (window.__OHMATE_SUSTAINED.restore(), true) : true').catch(() => {});
  }
  await disconnect();
  if (started) { await cli(['debug', 'stop']); }
  if (browserOpened) { await browse(['close']); }
  await ackFile?.close(); await browserFile?.close(); await intervalFile?.close();
  await writeFile(join(output, 'execution.json'), JSON.stringify({ cleanup: 'completed', root, failed: Boolean(failure) }) + '\n',
    { flag: 'wx', mode: 0o600 });
}
