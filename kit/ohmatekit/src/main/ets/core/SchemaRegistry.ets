/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreField, CoreResult, CoreSchema, CoreValue } from '../api/CoreTypes';

export function coreIdentifier(value: string): boolean {
  return typeof value === 'string' && new RegExp('^[A-Za-z][A-Za-z0-9_.-]{0,63}$').test(value);
}
export class CoreProjection {
  fields: Record<string, CoreValue> = {};
  rejected: number = 0;
  valid: boolean = true;
}
function fieldValid(field: CoreField): boolean {
  if (!coreIdentifier(field.key) ||
    new RegExp('token|cookie|password|secret|body|phone|device|input|email|address|identity', 'i').test(field.key)) {
    return false;
  }
  if (field.kind === 'enum') {
    return Array.isArray(field.values) && field.values !== undefined &&
      field.values.length > 0 && field.values.length <= 32 &&
      new Set<string>(field.values).size === field.values.length &&
      field.values.every((value: string): boolean => coreIdentifier(value));
  }
  if (field.kind === 'number') {
    return field.minimum !== undefined && field.maximum !== undefined &&
      Number.isFinite(field.minimum) && Number.isFinite(field.maximum) &&
      (field.minimum ?? 0) <= (field.maximum ?? 0);
  }
  return field.kind === 'boolean';
}
export class SchemaRegistry {
  private schemas: CoreSchema[] = [];
  register(schema: CoreSchema): CoreResult {
    try {
      if (!coreIdentifier(schema.name) || !Array.isArray(schema.fields) || schema.fields.length > 16 ||
        new Set<string>(schema.fields.map((field: CoreField): string => field.key)).size !== schema.fields.length ||
        !schema.fields.every((field: CoreField): boolean => fieldValid(field))) {
        return new CoreResult('SCHEMA_INVALID');
      }
      if (this.schemas.some((item: CoreSchema): boolean => item.name === schema.name)) {
        return new CoreResult('SCHEMA_CONFLICT');
      }
      if (this.schemas.length >= 64) { return new CoreResult('SCHEMA_QUOTA'); }
      this.schemas.push(JSON.parse(JSON.stringify(schema)) as CoreSchema);
      return new CoreResult('REGISTERED');
    } catch (_) { return new CoreResult('SCHEMA_INVALID'); }
  }
  snapshot(): CoreSchema[] {
    // Registration metadata outside the field contract must not enter an archive.
    return this.schemas.map((schema: CoreSchema): CoreSchema => {
      const fields: CoreField[] = schema.fields.map((field: CoreField): CoreField => {
        if (field.kind === 'enum') { return { key: field.key, kind: 'enum', values: field.values?.slice() ?? [] }; }
        if (field.kind === 'number') {
          return { key: field.key, kind: 'number', minimum: field.minimum ?? 0, maximum: field.maximum ?? 0 };
        }
        return { key: field.key, kind: 'boolean' };
      });
      return { name: schema.name, fields };
    });
  }
  project(name: string, fields: Record<string, Object>): CoreProjection | undefined {
    const schema: CoreSchema | undefined = this.schemas.find((item: CoreSchema): boolean => item.name === name);
    if (schema === undefined) { return undefined; }
    const output = new CoreProjection();
    try {
      const keys: string[] = Object.keys(fields);
      if (keys.length > 64) { output.valid = false; return output; }
      for (const key of keys) {
        const field: CoreField | undefined = schema.fields.find((item: CoreField): boolean => item.key === key);
        const value: Object = fields[key];
        if (field !== undefined && this.accepts(field, value)) {
          output.fields[key] = value as CoreValue;
        } else { output.rejected++; }
      }
    } catch (_) { output.valid = false; }
    return output;
  }
  private accepts(field: CoreField, value: Object): boolean {
    if (field.kind === 'boolean') { return typeof value === 'boolean'; }
    if (field.kind === 'enum') { return typeof value === 'string' && (field.values?.includes(value as string) ?? false); }
    return typeof value === 'number' && Number.isFinite(value as number) &&
      (value as number) >= (field.minimum ?? 0) && (value as number) <= (field.maximum ?? 0);
  }
}
