/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, PairingPackage, PairingRequest, Handshake, Negotiated, ChannelOffer, Limits, FrameHeader,
  SealedFrame, canonical, keysOf, numberOf, hashOf, uuidOf, base64Of, nonce, requireWire } from './Wire';
export { parsePairing, canonical } from './Wire';
export { makeMetricEvent } from './ReadonlyCollector';

interface Transcript {
  domain: string;
  suite: string;
  pairingId: string;
  fingerprint: string;
  expiresAt: number;
  serverKey: string;
  serverChallenge: string;
  clientKey: string;
  clientChallenge: string;
  negotiated: Negotiated;
  appConfirmed: boolean;
}
interface ReplyTranscript { transcript: string; limits: Limits; }

export class PairingSession {
  readonly negotiated: Negotiated;
  private input: PairingPackage;
  private port: CryptoPort;
  private now: () => number;
  private hello: Handshake;
  private transcript: string = '';
  private code: Uint8Array = new Uint8Array();
  private limits: Limits | undefined = undefined;
  private stage: string = 'review';
  private sent: number = 0;
  private received: number = 0;

  constructor(input: PairingPackage, port: CryptoPort, now: () => number, version: string = '1.1',
    supported: string[] = ['hidebug']) {
    this.input = input;
    this.port = port;
    this.now = now;
    requireWire(version === '1.0' || version === '1.1');
    const remote = input.invitation.handshake;
    requireWire(supported.length > 0 && supported.every((name: string) =>
      ['hidebug', 'ui', 'app.network', 'arkweb.dom', 'arkweb.console', 'arkweb.network', 'arkweb.storage', 'hiappevent'].includes(name)),
      'NO_READ_CAPABILITY');
    const channels = remote.channels.filter((item: ChannelOffer) => supported.includes(item.channel) && item.available && item.read);
    requireWire(channels.some((item: ChannelOffer) => item.channel === 'hidebug'), 'NO_READ_CAPABILITY');
    this.hello = {
      type: 'handshake', mode: 'readonly', protocolVersionRange: { min: '1.0', max: version },
      identity: remote.identity, channels: channels, maxFrame: 65536, resumeWindow: 1, compression: ['none']
    };
    const selected = version === '1.1' && remote.protocolVersionRange.max === '1.1' ? '1.1' : '1.0';
    requireWire(selected >= remote.protocolVersionRange.min, 'VERSION_MISMATCH');
    this.negotiated = {
      mode: 'readonly', protocolVersion: selected, identity: remote.identity, channels: channels,
      maxFrame: Math.min(remote.maxFrame, 65536), resumeWindow: 1, compression: 'none'
    };
  }
  request(appConfirmed: boolean): PairingRequest {
    requireWire(appConfirmed, 'APP_CONFIRMATION_REQUIRED');
    requireWire(this.stage === 'review', 'INVALID_STATE');
    this.stage = 'pairing';
    try {
      requireWire(this.input.invitation.expiresAt > this.now(), 'PAIRING_INVALID');
      const invitation = this.input.invitation;
      this.code = this.port.unbase64(invitation.oneTimeCode);
      invitation.oneTimeCode = '';
      const publicKey = this.port.ephemeral();
      const challenge = this.port.base64(this.port.random(32));
      const transcript: Transcript = {
        domain: 'ohmate/debug/pairing/1', suite: invitation.suite, pairingId: invitation.pairingId,
        fingerprint: invitation.fingerprint, expiresAt: invitation.expiresAt,
        serverKey: invitation.publicKey, serverChallenge: invitation.challenge,
        clientKey: publicKey, clientChallenge: challenge, negotiated: this.negotiated, appConfirmed: true
      };
      this.transcript = this.port.hash(canonical(transcript));
      return {
        type: 'pair-request', pairingId: invitation.pairingId, publicKey: publicKey,
        challenge: challenge, handshake: this.hello, appConfirmed: true,
        proof: this.port.proof(this.code, 'ohmate/debug/pairing/1/kit/' + this.transcript)
      };
    } catch {
      this.close();
      throw new Error('PAIRING_INVALID');
    }
  }
  finish(value: Object): void {
    requireWire(this.stage === 'pairing', 'INVALID_STATE');
    try {
      const reply = keysOf(value, ['type', 'pairingId', 'connectionId', 'expiresAt', 'maxFrames', 'proof']);
      requireWire(reply['type'] === 'pair-reply' && uuidOf(reply, 'pairingId') === this.input.invitation.pairingId);
      const limits: Limits = {
        connectionId: hashOf(reply, 'connectionId'),
        expiresAt: numberOf(reply, 'expiresAt', this.now() + 1, this.now() + 600000),
        maxFrames: numberOf(reply, 'maxFrames', 1, 65536), maxFrame: this.negotiated.maxFrame
      };
      const bound: ReplyTranscript = { transcript: this.transcript, limits: limits };
      const expected = this.port.proof(this.code, 'ohmate/debug/pairing/1/cli/' + this.port.hash(canonical(bound)));
      const actual = hashOf(reply, 'proof');
      let difference = actual.length ^ expected.length;
      for (let i = 0; i < expected.length; i++) { difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i); }
      requireWire(difference === 0);
      this.port.derive(this.input.invitation.publicKey, this.transcript);
      this.code.fill(0);
      this.limits = limits;
      this.stage = 'secure';
    } catch {
      this.close();
      throw new Error('PAIRING_INVALID');
    }
  }
  seal(value: Object): SealedFrame {
    const limits = this.active(this.sent);
    try {
      const plaintext = this.port.encode(JSON.stringify(value));
      requireWire(plaintext.length <= limits.maxFrame, 'FRAME_TOO_LARGE');
      const header: FrameHeader = {
        type: 'sealed', version: '1', connectionId: limits.connectionId, direction: 'kit-to-cli', counter: this.sent + 1
      };
      let encrypted: Uint8Array;
      try { encrypted = this.port.encrypt(plaintext, nonce(1, header.counter), this.port.encode(canonical(header))); }
      finally { plaintext.fill(0); }
      requireWire(encrypted.length >= 16);
      this.sent++;
      return {
        type: header.type, version: header.version, connectionId: header.connectionId, direction: header.direction,
        counter: header.counter, ciphertext: this.port.base64(encrypted.slice(0, encrypted.length - 16)),
        tag: this.port.base64(encrypted.slice(encrypted.length - 16))
      };
    } catch {
      this.close();
      throw new Error('FRAME_REJECTED');
    }
  }
  open(value: Object): Object {
    const limits = this.active(this.received);
    try {
      const frame = keysOf(value, ['type', 'version', 'connectionId', 'direction', 'counter', 'ciphertext', 'tag']);
      requireWire(frame['type'] === 'sealed' && frame['version'] === '1' &&
        frame['connectionId'] === limits.connectionId && frame['direction'] === 'cli-to-kit');
      const counter = numberOf(frame, 'counter', 1, limits.maxFrames);
      requireWire(counter === this.received + 1);
      const ciphertext = this.port.unbase64(base64Of(frame, 'ciphertext', this.port, -1));
      requireWire(ciphertext.length <= limits.maxFrame);
      const tag = this.port.unbase64(base64Of(frame, 'tag', this.port, 16));
      const header: FrameHeader = {
        type: 'sealed', version: '1', connectionId: limits.connectionId, direction: 'cli-to-kit', counter: counter
      };
      const plaintext = this.port.decrypt(ciphertext, tag, nonce(2, counter), this.port.encode(canonical(header)));
      try {
        const result: Object = JSON.parse(this.port.decode(plaintext));
        this.received = counter;
        return result;
      } finally { plaintext.fill(0); }
    } catch {
      this.close();
      throw new Error('FRAME_REJECTED');
    }
  }
  expiresAt(): number { return this.limits?.expiresAt ?? this.input.invitation.expiresAt; }
  close(): void {
    this.stage = 'closed';
    this.code.fill(0);
    this.input.invitation.oneTimeCode = '';
    this.port.clear();
  }
  private active(counter: number): Limits {
    requireWire(this.stage === 'secure' && this.limits !== undefined, 'INVALID_STATE');
    const limits = this.limits;
    if (limits === undefined) { throw new Error('INVALID_STATE'); }
    if (this.now() >= limits.expiresAt || counter >= limits.maxFrames) {
      this.close();
      throw new Error('KEY_EXPIRED');
    }
    return limits;
  }
}
