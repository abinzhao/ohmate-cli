/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import readline from 'node:readline/promises';
import { execa } from 'execa';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { EMULATOR_PRIVACY_BUNDLED } from '../data/emulator-privacy-bundled.js';

const acceptedCache = new Set<string>();
const emulatorVersionTextCache = new Map<string, string>();

/** Key in `.emu_config` for the emulator software agreement (Studio / `license`). */
export const HARMONYOS_SOFTWARE_SERVICE_AGREEMENT_KEY =
  'HarmonyOS_Software_Service_Agreement';

/**
 * User-facing text when `emulator start` or `emulator image download` blocks on
 * agreement / `.emu_config` (same copy for both flows).
 */
const EMULATOR_LICENSE_BLOCKED_USER_MESSAGE = [
  'Emulator license agreements are not accepted yet.',
  '',
  'Accept the agreements interactively (shows full text + y/N prompt):',
  '  devecocli emulator license',
  '',
  'Or accept non-interactively (no prompt, for CI/scripts):',
  '  devecocli emulator license accept',
  '',
  'To review the agreement text (read-only):',
  '  devecocli emulator license view',
].join('\n');

const EMULATOR_CLI_AGREEMENT_BLOCKED_USER_MESSAGE =
  EMULATOR_LICENSE_BLOCKED_USER_MESSAGE;

/** `.emu_config` key for HarmonyOS SDK license (image download). */
export const HARMONYOS_SDK_AGREEMENT_KEY = 'HarmonyOS_SDK_Agreement';

function cacheKey(emulatorPath: string, sdkPath: string): string {
  return `${emulatorPath}\0${sdkPath}`;
}

/** Clears in-process caches after updating `.emu_config` agreement flags. */
export function invalidateEmulatorLicenseCache(): void {
  acceptedCache.clear();
  emulatorVersionTextCache.clear();
}

const LICENSE_HINT_LINES = EMULATOR_LICENSE_BLOCKED_USER_MESSAGE;

export class EmulatorLicenseBlockedError extends Error {
  constructor(message = LICENSE_HINT_LINES) {
    super(message);
    this.name = 'EmulatorLicenseBlockedError';
  }
}

export function combinedEmulatorOutputText(
  stdout: string | undefined,
  stderr: string | undefined
): string {
  return [stdout ?? '', stderr ?? ''].join('\n');
}

/**
 * From `Emulator -version` text such as `HarmonyOS Emulator :6.1.1.100`, returns
 * the first two numeric segments joined as `6.1` (directory name is `Emulator6.1`).
 */
export function parseEmulatorMajorMinorFromVersionText(
  versionOutput: string
): string | null {
  const t = versionOutput.normalize('NFKC');
  const m = t.match(/(\d+)\.(\d+)\.\d+/);
  if (m) {
    return `${m[1]}.${m[2]}`;
  }
  const m2 = t.match(/(\d+)\.(\d+)\b/);
  return m2 ? `${m2[1]}.${m2[2]}` : null;
}

/** e.g. `6.1` -> `Emulator6.1` (Huawei data directory under LocalAppData / Caches). */
export function emulatorDataDirNameFromMajorMinor(majorMinor: string): string {
  return `Emulator${majorMinor.trim()}`;
}

/**
 * Resolves `.emu_config` per DevEco layout:
 * - Windows: `%LOCALAPPDATA%\Huawei\Emulator<major>.<minor>\.emu_config`
 * - macOS: `~/Library/Caches/Huawei/Emulator<major>.<minor>\.emu_config`
 */
export function resolveEmuConfigPathFromMajorMinor(majorMinor: string): string {
  const dirName = emulatorDataDirNameFromMajorMinor(majorMinor);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) {
      throw new Error(
        'LOCALAPPDATA is not set; cannot resolve .emu_config path.'
      );
    }
    return path.join(local, 'Huawei', dirName, '.emu_config');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Caches',
      'Huawei',
      dirName,
      '.emu_config'
    );
  }
  const cacheRoot =
    process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cacheRoot, 'Huawei', dirName, '.emu_config');
}

async function getEmulatorVersionOutputCached(
  emulatorPath: string,
  sdkPath: string,
  blockedMessage: string
): Promise<string> {
  const ck = cacheKey(emulatorPath, sdkPath);
  const hit = emulatorVersionTextCache.get(ck);
  if (hit !== undefined) {
    return hit;
  }
  const r = await execa(emulatorPath, ['-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEVECO_SDK_HOME: sdkPath },
    reject: false,
    maxBuffer: 1024 * 1024,
  });
  const text = combinedEmulatorOutputText(r.stdout, r.stderr).trim();
  if (r.exitCode !== 0 || !text) {
    throw new EmulatorLicenseBlockedError(blockedMessage);
  }
  emulatorVersionTextCache.set(ck, text);
  return text;
}

