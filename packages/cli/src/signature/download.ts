/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { httpClient } from '../utils/http-client.js';
import {
  CertConstants,
  SignatureErrorMessages,
  SignatureHttpStatusCode,
  SignatureResponseSignals,
} from '../config/signature.js';

function assertSafeDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Download URL must use HTTPS: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new Error(`Download URL points to internal/private address: ${hostname}`);
  }
}

/**
 * 下载远端文件到本地。
 * - 4xx/5xx 不抛错：若 403 且 reason phrase = Openproxy 标记 → 网络错误（场景1）；
 *   否则按状态码非 200 → 下载失败。
 *
 * JAR 的 downloadFile 用 IOException msg.contains("403 Openproxy_Blocked_URL_list")，
 * 该串 = statusCode + " " + reasonPhrase。CLI 拆成 statusCode + statusText 判定。
 */
export async function downloadFile(
  downloadUrl: string,
  filePath: string,
  expectedSha256?: string
): Promise<void> {
  assertSafeDownloadUrl(downloadUrl);
  const { statusCode, statusText, buffer } = await httpClient.getBinaryAllowFailure(
    downloadUrl,
    { timeout: CertConstants.DOWNLOAD_CONNECT_TIMEOUT_MS }
  );
  if (statusCode !== 200) {
    if (
      statusCode === SignatureHttpStatusCode.FORBIDDEN &&
      statusText === SignatureResponseSignals.OPENPROXY_BLOCKED_URL
    ) {
      throw new Error(SignatureErrorMessages.ERR_CERT_NETWORK_ERROR);
    }
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }
  if (expectedSha256) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${filePath}: expected ${expectedSha256.toLowerCase()}, got ${actual}`
      );
    }
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, buffer);
}
