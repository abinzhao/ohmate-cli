/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ExecutableLookup,
  ResolvedRuntime,
  RuntimeCommand,
  RuntimeEntry,
  RuntimeMetadata,
  SourcedCommand,
} from './types.js';
import { compareVersions } from '../../packages/cli/src/utils/semver.js';

export const WRAPPER_MARKER = 'deveco-cli-plugin-entry';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LABELS: Record<string, string> = {
  host: 'host-managed',
  path: 'global',
  private: 'plugin-managed',
};

export function installRoot(
  metadata: RuntimeMetadata,
  env: NodeJS.ProcessEnv = process.env
) {
  const root = env.DEVECO_PLUGIN_INSTALL_ROOT;
  if (root && !path.isAbsolute(root)) {
    throw new Error('DEVECO_PLUGIN_INSTALL_ROOT must be an absolute path.');
  }
  return root || path.join(userHome(env), ...metadata.installRoot.split('/'));
}

export function userHome(env: NodeJS.ProcessEnv = process.env) {
  return (
    (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir()
  );
}

export function isSemver(version: unknown): version is string {
  return typeof version === 'string' && SEMVER.test(version);
}

export async function meetsMinimum(version: string | null, minimum: string) {
  return isSemver(version) && (await compareVersions(version, minimum)) >= 0;
}

export async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function executable(file: string) {
  try {
    if (!(await fs.stat(file)).isFile()) {
      return false;
    }
    await fs.access(
      file,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
}

// Returns null, { wrapper: true } for this plugin's own launchers, or a directly spawnable CLI.
async function inspectExecutable(
  file: string
): Promise<ExecutableLookup | null> {
  if (/\.(?:c?js|mjs)$/i.test(file)) {
    if (!(await fs.stat(file).catch(() => null))?.isFile()) {
      return null;
    }
  } else if (!(await executable(file))) {
    return null;
  }
  const real = await fs.realpath(file);
  const ext = path.extname(real).toLowerCase();
  if (ext === '.exe') {
    return { command: real, args: [], entry: real };
  }
  const handle = await fs.open(real);
  let text;
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  if (text.includes(WRAPPER_MARKER)) {
    return { wrapper: true };
  }
  // Resolve npm shims to JavaScript so Windows never interprets user argv as shell code.
  if (ext === '.cmd' || ext === '.bat') {
    const match = text.match(/"%dp0%[\\/]([^"\r\n]+\.(?:c?js|mjs))"/i);
    if (!match) {
      return null;
    }
    const entry = path.resolve(
      path.dirname(real),
      match[1].replaceAll('\\', '/')
    );
    if (!(await fs.stat(entry).catch(() => null))?.isFile()) {
      return null;
    }
    return { command: process.execPath, args: [entry], entry };
  }
  if (/\.(?:c?js|mjs)$/.test(ext) || /^#!.*\bnode\b/.test(text)) {
    return { command: process.execPath, args: [real], entry: real };
  }
  return process.platform === 'win32'
    ? null
    : { command: real, args: [], entry: real };
}

export async function resolveExecutable(
  file: string
): Promise<RuntimeCommand | null> {
  const found = await inspectExecutable(file);
  return found?.wrapper ? null : found;
}

const samePath = (left: string, right: string) =>
  process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

// Read the owning npm package without executing the CLI; null when the entry is not an npm bin.
export async function entryPackage(entry: string) {
  let dir = path.dirname(entry);
  for (let depth = 0; depth < 3; depth++) {
    const pkg = await readJson(path.join(dir, 'package.json')).catch(
      () => null
    );
    const bin = pkg?.bin?.devecocli;
    if (typeof bin === 'string' && samePath(path.resolve(dir, bin), entry)) {
      return { root: dir, name: pkg.name, version: pkg.version };
    }
    dir = path.dirname(dir);
  }
  return null;
}

export async function managedRuntime(
  root: string,
  packageName: string
): Promise<RuntimeEntry | null> {
  const state = await readJson(path.join(root, 'current.json')).catch(
    (error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new Error(`Cannot read private Runtime state: ${error.message}`);
    }
  );
  if (!state || state.packageName !== packageName) {
    return null;
  }
  if (!/^[a-f0-9-]{36}$/.test(state.installId)) {
    throw new Error('Invalid private Runtime install ID.');
  }
  const packageRoot = path.join(
    root,
    'installs',
    state.installId,
    'node_modules',
    packageName
  );
  const pkg = await readJson(path.join(packageRoot, 'package.json'));
  const binEntry = pkg.bin?.devecocli;
  if (pkg.name !== packageName || typeof binEntry !== 'string') {
    throw new Error(
      'Invalid private DevEco CLI package. Run devecocli-install to repair it.'
    );
  }
  const entry = path.join(packageRoot, binEntry);
  if (!(await fs.stat(entry)).isFile()) {
    throw new Error(`Runtime entry is missing: ${entry}`);
  }
  return {
    command: process.execPath,
    args: [entry],
    entry,
    source: 'private',
    version: pkg.version,
  };
}

async function firstExecutable(
  dirs: string[],
  source: string
): Promise<SourcedCommand | null> {
  const names =
    process.platform === 'win32'
      ? ['devecocli.cmd', 'devecocli.exe']
      : ['devecocli'];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    for (const name of names) {
      const found = await inspectExecutable(path.join(dir, name));
      if (found && !found.wrapper) {
        return { ...found, source };
      }
    }
  }
  return null;
}

async function withVersion(
  runtime: (SourcedCommand & { version?: string | null }) | null
): Promise<RuntimeEntry | null> {
  if (!runtime) {
    return null;
  }
  const version =
    runtime.version ?? (await entryPackage(runtime.entry))?.version ?? null;
  return { ...runtime, version };
}

const describe = ({ source, entry, version }: RuntimeEntry) =>
  `the ${LABELS[source]} DevEco CLI at ${entry} (version ${version || 'unknown'})`;

/**
 * Selects the Runtime: an explicit entry as-is, otherwise the first host-managed or global CLI that meets the
 * plugin's minimum version, otherwise the plugin-managed Runtime. Older CLIs are skipped and reported, never modified.
 */
// eslint-disable-next-line max-lines-per-function -- Keep Runtime candidate selection together.
export async function resolveRuntime(
  metadata: RuntimeMetadata,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedRuntime> {
  const explicit = env.DEVECO_PLUGIN_RUNTIME_EXECUTABLE;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('DEVECO_PLUGIN_RUNTIME_EXECUTABLE must be absolute.');
    }
    const found = await resolveExecutable(explicit);
    if (!found) {
      throw new Error(
        `Invalid Runtime entry: ${explicit}. Use the real CLI entry, not the plugin wrapper.`
      );
    }
    return {
      ...found,
      source: 'explicit',
      version: (await entryPackage(found.entry))?.version ?? null,
      skipped: [],
    };
  }
  const home = userHome(env);
  const locations = [
    ...metadata.hostBinDirs.map((dir) => ({
      dirs: [path.join(home, ...dir.split('/'))],
      source: 'host',
    })),
    {
      dirs: (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean),
      source: 'path',
    },
  ];
  const skipped = [];
  let selected = null;
  for (const { dirs, source } of locations) {
    const candidate = await withVersion(await firstExecutable(dirs, source));
    if (!candidate) {
      continue;
    }
    if (await meetsMinimum(candidate.version, metadata.packageVersion)) {
      selected = candidate;
      break;
    }
    skipped.push(candidate);
  }
  if (!selected) {
    const managed = await managedRuntime(
      installRoot(metadata, env),
      metadata.packageName
    );
    const skippedText = skipped.length
      ? ` Skipped ${skipped.map(describe).join('; ')}: below the minimum version ${metadata.packageVersion}. Skipped CLIs are left unchanged.`
      : '';
    if (!managed) {
      throw new Error(
        `No DevEco CLI meeting the minimum version ${metadata.packageVersion} is installed.${skippedText} Run devecocli-install after authorizing the Runtime installation; it installs into the plugin-managed directory only.`
      );
    }
    if (!(await meetsMinimum(managed.version, metadata.packageVersion))) {
      throw new Error(
        `${describe(managed).replace(/^t/, 'T')} is below the minimum version ${metadata.packageVersion} required by this plugin.${skippedText} Run devecocli-install within the user's authorization to update it.`
      );
    }
    selected = managed;
  }
  return {
    ...selected,
    skipped: skipped.map(({ source, entry, version }) => ({
      source,
      entry,
      version,
    })),
  };
}
