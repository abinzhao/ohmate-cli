/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'node:path';
import { DEVICE_STAGING_DIR, ScreenRecordError } from './types.js';

/** Safe charset for names that cross into device shell command lines. */
export const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\.mp4$/;

/** `<dataDir>/record` file key for a serial: hex keeps names safe + reversible. */
export function encodeSerial(serial: string): string {
  return Buffer.from(serial, 'utf8').toString('hex');
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `20260916-115530123` — readable, sortable, ms-resolution timestamp. */
export function formatTimestamp(date: Date): string {
  return (
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
    `-${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Make a device name safe as a local file-name component: replace characters
 * illegal on Windows / risky on shells, collapse whitespace, trim dots and
 * spaces at the edges (Windows forbids trailing dots).
 */
export function sanitizeDeviceName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- must match control chars to sanitize them
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '');
  return cleaned || 'device';
}

/** Device-side unique media name: `devecocli-<ts>-<rand4>.mp4`. */
export function makeDeviceFileName(date: Date, rand4: string): string {
  if (!/^[a-z0-9]{4}$/.test(rand4)) {
    throw new ScreenRecordError(
      'INVALID_RECORDING_PATH',
      `Internal: bad random suffix ${JSON.stringify(rand4)}`
    );
  }
  return `devecocli-${formatTimestamp(date)}-${rand4}.mp4`;
}

/** Auto local name for directory destinations: `<device>-<ts>-<rand4>.mp4`. */
export function makeLocalFileName(
  deviceName: string,
  date: Date,
  rand4: string
): string {
  return `${sanitizeDeviceName(deviceName)}-${formatTimestamp(date)}-${rand4}.mp4`;
}

/** Staging path on device for one export attempt; internal safe charset only. */
export function makeStagingPath(fileName: string, rand4: string): string {
  if (!DEVICE_NAME_RE.test(fileName)) {
    throw new ScreenRecordError(
      'INVALID_RECORDING_PATH',
      `Unsafe device file name: ${JSON.stringify(fileName)}`
    );
  }
  return `${DEVICE_STAGING_DIR}/devecocli-${rand4}-${fileName}`;
}

/** Assert a persisted device file name is a plain safe basename. */
export function assertSafeDeviceFileName(fileName: string): void {
  if (!DEVICE_NAME_PERSISTED_RE.test(fileName)) {
    throw new Error(`Invalid session fileName: ${JSON.stringify(fileName)}`);
  }
}

/** Persisted names predate sanitization rules; accept but forbid traversal. */
const DEVICE_NAME_PERSISTED_RE = /^(?!\.{1,2}$)[^/\\:]+\.mp4$/;

/**
 * Non-overwrite candidate sequence: `demo.mp4` → `demo-recovered.mp4` →
 * `demo-recovered-2.mp4` → … up to a bounded count.
 */
export const MAX_PUBLISH_CANDIDATES = 20;

export function recoveryCandidates(target: string): string[] {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  const candidates = [target];
  candidates.push(path.join(dir, `${base}-recovered${ext}`));
  for (let i = 2; i < MAX_PUBLISH_CANDIDATES; i++) {
    candidates.push(path.join(dir, `${base}-recovered-${i}${ext}`));
  }
  return candidates;
}
