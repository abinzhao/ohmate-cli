/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, ExecutionContext } from '../runtime/types.js';

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ignored = new Set(['node_modules', 'oh_modules', 'build', 'dist', 'artifacts', '.git', '.hvigor', '.ohpm', '.test', '.DS_Store']);
export const privateEvidenceName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
export interface FileEvidence { path: string; sha256: string; size: number; mtimeMs: number; ctimeMs: number; }
function inside(root: string, file: string) {
  const name = relative(root, file);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}
export async function evidenceFile(root: string, file: string, maxBytes = 512 * 1024 * 1024): Promise<FileEvidence> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 512 * 1024 * 1024) { throw new Error('Invalid evidence byte limit'); }
  if (!inside(root, resolve(file))) { throw new Error('Evidence escapes the selected root'); }
  const parts = relative(root, file).split(sep);
  let parent = root;
  for (const part of parts) {
    parent = join(parent, part);
    if ((await lstat(parent)).isSymbolicLink()) { throw new Error('Symlink evidence is unsupported'); }
  }
  const initial = await lstat(file);
  if (!initial.isFile() || initial.nlink !== 1 || initial.size > maxBytes) { throw new Error('Evidence is not a bounded regular file'); }
  // Nonblocking open also rejects a FIFO swapped in after the regular-file check.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) { throw new Error('Evidence is not a bounded regular file'); }
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) { break; }
      total += bytesRead; hash.update(buffer.subarray(0, bytesRead));
      if (total > before.size) { throw new Error('Evidence changed during reading'); }
    }
    const after = await handle.stat(), current = await lstat(file);
    if (total !== before.size || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) { throw new Error('Evidence changed during reading'); }
    return { path: relative(root, file).split(sep).join('/'), sha256: hash.digest('hex'),
      size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
  } finally { await handle.close(); }
}
export async function inputEvidence(context: ExecutionContext) {
  const root = context.projectRoot ?? context.cwd, files: FileEvidence[] = [], skipped: string[] = [], queue = [root];
  let count = 0, bytes = 0;
  while (queue.length) {
    context.abortSignal.throwIfAborted();
    const parent = queue.shift()!;
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(parent, entry.name);
      if (ignored.has(entry.name) || file === context.dataDir) { continue; }
      if (privateEvidenceName.test(entry.name)) { skipped.push(relative(root, file)); continue; }
      if (++count > 10_000) { throw new Error('Build input evidence exceeds 10000 entries'); }
      if (entry.isDirectory()) { queue.push(file); continue; }
      const evidence = await evidenceFile(root, file);
      if (evidence.size > 8 * 1024 * 1024 || (bytes += evidence.size) > 64 * 1024 * 1024) { throw new Error('Build input evidence exceeds the content budget'); }
      files.push(evidence);
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}
export async function changedInputs(context: ExecutionContext, files: FileEvidence[]) {
  const root = context.projectRoot ?? context.cwd, changed: string[] = [];
  for (const file of files) {
    const current = await evidenceFile(root, join(root, file.path)).catch(() => null);
    if (current?.sha256 !== file.sha256) { changed.push(file.path); }
  }
  return changed;
}
export async function saveEvidenceBytes(context: ExecutionContext, kind: string, text: string | Uint8Array, extension = 'json'): Promise<Artifact> {
  const root = resolve(context.artifactStore.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) { throw new Error('Unsafe quality evidence directory'); }
  const file = join(root, `${kind}-${randomUUID()}.${extension}`);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  return { path: file, sha256: digest(text), kind };
}
export function saveEvidence(context: ExecutionContext, kind: string, value: unknown): Promise<Artifact> {
  return saveEvidenceBytes(context, kind, JSON.stringify(value, null, 2));
}
