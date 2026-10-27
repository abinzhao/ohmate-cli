/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createToolRouter,
  ToolRouter,
  type ToolDefinition,
  type ToolHandler,
} from './router.js';

const makeHandler =
  (mark: string): ToolHandler =>
  async () => ({
    content: [{ type: 'text', text: mark }],
  });

const makeDef = (name: string): ToolDefinition => ({
  name,
  description: `desc of ${name}`,
  inputSchema: z.object({}),
});

describe('ToolRouter', () => {
  it('初始状态 getAll 为空', () => {
    expect(createToolRouter().getAll()).toEqual([]);
  });

  it('add 返回 this 支持链式注册', () => {
    const router = createToolRouter();
    expect(router.add(makeDef('a'), makeHandler('a'))).toBe(router);
  });

  it('按注册顺序返回全部工具', () => {
    const router = createToolRouter()
      .add(makeDef('a'), makeHandler('a'))
      .add(makeDef('b'), makeHandler('b'))
      .add(makeDef('c'), makeHandler('c'));
    expect(router.getAll().map((t) => t.definition.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('条目保存原始 definition 与 handler 引用', () => {
    const def = makeDef('a');
    const handler = makeHandler('a');
    const entry = createToolRouter().add(def, handler).getAll()[0];
    expect(entry.definition).toBe(def);
    expect(entry.handler).toBe(handler);
  });

  it('同名工具覆盖注册', () => {
    const first = makeHandler('first');
    const second = makeHandler('second');
    const router = createToolRouter()
      .add(makeDef('a'), first)
      .add(makeDef('a'), second);
    const all = router.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].handler).toBe(second);
    expect(all[0].handler).not.toBe(first);
  });

  it('覆盖时保持首次注册位置（Map 语义）', () => {
    const router = createToolRouter()
      .add(makeDef('a'), makeHandler('a1'))
      .add(makeDef('b'), makeHandler('b'))
      .add(makeDef('a'), makeHandler('a2'));
    expect(router.getAll().map((t) => t.definition.name)).toEqual(['a', 'b']);
  });

  it('getAll 每次返回新数组，外部修改不影响内部', () => {
    const router = createToolRouter()
      .add(makeDef('a'), makeHandler('a'))
      .add(makeDef('b'), makeHandler('b'));
    const snapshot = router.getAll();
    expect(router.getAll()).not.toBe(snapshot);
    snapshot.pop();
    expect(router.getAll()).toHaveLength(2);
  });

  it('createToolRouter 产出 ToolRouter 实例', () => {
    expect(createToolRouter()).toBeInstanceOf(ToolRouter);
    expect(new ToolRouter().getAll()).toEqual([]);
  });
});
