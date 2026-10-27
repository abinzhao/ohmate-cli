/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { RpcProtocolError } from '../errors.js';

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface DecodeResult {
  value: unknown;
  rest: Buffer;
}

export interface Codec {
  name: string;
  frameDelimited: boolean;
  encode: (value: unknown) => Buffer;
  decode: (buf: Buffer) => DecodeResult | null;
}

export const lengthPrefixedCodec: Codec = {
  name: 'length-prefixed',
  /**
   * Whether the frame has its own length boundary. Only codecs with boundaries can multiplex
   * on a single connection (responses of N concurrent requests can be split unambiguously).
   * Bare JSON has no boundary; multiple frames stuck together cannot be split,
   * so a codec with frameDelimited=false must be serial.
   */
  frameDelimited: true,
  encode(value) {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  },
  decode(buf) {
    if (buf.length < 4) {
      return null;
    }
    const len = buf.readUInt32BE(0);
    if (len > MAX_FRAME_BYTES || len < 0) {
      throw new RpcProtocolError(`invalid frame length ${len}`);
    }
    if (buf.length < 4 + len) {
      return null;
    }
    const body = buf.subarray(4, 4 + len).toString('utf8');
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      throw new RpcProtocolError(`response is not valid JSON: ${body.slice(0, 200)}`);
    }
    return { value, rest: buf.subarray(4 + len) };
  },
};

export const rawCodec: Codec = {
  name: 'raw',
  // Bare JSON has no length boundary: concurrency is not allowed on a single connection,
  // otherwise response packets will stick together and cannot be split
  frameDelimited: false,
  encode(value) {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  },
  decode(buf) {
    const text = buf.toString('utf8').trim();
    if (!text) {
      return null;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      // Not enough data yet (partial packet), keep waiting
      return null;
    }
    return { value, rest: Buffer.alloc(0) };
  },
};

/**
 * Guess framing based on the first byte of the response:
 *   JSON always starts with '{'(0x7B) / '['(0x5B) → raw
 *   length-prefixed first 4 bytes are big-endian length, normal message first byte is 0x00 → length-prefixed
 */
export function detectFraming(buf: Buffer): 'raw' | 'length-prefixed' | null {
  if (!buf || buf.length === 0) {
    return null;
  }
  const first = buf[0];
  if (first === 0x7b || first === 0x5b) {
    return 'raw';
  }
  return 'length-prefixed';
}

/**
 * Adaptive codec (default for real devices):
 *   - Encoding: the official uitest agent only accepts bare JSON (de facto standard in the hypium ecosystem),
 *     so encoding is fixed to raw; length-prefixed is an explicit option for "enhanced agents that support
 *     returning request_id", and does not go through auto.
 *   - Decoding: identifies between raw / length-prefixed based on the first byte of each arriving data chunk,
 *     able to parse both official bare JSON and tolerate frames with length prefix from the peer.
 */
export const autoCodec: Codec = {
  name: 'auto',
  // Encoding is fixed to raw (no length boundary), so auto connections must also be serial
  frameDelimited: false,
  encode(value) {
    return rawCodec.encode(value);
  },
  decode(buf) {
    const kind = detectFraming(buf);
    if (!kind) {
      return null;
    }
    return (kind === 'raw' ? rawCodec : lengthPrefixedCodec).decode(buf);
  },
};

export function createCodec(framing: 'length-prefixed' | 'raw' | 'auto' = 'auto'): Codec {
  if (framing === 'raw') {
    return rawCodec;
  }
  if (framing === 'length-prefixed') {
    return lengthPrefixedCodec;
  }
  return createAutoCodec();
}

/**
 * Create a stateful adaptive codec (independent new instance per connection).
 *
 * Real device facts (tested with official uitest agent v1.2.2 / uitest 7.0.0.1):
 *   - Requests must be **bare JSON** (sending 4-byte length prefix is ignored, no response)
 *   - Responses are also bare JSON, and **do not return request_id** (transport auto-degrades to serial accordingly)
 * Therefore auto encoding is fixed to raw; decoding identifies the peer format based on the first byte of the
 * first frame and locks it, able to parse both official bare JSON and tolerate length-prefixed frames from the peer.
 *
 * Under raw, the transport layer is serial (server does not return id → auto degrades concurrency to serial),
 * a connection always operates in "one request, one response" mode, so bare JSON packets will not stick together,
 * and the whole chunk can be parsed directly.
 */
export function createAutoCodec(): Codec & { detected: 'raw' | 'length-prefixed' | null } {
  let locked: 'raw' | 'length-prefixed' | null = null;

  return {
    name: 'auto',
    frameDelimited: false,
    get detected() {
      return locked;
    },
    encode(value: unknown) {
      // Official agent only accepts bare JSON; length-prefixed is only for explicit config, not auto
      return rawCodec.encode(value);
    },
    decode(buf: Buffer) {
      if (!locked) {
        locked = detectFraming(buf);
      }
      if (locked === 'length-prefixed') {
        return lengthPrefixedCodec.decode(buf);
      }
      return rawCodec.decode(buf);
    },
  };
}

/**
 * Create a **server mirror** codec (independent new instance per incoming connection), for mock/server use only.
 *
 * Difference from the client-side {@link createAutoCodec}:
 *   - The client is the initiator, knows the official agent only accepts bare JSON, so encode is fixed to raw;
 *   - The server is the responder, must "speak the client's language": lock the format based on the first byte
 *     of the first received request, then use the locked format for both decode and encode — if the client sends
 *     length-prefixed, respond with length-prefixed; if the client sends bare JSON, respond with bare JSON.
 *
 * This way the same mock daemon can serve both:
 *   - Real device form clients (auto + bare JSON + no request_id return, serial)
 *   - Enhanced form clients (length-prefixed + request_id return, multiplexed)
 */
export function createMirrorCodec(): Codec & { detected: 'raw' | 'length-prefixed' | null } {
  let locked: 'raw' | 'length-prefixed' | null = null;

  const active = (): Codec => (locked === 'length-prefixed' ? lengthPrefixedCodec : rawCodec);

  return {
    name: 'mirror',
    frameDelimited: false,
    get detected() {
      return locked;
    },
    encode(value: unknown) {
      // In theory, encode always happens after at least one request has been decoded (receive before send);
      // in the extreme case where no lock has been established yet, respond with bare JSON (official form default).
      return active().encode(value);
    },
    decode(buf: Buffer) {
      if (!locked) {
        locked = detectFraming(buf);
      }
      return active().decode(buf);
    },
  };
}
