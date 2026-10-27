/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Identity, Negotiated, requireWire, match, keysOf, readIdentity, canonical, numberOf, uuidOf, textOf } from './Wire';
import { NetworkObservation } from './PlatformNetwork';

interface MetricPayload { metric: string; value: number; }
interface UiPayload { windowId: string; nodeCount: number; summary: string; }
interface Redaction { policyId: string; fieldsRemoved: number; }
export interface ClockReply {
  type: string;
  version: string;
  probeId: string;
  sessionEpoch: string;
  t0: string;
  clockId: string;
  bootId: string;
  t1: string;
  t2: string;
  precisionNs: string;
}
export function makeClockReply(value: Object, epoch: string, clockId: string, t1: string, t2: string): ClockReply {
  const record = keysOf(value, ['type', 'version', 'probeId', 'sessionEpoch', 't0']);
  requireWire(record['type'] === 'clock-probe' && record['version'] === '1' &&
    record['sessionEpoch'] === epoch, 'CLOCK_SAMPLE_INVALID');
  const t0 = textOf(record, 't0', 20);
  requireWire(match(t0, '^(0|[1-9][0-9]{0,19})$') && BigInt(t0) <= BigInt('18446744073709551615'),
    'CLOCK_SAMPLE_INVALID');
  requireWire(BigInt(t2) >= BigInt(t1), 'CLOCK_SAMPLE_INVALID');
  return {
    type: 'clock-reply', version: '1', probeId: uuidOf(record, 'probeId'), sessionEpoch: epoch,
    t0: t0, clockId: clockId, bootId: clockId, t1: t1, t2: t2, precisionNs: '1000000'
  };
}
export interface MetricEvent extends Identity {
  protocolVersion: string;
  channelVersion: string;
  messageId: string;
  sessionEpoch: string;
  sequence: number;
  channel: string;
  type: string;
  capability: string;
  clockId: string;
  bootId: string;
  wallTimeUtc: string;
  monotonicNs: string;
  offsetUncertaintyMs: number;
  payload: MetricPayload;
  redaction: Redaction;
}
export function makeMetricEvent(negotiated: Negotiated, epoch: string, sequence: number, clockId: string,
  monotonicNs: string, wallTimeUtc: string, pssBytes: number, metric: string = 'pssBytes'): MetricEvent {
  requireWire(metric === 'cpuPercent' || metric === 'pssBytes');
  requireWire(Number.isFinite(pssBytes) && pssBytes >= 0 &&
    (metric === 'cpuPercent' || Number.isSafeInteger(pssBytes)));
  requireWire(Number.isSafeInteger(sequence) && sequence > 0);
  requireWire(match(monotonicNs, '^(0|[1-9][0-9]{0,19})$'));
  const identity = negotiated.identity;
  return {
    project: identity.project, buildId: identity.buildId, device: identity.device, process: identity.process,
    sessionId: identity.sessionId, fingerprint: identity.fingerprint,
    protocolVersion: negotiated.protocolVersion, channelVersion: '1.0', messageId: 'metric-' + sequence,
    sessionEpoch: epoch, sequence: sequence, channel: 'hidebug', type: 'event', capability: 'hidebug.read',
    clockId: clockId, bootId: clockId, wallTimeUtc: wallTimeUtc, monotonicNs: monotonicNs,
    // No desktop clock calibration has occurred. Do not imply cross-device ordering.
    offsetUncertaintyMs: Number.MAX_SAFE_INTEGER,
    payload: { metric: metric, value: pssBytes },
    redaction: { policyId: 'metrics-only-v1', fieldsRemoved: 0 }
  };
}
export interface UiEvent extends Identity {
  protocolVersion: string;
  channelVersion: string;
  messageId: string;
  sessionEpoch: string;
  sequence: number;
  channel: string;
  type: string;
  capability: string;
  clockId: string;
  bootId: string;
  wallTimeUtc: string;
  monotonicNs: string;
  offsetUncertaintyMs: number;
  payload: UiPayload;
  redaction: Redaction;
}
export function makeUiEvent(negotiated: Negotiated, epoch: string, sequence: number, clockId: string,
  monotonicNs: string, wallTimeUtc: string, windowId: string, nodeCount: number): UiEvent {
  requireWire(negotiated.channels.some((offer) => offer.channel === 'ui' && offer.available && offer.read), 'UI_NOT_NEGOTIATED');
  requireWire(match(windowId, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') &&
    Number.isSafeInteger(nodeCount) && nodeCount > 0 && nodeCount <= 256, 'UI_TREE_INVALID');
  const base = makeMetricEvent(negotiated, epoch, sequence, clockId, monotonicNs, wallTimeUtc, 0);
  return {
    project: base.project, buildId: base.buildId, device: base.device, process: base.process,
    sessionId: base.sessionId, fingerprint: base.fingerprint,
    protocolVersion: base.protocolVersion, channelVersion: base.channelVersion, messageId: 'ui-' + sequence,
    sessionEpoch: epoch, sequence: sequence, channel: 'ui', type: 'event', capability: 'ui.read',
    clockId: base.clockId, bootId: base.bootId, wallTimeUtc: base.wallTimeUtc, monotonicNs: base.monotonicNs,
    offsetUncertaintyMs: base.offsetUncertaintyMs,
    payload: { windowId: windowId, nodeCount: nodeCount, summary: 'registered-subtree;expanded-only' },
    redaction: { policyId: 'structure-only-v1', fieldsRemoved: 0 }
  };
}

interface NetworkPayload { requestId: string; method: string; status?: number; durationMs: number; }
export interface NetworkEvent extends Identity {
  protocolVersion: string;
  channelVersion: string;
  messageId: string;
  sessionEpoch: string;
  sequence: number;
  channel: string;
  type: string;
  capability: string;
  clockId: string;
  bootId: string;
  wallTimeUtc: string;
  monotonicNs: string;
  offsetUncertaintyMs: number;
  payload: NetworkPayload;
  redaction: Redaction;
}
export function makeNetworkEvent(negotiated: Negotiated, epoch: string, sequence: number, observation: NetworkObservation): NetworkEvent {
  requireWire(negotiated.channels.some((offer) => offer.channel === 'app.network' && offer.available && offer.read),
    'NETWORK_NOT_NEGOTIATED');
  const base = makeMetricEvent(negotiated, epoch, sequence, 'run-' + negotiated.identity.sessionId,
    observation.monotonicNs, observation.wallTimeUtc, 0);
  const payload: NetworkPayload = {
    requestId: observation.requestId, method: observation.method, durationMs: observation.durationMs
  };
  if (observation.status !== undefined) { payload.status = observation.status; }
  return {
    project: base.project, buildId: base.buildId, device: base.device, process: base.process,
    sessionId: base.sessionId, fingerprint: base.fingerprint,
    protocolVersion: base.protocolVersion, channelVersion: '1.0', messageId: 'network-' + sequence,
    sessionEpoch: epoch, sequence: sequence, channel: 'app.network', type: 'event', capability: 'app.network.read',
    clockId: base.clockId, bootId: base.bootId, wallTimeUtc: base.wallTimeUtc, monotonicNs: base.monotonicNs,
    offsetUncertaintyMs: base.offsetUncertaintyMs, payload: payload,
    redaction: { policyId: 'network-metadata-only-v1', fieldsRemoved: 0 }
  };
}

export interface WebEvent extends Identity {
  protocolVersion: string;
  channelVersion: string;
  messageId: string;
  sessionEpoch: string;
  sequence: number;
  channel: string;
  type: string;
  capability: string;
  clockId: string;
  bootId: string;
  wallTimeUtc: string;
  monotonicNs: string;
  offsetUncertaintyMs: number;
  payload: Record<string, Object>;
  redaction: Redaction;
}
export function makeWebEvent(negotiated: Negotiated, epoch: string, sequence: number, channel: string,
  payload: Record<string, Object>, monotonicNs: string, wallTimeUtc: string): WebEvent {
  requireWire(['arkweb.dom', 'arkweb.console', 'arkweb.network', 'arkweb.storage'].includes(channel) &&
    negotiated.channels.some((offer) => offer.channel === channel && offer.available && offer.read), 'WEB_NOT_NEGOTIATED');
  const base = makeMetricEvent(negotiated, epoch, sequence, 'run-' + negotiated.identity.sessionId,
    monotonicNs, wallTimeUtc, 0);
  return {
    project: base.project, buildId: base.buildId, device: base.device, process: base.process,
    sessionId: base.sessionId, fingerprint: base.fingerprint,
    protocolVersion: base.protocolVersion, channelVersion: '1.0', messageId: 'web-' + sequence,
    sessionEpoch: epoch, sequence: sequence, channel: channel, type: 'event', capability: channel + '.read',
    clockId: base.clockId, bootId: base.bootId, wallTimeUtc: base.wallTimeUtc, monotonicNs: base.monotonicNs,
    offsetUncertaintyMs: base.offsetUncertaintyMs, payload: payload,
    redaction: { policyId: 'web-structure-only-v1', fieldsRemoved: 0 }
  };
}

export function makeDfxEvent(negotiated: Negotiated, epoch: string, sequence: number,
  eventName: string, monotonicNs: string, wallTimeUtc: string): WebEvent {
  requireWire(negotiated.channels.some((offer) => offer.channel === 'hiappevent' && offer.available && offer.read),
    'DFX_NOT_NEGOTIATED');
  requireWire(eventName === 'APP_CRASH' || eventName === 'APP_FREEZE', 'DFX_EVENT_INVALID');
  // Reuse the scoped envelope while retaining the distinct DFX capability.
  const base = makeMetricEvent(negotiated, epoch, sequence, 'run-' + negotiated.identity.sessionId,
    monotonicNs, wallTimeUtc, 0);
  const payload: Record<string, Object> = {
    'eventName': eventName, 'summary': 'observed-callback;fault-time-unverified;[MEMORY_ONLY]'
  };
  return {
    project: base.project, buildId: base.buildId, device: base.device, process: base.process,
    sessionId: base.sessionId, fingerprint: base.fingerprint, protocolVersion: base.protocolVersion,
    channelVersion: '1.0', messageId: 'dfx-' + sequence, sessionEpoch: epoch, sequence: sequence,
    channel: 'hiappevent', type: 'event', capability: 'hiappevent.read',
    clockId: base.clockId, bootId: base.bootId, wallTimeUtc: base.wallTimeUtc, monotonicNs: base.monotonicNs,
    offsetUncertaintyMs: base.offsetUncertaintyMs, payload: payload,
    redaction: { policyId: 'dfx-event-name-only-v1', fieldsRemoved: 0 }
  };
}

export function readAck(value: Object, negotiated: Negotiated, epoch: string, expected: number): number {
  const record = keysOf(value, ['project', 'buildId', 'device', 'process', 'sessionId', 'fingerprint',
    'protocolVersion', 'sessionEpoch', 'type', 'ackThrough']);
  const identity: Identity = {
    project: record['project'] as string, buildId: record['buildId'] as string, device: record['device'] as string,
    process: record['process'] as string, sessionId: record['sessionId'] as string, fingerprint: record['fingerprint'] as string
  };
  readIdentity(identity);
  requireWire(canonical(identity) === canonical(negotiated.identity) && record['protocolVersion'] === negotiated.protocolVersion &&
    record['sessionEpoch'] === epoch && record['type'] === 'ack', 'ACK_SCOPE_MISMATCH');
  return numberOf(record, 'ackThrough', expected, expected);
}
