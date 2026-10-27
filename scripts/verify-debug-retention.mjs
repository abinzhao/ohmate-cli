/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { on, once } from 'node:events';
import { createHash } from 'node:crypto';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm2-retention-built-r1';
const browser = process.argv.includes('--browser');
assert.match(label, /^[a-z0-9-]+$/);
const root = await mkdtemp('/private/tmp/ohmate-retention-'), home = join(root, 'home');
const workspace = join(root, 'workspace'), output = resolve('artifacts/validation', label);
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root,
  OHMATE_DATA_DIR: join(root, 'data'), NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'), OHMATE_VALIDATION_KEY: 'EXAMPLE_LOCAL_PROTOCOL_ONLY' };
const browserSession = `retention-${root.split('/').at(-1)}`;
const checks = [];
const privateCodes = [];
let started = false, browserOpened = false, pair, origin, cookie, sessionId, streamId;
let problemPath, firstEpoch, tail = 0, agentRequests = 0;
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, env, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, shell: false });
  assert.equal(result.error, undefined, 'Validation subprocess did not settle');
  return result;
}
function cli(args, expected = 0) {
  const result = run(process.execPath, [bin, ...args, '--format', 'json']);
  assert.equal(result.status, expected, `Unexpected CLI exit for ${args.slice(0, 3).join(' ')}`);
  return JSON.parse(result.stdout);
}
function browse(args) {
  const result = run('agent-browser', ['--session', browserSession, ...args]);
  assert.equal(result.status, 0, 'Private browser command failed'); return result.stdout;
}
function ref(name, role = 'button') {
  const match = browse(['snapshot', '-i']).match(new RegExp(`${role} "${name}" \\[[^\\]]*\\bref=(e\\d+)\\]`));
  assert(match, `Missing ${role}: ${name}`); return `@${match[1]}`;
}
function click(name, role = 'button') {
  browse(['scrollintoview', ref(name, role)]); browse(['click', ref(name, role)]);
}
function privateInvitation() {
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
  const result = run('python3', ['-c', python, process.execPath, bin, 'debug', 'pair',
    '--buildId', 'fixture-unverified', '--device', 'node-fixture', '--process', 'fixture-process', '--sessionId', 'fixture-session']);
  assert.equal(result.status, 0, 'Private pairing process failed');
  const capture = JSON.parse(result.stdout);
  assert.equal(capture.exit, 0, 'Private pairing entry failed');
  const line = capture.text.split(/\r?\n/).find((text) => text.startsWith('{"endpoint":'));
  assert(line, 'Private invitation missing');
  const envelope = JSON.parse(line); privateCodes.push(envelope.invitation.oneTimeCode); return envelope;
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
async function connect(api, WebSocket, options = { eventBatch: 'events-v1', retention: 'rolling-v1' }, version = '1.1') {
  const envelope = privateInvitation(), client = api.createPairingClient(envelope.invitation, {
    appConfirmed: true, protocolVersionRange: { min: version, max: version },
  });
  const ws = new WebSocket(envelope.endpoint, 'ohmate-readonly-v1'), frames = on(ws, 'message');
  const current = { ws, frames, invitation: envelope.invitation, version };
  pair = current;
  await once(ws, 'open');
  ws.send(JSON.stringify(client.request())); current.channel = client.finish(await next(current));
  current.epoch = current.channel.open(await next(current)).sessionEpoch;
  ws.send(JSON.stringify(current.channel.seal({ type: 'ready', sessionEpoch: current.epoch, ...options })));
  current.confirmed = current.channel.open(await next(current));
  assert.equal(current.confirmed.type, options.resume ? 'resumed' : 'connected');
  assert.equal(current.confirmed.retention, options.retention);
  return current;
}
async function disconnect() {
  if (!pair) { return; }
  const current = pair; pair = undefined;
  if (current.ws.readyState !== 3) { const closed = once(current.ws, 'close'); current.ws.close(); await closed; }
  current.channel?.close(); await current.frames.return();
}
function event(sequence, changes = {}) {
  return { ...pair.invitation.handshake.identity, protocolVersion: pair.version, channelVersion: '1.0',
    sessionEpoch: pair.epoch, sequence, messageId: `event-${sequence}`, channel: 'hilog', type: 'event',
    capability: 'hilog.read', clockId: 'fixture-clock', bootId: 'fixture-boot',
    wallTimeUtc: '2026-10-24T00:00:00Z', monotonicNs: String(sequence), offsetUncertaintyMs: 5,
    payload: { level: 'info', summary: `Fixture ${sequence} token=EXAMPLE_SECRET` },
    redaction: { policyId: 'fixture', fieldsRemoved: 0 }, ...changes };
}
async function send(events, batched = true) {
  pair.ws.send(JSON.stringify(pair.channel.seal(batched ? { type: 'event-batch', version: '1', events } : events[0])));
  const ack = pair.channel.open(await next(pair));
  assert.equal(ack.type, 'ack'); assert.equal(ack.ackThrough, events.at(-1).sequence);
  tail = ack.ackThrough;
}
function page(after = 0, limit = 100) {
  return cli(['debug', 'events', sessionId, '--stream', streamId, '--after', String(after), '--limit', String(limit)]).data;
}
async function sse(after, lastEventId) {
  const cancel = new AbortController();
  const response = await fetch(`${origin}/api/v1/debug/sessions/${sessionId}/streams/${streamId}/live?after=${after}&limit=256`,
    { headers: { cookie, ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }) },
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(30_000)]) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  async function* frames() {
    const decoder = new TextDecoder(); let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { break; }
        text += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = text.indexOf('\n\n')) !== -1) {
          const raw = text.slice(0, end); text = text.slice(end + 2);
          if (raw.startsWith(':')) { continue; }
          const fields = Object.fromEntries(raw.split('\n').map((line) => {
            const split = line.indexOf(':'); return [line.slice(0, split), line.slice(split + 1).trimStart()];
          }));
          yield { type: fields.event ?? 'message', id: fields.id, data: JSON.parse(fields.data) };
        }
      }
    } finally { cancel.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return { frames: frames(), cancel };
}
async function savedText(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? savedText(join(directory, entry.name)) :
    readFile(join(directory, entry.name), 'utf8')))).join('');
}
const modelServer = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) { body += chunk; }
    const payload = JSON.parse(body); agentRequests++;
    const returned = payload.messages.find((message) => message.role === 'tool');
    if (returned) {
      const receipt = JSON.parse(returned.content);
      assert.equal(receipt.exitCode, 0); assert.equal(receipt.data.retainedFrom, agentPage.retainedFrom);
      assert.equal(receipt.data.events[0].sequence, agentPage.retainedFrom);
      assert.equal(receipt.data.nextCursor, agentPage.retainedFrom);
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = returned ? { content: 'Retained Agent page verified.' } : { tool_calls: [{
      index: 0, id: 'retained-call', type: 'function',
      function: { name: 'replay__show', arguments: JSON.stringify({ path: problemPath, after: 0, limit: 1 }) },
    }] };
    for (const chunk of [{ delta, finish_reason: null }, { delta: {}, finish_reason: returned ? 'stop' : 'tool_calls' }]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', model: 'example', choices: [{ index: 0, ...chunk }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  } catch { response.destroy(new Error('Local model tool response invalid')); }
});
let agentPage;
try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 }); await mkdir(output, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const first = cli(['debug', 'start']); started = true;
  ({ origin } = first.data); sessionId = first.data.debugSession.id;
  const exchange = await fetch(`${origin}/api/v1/connect`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(first.data.url).hash.slice('#access='.length) }) });
  assert.equal(exchange.status, 200); cookie = exchange.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${origin}/api/v1/debug/sessions/${sessionId}/streams`)).status, 401);
  const runtimePath = createRequire(bin).resolve('@ohmate/cli-common');
  const api = await import(pathToFileURL(runtimePath).href);
  const { default: WebSocket } = await import(pathToFileURL(createRequire(runtimePath).resolve('ws')).href);
  await connect(api, WebSocket); firstEpoch = pair.epoch;
  for (let from = 1; from <= 4224; from += 64) {
    await send(Array.from({ length: 64 }, (_, index) => event(from + index)));
  }
  streamId = cli(['debug', 'show', sessionId]).data.bridge.streamId;
  const initial = page();
  assert.equal(initial.manifest.schemaVersion, '1.4');
  assert.equal(initial.manifest.maxEvents, 4096); assert.equal(initial.manifest.maxBytes, 5 * 1024 * 1024);
  assert.equal(initial.through, 4224); assert(initial.retainedFrom > 1);
  assert(initial.retainedCount <= 4096); assert.equal(initial.retainedFrom + initial.retainedCount - 1, tail);
  assert.deepEqual(initial.gap, { missingFrom: 1, missingThrough: initial.retainedFrom - 1, reason: 'retention-quota' });
  assert.deepEqual(initial.events.map((record) => record.index), Array.from({ length: 100 }, (_, index) => initial.retainedFrom + index));
  const directory = join(env.OHMATE_DATA_DIR, 'debug-events', sessionId, streamId);
  const checkpoint = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.index, tail); assert(checkpoint.bytes <= 5 * 1024 * 1024);
  assert.equal(checkpoint.retention.cleanupPending, false);
  const listing = cli(['debug', 'streams', sessionId]).data.streams[0];
  assert.equal(listing.retainedCount, initial.retainedCount); assert.equal(listing.through, tail);
  checks.push('production quota rolls beyond 4096; exact CLI and stream index range; cleanup checkpoint');
  console.log(`Rolling encrypted archive verified through ${tail}, retained from ${initial.retainedFrom}`);

  const live = await sse(0, tail);
  try {
    const initialNotice = await live.frames.next();
    assert.equal(initialNotice.value.type, 'retention');
    assert.equal(initialNotice.value.data.through, tail);
    await send([event(tail + 1)]);
    const notice = await live.frames.next();
    assert.equal(notice.value.type, 'retention');
    assert.equal(notice.value.data.through, tail);
    const pushed = await live.frames.next();
    assert.equal(pushed.value.type, 'message'); assert.equal(pushed.value.id, String(tail));
    assert.equal(pushed.value.data.index, tail);
  } finally { live.cancel.abort(); await live.frames.return(); }
  checks.push('authenticated live HTTP honors Last-Event-ID and pushes committed event');
  const selection = () => ['debug', 'problem', 'export', sessionId, '--stream', streamId, '--through', String(tail)];
  const staleArgs = selection(), stale = cli(staleArgs, 5);
  await send(Array.from({ length: 64 }, (_, index) => event(tail + index + 1)));
  assert.equal(cli([...staleArgs, '--approve-plan', stale.data.planId], 5).data.code, 'APPROVAL_STALE');
  checks.push('prefix eviction invalidates approved fixed cut without renumbering');
  const replayEvent = event(tail);
  await disconnect();
  await connect(api, WebSocket, { eventBatch: 'events-v1', retention: 'rolling-v1',
    resume: { streamId, previousEpoch: firstEpoch, resumeFrom: tail } });
  assert.equal(pair.confirmed.ackThrough, tail - 1);
  await send([{ ...replayEvent, sessionEpoch: pair.epoch }]);
  const beforeNew = page();
  await send([event(tail + 1, { bootId: 'second-boot' })]);
  const resumedEpoch = pair.epoch;
  assert.notEqual(resumedEpoch, firstEpoch);
  assert.equal(page().retainedCount, beforeNew.retainedCount + 1);
  const last = page(tail - 1, 1).events[0];
  assert.equal(last.event.sessionEpoch, resumedEpoch); assert(last.clock.segment > 1);
  await disconnect();
  checks.push('fresh pairing resumes replay without duplicate; epoch and boot split clock evidence');

  const retained = page();
  const replay = await sse(0);
  let cursor = retained.retainedFrom - 1, received = 0, ended = false;
  try {
    for await (const frame of replay.frames) {
      if (frame.type === 'gap') {
        assert.equal(received, 0); assert.equal(frame.id, String(cursor)); assert.deepEqual({
          missingFrom: frame.data.missingFrom, missingThrough: frame.data.missingThrough, reason: frame.data.reason,
        }, retained.gap);
      } else if (frame.type === 'message') {
        assert.equal(frame.id, String(++cursor)); assert.equal(frame.data.index, cursor); received++;
      } else if (frame.type === 'end') { ended = true; assert.equal(frame.data.through, tail); }
      else { assert.fail(`Unexpected archived SSE ${frame.type}`); }
    }
  } finally { replay.cancel.abort(); await replay.frames.return(); }
  assert(ended); assert.equal(cursor, tail); assert.equal(received, retained.retainedCount);
  checks.push('archive SSE gap precedes contiguous original event IDs and terminal end');

  const task = cli(['task', 'submit', 'debug.problem.export', '--payload', JSON.stringify({
    id: sessionId, stream: streamId, through: tail,
  }), '--wait'], 5).data;
  assert.equal(task.state, 'awaiting-approval');
  const complete = cli(['task', 'approve', task.id, task.plan.planId, '--wait']).data;
  assert.equal(complete.state, 'succeeded'); assert.equal(complete.processes.length, 0);
  problemPath = complete.receipt.data.path;
  const verified = cli(['replay', 'verify', '--path', problemPath]).data;
  assert.equal(verified.manifest.schemaVersion, '1.3'); assert.equal(verified.count, retained.retainedCount);
  assert.equal(verified.session.clockEvidenceLocation, 'events.jsonl');
  assert.deepEqual(verified.session.history.epochs, [firstEpoch, resumedEpoch]);
  assert.equal(verified.session.history.anchor.sequence, retained.retainedFrom - 1);
  assert.equal(verified.authentication, 'not-restored');
  agentPage = cli(['replay', 'show', '--path', problemPath, '--limit', '1']).data;
  assert.equal(agentPage.nextCursor, retained.retainedFrom);
  assert.deepEqual(agentPage.gap, retained.gap);
  const offlineLast = cli(['replay', 'show', '--path', problemPath, '--after', String(tail - 1), '--limit', '1']).data;
  assert.equal(offlineLast.clockEvidenceFrom, tail);
  assert.deepEqual(offlineLast.clockEvidence, [last.clock]);
  checks.push('approved task exports retained 1.3 package within session budget; absolute paging and clock evidence parity');

  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  cli(['model', 'add', 'validation', '--api', 'openai-completions', '--model', 'example',
    '--endpoint', `http://127.0.0.1:${modelServer.address().port}/v1`, '--credential-env', 'OHMATE_VALIDATION_KEY', '--max-tokens', '128']);
  cli(['model', 'select', 'validation']);
  const selected = ['--allowed-tools', 'replay.show', '--project', workspace];
  const preview = cli(['context', 'preview', '--prompt', 'Inspect retained archive', ...selected]).data;
  const result = await promisify(execFile)(process.execPath, [bin, 'agent', 'run', 'Inspect retained archive', ...selected,
    '--preview-hash', preview.hash, '--max-turns', '3', '--format', 'json'],
  { cwd: workspace, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(JSON.parse(result.stdout).data.text, 'Retained Agent page verified.'); assert.equal(agentRequests, 2);
  cli(['model', 'remove', 'validation']);
  checks.push('actual pi Agent calls installed replay.show through private loopback model protocol');
  console.log('SSE, stale approval, epoch recovery, problem package and Agent verified');

  if (browser) {
    const url = cli(['ui', '--no-open']).data.url;
    browserOpened = true; browse(['open', url]); browse(['set', 'viewport', '1280', '900']);
    click('调试', 'link');
    browse(['wait', '--text', `游标 ${retained.retainedFrom + 99} / ${tail}`]);
    assert(browse(['snapshot', '-s', '#canvas']).includes(`保留事件 ${retained.retainedCount} 条`));
    assert(browse(['snapshot', '-s', '#canvas']).includes(`事件缺口：1–${retained.retainedFrom - 1}`));
    const heads = JSON.parse(browse(['eval', 'Array.from(document.querySelectorAll(".debug-event-heading strong")).map(e=>e.textContent)']));
    assert(heads[0].startsWith(`#${retained.retainedFrom} ·`)); assert.equal(heads.length, 100);
    // Re-pair while the view has an old page cursor, then follow the same archive.
    await connect(api, WebSocket, { eventBatch: 'events-v1', retention: 'rolling-v1',
      resume: { streamId, previousEpoch: resumedEpoch, resumeFrom: tail + 1 } });
    click('刷新调试状态'); browse(['wait', '--text', '日志校验通过']);
    click('跟随新事件'); browse(['wait', '--text', `已保存游标 ${tail}`]);
    await send(Array.from({ length: 64 }, (_, index) => event(tail + index + 1)));
    browse(['wait', '--text', `已保存游标 ${tail}`]);
    const rollingNow = page();
    assert(browse(['snapshot', '-s', '#canvas']).includes(`已提交尾序号 ${tail}`));
    assert.equal(JSON.parse(browse(['eval', 'document.querySelectorAll(".debug-event:not(.problem-event)").length'])), 100);
    await disconnect(); browse(['wait', '--text', '事件流已结束']);
    assert(browse(['snapshot', '-s', '#canvas']).includes(`事件缺口：1–${rollingNow.retainedFrom - 1}`));
    browse(['fill', ref('问题包本机路径', 'textbox'), problemPath]); click('校验并查看问题包');
    browse(['wait', '--text', `离线游标 ${retained.retainedFrom + 99} / ${verified.through}`]);
    assert.equal(JSON.parse(browse(['eval', 'document.querySelector(".problem-event strong").textContent'])).startsWith(`#${retained.retainedFrom} ·`), true);
    assert(browse(['snapshot', '-s', '#canvas']).includes(`固定尾序号 ${verified.through}`));
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      browse(['set', 'viewport', String(width), String(height)]);
      assert.equal(JSON.parse(browse(['eval', 'document.documentElement.scrollWidth>innerWidth'])), false);
      browse(['eval', 'document.querySelector(".debug-workbench").scrollIntoView({block:"start"})']);
      browse(['screenshot', join(output, `${width}.png`)]);
      browse(['eval', 'document.getElementById("problem-title").scrollIntoView({block:"start"})']);
      browse(['screenshot', join(output, `offline-${width}.png`)]);
    }
    assert.equal(browse(['errors']).trim(), '');
    checks.push('real Chrome rolling live/archive/offline page; retained count, persistent gap, <=100 rows, 1280/390 containment');
  }
  // Both old protocol minors remain nonrolling and cannot convert their archives.
  for (const version of ['1.0', '1.1']) {
    await connect(api, WebSocket, {}, version); await send([event(1)], false);
    const oldStream = cli(['debug', 'show', sessionId]).data.bridge.streamId;
    const legacy = cli(['debug', 'events', sessionId, '--stream', oldStream]).data;
    assert.equal(legacy.manifest.schemaVersion, '1.2'); assert.equal(legacy.events.length, 1);
    assert.equal(legacy.events[0].event.protocolVersion, version);
    await disconnect();
  }
  checks.push('legacy 1.0/1.1 network clients keep nonrolling archives');
  const disk = await savedText(env.OHMATE_DATA_DIR);
  assert(!disk.includes('EXAMPLE_SECRET'));
  assert(privateCodes.every((code) => !disk.includes(code)));
  cli(['debug', 'stop']); started = false;
  assert.equal(page().through, browser ? verified.through + 64 : verified.through);
  const restarted = cli(['debug', 'start']); started = true;
  assert.notEqual(restarted.data.debugSession.id, sessionId);
  assert.equal(restarted.data.debugSession.bridge.authentication, 'unpaired');
  assert.equal(cli(['debug', 'streams', sessionId]).data.streams.length, 3);
  cli(['debug', 'stop']); started = false;
  checks.push('stop preserves rolling evidence; restart remains unpaired; three retained streams');
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', entry: bin,
    entrySha256: createHash('sha256').update(await readFile(bin)).digest('hex'), node: process.version, platform: process.platform,
    checks, browser, actualEncryptedNetwork: true, producer: 'node-fixture', devicesProbed: false,
    authenticationRestored: false, buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
    retainedFrom: retained.retainedFrom, retainedCount: retained.retainedCount, through: verified.through,
    quotas: { events: 4096, bytes: 5 * 1024 * 1024 }, agentRequests,
    limitations: ['ArkTS Kit/platform and HDC not verified', 'No sustained ten-minute load or physical paint measurement'] }, null, 2) + '\n');
  console.log(`Retention validation passed: ${output}`);
} finally {
  await disconnect();
  if (started) { cli(['debug', 'stop']); }
  if (browserOpened) { browse(['close']); }
  modelServer.closeAllConnections();
  if (modelServer.listening) { await new Promise((resolve) => modelServer.close(resolve)); }
  await writeFile(join(output, 'execution.json'), JSON.stringify({ checks, cleanup: 'completed', privateRoot: root }, null, 2) + '\n');
}
