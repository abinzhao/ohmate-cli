/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export const DIRECTION_MAP: Record<string, string> = {
  left: '0',
  right: '1',
  up: '2',
  down: '3',
};

export interface ClickOptions {
  device?: string;
  id?: string;
  window?: string;
}

export interface SwipeOptions {
  device?: string;
  speed?: string;
}

export interface TextOptions {
  device?: string;
  id?: string;
  window?: string;
}

export function assertCoord(value: string, name: string): void {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function assertOptionalCoord(
  value: string | undefined,
  name: string
): void {
  if (value !== undefined) {
    assertCoord(value, name);
  }
}

export function assertCoordsPair(
  x: string | undefined,
  y: string | undefined
): void {
  if ((x === undefined) !== (y === undefined)) {
    throw new Error('x and y must be provided together');
  }
}

export function assertNonEmpty(
  value: string | undefined,
  name: string
): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

export function assertSpeed(
  raw: string | undefined
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 200 || n > 40000) {
    throw new Error('--speed must be an integer between 200 and 40000');
  }
  return raw;
}

export function assertWindowId(value: string | undefined): void {
  if (value !== undefined && !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('--window must consist of letters, digits, - or _');
  }
}

export function assertTargetRule(
  hasCoords: boolean,
  hasId: boolean,
  hasWindow: boolean,
  requireOne = true
): void {
  if (hasWindow && !hasId) {
    throw new Error('--window must be used with --id');
  }
  if (hasCoords && hasId) {
    throw new Error('Coordinates and --id are mutually exclusive');
  }
  if (requireOne && !hasCoords && !hasId) {
    throw new Error('Either provide x y coordinates or use --id');
  }
}

export function assertTargetParams(
  x: string | undefined,
  y: string | undefined,
  id: string | undefined,
  window: string | undefined,
  requireOne = true
): void {
  assertCoordsPair(x, y);
  assertNonEmpty(id, '--id');
  assertOptionalCoord(x, 'x');
  assertOptionalCoord(y, 'y');
  assertWindowId(window);
  assertTargetRule(x !== undefined, !!id, !!window, requireOne);
}
