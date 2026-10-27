/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { on, once } from 'node:events';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm2-debug-lifecycle-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-debug-installed-')), home = join(root, 'home');
const output = resolve('artifacts/validation', label), receipts = {};
const env = { HOME: home, USERPROFILE: home, TMPDIR: root, PATH: process.env.PATH,
  OHMATE_DATA_DIR: join(root, 'data'), NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
function cli(name, args, expectedExit = 0) {
  const child = spawnSync(process.execPath, [bin, ...args, '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined); assert.equal(child.status, expectedExit, child.stderr || child.stdout);
  return receipts[name] = JSON.parse(child.stdout);
}
async function protocolMatrix(sessionId) {
  const api = await import(pathToFileURL(createRequire(bin).resolve('@ohmate/cli-common')).href);
  const identity = { project: 'test-project', buildId: `org.example@1@default@debug@test@${'a'.repeat(64)}`,
    device: 'test-producer', process: 'test-process', sessionId, fingerprint: 'b'.repeat(64) };
  const results = [];
  for (const version of ['1.1', '1.0']) {
    const local = api.createHandshake(identity, { channels: ['hilog'], resumeWindow: 2 });
    const peer = api.createHandshake(identity, { channels: ['hilog'], resumeWindow: 2,
      protocolVersionRange: { min: version, max: version } });
    const bridge = api.createReadonlyBridge(local); bridge.connect(peer, 'epoch-1');
    const event = { ...identity, protocolVersion: version, channelVersion: '1.0', sessionEpoch: 'epoch-1',
      sequence: 1, messageId: 'message-1', channel: 'hilog', type: 'event', capability: 'hilog.read',
      clockId: 'test-clock', bootId: 'test-boot', wallTimeUtc: '2026-10-23T00:00:00Z', monotonicNs: '1',
      offsetUncertaintyMs: 5, payload: { level: 'info', summary: 'Test-owned redacted summary' },
      redaction: { policyId: 'test-policy', fieldsRemoved: 0 } };
    assert.equal(bridge.accept(JSON.stringify(event)).disposition, 'accepted');
    assert.equal(bridge.accept(JSON.stringify(event)).disposition, 'duplicate');
    bridge.disconnect();
    bridge.resume(peer, { ...identity, type: 'resume', protocolVersion: version,
      previousEpoch: 'epoch-1', sessionEpoch: 'epoch-2', resumeFrom: 1 });
    assert.equal(bridge.accept({ ...event, sessionEpoch: 'epoch-2' }).disposition, 'replay');
    assert.throws(() => bridge.accept({ ...event, sessionEpoch: 'epoch-2', sequence: 3, messageId: 'message-3' }),
      (error) => error.code === 'SEQUENCE_GAP' && error.gap.missingFrom === 2);
    assert.throws(() => bridge.accept({ ...event, sessionEpoch: 'epoch-2', buildId: 'other' }),
      (error) => error.code === 'IDENTITY_MISMATCH');
    results.push({ version, status: 'passed', actualNetwork: false });
  }
  return results;
}

async function networkMatrix(sessionId, origin, cookie, csrf, workspaceId) {
  const require = createRequire(bin);
  const api = await import(pathToFileURL(require.resolve('@ohmate/cli-common')).href);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws')).href);
  const results = [];
  for (const version of ['1.1', '1.0']) {
    const response = await fetch(`${origin}/api/v1/debug/pairing`, { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
      body: JSON.stringify({ project: workspaceId, buildId: 'unverified-fixture-build', device: 'opaque-fixture',
        process: 'fixture-process', sessionId: `fixture-${version}` }) });
    assert.equal(response.status, 200);
    const invitation = await response.json();
    const client = api.createPairingClient(invitation, { appConfirmed: true, protocolVersionRange: { min: version, max: version } });
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/bridge/v1`, 'ohmate-readonly-v1');
    const frames = on(ws, 'message');
    let channel;
    try {
      await once(ws, 'open');
      const next = async () => JSON.parse((await frames.next()).value[0].toString());
      ws.send(JSON.stringify(client.request()));
      channel = client.finish(await next());
      const ready = channel.open(await next());
      ws.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: ready.sessionEpoch })));
      assert.equal(channel.open(await next()).type, 'connected');
      const event = { ...invitation.handshake.identity, protocolVersion: version, channelVersion: '1.0',
        sessionEpoch: ready.sessionEpoch, sequence: 1, messageId: 'event-1', channel: 'hilog', type: 'event',
        capability: 'hilog.read', clockId: 'fixture-clock', bootId: 'fixture-boot',
        wallTimeUtc: '2026-10-23T00:00:00Z', monotonicNs: '1', offsetUncertaintyMs: 5,
        payload: { level: 'info', summary: 'Test-owned summary' }, redaction: { policyId: 'fixture', fieldsRemoved: 0 } };
      ws.send(JSON.stringify(channel.seal(event)));
      assert.equal(channel.open(await next()).ackThrough, 1);
      const status = cli(`paired-${version}`, ['debug', 'show', sessionId]);
      assert.equal(status.data.bridge.buildVerification, 'unverified');
      assert.equal(status.data.bridge.deviceProvenance, 'peer-asserted');
      const saved = cli(`events-${version}`, ['debug', 'events', sessionId, '--stream', status.data.bridge.streamId]);
      assert.equal(saved.data.events[0].event.protocolVersion, version);
      assert.equal(saved.data.manifest.schemaVersion, '1.1');
      assert(!JSON.stringify(status).includes(invitation.oneTimeCode));
      results.push({ version, status: 'passed', actualNetwork: true, producer: 'node-fixture', streamId: status.data.bridge.streamId });
      const closed = once(ws, 'close'); ws.close(); await closed;
    } finally { channel?.close(); await frames.return(); ws.terminate(); }
  }
  return results;
}
let opened = false;
try {
  await mkdir(home); await mkdir(output, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const start = cli('start', ['debug', 'start']); opened = true;
  const { debugSession, pid, origin, url } = start.data;
  assert.equal(start.data.browser, 'not-requested'); assert.equal(debugSession.state, 'serving');
  assert.equal(debugSession.target, null); assert.equal(debugSession.bridge.reason, 'KIT_PRODUCER_NOT_VERIFIED');
  assert.equal(cli('alias', ['devtools', 'serve']).data.pid, pid);
  assert.equal(cli('ui', ['ui', '--no-open']).data.debugSession.id, debugSession.id);
  const exchange = await fetch(`${origin}/api/v1/connect`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(url).hash.slice('#access='.length) }) });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const request = await fetch(`${origin}/api/v1/debug/status`, { headers: { cookie } });
  assert.equal(request.status, 200);
  const web = await request.json(), terminal = cli('status', ['debug', 'status']);
  assert.deepEqual(web.data, terminal.data);
  const contract = cli('protocol', ['debug', 'protocol']);
  assert.equal(contract.data.channels.length, 17);
  const webContract = await fetch(`${origin}/api/v1/debug/protocol`, { headers: { cookie } });
  assert.equal(webContract.status, 200); assert.deepEqual((await webContract.json()).data, contract.data);
  const matrix = await protocolMatrix(debugSession.id);
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const network = await networkMatrix(debugSession.id, origin, cookie, bootstrap.csrf, start.project.workspaceId);
  for (const toolId of ['debug.start', 'devtools.serve']) {
    const rejected = await fetch(`${origin}/api/v1/tasks`, { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
      body: JSON.stringify({ toolId, input: {} }) });
    assert.equal(rejected.status, 400);
  }
  cli('stop', ['debug', 'stop']); opened = false;
  const stopped = cli('show', ['debug', 'show', debugSession.id]);
  assert.equal(stopped.data.state, 'stopped'); assert.deepEqual(cli('list', ['debug', 'list']).data, [stopped.data]);
  const next = cli('restart', ['debug', 'start']); opened = true;
  assert.notEqual(next.data.debugSession.id, debugSession.id);
  const serviceFile = join(env.OHMATE_DATA_DIR, 'web/service.json');
  const service = JSON.parse(await readFile(serviceFile, 'utf8'));
  assert.match(service.workbenchFingerprint, /^[a-f0-9]{64}$/);
  try {
    await writeFile(serviceFile, JSON.stringify({ ...service, workbenchFingerprint: '0'.repeat(64) }));
    const rejected = cli('code-drift', ['debug', 'start'], 5);
    assert.deepEqual(rejected.data, { code: 'WORKBENCH_CODE_CHANGED' });
  } finally { await writeFile(serviceFile, JSON.stringify(service)); }
  cli('final-stop', ['ui', 'stop']); opened = false;
  // One-time browser links are capabilities; persist only the public lifecycle fields.
  for (const receipt of Object.values(receipts)) { if (receipt.data?.url) { delete receipt.data.url; } }
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', bin, receipts,
    httpCliParity: true, protocolMatrix: matrix, networkMatrix: network,
    scope: { desktopTransport: 'websocket-loopback-aead', KitProducer: 'not-verified', deviceOperations: 'none',
      targetIdentity: 'peer-asserted', buildVerification: 'unverified', modelRequests: 'none', platform: process.platform } }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', label, session: debugSession.id }));
} finally {
  if (opened) { cli('cleanup', ['ui', 'stop']); }
  await rm(root, { recursive: true, force: true });
}
