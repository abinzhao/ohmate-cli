/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collapse } from './collapse.js';
import type { ArkUiNode } from './types.js';

const node = (
  overrides: Partial<ArkUiNode> & { children?: ArkUiNode[] } = {}
): ArkUiNode => ({
  children: [],
  ...overrides,
});

const originalDebug = process.env.DEVECO_CLI_DEBUG;

beforeEach(() => {
  process.env.DEVECO_CLI_DEBUG = undefined;
});

afterEach(() => {
  process.env.DEVECO_CLI_DEBUG = originalDebug;
});

describe('collapse', () => {
  it('returns root when tree has a single node', () => {
    const root = node({ type: 'Flex' });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Flex');
    expect(result[0].children).toEqual([]);
  });

  it('preserves root interactive flag', () => {
    const root = node({ type: 'Flex', clickable: true });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].clickable).toBe(true);
  });

  it('emits interactive child directly under root', () => {
    const child = node({
      id: 'btn',
      type: 'Button',
      clickable: true,
    });
    const root = node({ type: 'Flex', children: [child] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('btn');
    expect(result[0].children[0].clickable).toBe(true);
  });

  it('collapses non-interactive wrapper, moving interactive leaf up', () => {
    const leaf = node({
      id: 'btn',
      type: 'Button',
      clickable: true,
    });
    const wrapper = node({ type: 'Box', children: [leaf] });
    const root = node({ type: 'Flex', children: [wrapper] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('btn');
  });

  it('collapses deeply nested non-interactive chain', () => {
    const leaf = node({
      id: 'btn',
      type: 'Button',
      clickable: true,
    });
    const l3 = node({ type: 'Box', children: [leaf] });
    const l2 = node({ type: 'Box', children: [l3] });
    const l1 = node({ type: 'Box', children: [l2] });
    const root = node({ type: 'Flex', children: [l1] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('btn');
  });

  it('preserves child with text but no id', () => {
    const textChild = node({ type: 'Text', text: 'Hello' });
    const root = node({ type: 'Flex', children: [textChild] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].text).toBe('Hello');
  });

  it('preserves child with scrollable but no id', () => {
    const scrollChild = node({ type: 'List', scrollable: true });
    const root = node({ type: 'Flex', children: [scrollChild] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].scrollable).toBe(true);
  });

  it('preserves child with longClickable but no id', () => {
    const lcChild = node({ type: 'Item', longClickable: true });
    const root = node({ type: 'Flex', children: [lcChild] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].longClickable).toBe(true);
  });

  it('preserves child with checkable but no id', () => {
    const chkChild = node({ type: 'Check', checkable: true });
    const root = node({ type: 'Flex', children: [chkChild] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].checkable).toBe(true);
  });

  it('preserves child with id but nothing else', () => {
    const idChild = node({ id: 'section', type: 'Box' });
    const root = node({ type: 'Flex', children: [idChild] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('section');
  });

  it('maxDepth=0 does not limit depth', () => {
    const leaf = node({
      id: 'leaf',
      type: 'Button',
      clickable: true,
    });
    const mid = node({ type: 'Box', children: [leaf] });
    const wrapper = node({ type: 'Box', children: [mid] });
    const root = node({ type: 'Flex', children: [wrapper] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('leaf');
  });

  it('maxDepth=1 emits only root', () => {
    const child = node({
      id: 'btn',
      type: 'Button',
      clickable: true,
    });
    const root = node({ type: 'Flex', children: [child] });
    const result = collapse(root, 1);
    expect(result).toHaveLength(1);
    expect(result[0].children).toEqual([]);
  });

  it('maxDepth=2 emits root and first level only', () => {
    const grandchild = node({
      id: 'inner',
      type: 'Button',
      clickable: true,
    });
    const child = node({
      id: 'outer',
      type: 'Box',
      children: [grandchild],
    });
    const root = node({ type: 'Flex', children: [child] });
    const result = collapse(root, 2);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('outer');
    expect(result[0].children[0].children).toEqual([]);
  });

  it('handles multiple interactive siblings under same root', () => {
    const btn = node({ id: 'btn', type: 'Button', clickable: true });
    const txt = node({ type: 'Text', text: 'Label' });
    const list = node({ type: 'List', scrollable: true });
    const root = node({
      type: 'Flex',
      children: [btn, txt, list],
    });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(3);
    expect(result[0].children[0].id).toBe('btn');
    expect(result[0].children[1].text).toBe('Label');
    expect(result[0].children[2].scrollable).toBe(true);
  });

  it('collapses wrapper between two interactive nodes', () => {
    const btn = node({ id: 'btn', type: 'Button', clickable: true });
    const wrapper = node({ type: 'Box', children: [btn] });
    const txt = node({ type: 'Text', text: 'Hello' });
    const root = node({
      type: 'Flex',
      children: [wrapper, txt],
    });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].id).toBe('btn');
    expect(result[0].children[1].text).toBe('Hello');
  });

  it('empty children array on root returns root with empty children', () => {
    const root = node({ type: 'Flex', children: [] });
    const result = collapse(root, 0);
    expect(result).toHaveLength(1);
    expect(result[0].children).toEqual([]);
  });
});
