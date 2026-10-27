/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveModuleSrcPath } from './module-path.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-path-ut-'));
  tempRoots.push(root);
  return root;
}

function makeProjectRoot(): string {
  const root = makeRoot();
  fs.writeFileSync(
    path.join(root, 'build-profile.json5'),
    JSON.stringify({
      modules: [
        { name: 'entry', srcPath: './entry' },
        { name: 'lib', srcPath: 'libfeature' },
      ],
    })
  );
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveModuleSrcPath', () => {
  it('resolves the module srcPath and strips the ./ prefix', () => {
    const root = makeProjectRoot();
    expect(resolveModuleSrcPath(root, 'entry')).toBe('entry');
    expect(resolveModuleSrcPath(root, 'lib')).toBe('libfeature');
  });

  it('falls back to the module name when the profile is missing', () => {
    const root = makeRoot();
    expect(resolveModuleSrcPath(root, 'entry')).toBe('entry');
  });

  it('falls back to the module name when the module is not in the profile', () => {
    const root = makeProjectRoot();
    expect(resolveModuleSrcPath(root, 'nope')).toBe('nope');
  });

  it('falls back to the module name on malformed profile content', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'build-profile.json5'), '{{{');
    expect(resolveModuleSrcPath(root, 'entry')).toBe('entry');
  });
});
