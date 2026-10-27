/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readProblemFile } from '../../problem-package/files.js';
import { digest } from '../../quality/evidence.js';
import type { ToolProvider } from '../../toolchain/tool-provider.js';
import { decodeAPIText, positiveAPIInteger } from './log.js';
import { API_LIMITS, type APISDK, type APISource } from './types.js';

function metadata(bytes: Buffer, nested: boolean) {
  const input = JSON.parse(decodeAPIText(bytes, API_LIMITS.metadataBytes));
  const value = nested ? input.data : input;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (typeof value.apiVersion !== 'string' && typeof value.apiVersion !== 'number')) { throw new Error('API_SDK_METADATA_UNSUPPORTED'); }
  const apiVersion = positiveAPIInteger(String(value.apiVersion));
  if (apiVersion < 9 || apiVersion > 1000 || typeof value.platformVersion !== 'string' ||
    typeof value.version !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value.platformVersion) ||
    !/^\d+(?:\.\d+){1,3}$/.test(value.version)) { throw new Error('API_SDK_METADATA_UNSUPPORTED'); }
  return { apiVersion, platformVersion: value.platformVersion, packageVersion: value.version };
}
function category(message: string): string {
  const first = message.split('.')[0].trim().toLowerCase();
  const names: Record<string, string> = { 'no memory': 'no-memory', 'operation not allowed': 'operation-not-allowed',
    'permission denied': 'permission-denied', 'parameter error': 'parameter-error', 'unsupported format': 'unsupported-format',
    'system capability not supported': 'not-supported', 'service died': 'service-died', 'timeout': 'timeout' };
  return Object.hasOwn(names, first) ? names[first] : 'unclassified';
}
function throwsDeclaration(text: string, source: APISource, codes: Set<number>): APISDK['matches'][number] | null {
  if (!/^\s*\*\s*@throws\s*\{\s*BusinessError\s*\}/.test(text)) { return null; }
  const match = /^\s*\*\s*@throws\s*\{\s*BusinessError\s*\}\s*([1-9][0-9]*)\s+(?:-\s*)?(.+?)\s*$/.exec(text);
  if (!match || Buffer.byteLength(match[2]) > 4096) { throw new Error('API_SDK_DECLARATION_UNSUPPORTED'); }
  const code = positiveAPIInteger(match[1]);
  return codes.has(code) ? { code, category: category(match[2]), messageSha256: digest(match[2]), source } : null;
}
async function matches(bytes: Buffer, codes: Set<number>, signal: AbortSignal): Promise<APISDK['matches']> {
  decodeAPIText(bytes, API_LIMITS.sdkBytes);
  const result: APISDK['matches'] = [];
  let offset = 0, lines = 0, inComment = false;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > API_LIMITS.lines || raw.length > API_LIMITS.lineBytes) { throw new Error('API_SDK_LINE_LIMIT'); }
    const text = raw.toString('utf8').replace(/\r?\n$/, '');
    if (/^\s*\/\*\*/.test(text)) {
      if (inComment) { throw new Error('API_SDK_COMMENT_UNSUPPORTED'); }
      inComment = true;
    }
    const entry = inComment ? throwsDeclaration(text, { line: lines, offset, bytes: raw.length, sha256: digest(raw) }, codes) : null;
    if (entry) {
      if (result.length === API_LIMITS.sdkMatches) { throw new Error('API_SDK_MATCH_LIMIT'); }
      result.push(entry);
    }
    if (inComment && text.includes('*/')) { inComment = false; }
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted();
  if (inComment) { throw new Error('API_SDK_COMMENT_UNSUPPORTED'); }
  return result;
}
export async function readAPISDK(module: string, codes: Set<number>, provider: ToolProvider, signal: AbortSignal): Promise<APISDK> {
  try {
    signal.throwIfAborted();
    if (!/^@ohos\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(module) || module.endsWith('.d.ts')) { throw new Error('API_SDK_MODULE_UNSUPPORTED'); }
    const base = join(provider.sdkPath, 'default'), ets = join(base, 'openharmony/ets');
    const sdkBytes = await readProblemFile(join(base, 'sdk-pkg.json'), API_LIMITS.metadataBytes);
    signal.throwIfAborted();
    const etsBytes = await readProblemFile(join(ets, 'oh-uni-package.json'), API_LIMITS.metadataBytes);
    const sdk = metadata(sdkBytes, true), declarationPackage = metadata(etsBytes, false);
    if (JSON.stringify(sdk) !== JSON.stringify(declarationPackage)) { throw new Error('API_SDK_IDENTITY_CONFLICT'); }
    signal.throwIfAborted();
    const bytes = await readProblemFile(join(ets, 'api', module + '.d.ts'), API_LIMITS.sdkBytes);
    const entries = await matches(bytes, codes, signal);
    return { status: entries.length ? 'declaration-candidates' : 'code-not-declared', module, ...sdk,
      declarations: { sha256: digest(bytes), bytes: bytes.length },
      metadata: [{ role: 'sdk', sha256: digest(sdkBytes), bytes: sdkBytes.length }, { role: 'ets', sha256: digest(etsBytes), bytes: etsBytes.length }],
      matches: entries, association: 'module-jsdoc-only-not-callable-binding' };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith('API_SDK_')) { throw error; }
    throw new Error('API_SDK_INPUT_UNSAFE', { cause: error });
  }
}
