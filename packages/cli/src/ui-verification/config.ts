/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { AppConfig } from '../auth/auth-config.js';
import {
  decryptForLocalStorage,
  encryptForLocalStorage,
  isEncryptedBlob,
} from '../auth/utils/local-crypto.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import type { UiVerificationConfig } from './types.js';

function getConfigPath(): string {
  const configRoot =
    process.env.DEVECO_CLI_DATA_DIR
      ? getCliDataDir()
      : path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
  return path.join(configRoot, 'ui_verification_config.json');
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function loadUiVerificationConfig(): UiVerificationConfig | null {
  const raw = loadRawConfig();
  if (Object.keys(raw).length === 0) {
    return null;
  }

  let apiKey: string | undefined;
  if (isEncryptedBlob(raw.encryptedApiKey)) {
    try {
      apiKey = decryptForLocalStorage(raw.encryptedApiKey);
    } catch {
      // Treat an undecryptable key as an incomplete configuration.
    }
  }

  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    modelName: typeof raw.modelName === 'string' ? raw.modelName : undefined,
    apiKey,
  };
}

export function saveUiVerificationConfig(
  partial: UiVerificationConfig
): string {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

  const raw = loadRawConfig();
  if (partial.baseUrl !== undefined) {
    raw.baseUrl = partial.baseUrl;
  }
  if (partial.modelName !== undefined) {
    raw.modelName = partial.modelName;
  }
  if (partial.apiKey !== undefined) {
    raw.encryptedApiKey = encryptForLocalStorage(partial.apiKey);
    delete raw.apiKey;
  }

  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return configPath;
}
