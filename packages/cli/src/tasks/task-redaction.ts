/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
const names = '(?:api[_-]?key|password|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|(?:client[_-]?)?secret|authorization|private[_-]?key)';
export const secretKey = new RegExp(`^${names}$`, 'i');
const secretAssignment = new RegExp(`\\b${names}["']?\\s*[=:]\\s*(?:"[^"]*"|'[^']*'|[^\\s,}]+)`, 'gi');

export function redactTaskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/authorization["']?\s*:\s*bearer\s+\S+/gi, '[REDACTED]')
      .replace(secretAssignment, '[REDACTED]');
  }
  if (Array.isArray(value)) { return value.map(redactTaskValue); }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Object.fromEntries(entries.filter(([key]) => !secretKey.test(key))
      .map(([key, child]) => [key, redactTaskValue(child)]));
  }
  return value;
}
