/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export interface FloatingPosition {
  rightSide: boolean;
  edgeRatio: number;
}
export interface FloatingPositionStore {
  read(scope: string, bucket: string): Promise<FloatingPosition | undefined>;
  write(scope: string, bucket: string, position: FloatingPosition): Promise<boolean>;
  getState?(): string;
  retry?(): Promise<boolean>;
}
export function positionScopeValid(scope: string): boolean {
  return typeof scope === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(scope);
}
export function positionValid(position: FloatingPosition): boolean {
  return position !== undefined && position !== null && typeof position.rightSide === 'boolean' &&
    Number.isFinite(position.edgeRatio) && position.edgeRatio >= 0 && position.edgeRatio <= 1;
}
export function positionBucket(width: number, height: number): string {
  const short: number = Math.min(width, height);
  const long: number = Math.max(width, height);
  return (width === height ? 's' : width < height ? 'p' : 'l') +
    (short < 600 ? '0' : short < 840 ? '1' : '2') +
    (long < 600 ? '0' : long < 840 ? '1' : '2');
}
export class PositionBucket {
  bucket: string;
  value: FloatingPosition = { rightSide: true, edgeRatio: 0.65 };
  revision: number = 0;
  loaded: boolean = false;
  dirty: boolean = false;
  constructor(bucket: string) { this.bucket = bucket; }
}