type EmuConfigEntry = { value: string; delimiter: 'json' | ':' | '=' };

function stripWrappingQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' || first === "'") && first === last
    ? value.slice(1, -1)
    : value;
}

function tryParseEmuConfigJsonEntries(
  trimmed: string
): Record<string, EmuConfigEntry> | undefined {
  try {
    const j = JSON.parse(trimmed) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const out: Record<string, EmuConfigEntry> = {};
      for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
        out[k] = {
          value: typeof v === 'string' ? v : String(v),
          delimiter: 'json',
        };
      }
      return out;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseEmuConfigEntryFromLine(
  line: string
): { key: string; entry: EmuConfigEntry } | undefined {
  const s = line.trim();
  if (!s || s.startsWith('#')) {
    return undefined;
  }
  for (const delimiter of ['=', ':'] as const) {
    const idx = s.indexOf(delimiter);
    if (idx <= 0) {
      continue;
    }
    const key = s.slice(0, idx).trim();
    if (!key || (delimiter === ':' && key.includes('//'))) {
      continue;
    }
    const value = stripWrappingQuotes(s.slice(idx + 1).trim());
    return { key, entry: { value, delimiter } };
  }
  return undefined;
}

function parseEmuConfigLineEntries(
  raw: string
): Record<string, EmuConfigEntry> {
  const out: Record<string, EmuConfigEntry> = {};
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEmuConfigEntryFromLine(line);
    if (parsed) {
      out[parsed.key] = parsed.entry;
    }
  }
  return out;
}

function parseEmuConfigEntries(raw: string): Record<string, EmuConfigEntry> {
  const t = raw.trim();
  if (!t) {
    return {};
  }
  const jsonEntries = tryParseEmuConfigJsonEntries(t);
  if (jsonEntries) {
    return jsonEntries;
  }
  return parseEmuConfigLineEntries(raw);
}

function fieldIsAgree(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.normalize('NFKC').trim().toLowerCase() === 'agree';
}

async function ensureEmuConfigAgreementFieldIsAgree(
  emulatorPath: string,
  sdkPath: string,
  agreementKey: string,
  userMessage: string
): Promise<void> {
  const versionText = await getEmulatorVersionOutputCached(
    emulatorPath,
    sdkPath,
    userMessage
  );
  const majorMinor = parseEmulatorMajorMinorFromVersionText(versionText);
  if (!majorMinor) {
    throw new EmulatorLicenseBlockedError(userMessage);
  }
  const emuConfigPath = resolveEmuConfigPathFromMajorMinor(majorMinor);
  let raw: string;
  try {
    raw = await fs.readFile(emuConfigPath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new EmulatorLicenseBlockedError(userMessage);
    }
    throw e;
  }
  const record = parseEmuConfigEntries(raw);
  const entry = record[agreementKey];
  if (!entry) {
    throw new EmulatorLicenseBlockedError(userMessage);
  }
  if (entry.delimiter === '=') {
    throw new EmulatorLicenseBlockedError(userMessage);
  }
  if (!fieldIsAgree(entry.value)) {
    throw new EmulatorLicenseBlockedError(userMessage);
  }
}

/**
 * Before `emulator start`, require `.emu_config` to contain
 * `HarmonyOS_Software_Service_Agreement` set to `agree` at the path derived from
 * `Emulator -version` (Emulator&lt;major&gt;.&lt;minor&gt;).
 */
export async function ensureEmulatorServiceAgreementConfig(
  emulatorPath: string,
  sdkPath: string
): Promise<void> {
  await ensureEmuConfigAgreementFieldIsAgree(
    emulatorPath,
    sdkPath,
    HARMONYOS_SOFTWARE_SERVICE_AGREEMENT_KEY,
    EMULATOR_CLI_AGREEMENT_BLOCKED_USER_MESSAGE
  );
}

/**
 * Before `emulator image download`, require `.emu_config` to contain
 * `HarmonyOS_SDK_Agreement` set to `agree` (same config path as {@link ensureEmulatorServiceAgreementConfig}).
 */
export async function ensureEmulatorSdkAgreementForImageDownload(
  emulatorPath: string,
  sdkPath: string
): Promise<void> {
  await ensureEmuConfigAgreementFieldIsAgree(
    emulatorPath,
    sdkPath,
    HARMONYOS_SDK_AGREEMENT_KEY,
    EMULATOR_CLI_AGREEMENT_BLOCKED_USER_MESSAGE
  );
}

const LICENSE_BLOCKED_PATTERNS: RegExp[] = [
  /need to be reviewed/i,
  /license agreements that need/i,
  /License check aborted/i,
  /agreements? that need to be reviewed/i,
];

