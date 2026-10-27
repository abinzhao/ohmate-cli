/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import {
  resolveEnvRoot,
  stripEnvPathQuotes,
} from '../toolchain/environment-path.js';

const APP_NAME = 'deveco-cli';

let assertedCliDataDir: string | undefined;

export class CliDataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliDataDirError';
  }
}

function isCliDataDirConfigured(): boolean {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  return raw !== undefined && stripEnvPathQuotes(raw) !== '';
}

function resolveConfiguredOrDefault(): string {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  const envDir = raw === undefined || raw === '' ? '' : stripEnvPathQuotes(raw);
  const target = envDir || path.join(homedir(), '.local', 'share', APP_NAME);
  try {
    return resolveEnvRoot(target);
  } catch (error) {
    throw new CliDataDirError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function assertCliDataDirSafe(): Promise<string> {
  const dataDir = resolveConfiguredOrDefault();
  await fs.promises.mkdir(dataDir, { recursive: true });
  let realDir: string;
  try {
    realDir = await fs.promises.realpath(dataDir);
  } catch (error) {
    throw new CliDataDirError(
      `DEVECO_CLI_DATA_DIR is not usable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const dataDirStat = await fs.promises.stat(realDir);
  if (!dataDirStat.isDirectory()) {
    throw new CliDataDirError(
      'DEVECO_CLI_DATA_DIR must be a writable directory.'
    );
  }
  assertedCliDataDir = realDir;
  return realDir;
}

export function buildCliDataDirHintLines(): string[] {
  const dataDir = getCliDataDir();
  if (isCliDataDirConfigured()) {
    return [
      `Data directory (DEVECO_CLI_DATA_DIR): ${dataDir}`,
      'If you changed this in System Environment Variables, open a new terminal and retry.',
    ];
  }
  return [
    `Data directory (default): ${dataDir}`,
    'To use a custom location, set DEVECO_CLI_DATA_DIR and open a new terminal.',
  ];
}

export function getCliDataDir(): string {
  if (assertedCliDataDir !== undefined) {
    return assertedCliDataDir;
  }
  const resolved = resolveConfiguredOrDefault();
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // Fall through to unresolved create-before-use path.
  }
  return resolved;
}
