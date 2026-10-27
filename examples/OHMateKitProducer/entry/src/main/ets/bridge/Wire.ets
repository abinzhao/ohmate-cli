/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CHANNEL_CONTRACTS } from './GeneratedContract';

export interface Identity {
  project: string;
  buildId: string;
  device: string;
  process: string;
  sessionId: string;
  fingerprint: string;
}
export interface VersionRange { min: string; max: string; }
export interface ChannelOffer {
  channel: string;
  channelVersion: string;
  schemaHash: string;
  capabilityHash: string;
  capability: string;
  available: boolean;
  read: boolean;
  write: boolean;
  highRisk: boolean;
  reason: string;
}
export interface Handshake {
  type: string;
  mode: string;
  protocolVersionRange: VersionRange;
  identity: Identity;
  channels: ChannelOffer[];
  maxFrame: number;
  resumeWindow: number;
  compression: string[];
}
export interface Negotiated {
  mode: string;
  protocolVersion: string;
  identity: Identity;
  channels: ChannelOffer[];
  maxFrame: number;
  resumeWindow: number;
  compression: string;
}
export interface Invitation {
  type: string;
  suite: string;
  pairingId: string;
  fingerprint: string;
  oneTimeCode: string;
  publicKey: string;
  challenge: string;
  expiresAt: number;
  handshake: Handshake;
}
export interface PairingPackage { endpoint: string; invitation: Invitation; }
export interface PairingRequest {
  type: string;
  pairingId: string;
  publicKey: string;
  challenge: string;
  handshake: Handshake;
  appConfirmed: boolean;
  proof: string;
}
export interface PairingReply {
  type: string;
  pairingId: string;
  connectionId: string;
  expiresAt: number;
  maxFrames: number;
  proof: string;
}
export interface FrameHeader {
  type: string;
  version: string;
  connectionId: string;
  direction: string;
  counter: number;
}
export interface SealedFrame extends FrameHeader { ciphertext: string; tag: string; }
export interface Limits { connectionId: string; expiresAt: number; maxFrames: number; maxFrame: number; }

export interface CryptoPort {
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
  base64(bytes: Uint8Array): string;
  unbase64(text: string): Uint8Array;
  random(size: number): Uint8Array;
  hash(text: string): string;
  proof(code: Uint8Array, text: string): string;
  ephemeral(): string;
  derive(remote: string, transcript: string): void;
  encrypt(bytes: Uint8Array, iv: Uint8Array, aad: Uint8Array): Uint8Array;
  decrypt(bytes: Uint8Array, tag: Uint8Array, iv: Uint8Array, aad: Uint8Array): Uint8Array;
  clear(): void;
}

