/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getApiVersionFromFile } from './sdk-config.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-config-ut-'));
  tempRoots.push(root);
  return root;
}

function writeSdkPkg(root: string, data: object): string {
  const filePath = path.join(root, 'sdk-pkg.json');
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('getApiVersionFromFile', () => {
  it('reads the numeric apiVersion from the sdk info file', () => {
    const root = makeRoot();
    const filePath = writeSdkPkg(root, { data: { apiVersion: 20 } });
    expect(getApiVersionFromFile(filePath)).toBe(20);
  });

  it('accepts a string apiVersion and converts it to a number', () => {
    const root = makeRoot();
    const filePath = writeSdkPkg(root, { data: { apiVersion: '12' } });
    expect(getApiVersionFromFile(filePath)).toBe(12);
  });

  it('throws when the sdk info file is missing', () => {
    const root = makeRoot();
    expect(() =>
      getApiVersionFromFile(path.join(root, 'missing.json'))
    ).toThrow(/SDK info file not found/);
  });

  it('throws when the sdk info path is a directory', () => {
    const root = makeRoot();
    expect(() => getApiVersionFromFile(root)).toThrow(
      /Failed to read SDK info file/
    );
  });

  it('throws on invalid JSON content', () => {
    const root = makeRoot();
    const filePath = path.join(root, 'sdk-pkg.json');
    fs.writeFileSync(filePath, 'not json at all', 'utf-8');
    expect(() => getApiVersionFromFile(filePath)).toThrow(/Invalid JSON/);
  });

  it('throws when data.apiVersion is missing', () => {
    const root = makeRoot();
    const filePath = writeSdkPkg(root, { data: {} });
    expect(() => getApiVersionFromFile(filePath)).toThrow(
      /Missing data.apiVersion/
    );
  });

  it('throws when data.apiVersion is an empty string', () => {
    const root = makeRoot();
    const filePath = writeSdkPkg(root, { data: { apiVersion: '' } });
    expect(() => getApiVersionFromFile(filePath)).toThrow(
      /Missing data.apiVersion/
    );
  });

  it('throws when data.apiVersion is not numeric', () => {
    const root = makeRoot();
    const filePath = writeSdkPkg(root, { data: { apiVersion: 'abc' } });
    expect(() => getApiVersionFromFile(filePath)).toThrow(
      /Invalid data.apiVersion/
    );
  });
});
