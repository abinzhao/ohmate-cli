/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

// ==========================================
// 1. 常量定义
// ==========================================
const COMPONENT_COUNT = 3;
const KEY_LENGTH = 16;
const ITERATE_COUNT = 10000;
const ROOT_FOLDER = 'material';

// 16 字节固定分片
const FIXED_COMPONENT = new Uint8Array([
  0x31, 0xf3, 0x09, 0x73, 0xd6, 0xaf, 0x5b, 0xb8,
  0xd3, 0xbe, 0xb1, 0x58, 0x65, 0x83, 0xc0, 0x77,
]);

const ALGORITHM = 'aes-128-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
// Rust AesGcmKit::encrypt 格式: [length(4)][nonce(12)][ciphertext][authTag(16)]
const CONTENT_LENGTH_TAG = 4;

// ==========================================
// 2. 工具与加密辅助函数
// ==========================================

/** 生成指定长度的随机字节 */
function generateRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

/** 生成指定长度的随机 Hex 字符串 */
function generateRandomHex(byteLength: number): string {
  return randomBytes(byteLength).toString('hex');
}

/** 逐字节 XOR 多个字节数组 */
function xorArrays(...arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) {
    return new Uint8Array(0);
  }
  const length = arrays[0].length;
  const result = new Uint8Array(length);

  for (let i = 0; i < length; i++) {
    let byteVal = 0;
    for (const arr of arrays) {
      byteVal ^= arr[i];
    }
    result[i] = byteVal;
  }
  return result;
}

/** 密钥派生：components + FIXED_COMPONENT -> derivedKey */
function deriveRootKey(
  components: Uint8Array[],
  salt: Uint8Array,
  iterations: number = ITERATE_COUNT,
  keyLength: number = KEY_LENGTH
): Uint8Array {
  // 1. 加入固定分片并逐字节 XOR
  const fullComponents = [...components, FIXED_COMPONENT];
  const xorResult = xorArrays(...fullComponents);

  // 2. 转换为 UTF-8 字符串（损耗性转换，保持与规格一致）
  const passwordString = Buffer.from(xorResult).toString('utf8');
  const passwordBytes = Buffer.from(passwordString, 'utf8');

  // 3. PBKDF2-HMAC-SHA256 派生
  const derivedKeyBuffer = pbkdf2Sync(
    passwordBytes,
    salt,
    iterations,
    keyLength,
    'sha256'
  );

  return new Uint8Array(derivedKeyBuffer);
}

/**
 * AES-128-GCM 加密：输出 Buffer [length(4) + IV(12) + Ciphertext + AuthTag(16)]
 * @param key 密钥
 * @param plaintext 明文
 * @returns 加密后的 Buffer
 */
function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Rust AesGcmKit::encrypt 格式: [length(4)][nonce(12)][ciphertext][authTag(16)]
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);
  const length = ciphertextWithTag.length;

  // 使用 Buffer 手动构建与 Rust 一致的数据布局
  const result = Buffer.alloc(CONTENT_LENGTH_TAG + IV_LENGTH + ciphertextWithTag.length);

  // 写入 4 字节 length (big-endian)
  result.writeUInt32BE(length, 0);

  // 写入 12 字节 nonce
  iv.copy(result, CONTENT_LENGTH_TAG);

  // 写入 ciphertext + authTag
  ciphertextWithTag.copy(result, CONTENT_LENGTH_TAG + IV_LENGTH);
  return result;
}

/** 
 * AES-128-GCM 解密：输入 Buffer [length(4) + IV(12) + Ciphertext + AuthTag(16)]
 *  与 Rust AesGcmKit::decrypt 格式兼容
 */
function aesGcmDecrypt(key: Uint8Array, ciphertext: Buffer): Buffer {
  if (ciphertext.length < CONTENT_LENGTH_TAG + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }

  // 读取长度字段
  const bodyLength = ciphertext.readUInt32BE(0);

  // 提取 nonce
  const iv = ciphertext.subarray(CONTENT_LENGTH_TAG, CONTENT_LENGTH_TAG + IV_LENGTH);

  // 提取 ciphertext + authTag
  const ciphertextWithTag = ciphertext.subarray(
    CONTENT_LENGTH_TAG + IV_LENGTH,
    CONTENT_LENGTH_TAG + IV_LENGTH + bodyLength,
  );

  if (ciphertextWithTag.length < AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short for auth tag');
  }

  const encrypted = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ==========================================
// 3. 文件系统辅助函数
// ==========================================

async function deleteFolderRecursive(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略目录不存在的情况
  }
}

async function readUniqueFile(dirPath: string): Promise<Buffer> {
  const files = await fs.readdir(dirPath);
  const filtered = files.filter((f) => f !== '.DS_Store');
  if (filtered.length !== 1) {
    throw new Error(`Expected exactly 1 file in ${dirPath}, but found ${filtered.length} (filtered from ${files.length})`);
  }
  return fs.readFile(join(dirPath, filtered[0]));
}