export function requireWire(ok: boolean, code: string = 'INVALID_SCHEMA'): void {
  if (!ok) { throw new Error(code); }
}
export function canonical(value: Object | null): string {
  if (value === null) { return 'null'; }
  if (Array.isArray(value)) {
    return '[' + (value as Object[]).map((item: Object) => canonical(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, Object>;
    return '{' + Object.keys(record).filter((key: string) => record[key] !== undefined).sort()
      .map((key: string) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function recordOf(value: Object): Record<string, Object> {
  requireWire(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, Object>;
}
export function keysOf(value: Object, keys: string[]): Record<string, Object> {
  const record = recordOf(value);
  const actual = Object.keys(record);
  requireWire(actual.length === keys.length && actual.every((key: string) => keys.includes(key)));
  return record;
}
export function textOf(record: Record<string, Object>, key: string, max: number = 512): string {
  const value = record[key];
  requireWire(typeof value === 'string' && (value as string).length <= max);
  return value as string;
}
export function numberOf(record: Record<string, Object>, key: string, min: number, max: number): number {
  const value = record[key];
  requireWire(typeof value === 'number' && Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
  return value as number;
}
export function match(value: string, pattern: string): boolean { return new RegExp(pattern).test(value); }
export function hashOf(record: Record<string, Object>, key: string): string {
  const value = textOf(record, key, 64);
  requireWire(match(value, '^[a-f0-9]{64}$'));
  return value;
}
export function uuidOf(record: Record<string, Object>, key: string): string {
  const value = textOf(record, key, 36);
  requireWire(match(value, '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'));
  return value;
}
export function base64Of(record: Record<string, Object>, key: string, port: CryptoPort, size: number): string {
  const value = textOf(record, key, size < 0 ? 1398104 : 1024);
  requireWire(match(value, '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'));
  const bytes = port.unbase64(value);
  try {
    requireWire(port.base64(bytes) === value && (size < 0 || bytes.length === size));
  } finally { bytes.fill(0); }
  return value;
}
export function readIdentity(value: Object): Identity {
  const record = keysOf(value, ['project', 'buildId', 'device', 'process', 'sessionId', 'fingerprint']);
  for (const key of ['project', 'device', 'process', 'sessionId']) {
    requireWire(match(textOf(record, key, 128), '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'));
  }
  requireWire(match(textOf(record, 'buildId'), '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$'));
  hashOf(record, 'fingerprint');
  return value as Identity;
}
export function readHandshake(value: Object): Handshake {
  const record = keysOf(value, ['type', 'mode', 'protocolVersionRange', 'identity', 'channels', 'maxFrame', 'resumeWindow', 'compression']);
  requireWire(record['type'] === 'handshake' && record['mode'] === 'readonly');
  readIdentity(record['identity']);
  const range = keysOf(record['protocolVersionRange'], ['min', 'max']);
  requireWire(['1.0', '1.1'].includes(textOf(range, 'min')) && ['1.0', '1.1'].includes(textOf(range, 'max')));
  requireWire(textOf(range, 'min') <= textOf(range, 'max'));
  numberOf(record, 'maxFrame', 1024, 1048576);
  numberOf(record, 'resumeWindow', 1, 4096);
  requireWire(canonical(record['compression']) === '["none"]');
  requireWire(Array.isArray(record['channels']));
  const offers = record['channels'] as Object[];
  const known = JSON.parse(CHANNEL_CONTRACTS) as ChannelOffer[];
  requireWire(offers.length > 0 && offers.length <= known.length);
  const seen: string[] = [];
  for (const offer of offers) {
    const entry = keysOf(offer, ['channel', 'channelVersion', 'schemaHash', 'capabilityHash', 'capability',
      'available', 'read', 'write', 'highRisk', 'reason']);
    const name = textOf(entry, 'channel');
    requireWire(!seen.includes(name));
    seen.push(name);
    const expected = known.find((item: ChannelOffer) => item.channel === name);
    requireWire(expected !== undefined, 'CHANNEL_MISMATCH');
    if (expected === undefined) { throw new Error('CHANNEL_MISMATCH'); }
    requireWire(entry['channelVersion'] === expected.channelVersion && entry['schemaHash'] === expected.schemaHash &&
      entry['capabilityHash'] === expected.capabilityHash && entry['capability'] === expected.capability, 'CHANNEL_MISMATCH');
    requireWire(typeof entry['available'] === 'boolean' && entry['available'] === entry['read'] &&
      entry['write'] === false && entry['highRisk'] === false);
    textOf(entry, 'reason', 256);
  }
  return value as Handshake;
}
export function parsePairing(text: string, port: CryptoPort, now: number): PairingPackage {
  requireWire(port.encode(text).length <= 16384);
  const parsed = keysOf(JSON.parse(text), ['endpoint', 'invitation']);
  const endpoint = textOf(parsed, 'endpoint', 128);
  requireWire(match(endpoint, '^ws://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/bridge/v1$'), 'LOOPBACK_REQUIRED');
  const portNumber = Number(endpoint.split(':')[2].split('/')[0]);
  requireWire(portNumber <= 65535, 'LOOPBACK_REQUIRED');
  const invite = keysOf(parsed['invitation'], ['type', 'suite', 'pairingId', 'fingerprint', 'oneTimeCode', 'publicKey',
    'challenge', 'expiresAt', 'handshake']);
  requireWire(invite['type'] === 'pair-invitation' && invite['suite'] === 'P256-HKDF-SHA256-AES256-GCM');
  uuidOf(invite, 'pairingId');
  hashOf(invite, 'fingerprint');
  base64Of(invite, 'oneTimeCode', port, 32);
  base64Of(invite, 'challenge', port, 32);
  // Exact P-256 SPKI prefix prevents curve/type substitution before platform import.
  const der = port.unbase64(base64Of(invite, 'publicKey', port, 91));
  const prefix = '3059301306072a8648ce3d020106082a8648ce3d03010703420004';
  requireWire(hex(der.slice(0, 27)) === prefix, 'PAIRING_INVALID');
  numberOf(invite, 'expiresAt', now + 1, now + 120000);
  const handshake = readHandshake(invite['handshake']);
  requireWire(handshake.identity.fingerprint === invite['fingerprint']);
  requireWire(handshake.channels.some((item: ChannelOffer) => item.channel === 'hidebug' && item.available && item.read),
    'NO_READ_CAPABILITY');
  const invitation: Invitation = {
    type: textOf(invite, 'type'), suite: textOf(invite, 'suite'), pairingId: uuidOf(invite, 'pairingId'),
    fingerprint: hashOf(invite, 'fingerprint'), oneTimeCode: textOf(invite, 'oneTimeCode'),
    publicKey: textOf(invite, 'publicKey'), challenge: textOf(invite, 'challenge'),
    expiresAt: invite['expiresAt'] as number, handshake: handshake
  };
  return { endpoint: endpoint, invitation: invitation };
}
export function hex(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) { result += bytes[i].toString(16).padStart(2, '0'); }
  return result;
}
export function unhex(text: string): Uint8Array {
  requireWire(match(text, '^(?:[a-f0-9]{2})+$'));
  const result = new Uint8Array(text.length / 2);
  for (let i = 0; i < result.length; i++) { result[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16); }
  return result;
}
export function nonce(direction: number, counter: number): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, direction, false);
  view.setUint32(8, counter, false);
  return bytes;
}
