/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { digest, evidenceFile } from '../quality/evidence.js';
import type { ExecutionContext } from '../runtime/types.js';
import { publicPath } from '../workspace/path-guard.js';

export interface CompilerRead { path: string; sha256: string; size: number; }
export function compilerInputs(root: string, context: ExecutionContext) {
  const reads = new Map<string, CompilerRead>(), contents = new Map<string, string>();
  let bytesRead = 0;
  function allowed(file: string) {
    const path = relative(root, resolve(file)).split(sep).join('/');
    if (!path || isAbsolute(path) || resolve(file).startsWith(`${resolve(context.dataDir)}${sep}`)) { return false; }
    try { publicPath(path); return true; } catch { return false; }
  }
  function fileExists(file: string) {
    if (!allowed(file)) { return false; }
    try { return lstatSync(file).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error; }
  }
  function read(file: string): string | undefined {
    context.abortSignal.throwIfAborted();
    if (!allowed(file)) { throw new Error('Compiler input is outside the permitted project scope'); }
    if (!fileExists(file)) { return undefined; }
    const absolute = resolve(file), name = relative(root, absolute).split(sep).join('/');
    if (contents.has(absolute)) { return contents.get(absolute); }
    if (realpathSync(absolute) !== absolute) { throw new Error('Linked compiler input is unsupported'); }
    const handle = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(handle);
      if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 * 1024 ||
        bytesRead + before.size > 64 * 1024 * 1024 || reads.size >= 1000) { throw new Error('Compiler input exceeds the regular-file budget'); }
      const bytes = readFileSync(handle), after = fstatSync(handle), current = lstatSync(absolute);
      if (before.size !== bytes.length || before.ino !== current.ino || before.dev !== current.dev ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) { throw new Error('Compiler input changed during reading'); }
      const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
      bytesRead += bytes.length;
      contents.set(absolute, text); reads.set(absolute, { path: name, sha256: digest(bytes), size: bytes.length });
      return text;
    } finally { closeSync(handle); }
  }
  const directoryExists = (file: string) => {
    if (resolve(file) === root) { return true; }
    if (!allowed(file)) { return false; }
    try { return lstatSync(file).isDirectory() && realpathSync(file) === resolve(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error; }
  };
  return { read, fileExists, directoryExists, reads,
    verify: async () => {
      const drift = [];
      for (const entry of reads.values()) {
        const current = await evidenceFile(root, join(root, entry.path)).catch(() => null);
        if (current?.sha256 !== entry.sha256) { drift.push(entry.path); }
      }
      return drift.sort();
    } };
}
export function compilerHost(ts: typeof TS, options: TS.CompilerOptions, root: string, input: ReturnType<typeof compilerInputs>) {
  const host = ts.createCompilerHost(options), resolutions: { file: string; specifier: string; resolved: string | null }[] = [];
  host.readFile = input.read; host.fileExists = input.fileExists; host.directoryExists = input.directoryExists;
  host.getDirectories = () => []; host.getCurrentDirectory = () => root; host.writeFile = () => { throw new Error('Public API analysis cannot emit compiler output'); };
  host.getSourceFile = (file, languageVersion) => {
    const text = input.read(file), kinds = ts.ScriptKind as typeof TS.ScriptKind & { ETS?: TS.ScriptKind };
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true,
      file.endsWith('.ets') ? kinds.ETS ?? ts.ScriptKind.TS : ts.ScriptKind.TS);
  };
  host.resolveModuleNames = (names, containingFile) => names.map((specifier) => {
    const result = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
    resolutions.push({ file: relative(root, containingFile).split(sep).join('/'), specifier,
      resolved: result ? relative(root, result.resolvedFileName).split(sep).join('/') : null });
    return result;
  });
  return { host, resolutions };
}
