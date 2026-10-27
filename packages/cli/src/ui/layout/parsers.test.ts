/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeHitTestBehavior,
  parseNullableBool,
  parseBounds,
  resolveText,
  findNodesInTree,
} from './parsers.js';
import type { ArkUiNode } from './types.js';

describe('normalizeHitTestBehavior', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['HitTestMode.Default', undefined],
    ['HitTestMode.Transparent', 'Transparent'],
    ['HitTestMode.None', 'None'],
    ['HitTestMode.Block', 'Block'],
    ['Block', 'Block'],
  ])('normalizeHitTestBehavior(%s) → %s', (input, expected) => {
    expect(normalizeHitTestBehavior(input)).toBe(expected);
  });
});

describe('parseNullableBool', () => {
  it.each([
    [null, undefined],
    [undefined, undefined],
    ['', undefined],
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
    ['yes', undefined],
    [1, undefined],
    [0, undefined],
  ])('parseNullableBool(%s) → %s', (input, expected) => {
    expect(parseNullableBool(input)).toBe(expected);
  });
});

describe('parseBounds', () => {
  it.each([
    [undefined, undefined],
    [123, undefined],
    ['', undefined],
    ['abc', undefined],
    ['1,2,3', undefined],
    ['[0,0,100,200]', [0, 0, 100, 200]],
    ['x: -10, y: 0, w: 50, h: 80', [-10, 0, 50, 80]],
    ['1 2 3 4', [1, 2, 3, 4]],
    ['2000,3000,4000,5000', [2000, 3000, 4000, 5000]],
  ])('parseBounds(%s) → %j', (input, expected) => {
    expect(parseBounds(input)).toEqual(expected);
  });
});

describe('resolveText', () => {
  it.each([
    [{ originalText: 'hello' }, 'hello'],
    [{ originalText: '' }, undefined],
    [{ text: 'fallback', originalText: undefined }, undefined],
    [{ text: 'fallback' }, undefined],
    [{}, undefined],
  ])('resolveText(%j) → %s', (input, expected) => {
    expect(resolveText(input)).toBe(expected);
  });
});

describe('findNodesInTree', () => {
  const leaf = (id?: string, type?: string): ArkUiNode => ({
    id,
    type,
    children: [],
  });

  const tree = (children: ArkUiNode[]): ArkUiNode[] => children;

  it('returns [] for empty tree', () => {
    expect(findNodesInTree([], 'btn')).toEqual([]);
  });

  it('finds root node by id', () => {
    const nodes = tree([leaf('root', 'Flex')]);
    const found = findNodesInTree(nodes, 'root');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('root');
  });

  it('finds nested node at depth 2', () => {
    const child = { id: 'child', type: 'Text', children: [] };
    const root = { id: 'root', type: 'Flex', children: [child] };
    const found = findNodesInTree([root], 'child');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('child');
  });

  it('finds deeply nested node at depth 3', () => {
    const grandchild = {
      id: 'deep',
      type: 'Button',
      children: [],
    };
    const child = { id: 'mid', type: 'Box', children: [grandchild] };
    const root = { id: 'root', type: 'Flex', children: [child] };
    const found = findNodesInTree([root], 'deep');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('deep');
  });

  it('finds all nodes with duplicate id', () => {
    const a = leaf('dup', 'Text');
    const b = leaf('other', 'Box');
    const c = leaf('dup', 'Icon');
    const root = { id: 'root', type: 'Flex', children: [a, b, c] };
    const found = findNodesInTree([root], 'dup');
    expect(found).toHaveLength(2);
    expect(found.map((n) => n.type)).toEqual(['Text', 'Icon']);
  });

  it('returns [] when id does not exist', () => {
    const nodes = tree([
      { id: 'exists', type: 'Flex', children: [leaf('child')] },
    ]);
    expect(findNodesInTree(nodes, 'missing')).toEqual([]);
  });

  it('searches multiple root nodes', () => {
    const a = leaf('a');
    const b = { id: 'b', children: [leaf('target', 'Button')] };
    const found = findNodesInTree([a, b], 'target');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('target');
  });
});
