/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'crypto';
import { timingSafeEqual } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SkillsApiConstants } from '../config/constants.js';
import { httpClient } from '../utils/http-client.js';
import { ChecksumData } from '../types/skills.js';
import { fetchSkillChecksum } from './api.js';
import { assertSafeSkillName } from './skill-name.js';

const fsp = fs.promises;

/** 校验解压路径，越出父目录时抛出错误。 */
function assertWithin(parent: string, child: string): void {
  const resolved = path.resolve(child);
  const root = path.resolve(parent);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${child}.`);
  }
}

/**
 * 将相对路径按 process.cwd() 解析为绝对路径；绝对路径原样返回。
 */
export function resolvePath(pathToResolve: string): string {
  return path.isAbsolute(pathToResolve)
    ? pathToResolve
    : path.resolve(process.cwd(), pathToResolve);
}

/**
 * @returns Buffer 的 SHA256 哈希值，使用小写十六进制格式。
 */
export function calculateSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 校验 ZIP 文件大小和 SHA256 哈希值。
 * @throws 大小或哈希值与 expected 不符时抛出错误。
 */
export async function verifyZipIntegrity(
  zipBuffer: Buffer,
  expected: ChecksumData
): Promise<void> {
  const actualSize = zipBuffer.length;
  if (actualSize !== expected.size) {
    throw new Error(`Skill zip integrity verification failed: Size mismatch`);
  }

  const actualSha256 = calculateSha256(zipBuffer);
  const expectedSha256 = expected.sha256.toLowerCase();

  const actualBuf = Buffer.from(actualSha256, 'hex');
  const expectedBuf = Buffer.from(expectedSha256, 'hex');
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  ) {
    throw new Error(`Skill zip integrity verification failed: SHA256 mismatch`);
  }
}

/**
 * 从技能市场下载 Skill，并校验文件大小和 SHA256 哈希值。
 * @returns 校验通过的 ZIP 数据。
 * @throws 名称无效、下载失败或校验失败时抛出错误。
 */
export async function downloadSkill(skillName: string): Promise<Buffer> {
  assertSafeSkillName(skillName);

  const url = `${SkillsApiConstants.SKILL_API_BASE}/${skillName}/install?format=zip`;
  const buffer = await httpClient.getBinary(url);

  const checksum = await fetchSkillChecksum(skillName);

  await verifyZipIntegrity(buffer, checksum);

  return buffer;
}

/**
 * 将 ZIP 解压到 targetDir/skillName，覆盖已有文件。
 * @throws 名称无效、条目路径越界或解压失败时抛出错误。
 */
export async function extractSkill(
  zipBuffer: Buffer,
  targetDir: string,
  skillName: string
): Promise<void> {
  assertSafeSkillName(skillName);

  // Loaded on demand; the runtime entry does not need an archive reader at startup.
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  try {
    await fsp.stat(targetDir);
  } catch {
    await fsp.mkdir(targetDir, { recursive: true });
  }

  const extractPath = path.join(targetDir, skillName);

  assertWithin(targetDir, extractPath);

  for (const entry of entries) {
    const dest = path.join(extractPath, entry.entryName);
    assertWithin(extractPath, dest);
  }

  zip.extractAllTo(extractPath, true);
}

/**
 * 从当前模块目录向上查找包内的 skills/deveco-cli/ 目录。
 * @returns 首个匹配目录的绝对路径。
 * @throws 未找到目录时抛出错误。
 */
export function resolveBundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;

  while (true) {
    const candidate = path.join(dir, 'skills', 'deveco-cli');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    'skills/deveco-cli directory not found in deveco-cli package. Reinstall deveco-cli.'
  );
}
