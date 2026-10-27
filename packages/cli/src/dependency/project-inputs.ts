/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import JSON5 from 'json5';
import { sha256 } from '../agent/context-files.js';
import { patchPath, publicPath } from '../workspace/path-guard.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { parseSpans } from '../project-config/json5-spans.js';
import { nativeElf, readNativeArchive } from './native-archive.js';
import type { ExecutionContext } from '../runtime/types.js';
import { record, type DependencyGraph, type NativeBinary, type SourceFile } from './types.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inputName = /^(?:oh-package(?:-lock)?\.json5|package(?:-lock)?\.json|npm-shrinkwrap\.json|CMakeLists\.txt|.*\.(?:cmake|ets|ts|js|mjs|cjs|cpp|cc|c|cxx|h|hpp))$/;
const metadataName = /^(?:(?:build-profile|module)\.json5|function-config\.json)$/;
const nativeBytesName = /\.(?:a|so(?:\.\d+)*)$/;
type InputInventory = Pick<DependencyGraph, 'inputs' | 'findings'>;

function nativeMetadata(bytes: Buffer): NativeBinary {
  const binary: NativeBinary = { byteLength: bytes.length, format: 'unrecognized' };
  const magic = bytes.subarray(0, 8);
  if (magic.equals(Buffer.from('!<arch>\n')) || magic.equals(Buffer.from('!<thin>\n'))) {
    binary.format = magic.equals(Buffer.from('!<arch>\n')) ? 'ar-header' : 'ar-thin';
    binary.archive = readNativeArchive(bytes); return binary;
  }
  binary.elf = nativeElf(bytes);
  if (binary.elf) { binary.format = 'elf'; }
  return binary;
}
function safeUrls(text: string) {
  for (const match of text.matchAll(/\b(?:https?|git\+https?):\/\/[^\s"'<>]+/g)) {
    const url = new URL(match[0].replace(/^git\+/, ''));
    if (url.username || url.password || url.search) { throw new Error('Private registry URL is unsupported'); }
  }
}
async function readInput(context: ExecutionContext, path: string, binary: boolean): Promise<SourceFile> {
  const target = await patchPath(context.projectRoot ?? context.cwd, path, context.dataDir);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) { throw new Error('Dependency file exceeds limit or is not a regular unlinked file'); }
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) { break; }
      bytes += read.bytesRead;
    }
    const current = await lstat(target), final = await handle.stat();
    if (bytes !== info.size || current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || final.size !== info.size || final.mtimeMs !== info.mtimeMs) {
      throw new Error('Dependency file changed during reading');
    }
    const data = buffer.subarray(0, bytes);
    if (binary) { return { path, sha256: sha256(data), text: '', bytes, binary: true, nativeBinary: nativeMetadata(data) }; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) { throw new Error('Binary dependency input is unsupported'); }
    assertPublicValue(text); safeUrls(text);
    const value: unknown = /\.(?:json5|json)$/.test(path) ? JSON5.parse(text) : undefined;
    if (value !== undefined) { assertPublicValue(value); parseSpans(text); }
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) { throw new Error('Dependency metadata must be an object'); }
    return { path, sha256: sha256(data), text, bytes, ...(value !== undefined ? { value: record(value) } : {}) };
  } finally { await handle.close(); }
}

function denied(graph: InputInventory, path: string) {
  graph.findings.push({ code: 'DEPENDENCY_INPUT_UNAVAILABLE', severity: 'info', confidence: 'observed', incomplete: true,
    message: 'Input is unreadable, unsafe, malformed or exceeds the analysis budget', evidence: [{ path, sha256: '' }] });
}
export async function collectInputs(context: ExecutionContext, graph: InputInventory, projectMetadata = false): Promise<SourceFile[]> {
  const root = context.projectRoot ?? context.cwd, queue = [''], files: SourceFile[] = [];
  let entries = 0, bytes = 0;
  while (queue.length) {
    context.abortSignal.throwIfAborted();
    const directory = queue.shift()!, list = await readdir(join(root, directory), { withFileTypes: true }).catch(() => null);
    if (!list) { denied(graph, directory); continue; }
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 10_000) { denied(graph, directory); return files; }
      const path = directory ? `${directory}/${item.name}` : item.name;
      if (item.name === 'oh_modules') { continue; }
      if (join(root, path) === context.dataDir || join(root, path).startsWith(`${context.dataDir}${sep}`)) { continue; }
      try { publicPath(path); } catch { continue; }
      if (item.name.startsWith('.')) { continue; }
      if (item.isDirectory()) { queue.push(path); continue; }
      const binary = projectMetadata && nativeBytesName.test(item.name);
      if (!inputName.test(item.name) && !(projectMetadata && metadataName.test(item.name)) && !binary) { continue; }
      try {
        const file = await readInput(context, path, binary);
        bytes += file.bytes!;
        if (bytes > 32 * 1024 * 1024 || files.length >= 2_000) { denied(graph, path); return files; }
        files.push(file); graph.inputs.push({ path, sha256: file.sha256 });
      } catch { denied(graph, path); }
    }
  }
  return files;
}