export function isEmulatorLicenseBlockedOutput(text: string): boolean {
  const t = text.normalize('NFKC');
  return LICENSE_BLOCKED_PATTERNS.some((re) => re.test(t));
}

export function throwIfLicenseBlockedInToolOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null | undefined
): void {
  if (exitCode === 0) {
    return;
  }
  const blob = combinedEmulatorOutputText(stdout, stderr);
  if (isEmulatorLicenseBlockedOutput(blob)) {
    throw new EmulatorLicenseBlockedError();
  }
}

function getExecaCombinedText(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return '';
  }
  const o = err as Record<string, unknown>;
  const out =
    typeof o.stdout === 'string'
      ? o.stdout
      : o.stdout === undefined
        ? ''
        : String(o.stdout);
  const errOut =
    typeof o.stderr === 'string'
      ? o.stderr
      : o.stderr === undefined
        ? ''
        : String(o.stderr);
  return `${out}\n${errOut}`;
}

export function rethrowIfLicenseBlockedExecaError(err: unknown): void {
  if (!err || typeof err !== 'object') {
    return;
  }
  const o = err as { exitCode?: number | null };
  if (o.exitCode === 0 || o.exitCode === undefined) {
    return;
  }
  if (isEmulatorLicenseBlockedOutput(getExecaCombinedText(err))) {
    throw new EmulatorLicenseBlockedError();
  }
}

/**
 * Non-interactive probe with a process-local cache. Unknown failures are ignored so the
 * main emulator command can run and report the underlying error.
 */
export async function ensureEmulatorLicenseAccepted(
  emulatorPath: string,
  sdkPath: string
): Promise<void> {
  const key = cacheKey(emulatorPath, sdkPath);
  if (acceptedCache.has(key)) {
    return;
  }

  const env = { ...process.env, DEVECO_SDK_HOME: sdkPath };
  const probe = await execa(emulatorPath, ['-list', '-details'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    reject: false,
    maxBuffer: 20 * 1024 * 1024,
  });

  const combined = combinedEmulatorOutputText(probe.stdout, probe.stderr);
  const isBlocked = isEmulatorLicenseBlockedOutput(combined);
  if (isBlocked) {
    throw new EmulatorLicenseBlockedError();
  }
  if (probe.exitCode === 0) {
    acceptedCache.add(key);
  }
}

export function markEmulatorLicenseAcceptedForProcess(
  emulatorPath: string,
  sdkPath: string
): void {
  acceptedCache.add(cacheKey(emulatorPath, sdkPath));
}

async function getEmulatorVersionOutputStrict(
  emulatorPath: string,
  sdkPath: string
): Promise<string> {
  const r = await execa(emulatorPath, ['-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEVECO_SDK_HOME: sdkPath },
    reject: false,
    maxBuffer: 1024 * 1024,
  });
  const text = combinedEmulatorOutputText(r.stdout, r.stderr).trim();
  if (r.exitCode !== 0 || !text) {
    throw new Error(
      `Emulator -version failed (exit ${String(r.exitCode)}); cannot resolve .emu_config path.`
    );
  }
  const ck = cacheKey(emulatorPath, sdkPath);
  emulatorVersionTextCache.set(ck, text);
  return text;
}

async function resolveEmuConfigPathForWrites(
  emulatorPath: string,
  sdkPath: string
): Promise<string> {
  const versionText = await getEmulatorVersionOutputStrict(
    emulatorPath,
    sdkPath
  );
  const majorMinor = parseEmulatorMajorMinorFromVersionText(versionText);
  if (!majorMinor) {
    throw new Error(`Cannot parse Emulator major.minor from:\n${versionText}.`);
  }
  return resolveEmuConfigPathFromMajorMinor(majorMinor);
}

function escapeKeyForEmuConfigLineKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryWriteBothAgreementsAsJson(
  emuConfigPath: string,
  raw: string,
  trimmed: string
): Promise<boolean> {
  if (!trimmed.startsWith('{')) {
    return false;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      obj[HARMONYOS_SOFTWARE_SERVICE_AGREEMENT_KEY] = 'agree';
      obj[HARMONYOS_SDK_AGREEMENT_KEY] = 'agree';
      await fs.writeFile(
        emuConfigPath,
        `${JSON.stringify(obj, null, 2)}\n`,
        'utf8'
      );
      return true;
    }
  } catch {
    /* fall through to line format */
  }
  return false;
}

