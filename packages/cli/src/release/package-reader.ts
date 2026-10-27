/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { digest } from '../quality/evidence.js';
import { assertPublicValue } from '../tasks/task-state.js';
import type { ArchiveEntry, PackageEvidence, ReleaseFile } from './types.js';

const certificate = /(?:^|\/)[^/]*\.(?:pem|key|p12|pfx|cer|crt|keystore)$/i;
interface ArchiveBudget { bytes: number; entries: number }
function entryName(name: string) {
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || name.includes('\\') || name.includes('\0') || name.includes(':') ||
    parts.some((p) => !p || p === '..' || p === '.')) { throw new Error('Unsafe Release archive entry'); }
}
async function entries(bytes: Buffer, signal: AbortSignal, budget: ArchiveBudget, prefix = '', depth = 0): Promise<ArchiveEntry[]> {
  if (depth > 3) { throw new Error('Nested Release archives exceed depth 3'); }
  // Loaded on demand; the runtime entry does not need an archive reader at startup.
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(bytes), seen = new Set<string>(), output: ArchiveEntry[] = [];
  for (const entry of zip.getEntries()) {
    signal.throwIfAborted(); entryName(entry.entryName);
    if (seen.has(entry.entryName)) { throw new Error('Duplicate Release archive entry'); } seen.add(entry.entryName);
    if (++budget.entries > 10_000 || entry.header.flags & 1 || entry.header.size > 32 * 1024 * 1024 ||
      (budget.bytes += entry.header.size) > 64 * 1024 * 1024) { throw new Error('Encrypted or oversized Release archive'); }
    if (entry.isDirectory) { continue; }
    const path = `${prefix}${entry.entryName}`;
    if (certificate.test(entry.entryName)) { output.push({ path, size: entry.header.size, sha256: null, bytes: null }); continue; }
    const data = entry.getData();
    if (data.length !== entry.header.size) { throw new Error('Release archive size mismatch'); }
    output.push({ path, size: data.length, sha256: digest(data), bytes: data });
    if (/\.(?:hap|har|hsp|app)$/.test(entry.entryName)) { output.push(...await entries(data, signal, budget, `${path}!/`, depth + 1)); }
  }
  return output;
}
function moduleMetadata(entry: ArchiveEntry): Record<string, unknown> {
  if (entry.size > 1024 * 1024) { throw new Error('Packaged module metadata exceeds 1 MiB'); }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes!));
  assertPublicValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Packaged module metadata must be an object'); }
  return value as Record<string, unknown>;
}
export async function readPackage(file: ReleaseFile, signal: AbortSignal, budget: ArchiveBudget): Promise<PackageEvidence> {
  const content = await entries(file.bytes, signal, budget);
  // A HAP carries module.json at the root; an APP carries one per nested HAP.
  const direct = content.find((e) => e.path === 'module.json' && e.bytes);
  const sources = direct ? [direct] :
    content.filter((e) => /^[^/]+\.(?:hap|hsp|har)!\/module\.json$/.test(e.path) && e.bytes);
  return { file, entries: content, modules: sources.map(moduleMetadata) };
}