async function saveToRandomFile(dirPath: string, data: Uint8Array): Promise<string> {
  const filename = generateRandomHex(KEY_LENGTH); // 16字节 -> 32位 hex
  const filePath = join(dirPath, filename);
  await fs.writeFile(filePath, data, { mode: 0o600 });
  return filename;
}

// ==========================================
// 4. KeyManager 核心逻辑实现
// ==========================================

export class KeyManager {
  private static keyChain: Promise<void> = Promise.resolve();

  /**
   * 生成模式：创建并持久化密钥材料，返回 16 字节 workKey
   */
  private static async generateMaterial(baseDir: string): Promise<Uint8Array> {
    const materialDir = join(baseDir, ROOT_FOLDER);

    // 1. 删除旧的 material 目录结构
    await deleteFolderRecursive(materialDir);

    // 2. 创建所需目录
    const acDir = join(materialDir, 'ac');
    const ceDir = join(materialDir, 'ce');
    await fs.mkdir(acDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(ceDir, { recursive: true, mode: 0o700 });

    for (let i = 0; i < COMPONENT_COUNT; i++) {
      await fs.mkdir(join(materialDir, 'fd', String(i)), { recursive: true, mode: 0o700 });
    }

    // 3. 生成随机数
    const salt = generateRandomBytes(KEY_LENGTH);
    const components: Uint8Array[] = [];
    for (let i = 0; i < COMPONENT_COUNT; i++) {
      components.push(generateRandomBytes(KEY_LENGTH));
    }
    const workKey = generateRandomBytes(KEY_LENGTH);

    // 4. 派生 derivedKey
    const derivedKey = deriveRootKey(components, salt);

    // 5. 使用 derivedKey 加密 workKey 得到 workKeyMaterial
    const workKeyMaterial = aesGcmEncrypt(derivedKey, workKey);

    // 6. 存储到文件系统
    await saveToRandomFile(acDir, salt);
    await saveToRandomFile(ceDir, workKeyMaterial);
    for (let i = 0; i < COMPONENT_COUNT; i++) {
      const fdSubDir = join(materialDir, 'fd', String(i));
      await saveToRandomFile(fdSubDir, components[i]);
    }

    // 7. 返回明文 workKey
    return workKey;
  }

  /**
   * 读取模式：读取本地密钥材料并解密获得 workKey
   */
  private static async readMaterial(baseDir: string): Promise<Uint8Array> {
    const materialDir = join(baseDir, ROOT_FOLDER);

    // 1. 读取 salt
    const acDir = join(materialDir, 'ac');
    const salt = new Uint8Array(await readUniqueFile(acDir));

    // 2. 读取 components
    const components: Uint8Array[] = [];
    for (let i = 0; i < COMPONENT_COUNT; i++) {
      const fdSubDir = join(materialDir, 'fd', String(i));
      const compData = await readUniqueFile(fdSubDir);
      components.push(new Uint8Array(compData));
    }

    // 3. 读取 workKeyMaterial
    const ceDir = join(materialDir, 'ce');
    const workKeyMaterial = await readUniqueFile(ceDir);

    // 4. 重新派生 derivedKey
    const derivedKey = deriveRootKey(components, salt);

    // 5. 解密获得 workKey
    const workKeyBuffer = aesGcmDecrypt(derivedKey, workKeyMaterial);

    return new Uint8Array(workKeyBuffer);
  }

  /**
   * 辅助方法：从 storeFile 路径推导 material 目录并获取 workKey
   * 如果 material 不存在或无法读取，自动重新生成
   */
  private static async getStoreKey(
    storeFile: string
  ): Promise<Uint8Array> {
    let release!: () => void;
    const previous = this.keyChain;
    this.keyChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const baseDir = dirname(storeFile);
      try {
        return await this.readMaterial(baseDir);
      } catch {
        return await this.generateMaterial(baseDir);
      }
    } finally {
      release();
    }
  }

  /**
   * 加密明文密码，返回 hex 格式密文
   */
  public static async encryptedPassword(
    password: string,
    storeFile: string
  ): Promise<string> {
    const workKey = await this.getStoreKey(storeFile);
    const passwordBytes = Buffer.from(password, 'utf8');

    const encryptedBuffer = aesGcmEncrypt(workKey, passwordBytes);
    return encryptedBuffer.toString('hex');
  }

  /**
   * 解密 hex 格式密文，返回明文密码
   */
  public static async decryptPassword(
    encryptedHex: string,
    storeFile: string
  ): Promise<string> {
    if (!encryptedHex) {
      return '';
    }

    const workKey = await this.getStoreKey(storeFile);
    const encryptedBuffer = Buffer.from(encryptedHex, 'hex');

    const decryptedBuffer = aesGcmDecrypt(workKey, encryptedBuffer);
    return decryptedBuffer.toString('utf8');
  }
}