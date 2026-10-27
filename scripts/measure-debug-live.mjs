/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createPairingClient } from '../packages/cli/src/debug-protocol/security.ts';
import { startWebServer } from '../packages/cli/src/web/web-server.ts';
import { createRuntime, createExecutionContext } from '../packages/cli/src/runtime/index.ts';
import { processIdentity } from '../packages/cli/src/runtime/process-tree.ts';
import { createDebugSession, updateDebugBridge } from '../packages/cli/src/debug/debug-state.ts';
import { EventJournal } from '../packages/cli/src/debug/event-journal.ts';

const output = resolve(process.argv[2] ?? '/private/tmp/ohmate-live-measurement.json');
const batchSize = Number(process.argv[3] ?? 32), count = Number(process.argv[4] ?? 2048);
assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 64);
assert(Number.isSafeInteger(count) && count >= 1 && count <= 4096);
const root = await mkdtemp('/private/tmp/ohmate-live-measurement-');
const context = await createExecutionContext({ cwd: root, dataDir: root }), sessionId = randomUUID();
let owner, socket, frames, channel, reader, reading;
const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
const server = await startWebServer(await createRuntime(), context, { debugSessionId: sessionId,
  onBridgeStatus: (status) => updateDebugBridge(root, owner, status) });
const latencies = [], acknowledgements = [];
function quantile(values, fraction) { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]; }
async function consume() {
  let buffer = '', through = 0;
  const decoder = new TextDecoder();
  while (through < count) {
    const next = await reader.read();
    assert(!next.done, 'live stream ended before its committed cursor');
    buffer += decoder.decode(next.value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (frame.startsWith(':')) { continue; }
      const match = /^id: (\d+)\ndata: (.+)$/.exec(frame);
      assert(match, 'unexpected live fault or terminal event');
      const record = JSON.parse(match[2]);
      assert.equal(record.index, ++through); assert.equal(Number(match[1]), through);
      assert.equal(record.event.sequence, through); assert.equal(record.event.payload.metric, 'pssBytes');
      latencies.push(Number(process.hrtime.bigint() - BigInt(record.event.monotonicNs)) / 1e6);
    }
    assert(buffer.length < 6 * 1024 * 1024, 'unbounded incomplete SSE frame');
  }
  return through;
}
try {
  owner = { origin: server.origin, pid: process.pid, identity: await processIdentity(process.pid), cwd: root, projectRoot: null,
    startedAt: new Date().toISOString(), controlSecret: 'a'.repeat(64), debugSessionId: sessionId };
  await createDebugSession(root, owner, server.bridgeStatus());
  const login = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST', signal,
    headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie }, signal })).json();
  const target = { project: context.workspaceId, buildId: 'unverified-live-measurement', device: 'node-measurement',
    process: 'node-process', sessionId: 'node-session' };
  const invitation = await (await fetch(`${server.origin}/api/v1/debug/pairing`, { method: 'POST', signal,
    headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
    body: JSON.stringify(target) })).json();
  const client = createPairingClient(invitation, { appConfirmed: true });
  socket = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
  frames = on(socket, 'message', { signal }); await once(socket, 'open', { signal });
  const next = async () => JSON.parse((await frames.next()).value[0].toString());
  const send = (value) => socket.send(JSON.stringify(channel.seal(value)));
  socket.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  send({ type: 'ready', sessionEpoch: ready.sessionEpoch, eventBatch: 'events-v1' });
  assert.equal(channel.open(await next()).type, 'connected');
  const streamId = server.bridgeStatus().streamId;
  const response = await fetch(`${server.origin}/api/v1/debug/sessions/${sessionId}/streams/${streamId}/live?limit=100`,
    { headers: { cookie }, signal });
  assert.equal(response.status, 200); reader = response.body.getReader();
  reading = consume(); reading.catch(() => {});
  const started = performance.now();
  for (let first = 1; first <= count; first += batchSize) {
    const through = Math.min(count, first + batchSize - 1), start = performance.now();
    const events = Array.from({ length: through - first + 1 }, (_, offset) => {
      const sequence = first + offset;
      return { ...invitation.handshake.identity, type: 'event', channel: 'hidebug', capability: 'hidebug.read',
        protocolVersion: '1.1', channelVersion: '1.0', sessionEpoch: ready.sessionEpoch, sequence, messageId: `event-${sequence}`,
        clockId: 'node-clock', bootId: 'node-boot', monotonicNs: process.hrtime.bigint().toString(),
        wallTimeUtc: new Date().toISOString(), offsetUncertaintyMs: Number.MAX_SAFE_INTEGER,
        payload: { metric: 'pssBytes', value: sequence }, redaction: { policyId: 'measurement', fieldsRemoved: 0 } };
    });
    send({ type: 'event-batch', version: '1', events });
    const reply = channel.open(await next());
    assert.equal(reply.type, 'ack'); assert.equal(reply.ackThrough, through);
    acknowledgements.push(performance.now() - start);
  }
  assert.equal(await reading, count);
  const elapsedMs = performance.now() - started, journal = await EventJournal.read(root, sessionId, streamId);
  assert.equal(journal.events.length, count);
  assert.equal(journal.events.at(-1).index, count);
  const result = { platform: process.platform, node: process.version, root, producer: 'Node-encrypted-loopback',
    dedicatedDevice: false, count, batchSize, elapsedMs, eventsPerSecond: count * 1000 / elapsedMs,
    ackP95Ms: quantile(acknowledgements, 0.95), transportSamples: latencies.length,
    transportP50Ms: quantile(latencies, 0.5), transportP95Ms: quantile(latencies, 0.95), transportMaxMs: Math.max(...latencies),
    clock: 'same-process-monotonic', includesBrowserRendering: false, integrity: 'verified',
    boundedJournal: { events: 4096, bytes: 5 * 1024 ** 2 },
    gaLoad: { requiredEventsPerSecond: 1000, requiredDurationSeconds: 600, verified: false } };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  controller.abort(); await reader?.cancel().catch(() => {}); await reading?.catch(() => {});
  await frames?.return();
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = once(socket, 'close'); socket.terminate(); await closed;
  }
  channel?.close(); await server.close();
}
