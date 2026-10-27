/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * Version comparison (no third-party dependency)
 * @returns 1 / 0 / -1
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) {
      return 1;
    }
    if (na < nb) {
      return -1;
    }
  }
  return 0;
}

function normalize(v: string): number[] {
  return String(v || '')
    .trim()
    .split(/[.\-+_]/)
    .filter(Boolean)
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

/**
 * Extract version number like 1.2.3 from text
 */
export function extractVersion(text: string): string | null {
  const m = /(\d+(?:\.\d+)+)/.exec(String(text || ''));
  return m ? m[1] : null;
}