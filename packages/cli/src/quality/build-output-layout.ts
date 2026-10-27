/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { privateEvidenceName } from './evidence.js';
import { readEvidenceText } from './source-scope.js';

const filePath = z.string().min(1).max(4096), product = z.string().regex(/^[A-Za-z0-9_-]+$/);
const outputPathSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('module'), path: filePath, product,
    modulePath: filePath, target: z.string().regex(/^[A-Za-z0-9_.-]+$/) }),
  z.strictObject({ scope: z.literal('module-metadata'), path: filePath, product,
    modulePath: filePath, target: z.string().regex(/^[A-Za-z0-9_.-]+$/), kind: z.enum(['hap', 'hsp']) }),
  z.strictObject({ scope: z.literal('product'), path: filePath, product }),
]);
const recordSchema = z.strictObject({
  version: z.literal(1), completion: z.literal('path-method-return'), phase: z.enum(['started', 'closed']), pid: z.number().int().positive(),
  paths: z.array(outputPathSchema).max(128), missing: z.array(z.string().max(100)).max(100),
});
export interface BuildOutputLayout {
  binding: 'observed-partial' | 'not-observed';
  paths: z.infer<typeof outputPathSchema>[];
  missing: string[]; invalid: boolean;
}
export function emptyBuildOutputLayout(): BuildOutputLayout {
  return { binding: 'not-observed', paths: [], missing: ['build-output-paths-not-observed', 'full-final-output-layout'], invalid: false };
}
export async function safeBuildOutputPath(root: string, file: string) {
  const name = relative(root, file);
  if (!isAbsolute(file) || file !== resolve(file) || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name) ||
    name.split(sep).some((part) => privateEvidenceName.test(part) || /^(?:local\.properties|\.ohpmrc)$/i.test(part) ||
      [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) { throw new Error('Unsafe build output path'); }
  let parent = root;
  for (const part of [null, ...name.split(sep)]) {
    if (part !== null) { parent = join(parent, part); }
    try { if ((await lstat(parent)).isSymbolicLink()) { throw new Error('Symlink build output path'); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { break; } throw error; }
  }
  return name.split(sep).join('/');
}
export async function collectBuildOutputLayout(directory: string, project: string): Promise<BuildOutputLayout> {
  const result = emptyBuildOutputLayout(), paths = new Map<string, z.infer<typeof outputPathSchema>>();
  let bytes = 0, count = 0;
  const names = await readdir(directory);
  if (names.length > 64) { return { ...result, invalid: true, missing: [...result.missing, 'build-output-file-budget'] }; }
  for (const name of names.sort()) {
    try {
      if (!/^[a-f0-9-]{36}\.jsonl$/.test(name)) { throw new Error('Unexpected output observation'); }
      const document = await readEvidenceText(directory, join(directory, name), Math.min(512 * 1024, 4 * 1024 * 1024 - bytes));
      bytes += document.evidence.size;
      const records = document.text.trim().split('\n').map((line) => recordSchema.parse(JSON.parse(line)));
      const closed = records[1];
      if (records.length !== 2 || records[0].phase !== 'started' || closed.phase !== 'closed' ||
        records[0].pid !== closed.pid || records[0].paths.length) { throw new Error('Unfinished output observation'); }
      count += closed.paths.length;
      if (count > 128) { throw new Error('Output path budget'); }
      for (const item of closed.paths) {
        const path = await safeBuildOutputPath(resolve(project), item.path);
        const converted = item.scope !== 'product' ? { ...item, path, modulePath: await safeBuildOutputPath(resolve(project), item.modulePath) } : { ...item, path };
        paths.set(JSON.stringify(converted), converted);
      }
      result.missing.push(...closed.missing);
      if (closed.missing.length) { result.invalid = true; }
    } catch { result.invalid = true; result.missing.push('build-output-observation-unreadable'); }
  }
  result.paths = [...paths.values()];
  if (result.paths.length) { result.binding = 'observed-partial'; }
  result.missing = [...new Set(result.missing.filter((item) => item !== 'build-output-paths-not-observed' || !result.paths.length))];
  return result;
}