async function writeBothAgreementsLineOriented(
  emuConfigPath: string,
  raw: string
): Promise<void> {
  const service = HARMONYOS_SOFTWARE_SERVICE_AGREEMENT_KEY;
  const sdk = HARMONYOS_SDK_AGREEMENT_KEY;
  const keyRes = [
    {
      k: service,
      re: new RegExp(`^\\s*${escapeKeyForEmuConfigLineKey(service)}\\s*[:=]`),
    },
    {
      k: sdk,
      re: new RegExp(`^\\s*${escapeKeyForEmuConfigLineKey(sdk)}\\s*[:=]`),
    },
  ];
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/);
  const outLines: string[] = [];
  const written = new Set<string>();

  for (const line of lines) {
    let matched = false;
    for (const { k, re } of keyRes) {
      if (re.test(line)) {
        outLines.push(`${k}:agree`);
        written.add(k);
        matched = true;
        break;
      }
    }
    if (!matched) {
      outLines.push(line);
    }
  }
  if (!written.has(service)) {
    outLines.push(`${service}:agree`);
  }
  if (!written.has(sdk)) {
    outLines.push(`${sdk}:agree`);
  }
  await fs.writeFile(
    emuConfigPath,
    outLines.join('\n') + (outLines.length > 0 ? '\n' : ''),
    'utf8'
  );
}

/**
 * Sets both agreement keys to `agree`, preserving JSON when the file parses as JSON,
 * otherwise line-oriented `key:agree` upserts.
 */
async function writeBothAgreementsToEmuConfig(
  emuConfigPath: string
): Promise<void> {
  await fs.mkdir(path.dirname(emuConfigPath), { recursive: true });

  let raw = '';
  try {
    raw = await fs.readFile(emuConfigPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  const trimmed = raw.trim();
  if (await tryWriteBothAgreementsAsJson(emuConfigPath, raw, trimmed)) {
    return;
  }
  await writeBothAgreementsLineOriented(emuConfigPath, raw);
}

/** Prints the bundled HarmonyOS privacy statement (does not spawn Emulator). */
export async function runEmulatorLicenseView(
  _emulatorPath: string,
  _sdkPath: string
): Promise<number> {
  void _emulatorPath;
  void _sdkPath;
  console.log(EMULATOR_PRIVACY_BUNDLED);
  return 0;
}

const LICENSE_ACCEPT_PROMPT =
  'Please read carefully and confirm whether agree to the above agreement? (y/N): ';

/** Returns true when both the service and SDK agreement keys are already set to `agree`. */
async function isEmulatorLicenseAlreadyAccepted(
  emulatorPath: string,
  sdkPath: string
): Promise<boolean> {
  try {
    await ensureEmulatorServiceAgreementConfig(emulatorPath, sdkPath);
    await ensureEmulatorSdkAgreementForImageDownload(emulatorPath, sdkPath);
    return true;
  } catch (e) {
    if (e instanceof EmulatorLicenseBlockedError) {
      return false;
    }
    throw e;
  }
}

/** Shows the bundled privacy statement, prompts y/N, then writes both agreement keys to `.emu_config`. */
export async function runEmulatorLicenseAccept(
  emulatorPath: string,
  sdkPath: string
): Promise<number> {
  if (await isEmulatorLicenseAlreadyAccepted(emulatorPath, sdkPath)) {
    console.log('Emulator license agreements are already accepted.');
    return 0;
  }

  const body = EMULATOR_PRIVACY_BUNDLED;

  console.log(body);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      '`devecocli emulator license` requires an interactive terminal.\n' +
        'For non-interactive environments, use: devecocli emulator license accept'
    );
    return 1;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await rl.question(LICENSE_ACCEPT_PROMPT);
  } finally {
    rl.close();
  }

  const norm = answer.trim().toLowerCase();
  if (norm !== 'y' && norm !== 'yes') {
    console.error(
      'Agreements not accepted. Emulator features will remain blocked until accepted.'
    );
    return 1;
  }

  try {
    const emuConfigPath = await resolveEmuConfigPathForWrites(
      emulatorPath,
      sdkPath
    );
    await writeBothAgreementsToEmuConfig(emuConfigPath);
    invalidateEmulatorLicenseCache();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.log('Emulator license agreements accepted.');
  return 0;
}

/**
 * Non-interactively accepts all emulator license agreements by writing
 * `agree` to `.emu_config` for both keys, without printing the statement or
 * prompting the user. Suitable for automation / non-TTY environments.
 */
export async function runEmulatorLicenseAcceptDirectly(
  emulatorPath: string,
  sdkPath: string
): Promise<number> {
  if (await isEmulatorLicenseAlreadyAccepted(emulatorPath, sdkPath)) {
    console.log('Emulator license agreements are already accepted.');
    return 0;
  }
  try {
    const emuConfigPath = await resolveEmuConfigPathForWrites(
      emulatorPath,
      sdkPath
    );
    await writeBothAgreementsToEmuConfig(emuConfigPath);
    invalidateEmulatorLicenseCache();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.log('Emulator license agreements accepted.');
  return 0;
}
