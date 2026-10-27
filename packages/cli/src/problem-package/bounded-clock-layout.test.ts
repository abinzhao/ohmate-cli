/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { advanceClock, type ClockSegment } from '../debug-protocol/clock-segments.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { buildProblemPackage, verifyProblemPackage, verifyProblemArchive, problemHash } from './package.js';
import { readProblemZip, readProblemZipAt, storedProblemZip } from './zip.js';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { agentTools, agentSpecs } from '../agent/agent-tools.js';

let exported: ReturnType<typeof buildProblemPackage> | undefined;
function measuredPackage() {
  if (exported) { return exported; }
  function capture(sequence: number) {
    return event(sequence, { clockId: 'clock-1', bootId: 'boot-1', monotonicNs: String(904000000 + sequence) });
  }
  function clock(previous: ClockSegment | null, sequence: number) {
    const value = capture(sequence);
    return advanceClock(previous, {
      clockId: value.clockId, bootId: value.bootId, monotonicNs: value.monotonicNs,
      wallTimeUtc: value.wallTimeUtc, offsetUncertaintyMs: value.offsetUncertaintyMs,
    }, 10, { sessionEpoch: value.sessionEpoch, desktopClockId: 'desktop-1',
      receivedNs: String(1006000000 + sequence),
      sample: { probeId: 'probe-1', sessionEpoch: value.sessionEpoch, desktopClockId: 'desktop-1',
        clockId: 'clock-1', bootId: 'boot-1', t0: '1000000000', t1: '902000000',
        t2: '903000000', t3: '1005000000', precisionNs: '1000000' } });
  }
  const anchor = clock(clock(null, 4095), 4096), events = [], clocks: ClockSegment[] = [];
  let previous = anchor;
  for (let sequence = 4097; sequence <= 8192; sequence++) {
    events.push(capture(sequence)); previous = clock(previous, sequence); clocks.push(previous);
  }
  return exported = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity,
    events, clocks, through: 8192, history: { retention: 'rolling-v1', from: 4097, retainedCount: 4096,
      epochs: ['epoch-1'], anchor: { sequence: 4096, sessionEpoch: 'epoch-1', clock: anchor },
      gap: { missingFrom: 1, missingThrough: 4096, reason: 'retention-quota' } } });
}
it('exports all 4096 retained measured clocks without increasing the session decode budget', () => {
  const result = measuredPackage();
  expect(result.manifest.schemaVersion).toBe('1.3');
  const files = readProblemZip(result.bytes);
  expect(files.get('session.json')!.size).toBeLessThanOrEqual(1024 ** 2);
  expect(files.get('events.jsonl')!.size).toBeLessThanOrEqual(32 * 1024 ** 2);
  const stored = JSON.parse(files.get('session.json')!.read().toString());
  expect(stored.clockEvidence).toBeUndefined();
  expect(stored.clockEvidenceLocation).toBe('events.jsonl');
  const restored = verifyProblemPackage(result.bytes);
  expect(restored.events).toHaveLength(4096);
  expect(restored.events![0].sequence).toBe(4097);
  expect(restored.events!.at(-1)!.sequence).toBe(8192);
  expect(restored.events![0]).not.toHaveProperty('clockEvidence');
  expect(restored.session!.clockEvidence).toEqual(result.session.clockEvidence);
  expect(restored.session!.history).toEqual(result.session.history);
  expect(restored.session!.authentication).toBe('not-restored');
});

it('reconstructs the same clocks through the actual positional archive reader', async () => {
  const result = measuredPackage();
  const signal = new AbortController().signal;
  const files = await readProblemZipAt(result.bytes.length, async (offset, length) => result.bytes.subarray(offset, offset + length), signal);
  const restored = await verifyProblemArchive(files, signal);
  expect(restored.session!.clockEvidence).toEqual(result.session.clockEvidence);
  expect(restored.events!.at(-1)!.sequence).toBe(8192);
});

it('imports a measured archive through Agent without returning all retained clocks or exceeding its budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-clock-import-'));
  try {
    const path = join(root, 'measured.ohmate-problem.zip');
    await writeFile(path, measuredPackage().bytes, { mode: 0o600 });
    const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }), runtime = await createRuntime();
    const tools = agentTools(runtime, agentSpecs(runtime, ['replay.import']), context, [], { pending: [], receipts: [] });
    const imported = await tools[0].execute('bounded-import', { path });
    const text = (imported.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(imported.terminate).toBe(false);
    const receipt = JSON.parse(text);
    expect(receipt).toMatchObject({ exitCode: 0, data: { path, importStatus: 'opened', count: 4096,
      session: { through: 8192, history: { from: 4097, gap: { missingFrom: 1, missingThrough: 4096 } } } } });
    expect(receipt.data).not.toHaveProperty('events');
    expect(receipt.data).not.toHaveProperty('clockEvidence');
    expect(receipt.data.session).not.toHaveProperty('clockEvidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('returns only the requested page clocks to the actual Agent tool within its sending budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-clock-page-'));
  try {
    const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
    const path = join(root, 'measured.ohmate-problem.zip');
    await writeFile(path, measuredPackage().bytes, { mode: 0o600 });
    const context = await createExecutionContext({ cwd: root, dataDir: data }), runtime = await createRuntime();
    const tools = agentTools(runtime, agentSpecs(runtime, ['replay.show']), context, [], { pending: [], receipts: [] });
    const shown = await tools[0].execute('bounded-page', { path, after: 5000, limit: 1 });
    const text = (shown.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(shown.terminate).toBe(false);
    const receipt = JSON.parse(text);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.data.events[0].sequence).toBe(5001);
    expect(receipt.data.session.clockEvidence).toBeUndefined();
    expect(receipt.data.clockEvidenceFrom).toBe(5001);
    expect(receipt.data.clockEvidence).toEqual([measuredPackage().session.clockEvidence![5001 - 4097]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['missing', 'derived', 'downgrade', 'dual', 'schema'] as const)(
  'rejects forged external %s clocks even when all archive hashes are recomputed', (change) => {
    const files = new Map([...readProblemZip(measuredPackage().bytes)].map(([name, file]) => [name, file.read()]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    const session = JSON.parse(files.get('session.json')!.toString());
    const lines = files.get('events.jsonl')!.toString().trim().split('\n').map((line) => JSON.parse(line));
    if (change === 'missing') { delete lines[0].clockEvidence; }
    if (change === 'derived') { lines[0].clockEvidence.alignment.offsetNs = '1'; }
    if (change === 'downgrade') { manifest.schemaVersion = '1.2'; session.schemaVersion = '1.2'; }
    if (change === 'dual') {
      session.clockEvidence = [];
      const schema = JSON.parse(files.get('schemas/session.schema.json')!.toString());
      schema.properties.clockEvidence = { type: 'array' };
      files.set('schemas/session.schema.json', Buffer.from(JSON.stringify(schema)));
    }
    if (change === 'schema') {
      const schema = JSON.parse(files.get('schemas/event.schema.json')!.toString());
      delete schema.anyOf[0].properties.clockEvidence;
      files.set('schemas/event.schema.json', Buffer.from(JSON.stringify(schema)));
    }
    files.set('session.json', Buffer.from(JSON.stringify(session)));
    files.set('events.jsonl', Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'));
    for (const file of manifest.files) { file.size = files.get(file.path)!.length; file.sha256 = problemHash(files.get(file.path)!); }
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => verifyProblemPackage(storedProblemZip(files))).toThrow(/PROBLEM_|Invalid input/);
  });
