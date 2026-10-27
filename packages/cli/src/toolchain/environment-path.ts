/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { resolveCanonicalPath } from '../utils/path-containment.js';

export function stripEnvPathQuotes(value: string): string {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function resolveEnvRoot(value: string): string {
  const normalized = stripEnvPathQuotes(value);
  if (!normalized) {
    throw new Error('Path must not be empty.');
  }
  return resolveCanonicalPath(normalized);
}
