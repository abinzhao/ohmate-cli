/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { identity, event } from './test-fixtures.js';
import { createHandshake } from './handshake.js';

const target = { project: identity.project, buildId: identity.buildId, device: identity.device,
  process: identity.process, sessionId: identity.sessionId };

async function security(): Promise<typeof import('./security.js')> {
  expect(existsSync(new URL('./security.ts', import.meta.url)), 'secure pairing entry is missing').toBe(true);
  const path = './security.js';
  return import(path);
}

async function paired(options: Record<string, number> = {}) {
  const { PairingAuthority, createPairingClient } = await security();
  const authority = new PairingAuthority(options);
  const invitation = authority.issue(target);
  const client = createPairingClient(invitation, { appConfirmed: true });
  const accepted = authority.accept(client.request());
  const channel = client.finish(accepted.reply);
  return { authority, invitation, client, server: accepted.channel, channel };
}

it('pairs only after application confirmation and negotiates N/N-1 read-only channels', async () => {
  const { PairingAuthority, createPairingClient } = await security();
  const authority = new PairingAuthority();
  const invitation = authority.issue(target);
  expect(invitation.oneTimeCode).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(invitation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(() => createPairingClient(invitation, { appConfirmed: false })).toThrow('APP_CONFIRMATION_REQUIRED');
  const client = createPairingClient(invitation, { appConfirmed: true, protocolVersionRange: { min: '1.0', max: '1.0' } });
  const accepted = authority.accept(client.request());
  expect(accepted.negotiated.protocolVersion).toBe('1.0');
  expect(accepted.negotiated.channels.every((item) => !item.write && !item.highRisk)).toBe(true);
  expect(client.finish(accepted.reply).open(accepted.channel.seal({ type: 'ready' }))).toEqual({ type: 'ready' });
  authority.close();
});

it('never sends the invitation secret or unencrypted event payload on the wire', async () => {
  const { authority, invitation, client, server, channel } = await paired();
  expect(JSON.stringify(client.request())).not.toContain(invitation.oneTimeCode);
  const sealed = channel.seal(event());
  expect(JSON.stringify(sealed)).not.toContain('Redacted fixture summary');
  expect(server.open(sealed)).toEqual(event());
  authority.close(); channel.close();
});

it('consumes an invitation once and rejects expired codes before establishing a session', async () => {
  const { PairingAuthority, createPairingClient } = await security();
  let now = 1000;
  const authority = new PairingAuthority({ now: () => now, pairingTtlMs: 200 });
  const invitation = authority.issue(target);
  const client = createPairingClient(invitation, { appConfirmed: true, now: () => now });
  const request = client.request();
  authority.accept(request);
  expect(() => authority.accept(request)).toThrow('PAIRING_INVALID');
  const expired = createPairingClient(authority.issue(target), { appConfirmed: true, now: () => now });
  now = 1200;
  expect(() => authority.accept(expired.request())).toThrow('PAIRING_INVALID');
  authority.close();
});

it.each(['buildId', 'device', 'process', 'project', 'sessionId', 'fingerprint'])('binds mutual challenge to %s', async (field) => {
  const { PairingAuthority, createPairingClient } = await security();
  const authority = new PairingAuthority();
  const invitation = authority.issue(target);
  const client = createPairingClient(invitation, { appConfirmed: true });
  const request = client.request();
  const corrupted = structuredClone(request);
  corrupted.handshake.identity[field as keyof typeof identity] = field === 'fingerprint' ? 'b'.repeat(64) : 'other';
  expect(() => authority.accept(corrupted)).toThrow();
  expect(() => authority.accept(request)).toThrow('PAIRING_INVALID');
  authority.close();
});

it('rejects wrong proof, altered service fingerprint, malformed public key, and changed capabilities', async () => {
  const { PairingAuthority, createPairingClient } = await security();
  const authority = new PairingAuthority();
  const invitation = authority.issue(target);
  const client = createPairingClient(invitation, { appConfirmed: true });
  expect(() => createPairingClient({ ...invitation, fingerprint: 'b'.repeat(64) }, { appConfirmed: true })).toThrow();
  expect(() => authority.accept({ ...client.request(), proof: 'b'.repeat(64) })).toThrow('PAIRING_INVALID');
  const next = authority.issue(target);
  const badKey = createPairingClient(next, { appConfirmed: true }).request();
  badKey.publicKey = Buffer.from('not a public key').toString('base64');
  expect(() => authority.accept(badKey)).toThrow();
  const capabilities = createPairingClient(authority.issue(target), { appConfirmed: true }).request();
  capabilities.handshake.channels[0].write = true as false;
  expect(() => authority.accept(capabilities)).toThrow();
  authority.close();
});

it('verifies the service proof and refuses to finish twice', async () => {
  const { PairingAuthority, createPairingClient } = await security();
  const authority = new PairingAuthority();
  const client = createPairingClient(authority.issue(target), { appConfirmed: true });
  const accepted = authority.accept(client.request());
  expect(() => client.finish({ ...accepted.reply, proof: 'b'.repeat(64) })).toThrow('PAIRING_INVALID');
  expect(() => client.finish(accepted.reply)).toThrow('INVALID_STATE');
  authority.close();
});

it('authenticates ciphertext, headers, sequence, direction and channel identity', async () => {
  const { authority, channel, server } = await paired();
  const sealed = channel.seal({ summary: 'allowed' });
  expect(() => server.open({ ...sealed, counter: 2 })).toThrow();
  expect(() => server.open({ ...sealed, direction: 'cli-to-kit' })).toThrow();
  expect(() => server.open({ ...sealed, connectionId: 'b'.repeat(64) })).toThrow();
  expect(() => server.open({ ...sealed, tag: Buffer.alloc(16, 1).toString('base64') })).toThrow('FRAME_AUTHENTICATION_FAILED');
  expect(server.open(sealed)).toEqual({ summary: 'allowed' });
  expect(() => server.open(sealed)).toThrow('FRAME_REPLAY');
  expect(() => channel.open(sealed)).toThrow('FRAME_SCOPE_MISMATCH');
  authority.close(); channel.close();
});

it('requires fresh key material on expiry and frame rotation limits', async () => {
  const { PairingAuthority, createPairingClient } = await security();
  let now = 1000;
  const authority = new PairingAuthority({ now: () => now, sessionTtlMs: 300, maxFrames: 2 });
  const invitation = authority.issue(target);
  const client = createPairingClient(invitation, { appConfirmed: true, now: () => now });
  const accepted = authority.accept(client.request());
  const channel = client.finish(accepted.reply);
  accepted.channel.open(channel.seal({ n: 1 }));
  accepted.channel.open(channel.seal({ n: 2 }));
  expect(() => channel.seal({ n: 3 })).toThrow('KEY_ROTATION_REQUIRED');
  now = 1300;
  expect(() => accepted.channel.seal({ n: 1 })).toThrow('KEY_EXPIRED');
  authority.close(); channel.close();
});

it('bounds pending invitations and encryptable JSON without leaking invalid values', async () => {
  const { PairingAuthority } = await security();
  const authority = new PairingAuthority({ maxPending: 1 });
  authority.issue(target);
  expect(() => authority.issue(target)).toThrow('PAIRING_LIMIT');
  authority.close();
  expect(() => authority.issue(target)).toThrow('INVALID_STATE');
  const pair = await paired();
  expect(() => pair.channel.seal({ text: 'x'.repeat(70000) })).toThrow('FRAME_TOO_LARGE');
  expect(() => pair.channel.seal(undefined)).toThrow('INVALID_SCHEMA');
  pair.authority.close(); pair.channel.close();
});

it('interoperates with an independent WebCrypto P-256/HKDF/AES-GCM producer', async () => {
  const { PairingAuthority, pairingTranscript, pairingProof } = await security();
  const authority = new PairingAuthority();
  const invitation = authority.issue(target);
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const peer = createHandshake(invitation.handshake.identity);
  const request = { type: 'pair-request' as const, pairingId: invitation.pairingId, publicKey,
    challenge: Buffer.alloc(32, 7).toString('base64'), handshake: peer, appConfirmed: true as const, proof: '' };
  const transcript = pairingTranscript(invitation, request);
  request.proof = pairingProof(invitation.oneTimeCode, 'kit', transcript);
  const accepted = authority.accept(request);
  const remote = await webcrypto.subtle.importKey('spki', Buffer.from(invitation.publicKey, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: remote }, pair.privateKey, 256);
  const material = await webcrypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  const key = await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from(transcript, 'hex'),
    info: Buffer.from('ohmate/debug/1/cli-to-kit') }, material, 256);
  const frame = accepted.channel.seal({ type: 'ready' });
  const { ciphertext, tag, ...header } = frame;
  const { canonicalJson } = await import('./canonical-hash.js');
  const iv = Buffer.alloc(12); iv.writeUInt32BE(2); iv.writeBigUInt64BE(BigInt(frame.counter), 4);
  const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv,
    additionalData: Buffer.from(canonicalJson(header)), tagLength: 128 }, aes,
  Buffer.concat([Buffer.from(ciphertext, 'base64'), Buffer.from(tag, 'base64')]));
  expect(JSON.parse(Buffer.from(plaintext).toString())).toEqual({ type: 'ready' });
  authority.close();
});
