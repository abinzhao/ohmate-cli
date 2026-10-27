/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { canonicalJson } from '../debug-protocol/canonical-hash.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function newerProblemMinor(value: unknown): boolean {
  return record(value) && typeof value.schemaVersion === 'string' && /^1\.[1-9]\d{0,3}$/.test(value.schemaVersion);
}

// Only additive object properties may vary. Canonical constraints and union
// alternatives remain pinned; candidate schemas are data, never validators.
export function compatibleProblemSchema(candidate: unknown, canonical: unknown): boolean {
  if (!record(canonical)) { return canonicalJson(candidate) === canonicalJson(canonical); }
  if (!record(candidate)) { return false; }
  const annotations = new Set(['title', 'description', '$comment', 'examples', 'deprecated']);
  if (Object.keys(candidate).some((key) => !Object.hasOwn(canonical, key) && !annotations.has(key))) { return false; }
  for (const [key, expected] of Object.entries(canonical)) {
    const actual = candidate[key];
    if (key === 'properties' && record(expected)) {
      if (!record(actual) || Object.entries(expected).some(([name, schema]) => !compatibleProblemSchema(actual[name], schema))) { return false; }
    } else if (key === 'required' && Array.isArray(expected)) {
      const properties = record(canonical.properties) ? canonical.properties : {};
      if (!Array.isArray(actual) || expected.some((name) => !actual.includes(name)) ||
        actual.some((name) => typeof name !== 'string' || Object.hasOwn(properties, name) && !expected.includes(name) ||
          !record(candidate.properties) || !Object.hasOwn(candidate.properties, name))) { return false; }
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length ||
        expected.some((item, index) => !compatibleProblemSchema(actual[index], item))) { return false; }
    } else if (!compatibleProblemSchema(actual, expected)) { return false; }
  }
  return true;
}

export function knownProblemFields(value: unknown, schema: unknown, omitted: { count: number }): unknown {
  if (!record(schema)) { return value; }
  if (Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.find((option) => record(option) && record(option.properties) &&
      record(option.properties.channel) && record(value) && option.properties.channel.const === value.channel);
    return branch ? knownProblemFields(value, branch, omitted) : value;
  }
  if (record(schema.properties) && record(value)) {
    const properties = schema.properties;
    omitted.count += Object.keys(value).filter((key) => !Object.hasOwn(properties, key)).length;
    return Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(properties, key))
      .map(([key, item]) => [key, knownProblemFields(item, properties[key], omitted)]));
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    return value.map((item) => knownProblemFields(item, schema.items, omitted));
  }
  return value;
}
