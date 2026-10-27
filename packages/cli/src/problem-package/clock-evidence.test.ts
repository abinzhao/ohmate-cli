/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildProblemPackage, verifyProblemPackage, problemHash } from './package.js';
import { advanceClock, type ClockSegment } from '../debug-protocol/clock-segments.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { readProblemZip, storedProblemZip } from './zip.js';

function measured() {
  const capture = event(1, { clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '904000000' });
  const clock = advanceClock(null, {
    clockId: capture.clockId, bootId: capture.bootId, monotonicNs: capture.monotonicNs,
    wallTimeUtc: capture.wallTimeUtc, offsetUncertaintyMs: capture.offsetUncertaintyMs,
  }, 10, {
    sessionEpoch: capture.sessionEpoch, desktopClockId: 'desktop-1', receivedNs: '1006000000',
    sample: { probeId: 'probe-1', sessionEpoch: capture.sessionEpoch, desktopClockId: 'desktop-1',
      clockId: 'clock-1', bootId: 'boot-1', t0: '1000000000', t1: '902000000',
      t2: '903000000', t3: '1005000000', precisionNs: '1000000' },
  });
  return buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity,
    events: [capture], clocks: [clock] });
}

it('exports the measured observation and derived interval, while keeping identity unverified', () => {
  const result = measured(), restored = verifyProblemPackage(result.bytes);
  expect(result.manifest.schemaVersion).toBe('1.1');
  expect(restored.session).toMatchObject({
    authentication: 'not-restored', deviceProvenance: 'peer-asserted', buildVerification: 'unverified',
    clockEvidence: [{ alignment: { status: 'calibrated', offsetNs: '100000000', uncertaintyNs: '4006000' } }],
  });
});

it.each(['derived', 'epoch', 'clock', 'budget'])('rejects forged clock %s even with all file hashes recomputed', (change) => {
  const files = new Map([...readProblemZip(measured().bytes)].map(([name, value]) => [name, value.read()]));
  const session = JSON.parse(files.get('session.json')!.toString());
  expect(session.clockEvidence, 'clock evidence was not exported').toHaveLength(1);
  const clock = session.clockEvidence[0];
  if (change === 'derived') { clock.alignment.offsetNs = '1'; }
  if (change === 'epoch') { clock.alignment.observation.sessionEpoch = 'other-epoch'; }
  if (change === 'clock') { clock.bootId = 'other-boot'; }
  if (change === 'budget') { clock.alignment.uncertaintyNs = '1'; }
  files.set('session.json', Buffer.from(JSON.stringify(session)));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  for (const file of manifest.files) {
    file.size = files.get(file.path)!.length; file.sha256 = problemHash(files.get(file.path)!);
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  expect(() => verifyProblemPackage(storedProblemZip(files))).toThrow('PROBLEM_CLOCK_INVALID');
});

it('keeps archives without observations explicitly uncalibrated', () => {
  const result = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)] });
  expect(result.manifest.schemaVersion).toBe('1.0');
  expect(verifyProblemPackage(result.bytes).session!.clockEvidence).toBeUndefined();
});

it('refuses an export whose measurement metadata exceeds the reader session budget before approval', () => {
  const events: ReturnType<typeof event>[] = [], clocks: ClockSegment[] = [];
  let previous: ClockSegment | null = null;
  for (let sequence = 1; sequence <= 4096; sequence++) {
    const capture = event(sequence, { clockId: 'clock-1', bootId: 'boot-1', monotonicNs: String(904000000 + sequence) });
    previous = advanceClock(previous, { clockId: capture.clockId, bootId: capture.bootId,
      monotonicNs: capture.monotonicNs, wallTimeUtc: capture.wallTimeUtc, offsetUncertaintyMs: capture.offsetUncertaintyMs }, 10,
    { sessionEpoch: capture.sessionEpoch, desktopClockId: 'desktop-1', receivedNs: String(1006000000 + sequence),
      sample: { probeId: 'probe-1', sessionEpoch: capture.sessionEpoch, desktopClockId: 'desktop-1',
        clockId: 'clock-1', bootId: 'boot-1', t0: '1000000000', t1: '902000000',
        t2: '903000000', t3: '1005000000', precisionNs: '1000000' } });
    events.push(capture); clocks.push(previous);
  }
  expect(() => buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events, clocks }))
    .toThrow('PROBLEM_SUMMARY_LIMIT');
});
