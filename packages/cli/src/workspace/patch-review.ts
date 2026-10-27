/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { sha256 } from '../agent/context-files.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { patchPath } from './path-guard.js';
import { patchSchema, type PatchInput, type Snapshot } from './patch-types.js';

function lines(text: string) {
  if (!text) { return []; }
  const result = text.split('\n');
  if (result.at(-1) === '') { result.pop(); }
  else { result[result.length - 1] += '\n\\ No newline at end of file'; }
  return result;
}
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const old = lines(before ?? ''), next = lines(after ?? '');
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) { prefix++; }
  while (suffix < Math.min(old.length, next.length) - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) { suffix++; }
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const oldEnd = old.length - suffix, nextEnd = next.length - suffix;
  const body = [...old.slice(start, prefix).map((line) => ` ${line}`),
    ...old.slice(prefix, oldEnd).map((line) => `-${line}`), ...next.slice(prefix, nextEnd).map((line) => `+${line}`),
    ...old.slice(oldEnd, oldEnd + tail).map((line) => ` ${line}`)];
  const oldCount = oldEnd + tail - start, nextCount = nextEnd + tail - start;
  return `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n` +
    `@@ -${oldCount ? start + 1 : start},${oldCount} +${nextCount ? start + 1 : start},${nextCount} @@\n${body.join('\n')}\n`;
}

export async function readSnapshot(context: ExecutionContext, path: string): Promise<Snapshot> {
  const file = await patchPath(context.projectRoot ?? context.cwd, path, context.dataDir);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { path, text: null, oldHash: null, mode: 0o644 }; } throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) { throw new InputInvalidError('Patch file is unsupported or exceeds 128 KiB'); }
    const bytes = await handle.readFile(), current = await lstat(file);
    if (bytes.length > 128 * 1024 || current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1) {
      throw new InputInvalidError('Patch file changed while reading');
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) { throw new InputInvalidError('Binary patch files are unsupported'); }
    assertPublicValue(text);
    return { path, text, oldHash: sha256(bytes), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function inspectPatch(value: unknown, context: ExecutionContext) {
  try {
    const input = patchSchema.parse(value);
    assertPublicValue(input);
    if (new Set(input.changes.map((change) => change.path)).size !== input.changes.length) { throw new Error('Duplicate patch paths'); }
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) { throw new Error('Patch exceeds 256 KiB'); }
    const before: Snapshot[] = [];
    for (const change of input.changes) {
      if (change.text !== null && (change.text.includes('\0') || Buffer.byteLength(change.text) > 128 * 1024)) { throw new Error('Unsupported patch content'); }
      const snapshot = await readSnapshot(context, change.path);
      if (snapshot.oldHash !== change.oldHash) { throw new Error(`Old content hash does not match: ${change.path}`); }
      if (snapshot.text === change.text) { throw new Error(`Patch has no change: ${change.path}`); }
      before.push(snapshot);
    }
    const review = patchReview(input, before);
    if (Buffer.byteLength(JSON.stringify({ input, review, before })) > 900 * 1024) { throw new Error('Patch review exceeds storage budget'); }
    return { input, before, review };
  } catch (error) { throw new InputInvalidError(error instanceof Error ? error.message : String(error)); }
}

function patchReview(input: PatchInput, before: Snapshot[]) {
  return { schemaVersion: '1.0', patchHash: sha256(JSON.stringify(input)), atomicity: 'per-file-with-reviewed-recovery',
    files: input.changes.map((change, index) => ({
      path: change.path, operation: change.text === null ? 'delete' : change.oldHash === null ? 'create' : 'replace',
      oldHash: change.oldHash, newHash: change.text === null ? null : sha256(change.text),
      bytes: Buffer.byteLength(change.text ?? ''), diff: unifiedDiff(change.path, before[index].text, change.text),
    })) };
}
