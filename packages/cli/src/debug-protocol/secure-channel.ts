/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { canonicalJson } from './canonical-hash.js';
import { SealedFrameSchema, parseSecurity, securityError } from './security-schemas.js';
import type { SealedFrame } from './security-schemas.js';

export interface ChannelKeys { kitToCli: Buffer; cliToKit: Buffer }
export interface ChannelLimits { connectionId: string; expiresAt: number; maxFrames: number; maxFrame: number }
function nonce(direction: SealedFrame['direction'], counter: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(direction === 'kit-to-cli' ? 1 : 2);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

export class SecureChannel {
  private sent = 0;
  private received = 0;
  private closed = false;
  private readonly outgoing: SealedFrame['direction'];
  private readonly incoming: SealedFrame['direction'];
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;
  constructor(role: 'cli' | 'kit', keys: ChannelKeys, readonly limits: ChannelLimits, private now = Date.now) {
    this.outgoing = role === 'cli' ? 'cli-to-kit' : 'kit-to-cli';
    this.incoming = role === 'cli' ? 'kit-to-cli' : 'cli-to-kit';
    this.sendKey = Buffer.from(role === 'cli' ? keys.cliToKit : keys.kitToCli);
    this.receiveKey = Buffer.from(role === 'cli' ? keys.kitToCli : keys.cliToKit);
    keys.cliToKit.fill(0); keys.kitToCli.fill(0);
  }
  seal(value: unknown): SealedFrame {
    this.assertActive(this.sent);
    let content: string | undefined;
    try { content = JSON.stringify(value); } catch { throw securityError('INVALID_SCHEMA'); }
    if (content === undefined) { throw securityError('INVALID_SCHEMA'); }
    if (Buffer.byteLength(content) > this.limits.maxFrame) { throw securityError('FRAME_TOO_LARGE'); }
    const header = { type: 'sealed' as const, version: '1' as const, connectionId: this.limits.connectionId,
      direction: this.outgoing, counter: this.sent + 1 };
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce(header.direction, header.counter), { authTagLength: 16 });
    cipher.setAAD(Buffer.from(canonicalJson(header)));
    const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    this.sent++;
    return { ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  open(input: unknown): unknown {
    this.assertActive(this.received);
    const frame = parseSecurity(SealedFrameSchema, input);
    const { ciphertext, tag, ...header } = frame;
    if (header.direction !== this.incoming || header.connectionId !== this.limits.connectionId) {
      throw securityError('FRAME_SCOPE_MISMATCH');
    }
    if (header.counter <= this.received) { throw securityError('FRAME_REPLAY'); }
    if (header.counter !== this.received + 1) { throw securityError('FRAME_SEQUENCE_GAP'); }
    const bytes = Buffer.from(ciphertext, 'base64');
    if (bytes.length > this.limits.maxFrame) { throw securityError('FRAME_TOO_LARGE'); }
    let plaintext: Buffer;
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.receiveKey, nonce(header.direction, header.counter), { authTagLength: 16 });
      cipher.setAAD(Buffer.from(canonicalJson(header))); cipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    } catch { throw securityError('FRAME_AUTHENTICATION_FAILED'); }
    this.received++;
    try { return JSON.parse(plaintext.toString('utf8')); }
    catch { throw securityError('INVALID_SCHEMA'); }
    finally { plaintext.fill(0); }
  }
  close(): void {
    this.closed = true; this.sendKey.fill(0); this.receiveKey.fill(0);
  }
  private assertActive(counter: number): void {
    if (this.closed) { throw securityError('INVALID_STATE'); }
    if (this.now() >= this.limits.expiresAt) { this.close(); throw securityError('KEY_EXPIRED'); }
    if (counter >= this.limits.maxFrames) { throw securityError('KEY_ROTATION_REQUIRED'); }
  }
}
