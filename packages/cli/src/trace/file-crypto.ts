/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 打点文件落盘加密：AES-256-GCM，每条事件一行一个密文 blob。
 * 密钥由本机独立随机密钥（trace-file-secret，与上传的安装标识 uid 完全无关）派生，
 * 该密钥文件仅存在于本机数据目录、永不随事件上报；跨进程解密
 * （CLI 调度器 / 后台上传进程）通过读取同一密钥文件保持一致。
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_SALT = 'deveco-cli-trace-file';
const SECRET_FILENAME = 'trace-file-secret';
const SECRET_BYTES = 32;

/** 读取落盘的本地密钥（base64，32 字节）；文件缺失或损坏返回 null。 */
function readStoredSecret(file: string): string | null {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value) {
      return null;
    }
    const raw = Buffer.from(value, 'base64');
    return raw.length === SECRET_BYTES ? value : null;
  } catch {
    return null;
  }
}

/**
 * 解析本机打点文件密钥（不随事件上报）：
 * 初始化时随机生成 32 字节密钥并写入 `<storageDir>/trace-file-secret`；
 * 已存在则复用；并发竞争（wx 失败）时复用先写入者的密钥；写盘失败返回进程内密钥，下次进程重试。
 */
export function resolveTraceFileKey(storageDir: string): Buffer {
  const file = path.join(storageDir, SECRET_FILENAME);
  const existing = readStoredSecret(file);
  if (existing) {
    return createTraceFileKey(existing);
  }
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64');
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    try {
      fs.writeFileSync(file, secret, { flag: 'wx' });
    } catch {
      // 并发进程已先写入：复用其密钥；内容损坏则覆盖重写
      const winner = readStoredSecret(file);
      if (winner) {
        return createTraceFileKey(winner);
      }
      fs.writeFileSync(file, secret);
    }
  } catch {
    // 目录或写盘失败（只读 fs 等）：返回进程内密钥，本次不落盘，下次进程重新生成
  }
  return createTraceFileKey(secret);
}

export function createTraceFileKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(KEY_SALT).update(secret).digest();
}

export interface TraceFileCipherBlob {
  version: 1;
  algorithm: 'aes-256-gcm';
  /** Base64 */
  ciphertext: string;
  /** Base64 */
  iv: string;
  /** Base64 */
  authTag: string;
}

/** 加密单行明文事件，返回一行密文 blob 的 JSON 字符串。 */
export function encryptTraceLine(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const blob: TraceFileCipherBlob = {
    version: 1,
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
  return JSON.stringify(blob);
}

/**
 * 解密一行密文 blob，返回明文事件 JSON；无法解析/校验失败返回 null。
 * 非 blob 的历史明文行（加密改造前的调试期遗留）原样放行。
 */
export function decryptTraceLine(line: string, key: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isTraceFileCipherBlob(parsed)) {
    return line;
  }
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function isTraceFileCipherBlob(value: unknown): value is TraceFileCipherBlob {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TraceFileCipherBlob>;
  return (
    candidate.version === 1 &&
    candidate.algorithm === ALGORITHM &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.authTag === 'string'
  );
}
