/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import json5 from 'json5';
import { fileURLToPath } from 'url';
import { createProject, SUPPORTED_DEVICE_TYPES } from './template-provider.js';

const MODULE_JSON5 = ['entry', 'src', 'main', 'module.json5'];
const TEMPLATE_DIR = fileURLToPath(
  new URL('../../templates/application', import.meta.url)
);

let root: string;
let projectPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-template-'));
  projectPath = path.join(root, 'app');
});

afterEach(() => {
  fs.removeSync(root);
});

function readModuleJson5(): string {
  return fs.readFileSync(path.join(projectPath, ...MODULE_JSON5), 'utf-8');
}

function readDeviceTypes(): string[] {
  return json5.parse(readModuleJson5()).module.deviceTypes;
}

function deviceTypesBlock(): string {
  const match = /^([ \t]*)"deviceTypes"\s*:\s*\[[\s\S]*?\]/m.exec(
    readModuleJson5()
  );
  return match?.[0] ?? '';
}

function templateEol(): string {
  const original = fs.readFileSync(
    path.join(TEMPLATE_DIR, ...MODULE_JSON5),
    'utf-8'
  );
  return original.includes('\r\n') ? '\r\n' : '\n';
}

function expectedDeviceTypesBlock(deviceTypes: string[]): string {
  const eol = templateEol();
  const entries = deviceTypes.map((deviceType) => `      "${deviceType}"`);
  return `    "deviceTypes": [${eol}${entries.join(`,${eol}`)}${eol}    ]`;
}

function create(deviceTypes: string[]): void {
  createProject(projectPath, 'MyApp', 'com.example.myapp', 26, deviceTypes);
}

describe('SUPPORTED_DEVICE_TYPES', () => {
  it('matches the DevEco Studio project wizard device types', () => {
    expect([...SUPPORTED_DEVICE_TYPES]).toEqual([
      'phone',
      'tablet',
      '2in1',
      'car',
      'wearable',
      'tv',
    ]);
  });
});

describe('createProject deviceTypes', () => {
  it('writes a single device type with the template indentation and line endings', () => {
    create(['tablet']);

    expect(readDeviceTypes()).toEqual(['tablet']);
    expect(deviceTypesBlock()).toBe(expectedDeviceTypesBlock(['tablet']));
  });

  it('separates multiple device types with commas and keeps their order', () => {
    create(['phone', 'wearable', 'tv']);

    expect(readDeviceTypes()).toEqual(['phone', 'wearable', 'tv']);
    expect(deviceTypesBlock()).toBe(
      expectedDeviceTypesBlock(['phone', 'wearable', 'tv'])
    );
  });

  it('writes every supported device type as parseable JSON5', () => {
    for (const deviceType of SUPPORTED_DEVICE_TYPES) {
      fs.removeSync(projectPath);
      create([deviceType]);

      expect(readDeviceTypes()).toEqual([deviceType]);
    }
  });
});
