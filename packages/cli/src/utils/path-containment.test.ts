/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isPathInside } from './path-containment.js';

const ROOT = path.resolve(path.sep, 'data', 'project');
const CHILD = path.join(ROOT, 'entry', 'src');
const SIBLING = path.resolve(path.sep, 'data', 'other');

describe('isPathInside', () => {
  it('accepts the parent itself', () => {
    expect(isPathInside(ROOT, ROOT)).toBe(true);
  });

  it('accepts direct and nested children', () => {
    expect(isPathInside(path.join(ROOT, 'file.txt'), ROOT)).toBe(true);
    expect(isPathInside(CHILD, ROOT)).toBe(true);
  });

  it('accepts children expressed with redundant segments', () => {
    expect(isPathInside(path.join(ROOT, 'a', '..', 'b'), ROOT)).toBe(true);
  });

  it('rejects siblings and ancestors', () => {
    expect(isPathInside(SIBLING, ROOT)).toBe(false);
    expect(isPathInside(path.resolve(ROOT, '..'), ROOT)).toBe(false);
  });

  it('rejects traversal attempts outside the parent', () => {
    const escape = path.join(ROOT, '..', 'outside', 'file.txt');
    expect(isPathInside(escape, ROOT)).toBe(false);
    expect(isPathInside(path.join(ROOT, 'a', '..', '..', 'x'), ROOT)).toBe(
      false
    );
  });

  it('rejects unrelated absolute paths', () => {
    expect(isPathInside(CHILD, SIBLING)).toBe(false);
  });
});
