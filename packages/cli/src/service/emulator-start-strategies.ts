/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as path from 'path';
import type {
  EmulatorBootMode,
  EmulatorInfo,
  EmulatorStartOptions,
} from './emulator-types.js';
import type { EmulatorSpawnHandle } from '../utils/emulator-spawn.js';

type EmulatorNativeBootMode = EmulatorBootMode;

function dedupeArgLists(lists: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const args of lists) {
    const k = JSON.stringify(args);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(args);
  }
  return out;
}

/** Parent of the instance folder (e.g. .../deployed for .../deployed/AAA). */
function resolveEmulatorDeployedParentDir(emulator: EmulatorInfo): string {
  const ip = emulator.instancePath?.trim();
  if (ip) {
    return path.dirname(path.normalize(ip)).replace(/\\/g, '/');
  }
  const p = emulator.path?.trim();
  if (p) {
    return path.dirname(path.normalize(p)).replace(/\\/g, '/');
  }
  return '';
}

function collectEmulatorImageSources(
  imageRoot: string | undefined
): string[][] {
  const imageSources: string[][] = [];
  if (imageRoot) {
    imageSources.push(['-imageRoot', imageRoot]);
  }
  imageSources.push([]);
  return imageSources;
}

function withStartArgs(
  args: string[],
  nativeBootMode?: EmulatorNativeBootMode,
  startOptions?: EmulatorStartOptions
): string[] {
  const out = [...args];
  const bootMode = startOptions?.bootMode ?? nativeBootMode;
  if (bootMode) {
    out.push('-bootmode', bootMode);
  }
  if (startOptions?.hdcPort !== undefined) {
    out.push('-hdcport', String(startOptions.hdcPort));
  }
  if (startOptions?.noWindow) {
    out.push('-noWindow');
  }
  return out;
}

/**
 * Prefer bare `-start <name>`; fall back to `-hvd <name> -path <deployedParent>
 * [-imageRoot …] [-bootmode …]` when list details supply paths.
 */
export function buildEmulatorStartArgCandidates(
  listName: string,
  emulator: EmulatorInfo,
  nativeBootMode?: EmulatorNativeBootMode,
  startOptions?: EmulatorStartOptions
): string[][] {
  const candidates: string[][] = [
    withStartArgs(['-start', listName], nativeBootMode, startOptions),
  ];

  const pathVal = resolveEmulatorDeployedParentDir(emulator);
  if (pathVal) {
    for (const imageArgs of collectEmulatorImageSources(emulator.imageRoot)) {
      candidates.push(
        withStartArgs(
          ['-hvd', listName, '-path', pathVal, ...imageArgs],
          nativeBootMode,
          startOptions
        )
      );
    }
  }

  return dedupeArgLists(candidates);
}

export async function runAllEmulatorStartStrategies(
  listName: string,
  targetEmulator: EmulatorInfo,
  executeEmulatorDetached: (args: string[]) => EmulatorSpawnHandle,
  nativeBootMode?: EmulatorNativeBootMode,
  startOptions?: EmulatorStartOptions
): Promise<
  | { ok: true; args: string[]; tracker: EmulatorSpawnHandle['tracker'] }
  | { ok: false; lastError: Error }
> {
  let lastError: Error = new Error('No start strategy ran');
  const candidates = buildEmulatorStartArgCandidates(
    listName,
    targetEmulator,
    nativeBootMode,
    startOptions
  );

  for (const args of candidates) {
    let handle: EmulatorSpawnHandle | undefined;
    try {
      handle = executeEmulatorDetached(args);
      await handle.started;
      return { ok: true, args, tracker: handle.tracker };
    } catch (err) {
      if (handle?.tracker) {
        try {
          await handle.tracker.stop();
        } catch {
          // ignore tracker stop failure
        }
      }
      lastError = err as Error;
    }
  }

  return { ok: false, lastError };
}
