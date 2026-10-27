/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Character set safe without quoting (improves readability, does not change semantics) */
const SAFE_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Regex to match single quotes in shell text */
const SINGLE_QUOTE_RE = /'/g;
/** Shell escape sequence for a literal single quote inside single-quoted string */
const ESCAPED_SINGLE_QUOTE = `'\\''`;

/**
 * POSIX single-quote hard quoting: turns any string into a single literal token in shell
 */
export function shellQuote(value: string | number | boolean): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (text === '') {
    return "''";
  }
  if (SAFE_PATTERN.test(text)) {
    return text;
  }
  return `'${text.replace(SINGLE_QUOTE_RE, ESCAPED_SINGLE_QUOTE)}'`;
}

/**
 * Join an argv array into a single safe shell command line
 */
export function shellJoin(argv: (string | number | boolean)[]): string {
  if (!Array.isArray(argv)) {
    throw new TypeError('shellJoin expects an array of arguments');
  }
  return argv
    .filter((item) => item !== undefined && item !== null && item !== '')
    .map((item) => shellQuote(item))
    .join(' ');
}

/**
 * Single-line command validation: prohibit newline / carriage return / NUL, preventing "one line becomes multiple lines" injection of a second command
 */
export function assertShellLine(cmd: string): string {
  const text = String(cmd ?? '');
  if (/[\r\n\0]/.test(text)) {
    throw new ShellSafetyError('shell command must not contain newline or NUL characters');
  }
  return text;
}

/**
 * Remote path validation: must be an absolute path, and must not contain shell control characters (quoting is the external defense, this is the fallback)
 */
export function assertRemotePath(path: string): string {
  const text = String(path ?? '').trim();
  if (!text) {
    throw new ShellSafetyError('remote path is empty');
  }
  if (!text.startsWith('/')) {
    throw new ShellSafetyError(`remote path must be absolute: ${JSON.stringify(path)}`);
  }
  if (/[\r\n\0]/.test(text)) {
    throw new ShellSafetyError('remote path must not contain newline or NUL characters');
  }
  return text;
}

/**
 * Validate and normalize pid (must be a positive integer)
 */
export function assertPid(pid: number | string): number {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ShellSafetyError(`invalid pid: ${JSON.stringify(pid)}`);
  }
  return value;
}

/**
 * Validate device endpoint descriptor, e.g., localabstract:uitest_socket / tcp:8012
 */
export function assertDeviceEndpoint(endpoint: string): string {
  const text = String(endpoint ?? '').trim();
  if (!/^(localabstract|localfilesystem|tcp|jdwp):[A-Za-z0-9_.-]+$/.test(text)) {
    throw new ShellSafetyError(`invalid device endpoint: ${JSON.stringify(endpoint)}`);
  }
  return text;
}

/**
 * Validate host port number
 */
export function assertHostPort(port: number | string): number {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ShellSafetyError(`invalid host port: ${JSON.stringify(port)}`);
  }
  return value;
}

/** Escaping-related errors */
export class ShellSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellSafetyError';
  }
}

export default {
  shellQuote,
  shellJoin,
  assertShellLine,
  assertRemotePath,
  assertPid,
  assertDeviceEndpoint,
  assertHostPort,
  ShellSafetyError,
};