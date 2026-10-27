/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  createTraceFileKey,
  encryptTraceLine,
  decryptTraceLine,
  type TraceFileCipherBlob,
} from './file-crypto.js';

const KEY = createTraceFileKey('test-secret');
const OTHER_KEY = createTraceFileKey('other-secret');

describe('createTraceFileKey', () => {
  it('derives a deterministic 32-byte key from the secret', () => {
    const a = createTraceFileKey('secret');
    const b = createTraceFileKey('secret');
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
  });

  it('derives different keys for different secrets', () => {
    expect(createTraceFileKey('a')).not.toEqual(createTraceFileKey('b'));
  });
});

describe('encryptTraceLine / decryptTraceLine', () => {
  it('roundtrips plaintext including unicode', () => {
    const plaintext = '{"event_type":"cli","label":"中文🎉"}';
    const line = encryptTraceLine(plaintext, KEY);
    expect(decryptTraceLine(line, KEY)).toBe(plaintext);
  });

  it('produces a v1 aes-256-gcm blob with a 12-byte IV', () => {
    const blob = JSON.parse(encryptTraceLine('x', KEY)) as TraceFileCipherBlob;
    expect(blob.version).toBe(1);
    expect(blob.algorithm).toBe('aes-256-gcm');
    expect(Buffer.from(blob.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(blob.authTag, 'base64')).toHaveLength(16);
  });

  it('uses a fresh IV per call', () => {
    const a = JSON.parse(encryptTraceLine('x', KEY)) as TraceFileCipherBlob;
    const b = JSON.parse(encryptTraceLine('x', KEY)) as TraceFileCipherBlob;
    expect(a.iv).not.toBe(b.iv);
  });

  it('returns null when the auth tag or ciphertext was tampered with', () => {
    const blob = JSON.parse(
      encryptTraceLine('secret', KEY)
    ) as TraceFileCipherBlob;
    const tamperedTag: TraceFileCipherBlob = {
      ...blob,
      authTag: Buffer.from('badauthtag').toString('base64'),
    };
    expect(decryptTraceLine(JSON.stringify(tamperedTag), KEY)).toBeNull();

    const tamperedText: TraceFileCipherBlob = {
      ...blob,
      ciphertext: Buffer.from('forged').toString('base64'),
    };
    expect(decryptTraceLine(JSON.stringify(tamperedText), KEY)).toBeNull();
  });

  it('returns null for a wrong key', () => {
    const line = encryptTraceLine('secret', KEY);
    expect(decryptTraceLine(line, OTHER_KEY)).toBeNull();
  });

  it('passes through legacy plaintext JSON lines unchanged', () => {
    const legacy = '{"event_type":"cli","debug":true}';
    expect(decryptTraceLine(legacy, KEY)).toBe(legacy);
  });

  it('returns null for invalid JSON lines', () => {
    expect(decryptTraceLine('not json at all', KEY)).toBeNull();
    expect(decryptTraceLine('', KEY)).toBeNull();
  });

  it('passes through JSON lines that are not v1 cipher blobs', () => {
    const version2 = '{"version":2,"algorithm":"aes-256-gcm"}';
    expect(decryptTraceLine(version2, KEY)).toBe(version2);
    const missingAuthTag =
      '{"version":1,"algorithm":"aes-256-gcm","ciphertext":"x","iv":"x"}';
    expect(decryptTraceLine(missingAuthTag, KEY)).toBe(missingAuthTag);
  });

  it('returns null for well-formed blobs that fail to decode', () => {
    expect(
      decryptTraceLine(
        JSON.stringify({
          version: 1,
          algorithm: 'aes-256-gcm',
          ciphertext: 'x',
          iv: Buffer.alloc(12).toString('base64'),
          authTag: 'not-base64!!!',
        }),
        KEY
      )
    ).toBeNull();
  });
});
