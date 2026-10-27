/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createPairingClient } from '../packages/cli/src/debug-protocol/security.ts';
import { startWebServer } from '../packages/cli/src/web/web-server.ts';
import { createRuntime, createExecutionContext } from '../packages/cli/src/runtime/index.ts';
import { EventJournal } from '../packages/cli/src/debug/event-journal.ts';

const output = resolve(process.argv[2]);
const batchSize = Number(process.argv[3] ?? 64), count = Number(process.argv[4] ?? 8320);
assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 64);
assert(Number.isSafeInteger(count) && count > 4096 && count <= 600000);
const root = resolve(process.env.OHMATE_MEASURE_ROOT ?? '');
assert.match(root, /^\/private\/tmp\/ohmate-rolling-measure-[^/]+$/);
assert.equal(process.env.HOME, join(root, 'home'));
await mkdir(join(root, 'workspace'), { mode: 0o700 });
await mkdir(join(root, 'data'), { mode: 0o700 });
const sourceHashes = {};
for (const file of ['scripts/measure-debug-rolling.mjs', 'packages/cli/src/debug/event-journal.ts',
  'packages/cli/src/debug/journal-read-cache.ts', 'packages/cli/src/debug/journal-files.ts']) {
  sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const context = await createExecutionContext({ cwd: join(root, 'workspace'), dataDir: join(root, 'data') });
const id = randomUUID(), server = await startWebServer(await createRuntime(), context, { debugSessionId: id });
let socket, iterator, channel, streamId;
const samples = [], reads = [];
let maxRssBytes = process.memoryUsage().rss;
try {
  const login = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const target = { project: context.workspaceId, buildId: 'unverified-rolling-measurement', device: 'node-measurement',
    process: 'node-process', sessionId: 'node-session' };
  const response = await fetch(`${server.origin}/api/v1/debug/pairing`, { method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
    body: JSON.stringify(target) });
  assert.equal(response.status, 200);
  const invitation = await response.json(), client = createPairingClient(invitation, { appConfirmed: true });
  socket = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
  iterator = on(socket, 'message');
  await once(socket, 'open');
  const next = async () => {
    let timer;
    try {
      const result = await Promise.race([iterator.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Encrypted response timed out')), 10_000);
      })]);
      assert(!result.done, 'Encrypted connection ended before response');
      return JSON.parse(result.value[0].toString());
    } finally { clearTimeout(timer); }
  };
  const send = (value) => socket.send(JSON.stringify(channel.seal(value)));
  socket.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  send({ type: 'ready', sessionEpoch: ready.sessionEpoch, clockSync: 'four-timestamp-v1',
    eventBatch: 'events-v1', retention: 'rolling-v1' });
  assert.deepEqual(channel.open(await next()), { type: 'connected', sessionEpoch: ready.sessionEpoch,
    eventBatch: 'events-v1', retention: 'rolling-v1' });
  async function clockReply(probe) {
    const t1 = process.hrtime.bigint().toString();
    send({ type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
      clockId: 'node-clock', bootId: 'node-boot', t1, t2: process.hrtime.bigint().toString(), precisionNs: '1000000' });
  }
  await clockReply(channel.open(await next()));
  streamId = server.bridgeStatus().streamId;
  const started = performance.now();
  let previousFrom = 1, evictionsObserved = 0;
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
    send({ type: 'event-batch', version: '1', events });
    const reading = through % 128 === 0 ? (async () => {
      const readStart = performance.now();
      const snapshot = await EventJournal.read(join(root, 'data'), id, streamId);
      assert(snapshot.events.length <= 4096);
      assert(snapshot.retention.through >= first - 1 && snapshot.retention.through <= through);
      assert.equal(snapshot.events[0]?.index ?? 1, snapshot.retention.from);
      assert.equal(snapshot.events.at(-1)?.index ?? 0, snapshot.retention.through);
      assert(snapshot.retention.from >= previousFrom);
      if (snapshot.retention.from > previousFrom) { evictionsObserved++; }
      previousFrom = snapshot.retention.from;
      reads.push({ through: snapshot.retention.through, from: snapshot.retention.from, ms: performance.now() - readStart });
    })() : Promise.resolve();
    let reply = channel.open(await next());
    while (reply.type === 'clock-probe') { await clockReply(reply); reply = channel.open(await next()); }
    assert.equal(reply.type, 'ack'); assert.equal(reply.ackThrough, through);
    samples.push({ through, ms: performance.now() - start });
    await reading;
    maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
    if (through % 1024 === 0) { console.log(JSON.stringify({ through, elapsedMs: performance.now() - started })); }
  }
  const elapsedMs = performance.now() - started;
  const final = await EventJournal.read(join(root, 'data'), id, streamId);
  assert.equal(final.manifest.schemaVersion, '1.4');
  assert.equal(final.manifest.maxEvents, 4096); assert.equal(final.manifest.maxBytes, 5 * 1024 ** 2);
  assert.equal(final.manifest.buildVerification, 'unverified'); assert.equal(final.manifest.deviceProvenance, 'peer-asserted');
  assert.equal(final.retention.through, count); assert(final.retention.from > 1);
  assert(final.events.length <= 4096 && final.events.length > 0);
  assert.equal(final.retention.from + final.events.length - 1, count);
  assert.deepEqual(final.retention.gap, { missingFrom: 1, missingThrough: final.retention.from - 1, reason: 'retention-quota' });
  for (const [offset, record] of final.events.entries()) {
    assert.equal(record.index, final.retention.from + offset);
    assert.equal(record.event.sequence, record.index); assert.equal(record.event.payload.value, record.index);
  }
  assert(evictionsObserved >= 2, 'Measurement must observe repeated production-quota eviction');
  const journal = join(root, 'data', 'debug-events', id, streamId);
  let diskBytes = 0;
  for (const name of await readdir(journal)) { diskBytes += (await readFile(join(journal, name))).length; }
  assert(diskBytes <= 5 * 1024 ** 2);
  const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const result = { platform: process.platform, node: process.version, root, producer: 'Node-encrypted-loopback',
    dedicatedDevice: false, sourceHashes, count, batchSize, ackSamples: samples.length, concurrentReads: reads.length,
    elapsedMs, eventsPerSecond: count * 1000 / elapsedMs, ackP50Ms: quantile(samples.map((s) => s.ms), 0.5),
    ackP95Ms: quantile(samples.map((s) => s.ms), 0.95), readP95Ms: quantile(reads.map((s) => s.ms), 0.95),
    afterEvictionAckP95Ms: quantile(samples.filter((s) => s.through > 4096).map((s) => s.ms), 0.95),
    evictionsObserved, retainedFrom: final.retention.from, retainedCount: final.events.length, diskBytes, maxRssBytes,
    gaLoad: { requiredEventsPerSecond: 1000, requiredDurationSeconds: 600, verified: false },
    integrity: 'verified', samples, reads };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { samples: _samples, reads: _reads, ...summary } = result; void _samples; void _reads;
  console.log(JSON.stringify(summary));
} finally {
  await iterator?.return();
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = once(socket, 'close'); socket.terminate(); await closed;
  }
  channel?.close(); await server.close();
}
