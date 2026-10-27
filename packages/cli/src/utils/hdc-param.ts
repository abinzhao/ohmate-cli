/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runCommand } from './cmd.js';
import { debugLog } from './logger.js';

/** Normalize `hdc shell param get` stdout (`key = value` or raw). */
export function parseHdcParamStdout(stdout: string): string {
  const t = stdout.trim();
  const i = t.indexOf('=');
  return i !== -1 ? t.slice(i + 1).trim() : t;
}

export type HdcOutputClass = 'ok' | 'fatal' | 'transient';

const TRANSIENT_PATTERNS: RegExp[] = [
  /communication channel is being established/i,
  /please wait for several seconds and try again/i,
  /device offline/i,
  /\[E0+04\]/i,
  /not connected/i,
];

const FATAL_PATTERNS: RegExp[] = [
  /\[fail\]/i,
  /\bfail!/i,
  /not found/i,
  /permission denied/i,
  /device unauthorized/i,
];

export function classifyHdcOutput(text: string | undefined): HdcOutputClass {
  if (!text) {
    return 'ok';
  }
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) {
    return 'transient';
  }
  if (FATAL_PATTERNS.some((re) => re.test(text))) {
    return 'fatal';
  }
  return 'ok';
}

const PID_LIST_RE = /(?:^|\s)(\d{2,})(?:\s|$)/;

export type PidofOutcome = 'alive' | 'dead' | 'query-failed';

/**
 * Classify a `hdc shell pidof <bundle>` result (after runHdcWithRetry).
 * - `alive`: clean exit with pid digits on stdout.
 * - `dead`: confirmed no process — pidof's standard no-match (exit 1, no
 *   output) or a clean exit with empty stdout.
 * - `query-failed`: transport/spawn trouble or hdc error text — the process
 *   state is UNKNOWN and must never be treated as "dead" (a transient
 *   disconnect is not a crash).
 */
export function classifyPidofResult(result: HdcCommandResult): PidofOutcome {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (
    classifyHdcOutput(stdout) !== 'ok' ||
    classifyHdcOutput(stderr) !== 'ok'
  ) {
    return 'query-failed';
  }
  if (result.exitCode === 0) {
    if (!stdout) {
      return 'dead';
    }
    return PID_LIST_RE.test(stdout) ? 'alive' : 'dead';
  }
  if (result.exitCode === 1 && !stdout && !stderr) {
    return 'dead';
  }
  return 'query-failed';
}

/** Backoff schedule for transient hdc failures. ~4.8 s total wall time. */
const RETRY_DELAYS_MS = [800, 1500, 2500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HdcCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `hdc <args>` with transient-error retries (channel establishing,
 * device offline, etc.). Returns the final raw result; the caller still owns
 * exit-code handling and stdout parsing — but the `[E000004] communication
 * channel is being established` window is transparently waited out.
 */
export async function runHdcWithRetry(
  hdcPath: string,
  args: string[]
): Promise<HdcCommandResult> {
  const attempts = 1 + RETRY_DELAYS_MS.length;
  let last: HdcCommandResult = { stdout: '', stderr: '', exitCode: -1 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await runCommand(hdcPath, args);
    if (last.exitCode === 0 || classifyHdcOutput(last.stderr) !== 'transient') {
      return last;
    }
    if (attempt >= attempts - 1) {
      return last;
    }
    debugLog(
      `hdc transient failure on \`${args.join(' ')}\`: retrying in ${RETRY_DELAYS_MS[attempt]}ms`
    );
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return last;
}

const SAFE_PARAM_KEY_RE = /^[\w.-]+$/;

/**
 * Read a single `param get` value from a device. Returns `undefined` on any
 * failure (including transient errors that exhausted the retry budget).
 */
export async function tryGetHdcShellParam(
  hdcPath: string,
  deviceId: string,
  paramKey: string
): Promise<string | undefined> {
  if (!SAFE_PARAM_KEY_RE.test(paramKey)) {
    debugLog(`Skipping invalid param key: ${JSON.stringify(paramKey)}`);
    return undefined;
  }
  const args = ['-t', deviceId, 'shell', 'param', 'get', paramKey];
  debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
  const result = await runHdcWithRetry(hdcPath, args);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const raw = result.stdout.trim();
  if (!raw || classifyHdcOutput(raw) !== 'ok') {
    return undefined;
  }
  return parseHdcParamStdout(raw);
}

const BATCH_DELIM = '__DEVECO_PARAM_DELIM__';

function parseBatchedParamSegments(
  stdout: string,
  paramKeys: string[]
): Map<string, string> {
  const values = new Map<string, string>();
  const segments = stdout.split(BATCH_DELIM);
  for (let i = 0; i < paramKeys.length; i++) {
    const raw = (segments[i] ?? '').trim();
    if (!raw || classifyHdcOutput(raw) !== 'ok') {
      continue;
    }
    const value = parseHdcParamStdout(raw);
    if (value) {
      values.set(paramKeys[i], value);
    }
  }
  return values;
}

/**
 * Batched `param get` for many keys in a single shell invocation. Same
 * transient-error retry semantics as {@link tryGetHdcShellParam}; per-key
 * fatal errors are silently skipped so partial results still flow through.
 */
export async function tryGetHdcShellParams(
  hdcPath: string,
  deviceId: string,
  paramKeys: string[]
): Promise<Map<string, string>> {
  const sanitizedKeys = paramKeys.filter((k) => {
    if (!SAFE_PARAM_KEY_RE.test(k)) {
      debugLog(`Skipping invalid param key: ${JSON.stringify(k)}`);
      return false;
    }
    return true;
  });

  if (sanitizedKeys.length === 0) {
    return new Map();
  }
  if (sanitizedKeys.length === 1) {
    const result = new Map<string, string>();
    const v = await tryGetHdcShellParam(hdcPath, deviceId, sanitizedKeys[0]);
    if (v) {
      result.set(sanitizedKeys[0], v);
    }
    return result;
  }

  const command =
    sanitizedKeys.map((k) => `param get ${k}`).join(`; echo ${BATCH_DELIM}; `) +
    `; echo ${BATCH_DELIM}`;

  // On Mac/Linux, hdc shell sometimes behaves better with explicit quotes
  // when multiple commands are joined by semicolons.
  const result = await runHdcWithRetry(hdcPath, [
    '-t',
    deviceId,
    'shell',
    command,
  ]);

  if (result.exitCode === 0) {
    const map = parseBatchedParamSegments(result.stdout, sanitizedKeys);
    if (map.size > 0) {
      return map;
    }
  }

  // Fallback: try individual keys if the batched command failed or returned nothing.
  // This is slower but more reliable on flaky connections or specific hdc versions.
  debugLog(
    `Batched param fetch failed (exit=${result.exitCode}), falling back to individual calls for ${deviceId}`
  );
  const fallbackMap = new Map<string, string>();
  for (const key of sanitizedKeys) {
    const val = await tryGetHdcShellParam(hdcPath, deviceId, key);
    if (val) {
      fallbackMap.set(key, val);
    }
  }
  return fallbackMap;
}
