/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import WebSocket from 'ws';
import { createPairingClient } from '../packages/cli/src/debug-protocol/security.ts';
import { startWebServer } from '../packages/cli/src/web/web-server.ts';
import { createRuntime, createExecutionContext } from '../packages/cli/src/runtime/index.ts';
import { EventJournal } from '../packages/cli/src/debug/event-journal.ts';
import { performance } from 'node:perf_hooks';

const root = await mkdtemp('/private/tmp/ohmate-throughput-');
const output = resolve(process.argv[2] ?? '/private/tmp/ohmate-clock-throughput-r1.json');
const batchSize = Number(process.argv[3] ?? 1), count = Number(process.argv[4] ?? 512);
assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 64);
assert(Number.isSafeInteger(count) && count >= 1 && count <= 4096);
const context = await createExecutionContext({ cwd: root, dataDir: root });
const id = randomUUID();
const server = await startWebServer(await createRuntime(), context, { debugSessionId: id });
let socket, iterator, channel, streamId;
const latencies = [], reads = [];
try {
  const login = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const target = { project: context.workspaceId, buildId: 'unverified-throughput', device: 'node-measurement',
    process: 'node-process', sessionId: 'node-session' };
  const invitation = await (await fetch(`${server.origin}/api/v1/debug/pairing`, { method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
    body: JSON.stringify(target) })).json();
  const client = createPairingClient(invitation, { appConfirmed: true });
  socket = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
  iterator = on(socket, 'message');
  await once(socket, 'open');
  const next = async () => JSON.parse((await iterator.next()).value[0].toString());
  const send = (value) => socket.send(JSON.stringify(channel.seal(value)));
  socket.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  send({ type: 'ready', sessionEpoch: ready.sessionEpoch, clockSync: 'four-timestamp-v1',
    ...(batchSize > 1 ? { eventBatch: 'events-v1' } : {}) });
  const connected = channel.open(await next());
  assert.equal(connected.type, 'connected');
  if (batchSize > 1) { assert.equal(connected.eventBatch, 'events-v1'); }
  async function clockReply(probe) {
    const t1 = process.hrtime.bigint().toString();
    send({ type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
      clockId: 'node-clock', bootId: 'node-boot', t1, t2: process.hrtime.bigint().toString(), precisionNs: '1000000' });
  }
  await clockReply(channel.open(await next()));
  streamId = server.bridgeStatus().streamId;
  const started = performance.now();
  const counts = { calibrated: 0, overBudget: 0, notCalibrated: 0 };
  for (let first = 1; first <= count; first += batchSize) {
    const through = Math.min(count, first + batchSize - 1);
    const events = Array.from({ length: through - first + 1 }, (_, offset) => {
      const sequence = first + offset;
      return { ...invitation.handshake.identity, type: 'event', channel: 'hidebug', capability: 'hidebug.read',
      protocolVersion: '1.1', channelVersion: '1.0', sessionEpoch: ready.sessionEpoch, sequence, messageId: `event-${sequence}`,
      clockId: 'node-clock', bootId: 'node-boot', monotonicNs: process.hrtime.bigint().toString(),
      wallTimeUtc: new Date().toISOString(), offsetUncertaintyMs: Number.MAX_SAFE_INTEGER,
      payload: { metric: 'pssBytes', value: sequence }, redaction: { policyId: 'measurement', fieldsRemoved: 0 } };
    });
    const start = performance.now();
    send(batchSize > 1 ? { type: 'event-batch', version: '1', events } : events[0]);
    const reading = through % 32 === 0 ? (async () => {
      const readStart = performance.now();
      const snapshot = await EventJournal.read(root, id, streamId);
      assert(snapshot.events.length >= first - 1 && snapshot.events.length <= through);
      reads.push(performance.now() - readStart);
    })() : Promise.resolve();
    let reply = channel.open(await next());
    while (reply.type === 'clock-probe') { await clockReply(reply); reply = channel.open(await next()); }
    assert.equal(reply.type, 'ack'); assert.equal(reply.ackThrough, through);
    latencies.push(performance.now() - start);
    await reading;
  }
  const elapsedMs = performance.now() - started;
  const final = await EventJournal.read(root, id, streamId);
  assert.equal(final.events.length, count);
  for (const record of final.events) {
    const status = record.clock.alignment?.status;
    if (status === 'calibrated') { counts.calibrated++; }
    else if (status === 'over-budget') { counts.overBudget++; }
    else { counts.notCalibrated++; }
  }
  const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const result = { platform: process.platform, node: process.version, root, producer: 'Node-encrypted-loopback',
    dedicatedDevice: false, count, batchSize, ackSamples: latencies.length, concurrentReads: reads.length, elapsedMs, eventsPerSecond: count * 1000 / elapsedMs,
    ackP50Ms: quantile(latencies, 0.5), ackP95Ms: quantile(latencies, 0.95), readP95Ms: quantile(reads, 0.95),
    calibration: counts, boundedJournal: { events: 4096, bytes: 5 * 1024 ** 2 },
    gaLoad: { requiredEventsPerSecond: 1000, requiredDurationSeconds: 600, verified: false },
    integrity: 'verified' };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  iterator?.return();
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = once(socket, 'close'); socket.terminate(); await closed;
  }
  channel?.close(); await server.close();
}
