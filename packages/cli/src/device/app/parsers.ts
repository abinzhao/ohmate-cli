/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type {
  AppEntry,
  ForegroundAppInfo,
  AppInfoFields,
} from './types.js';

interface RawApp {
  bundleName?: unknown;
  label?: unknown;
}

function matchField(
  output: string,
  pattern: RegExp
): string | undefined {
  const m = output.match(pattern);
  return m ? m[1] : undefined;
}

/**
 * Parse `aa dump -l` text output and extract all foreground apps'
 * `bundleName` and `abilityName`. Only AbilityRecords whose `state` is
 * `FOREGROUND` are considered; all other records are ignored.
 */
export function parseForegroundApp(output: string): ForegroundAppInfo[] {
  const results: ForegroundAppInfo[] = [];
  const blocks = output.split(/(?=AbilityRecord ID #)/);
  for (const block of blocks) {
    const stateMatch = block.match(/^\s*state #(\w+)/m);
    if (stateMatch && stateMatch[1].toUpperCase() === 'FOREGROUND') {
      results.push({
        bundleName: matchField(block, /app name \[([^\]]+)\]/),
        abilityName: matchField(block, /main name \[([^\]]+)\]/),
      });
    }
  }
  return results;
}

/**
 * Parse `bm dump -a -l` JSON output into app entries. Tries full JSON
 * array first, then falls back to extracting individual `{...}` blocks.
 */
export function parseAppList(output: string): AppEntry[] {
  const results: AppEntry[] = [];
  const collect = (raw: RawApp) => {
    if (typeof raw.bundleName === 'string') {
      results.push({
        bundleName: raw.bundleName,
        label: typeof raw.label === 'string' ? raw.label : undefined,
      });
    }
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      collect(item as RawApp);
    }
    if (results.length > 0) {
      return results;
    }
  }

  const objects = output.match(/\{[^{}]+\}/g) ?? [];
  for (const objStr of objects) {
    try {
      collect(JSON.parse(objStr) as RawApp);
    } catch {
      // skip malformed
    }
  }
  return results;
}

/**
 * Parse the JSON body from `bm dump -n <bundleName>` output (which is
 * prefixed with `<bundleName>:`). Returns the parsed object or `null`
 * when no JSON body is found.
 */
export function parseAppInfo(
  output: string
): Record<string, unknown> | null {
  const start = output.indexOf('{');
  if (start === -1) {
    return null;
  }
  try {
    return JSON.parse(output.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the five user-facing fields from a parsed `bm dump -n` object:
 * `bundleName` (from top-level `name`), `entryModuleName`,
 * `mainAbility` (from `hapModuleInfos[0].mainAbility`), `versionCode`,
 * `versionName`.
 */
/**
 * Check `aa start` output for common error patterns. Returns an object
 * with `success` flag and the original output as `message`.
 */
export function parseStartAppResult(output: string): { success: boolean; message: string } {
  const trimmed = output.trim();
  const isError = /error:\s*failed to start|error code:\s*\d+|the specified ability does not exist/i.test(trimmed);
  return { success: !isError, message: trimmed };
}

export function extractAppInfoFields(
  data: Record<string, unknown>
): AppInfoFields {
  const hapModuleInfos = data.hapModuleInfos;
  const firstModule =
    Array.isArray(hapModuleInfos) && hapModuleInfos[0]
      ? (hapModuleInfos[0] as Record<string, unknown>)
      : undefined;
  return {
    bundleName: data.name,
    entryModuleName: data.entryModuleName,
    mainAbility: firstModule?.mainAbility,
    versionCode: data.versionCode,
    versionName: data.versionName,
  };
}
