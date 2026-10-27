/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { homedir } from 'os';
import { AppConfig, CryptoConstants } from '../auth-config.js';
import { DefinedError } from './errors.js';
import { getCliDataDir } from '../../utils/cli-data-dir.js';

interface WrappedDekData {
  version: number;
  algorithm: 'aes-256-gcm';
  kekId: string;
  encryptedDek: string; // Base64
  iv: string; // Base64
  authTag: string; // Base64
  timeStamp: number;
}

export interface EncryptedBlob {
  version: number;
  algorithm: 'aes-256-gcm';
  ciphertext: string; // Base64
  iv: string; // Base64
  authTag: string; // Base64
  timeStamp: number;
}

const algorithm = CryptoConstants.ALGORITHM;
const ivLength = CryptoConstants.IV_LENGTH;
const kekLength = CryptoConstants.KEY_LENGTH; // 256 bits
const dekLength = CryptoConstants.KEY_LENGTH;
const rootKeyIds = CryptoConstants.KEK_VERSIONS;

// 隔离存储
const configPath =
  process.env.DEVECO_CLI_DATA_DIR
    ? getCliDataDir()
    : path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
const keyDirPath = path.join(
  homedir(),
  '.local',
  'share',
  AppConfig.APP_NAME,
  'keys'
);
const wrappedDekPath = path.join(configPath, AppConfig.KEY_FILE_NAME);

function getPermissionHint(dirPath: string): string {
  const platform = os.platform();
  if (platform === 'win32') {
    return `Permission denied. Please run as administrator or grant write permission to ${dirPath}.`;
  }
  return `Permission denied. You can try: sudo chown -R $(whoami) ${dirPath}`;
}

function getRootKeyPath(keyId: string): string {
  return path.join(keyDirPath, `${keyId}.bin`);
}

function ensureDirectories(): void {
  if (!fs.existsSync(configPath)) {
    try {
      fs.mkdirSync(configPath, { recursive: true, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new DefinedError(getPermissionHint(configPath));
      }
      throw err;
    }
  }
  if (!fs.existsSync(keyDirPath)) {
    try {
      fs.mkdirSync(keyDirPath, { recursive: true, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new DefinedError(getPermissionHint(path.dirname(keyDirPath)));
      }
      throw err;
    }
  }
}

function ensureRootKeys(): void {
  ensureDirectories();
  for (const keyId of rootKeyIds) {
    const filePath = getRootKeyPath(keyId);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, crypto.randomBytes(kekLength), { mode: 0o600 });
    }
  }
}

function loadRootKey(keyId: string): Buffer {
  if (!rootKeyIds.some((id) => id === keyId)) {
    throw new Error(`Invalid kekId: ${keyId}`);
  }
  ensureRootKeys();
  const filePath = getRootKeyPath(keyId);
  const key = fs.readFileSync(filePath);
  if (key.length === kekLength) {
    return key;
  }
  const next = crypto.randomBytes(kekLength);
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  return next;
}

function wrapDekWithKek(dek: Buffer, kekId: string): WrappedDekData {
  const iv = crypto.randomBytes(ivLength);
  const kek = loadRootKey(kekId);
  const cipher = crypto.createCipheriv(algorithm, kek, iv) as crypto.CipherGCM;
  const encryptedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm,
    kekId,
    encryptedDek: encryptedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    timeStamp: Date.now(),
  };
}

function unwrapDek(wrapped: WrappedDekData, kek: Buffer): Buffer {
  return decryptAesGcm(
    Buffer.from(wrapped.encryptedDek, 'base64'),
    kek,
    wrapped.iv,
    wrapped.authTag
  );
}

function decryptAesGcm(
  ciphertext: Buffer,
  key: Buffer,
  iv: string,
  authTag: string
): Buffer {
  const decipher = crypto.createDecipheriv(
    algorithm,
    key,
    Buffer.from(iv, 'base64')
  ) as crypto.DecipherGCM;
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptBlobWithDek(blob: EncryptedBlob, dek: Buffer): string {
  return decryptAesGcm(
    Buffer.from(blob.ciphertext, 'base64'),
    dek,
    blob.iv,
    blob.authTag
  ).toString('utf8');
}

function ensureWrappedDek(): void {
  ensureRootKeys();
  if (fs.existsSync(wrappedDekPath)) {
    return;
  }
  const dek = crypto.randomBytes(dekLength);
  const wrapped = wrapDekWithKek(dek, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(wrapped, null, 2), {
    mode: 0o600,
  });
}

function loadDek(): Buffer {
  ensureWrappedDek();
  const wrapped = JSON.parse(
    fs.readFileSync(wrappedDekPath, 'utf8')
  ) as WrappedDekData;
  const dek = unwrapDek(wrapped, loadRootKey(wrapped.kekId));
  if (dek.length === dekLength) {
    return dek;
  }
  const next = crypto.randomBytes(dekLength);
  const nextWrapped = wrapDekWithKek(next, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(nextWrapped, null, 2), {
    mode: 0o600,
  });
  return next;
}

function rebuildKeyMaterials(): void {
  ensureDirectories();
  for (const keyId of rootKeyIds) {
    const filePath = getRootKeyPath(keyId);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, crypto.randomBytes(kekLength), {
        mode: 0o600,
      });
    }
  }
  if (fs.existsSync(wrappedDekPath)) {
    return;
  }
  const dek = crypto.randomBytes(dekLength);
  const wrapped = wrapDekWithKek(dek, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(wrapped, null, 2), {
    mode: 0o600,
  });
}

export function encryptForLocalStorage(plaintext: string): EncryptedBlob {
  const dek = loadDek();
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, dek, iv) as crypto.CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    timeStamp: Date.now(),
  };
}

export function decryptForLocalStorage(blob: EncryptedBlob): string {
  try {
    return decryptBlobWithDek(blob, loadDek());
  } catch {
    rebuildKeyMaterials();
    throw new Error('Failed to decrypt local ciphertext');
  }
}

/**
 * 解密另一个 DevEco 进程配置目录中的凭据。
 * 此方法严格只读，不会创建或修复外部进程的密钥材料。
 */
export function decryptForLocalStorageFromDirectory(
  blob: EncryptedBlob,
  externalConfigPath: string
): string {
  const externalWrappedDekPath = path.join(
    externalConfigPath,
    AppConfig.KEY_FILE_NAME
  );
  const wrapped = JSON.parse(
    fs.readFileSync(externalWrappedDekPath, 'utf8')
  ) as WrappedDekData;
  if (!rootKeyIds.some((id) => id === wrapped.kekId)) {
    throw new Error(`Invalid kekId: ${wrapped.kekId}`);
  }
  const rootKeyPath = path.join(
    externalConfigPath,
    'keys',
    `${wrapped.kekId}.bin`
  );
  const resolved = path.resolve(rootKeyPath);
  const resolvedBase = path.resolve(path.join(externalConfigPath, 'keys'));
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error('kekId resolves outside the keys directory');
  }
  const kek = fs.readFileSync(resolved);
  if (kek.length !== kekLength) {
    throw new Error('Invalid external root key');
  }

  const dek = unwrapDek(wrapped, kek);
  if (dek.length !== dekLength) {
    throw new Error('Invalid external data encryption key');
  }
  return decryptBlobWithDek(blob, dek);
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EncryptedBlob>;
  return (
    candidate.algorithm === 'aes-256-gcm' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.authTag === 'string'
  );
}

export * as LocalCrypto from './local-crypto.js';
