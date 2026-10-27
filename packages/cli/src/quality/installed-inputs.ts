/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecutionContext } from '../runtime/types.js';
import { digest, evidenceFile, privateEvidenceName } from './evidence.js';

interface InstalledSelection { root: string; modules: { path: string }[]; }
interface InstalledFile { path: string; sha256: string; size: number; }
interface InstalledLink { path: string; sha256: string; targetPath: string; }
interface Inventory {
  scope: 'ohpm-installed-inventory'; binding: 'inventory-only';
  roots: { path: string; status: 'present' | 'absent' | 'unreadable' }[];
  files: InstalledFile[]; links: InstalledLink[]; missing: string[];
}
const within = (root: string, file: string) => file === root || file.startsWith(`${root}${sep}`);
const portable = (root: string, file: string) => relative(root, file).split(sep).join('/');
function permitted(root: string, file: string, context: ExecutionContext) {
  const name = portable(root, file);
  return name && !isAbsolute(name) && within(root, file) && !within(resolve(context.dataDir), file) &&
    !name.split('/').some((part) => privateEvidenceName.test(part) ||
      [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
}
async function installedLink(file: string, roots: string[], root: string, context: ExecutionContext) {
  const value = await readlink(file), target = resolve(file, '..', value);
  if (!permitted(root, target, context) || !roots.some((path) => within(path, target))) { throw new Error('Unsafe installed link'); }
  const canonical = await realpath(file);
  if (!permitted(root, canonical, context) || !roots.some((path) => within(path, canonical)) ||
    await readlink(file) !== value) { throw new Error('Unsafe installed link'); }
  return { path: portable(root, file), targetPath: portable(root, canonical), sha256: digest(value) };
}
export async function snapshotInstalledInputs(selection: InstalledSelection, context: ExecutionContext): Promise<Inventory> {
  const root = resolve(selection.root), roots = [...new Set([root, ...selection.modules.map((item) => item.path)]
    .map((path) => join(path, 'oh_modules')))].sort();
  const inventory: Inventory = { scope: 'ohpm-installed-inventory', binding: 'inventory-only', roots: [], files: [], links: [], missing: [] };
  const queue: string[] = [], visited = new Set<string>();
  for (const file of roots) {
    try {
      if (!permitted(root, file, context)) { throw new Error('Unsafe installed root'); }
      const info = await lstat(file);
      if (!info.isDirectory() || await realpath(file) !== file) { throw new Error('Unsafe installed root'); }
      inventory.roots.push({ path: portable(root, file), status: 'present' }); queue.push(file);
    } catch (error) {
      const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
      inventory.roots.push({ path: portable(root, file), status });
      if (status === 'unreadable') { inventory.missing.push(portable(root, file)); }
    }
  }
  await readInstalledInventory(queue, visited, roots, root, context, inventory);
  inventory.files.sort((a, b) => a.path.localeCompare(b.path));
  inventory.links.sort((a, b) => a.path.localeCompare(b.path));
  inventory.missing = [...new Set(inventory.missing)].sort();
  return inventory;
}
async function readInstalledInventory(queue: string[], visited: Set<string>, roots: string[], root: string,
  context: ExecutionContext, inventory: Inventory) {
  let entries = 0, bytes = 0;
  while (queue.length) {
    context.abortSignal.throwIfAborted();
    const file = queue.shift()!, name = portable(root, file);
    if (visited.has(file)) { continue; }
    visited.add(file);
    if (++entries > 10_000) { inventory.missing.push('installed-entry-budget'); break; }
    if (!permitted(root, file, context)) { inventory.missing.push('installed-sensitive-input'); continue; }
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) {
        const link = await installedLink(file, roots, root, context);
        inventory.links.push(link); queue.push(join(root, link.targetPath)); continue;
      }
      if (info.isDirectory()) {
        if (await realpath(file) !== file) { throw new Error('Unsafe installed directory'); }
        const names = await readdir(file);
        if (entries + queue.length + names.length > 10_000) { inventory.missing.push('installed-entry-budget'); break; }
        queue.push(...names.sort().map((part) => join(file, part))); continue;
      }
      const evidence = await evidenceFile(root, file, Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - bytes));
      bytes += evidence.size;
      inventory.files.push({ path: evidence.path, sha256: evidence.sha256, size: evidence.size });
    } catch { inventory.missing.push(name); }
  }
}
export function installedInputDrift(before: Inventory, after: Inventory) {
  const map = (value: Inventory) => new Map([
    ...value.files.map((item) => [item.path, `file:${item.sha256}`] as const),
    ...value.links.map((item) => [item.path, `link:${item.sha256}:${item.targetPath}`] as const),
    ...value.roots.map((item) => [item.path, `root:${item.status}`] as const),
  ]);
  const prior = map(before), current = map(after);
  return [...new Set([...prior.keys(), ...current.keys()])]
    .filter((path) => prior.get(path) !== current.get(path)).sort();
}
