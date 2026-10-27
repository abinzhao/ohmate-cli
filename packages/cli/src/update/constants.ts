/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Returns the npm package name injected at build time by tsup, falling back to a sensible default */
export function getPackageName(): string {
  if (process.env.DEVECO_CLI_WRAPPER_NAME) {
    return process.env.DEVECO_CLI_WRAPPER_NAME;
  }
  return process.env.npm_package_name || '@deveco/deveco-cli';
}

/** Returns the running CLI version, falling back to 0.0.1 when env is unset (e.g. binary invocation) */
export function getCurrentVersion(): string {
  if (process.env.DEVECO_CLI_WRAPPER_VERSION) {
    return process.env.DEVECO_CLI_WRAPPER_VERSION;
  }
  return process.env.npm_package_version || '0.0.1';
}

/** Returns the npm dist-tag configured at publish time, defaulting to 'latest' */
export function getPublishTag(): string {
  return process.env.npm_config_tag || 'latest';
}

/**
 * Returns the highest documentation `apiVersion` this CLI build can load.
 * Injected at build time by tsup from `package.json#supportedDocsApi`, falling
 * back to 1. Older CLIs can also read this field from a newer CLI's published
 * metadata via `npm view` to pick a Docs version the upgraded CLI supports.
 */
export function getSupportedDocsApi(): number {
  const raw = process.env.npm_package_supported_docs_api;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** npm package name of the documentation knowledgebase. */
export const DOCS_PKG_NAME = '@ohmate/knowledgebase';

/** Disable mode for the update subsystem (env `DEVECO_CLI_DISABLE_UPDATE`). */
export type UpdateDisableMode = 'off' | 'check' | 'all';

/**
 * Returns the configured disable mode for update notifications and the
 * blocked-version gate. `check` skips the gate + notify/background refresh but
 * keeps `devecocli update` usable; `all` additionally refuses `devecocli update`.
 */
export function getUpdateDisableMode(): UpdateDisableMode {
  const value = process.env.DEVECO_CLI_DISABLE_UPDATE;
  return value === 'check' || value === 'all' ? value : 'off';
}
