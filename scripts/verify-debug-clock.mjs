/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { on, once } from 'node:events';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const output = resolve(process.argv[3] ?? '/private/tmp/ohmate-clock-built-r1.json');
const batched = process.argv[4] === 'batch';
const root = await mkdtemp('/private/tmp/ohmate-clock-entry-'), home = join(root, 'home');
await mkdir(home); await writeFile(join(home, 'npmrc'), ''); await writeFile(join(home, 'global-npmrc'), '');
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root,
  OHMATE_DATA_DIR: join(root, 'data'), NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 ** 2 });
  assert(!result.error, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function cli(args) { return JSON.parse(run(process.execPath, [bin, ...args, '--format', 'json'])); }
function invite() {
  const python = `import os,pty,select,subprocess,sys,time,json,errno
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
data=b''
deadline=time.monotonic()+20
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   if not chunk: break
   data+=chunk
  elif p.poll() is not None: break
 if p.poll() is None: p.wait(timeout=2)
 assert p.returncode==0
 for line in data.decode().splitlines():
  if line.startswith('{"endpoint":'): print(line); break
finally:
 if p.poll() is None: p.kill(); p.wait()
 os.close(master)`;
  return JSON.parse(run('python3', ['-c', python, process.execPath, bin, 'debug', 'pair',
    '--buildId', 'unverified-clock-fixture', '--device', 'node-fixture', '--process', 'fixture-process', '--sessionId', 'fixture-session']));
}
let started = false, socket, channel, frames;
try {
  const begun = cli(['debug', 'start']); started = true;
  const id = begun.data.debugSession.id;
  const runtimePath = createRequire(bin).resolve('@ohmate/cli-common');
  const runtime = await import(pathToFileURL(runtimePath).href);
  const { default: WebSocket } = await import(pathToFileURL(createRequire(runtimePath).resolve('ws')).href);
  const { endpoint, invitation } = invite();
  const client = runtime.createPairingClient(invitation, { appConfirmed: true });
  socket = new WebSocket(endpoint, 'ohmate-readonly-v1'); frames = on(socket, 'message');
  await once(socket, 'open');
  const next = async () => JSON.parse((await frames.next()).value[0].toString());
  const send = (value) => socket.send(JSON.stringify(channel.seal(value)));
  socket.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  send({ type: 'ready', sessionEpoch: ready.sessionEpoch, clockSync: 'four-timestamp-v1',
    ...(batched ? { eventBatch: 'events-v1' } : {}) });
  const connected = channel.open(await next());
  assert.equal(connected.type, 'connected');
  if (batched) { assert.equal(connected.eventBatch, 'events-v1'); }
  const probe = channel.open(await next());
  assert.equal(probe.type, 'clock-probe');
  send({ type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
    clockId: 'fixture-clock', bootId: 'fixture-boot', t1: process.hrtime.bigint().toString(),
    t2: process.hrtime.bigint().toString(), precisionNs: '1000000' });
  const events = Array.from({ length: 3 }, (_, n) => {
    const sequence = n + 1;
    return { ...invitation.handshake.identity, type: 'event', channel: 'hidebug', capability: 'hidebug.read',
      protocolVersion: '1.1', channelVersion: '1.0', sessionEpoch: ready.sessionEpoch, sequence, messageId: `event-${sequence}`,
      clockId: 'fixture-clock', bootId: 'fixture-boot', monotonicNs: process.hrtime.bigint().toString(),
      wallTimeUtc: new Date().toISOString(), offsetUncertaintyMs: Number.MAX_SAFE_INTEGER,
      payload: { metric: 'pssBytes', value: sequence }, redaction: { policyId: 'fixture', fieldsRemoved: 0 } };
  });
  for (const batch of batched ? [events] : events.map((event) => [event])) {
    send(batched ? { type: 'event-batch', version: '1', events: batch } : batch[0]);
    const ack = channel.open(await next());
    assert.equal(ack.type, 'ack'); assert.equal(ack.ackThrough, batch.at(-1).sequence);
  }
  const closed = once(socket, 'close'); socket.close(); await closed;
  const stream = cli(['debug', 'show', id]).data.bridge.streamId;
  const selected = ['debug', 'inspect', id, '--stream', stream, '--channel', 'hidebug'];
  const inspected = cli(selected).data;
  assert.equal(inspected.clockCalibration, 'per-record');
  assert.equal(inspected.events.length, 3);
  assert(inspected.records.some((record) => record.clockCalibration === 'calibrated'));
  assert(inspected.records.every((record) => ['calibrated', 'over-budget'].includes(record.clockCalibration)));
  const selection = ['debug', 'problem', 'export', id, '--stream', stream, '--through', '3'];
  const pending = spawnSync(process.execPath, [bin, ...selection, '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(pending.status, 5);
  const review = JSON.parse(pending.stdout);
  const approved = cli([...selection, '--approve-plan', review.data.planId]);
  const archive = approved.data.path;
  const offline = cli(['replay', 'show', '--path', archive]).data;
  assert.equal(offline.events.length, 3);
  assert.deepEqual(offline.session.clockEvidence, inspected.events.map((record) => record.clock));
  cli(['debug', 'stop']); started = false;
  assert.deepEqual(cli(selected).data.events, inspected.events);
  const restarted = cli(['debug', 'start']); started = true;
  assert.equal(restarted.data.debugSession.bridge.state, 'waiting-pairing');
  assert.notEqual(restarted.data.debugSession.id, id);
  await writeFile(output, JSON.stringify({ status: 'passed', bin, root, epoch: ready.sessionEpoch,
    encryptedEventBatch: batched,
    encryptedClock: true, privateTty: true, cliInspector: inspected.records.map((record) => record.clockCalibration),
    offlineRecomputed: true, historicalEvidencePreserved: true, authenticationNotRestored: true,
    producer: 'Node-fixture', deviceVerification: 'unverified', buildVerification: 'unverified' }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Built clock validation passed: ${output}`);
} finally {
  frames?.return();
  if (socket && socket.readyState !== socket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed; }
  channel?.close();
  if (started) { cli(['debug', 'stop']); }
}
