/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { extractToolMetrics } from './tool-metrics.js';

/** 模拟 handler 成功返回：单条 text content。 */
function ok(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

/** 来源分类用的固定根路径。 */
const PROJECT = 'D:\\proj';
const SDK = 'C:\\Sdk';

describe('extractToolMetrics', () => {
  it('isError 响应返回空对象', () => {
    expect(
      extractToolMetrics('check', { ...ok('x'), isError: true }, {}, '', '')
    ).toEqual({});
  });

  it('无 content 返回空对象', () => {
    expect(extractToolMetrics('check', {}, {}, '', '')).toEqual({});
  });

  it('空 text 返回空对象', () => {
    expect(extractToolMetrics('check', ok(''), {}, '', '')).toEqual({});
  });

  it('未知工具返回空对象', () => {
    expect(
      extractToolMetrics('unknownTool', ok('anything'), {}, '', '')
    ).toEqual({});
  });

  describe('check', () => {
    it('按 severity 分桶，未知 severity 仅计入总数', () => {
      const diags = [
        { severity: 1, source: 'rule-no-x' },
        { severity: 2 },
        { severity: 3 },
        { severity: 4 },
        { severity: 9 },
      ];
      const text = `a.ets => Diagnostic: ${JSON.stringify(diags)}`;
      expect(extractToolMetrics('check', ok(text), {}, '', '')).toEqual({
        diagTotal: 5,
        diagError: 1,
        diagWarn: 1,
        diagInfo: 2,
        rules: ['rule-no-x'],
      });
    });

    it('无 source 时不含 rules 键', () => {
      const text = `a.ets => Diagnostic: ${JSON.stringify([
        { severity: 1 },
        { severity: 2 },
      ])}`;
      expect(extractToolMetrics('check', ok(text), {}, '', '')).toEqual({
        diagTotal: 2,
        diagError: 1,
        diagWarn: 1,
        diagInfo: 0,
      });
    });

    it('多行输出跳过非诊断行并聚合 rules 去重', () => {
      const text = [
        'Compiling project...',
        `a.ets => Diagnostic: ${JSON.stringify([{ severity: 1, source: 'rule-no-x' }])}`,
        'unrelated output',
        `b.ets => Diagnostic: ${JSON.stringify([
          { severity: 1, source: 'rule-no-x' },
          { severity: 2, source: 'rule-no-y' },
        ])}`,
      ].join('\n');
      expect(extractToolMetrics('check', ok(text), {}, '', '')).toEqual({
        diagTotal: 3,
        diagError: 2,
        diagWarn: 1,
        diagInfo: 0,
        rules: ['rule-no-x', 'rule-no-y'],
      });
    });

    it('非法 JSON 的诊断行跳过', () => {
      expect(
        extractToolMetrics(
          'check',
          ok('a.ets => Diagnostic: not-json'),
          {},
          '',
          ''
        )
      ).toEqual({
        diagTotal: 0,
        diagError: 0,
        diagWarn: 0,
        diagInfo: 0,
      });
    });

    it('非数组 JSON 跳过', () => {
      const text = `a.ets => Diagnostic: ${JSON.stringify({ severity: 1 })}`;
      expect(extractToolMetrics('check', ok(text), {}, '', '')).toEqual({
        diagTotal: 0,
        diagError: 0,
        diagWarn: 0,
        diagInfo: 0,
      });
    });

    it('数组内非对象项跳过', () => {
      const text = `a.ets => Diagnostic: ${JSON.stringify([null, 'str', 42, { severity: 1 }])}`;
      expect(extractToolMetrics('check', ok(text), {}, '', '')).toEqual({
        diagTotal: 1,
        diagError: 1,
        diagWarn: 0,
        diagInfo: 0,
      });
    });
  });

  describe('hover', () => {
    it('payload 可解析时 hit 为 true', () => {
      const text = `hover: ${JSON.stringify({ contents: 'x' })}`;
      expect(extractToolMetrics('hover', ok(text), {}, '', '')).toEqual({
        hit: true,
      });
    });

    it('no result 时 hit 为 false', () => {
      expect(
        extractToolMetrics('hover', ok('hover: no result'), {}, '', '')
      ).toEqual({
        hit: false,
      });
    });

    it('无 ": " 分隔符时 hit 为 false', () => {
      expect(
        extractToolMetrics('hover', ok('hover something'), {}, '', '')
      ).toEqual({
        hit: false,
      });
    });
  });

  describe('definition 与 declaration', () => {
    const args = { file: 'D:\\proj\\src\\a.ets' };

    it('definition 命中工程内文件', () => {
      const text = `definition: ${JSON.stringify({ uri: 'file://D:/proj/src/a.ets' })}`;
      expect(
        extractToolMetrics('definition', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: true,
        sourceType: 'user_project',
      });
    });

    it('declaration 与 definition 行为一致', () => {
      const text = `declaration: ${JSON.stringify({ uri: 'file://D:/proj/src/a.ets' })}`;
      expect(
        extractToolMetrics('declaration', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: true,
        sourceType: 'user_project',
      });
    });

    it('SDK 内文件归类为 sdk', () => {
      const text = `definition: ${JSON.stringify({ uri: 'file://C:/Sdk/ets/api/index.ets' })}`;
      expect(
        extractToolMetrics('definition', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: false,
        sourceType: 'sdk',
      });
    });

    it('工程与 SDK 之外归类为 system', () => {
      const text = `definition: ${JSON.stringify({ uri: 'file://E:/other/x.ets' })}`;
      expect(
        extractToolMetrics('definition', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: false,
        sourceType: 'system',
      });
    });

    it('payload 无 uri 时归类为 unknown', () => {
      const text = `definition: ${JSON.stringify({})}`;
      expect(
        extractToolMetrics('definition', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: false,
        sourceType: 'unknown',
      });
    });

    it('数组 payload 取首个 Location', () => {
      const text = `definition: ${JSON.stringify([
        { uri: 'file://D:/proj/src/a.ets' },
        { uri: 'file://C:/Sdk/x.ets' },
      ])}`;
      expect(
        extractToolMetrics('definition', ok(text), args, PROJECT, SDK)
      ).toEqual({
        found: true,
        sameFile: true,
        sourceType: 'user_project',
      });
    });

    it('no result 时 found 为 false', () => {
      expect(
        extractToolMetrics(
          'definition',
          ok('definition: no result'),
          args,
          PROJECT,
          SDK
        )
      ).toEqual({
        found: false,
      });
    });
  });

  describe('references', () => {
    it('统计引用总数与去重文件数', () => {
      const text = `references: ${JSON.stringify([
        { uri: 'u1' },
        { uri: 'u1' },
        { uri: 'u2' },
        { line: 1 },
      ])}`;
      expect(extractToolMetrics('references', ok(text), {}, '', '')).toEqual({
        refTotal: 4,
        fileCount: 2,
      });
    });

    it('非数组 payload 计零', () => {
      const text = `references: ${JSON.stringify({ uri: 'u1' })}`;
      expect(extractToolMetrics('references', ok(text), {}, '', '')).toEqual({
        refTotal: 0,
        fileCount: 0,
      });
    });

    it('no result 计零', () => {
      expect(
        extractToolMetrics(
          'references',
          ok('references: no result'),
          {},
          '',
          ''
        )
      ).toEqual({
        refTotal: 0,
        fileCount: 0,
      });
    });
  });

  describe('implementation', () => {
    it('数组 payload 返回实现总数', () => {
      const text = `implementation: ${JSON.stringify([{ uri: 'a' }, { uri: 'b' }])}`;
      expect(
        extractToolMetrics('implementation', ok(text), {}, '', '')
      ).toEqual({
        implTotal: 2,
        found: true,
      });
    });

    it('单对象 payload 视为一条', () => {
      const text = `implementation: ${JSON.stringify({ uri: 'a' })}`;
      expect(
        extractToolMetrics('implementation', ok(text), {}, '', '')
      ).toEqual({
        implTotal: 1,
        found: true,
      });
    });

    it('no result 时 found 为 false', () => {
      expect(
        extractToolMetrics(
          'implementation',
          ok('implementation: no result'),
          {},
          '',
          ''
        )
      ).toEqual({ found: false });
    });
  });

  describe('documentSymbol', () => {
    it('递归统计嵌套符号与 kind 分布', () => {
      const syms = [
        {
          kind: 1,
          children: [{ kind: 2 }, { kind: 2, children: [{ kind: 1 }] }],
        },
        { kind: 3 },
      ];
      const text = `documentSymbol: ${JSON.stringify(syms)}`;
      expect(
        extractToolMetrics('documentSymbol', ok(text), {}, '', '')
      ).toEqual({
        symbolTotal: 5,
        kindDist: { 1: 2, 2: 2, 3: 1 },
      });
    });

    it('非对象符号跳过', () => {
      const text = `documentSymbol: ${JSON.stringify([null, { kind: 1 }])}`;
      expect(
        extractToolMetrics('documentSymbol', ok(text), {}, '', '')
      ).toEqual({
        symbolTotal: 1,
        kindDist: { 1: 1 },
      });
    });

    it('缺 kind 的符号计入总数不入分布', () => {
      const text = `documentSymbol: ${JSON.stringify([{}, { kind: 5 }])}`;
      expect(
        extractToolMetrics('documentSymbol', ok(text), {}, '', '')
      ).toEqual({
        symbolTotal: 2,
        kindDist: { 5: 1 },
      });
    });

    it('非数组 payload 返回零值', () => {
      const text = `documentSymbol: ${JSON.stringify({ kind: 1 })}`;
      expect(
        extractToolMetrics('documentSymbol', ok(text), {}, '', '')
      ).toEqual({
        symbolTotal: 0,
        kindDist: {},
      });
    });
  });

  describe('callHierarchy', () => {
    const calls = [
      { from: { uri: 'file://D:/proj/a.ets' } },
      { from: { uri: 'file://C:/Sdk/x.ets' } },
      { to: { uri: 'file://E:/sys.ets' } },
    ];

    it('incoming 方向按 from 分类来源', () => {
      const text = `callHierarchy: ${JSON.stringify({ calls })}`;
      expect(
        extractToolMetrics(
          'callHierarchy',
          ok(text),
          { direction: 'incoming' },
          PROJECT,
          SDK
        )
      ).toEqual({
        callsTotal: 3,
        calleeSrcDist: { user_project: 1, sdk: 1, unknown: 1 },
      });
    });

    it('outgoing 方向按 to 分类来源', () => {
      const text = `callHierarchy: ${JSON.stringify({ calls })}`;
      expect(
        extractToolMetrics(
          'callHierarchy',
          ok(text),
          { direction: 'outgoing' },
          PROJECT,
          SDK
        )
      ).toEqual({
        callsTotal: 3,
        calleeSrcDist: { unknown: 2, system: 1 },
      });
    });

    it('direction 缺省按 to 分类', () => {
      const text = `callHierarchy: ${JSON.stringify({ calls })}`;
      expect(
        extractToolMetrics('callHierarchy', ok(text), {}, PROJECT, SDK)
      ).toEqual({
        callsTotal: 3,
        calleeSrcDist: { unknown: 2, system: 1 },
      });
    });

    it('非对象 call 计入总数不入分布', () => {
      const text = `callHierarchy: ${JSON.stringify({
        calls: [null, { to: { uri: 'file://E:/x.ets' } }],
      })}`;
      expect(
        extractToolMetrics('callHierarchy', ok(text), {}, PROJECT, SDK)
      ).toEqual({
        callsTotal: 2,
        calleeSrcDist: { system: 1 },
      });
    });

    it('无 calls 字段计零', () => {
      const text = `callHierarchy: ${JSON.stringify({})}`;
      expect(
        extractToolMetrics('callHierarchy', ok(text), {}, PROJECT, SDK)
      ).toEqual({
        callsTotal: 0,
        calleeSrcDist: {},
      });
    });
  });

  describe('workspaceSymbol', () => {
    it('统计 kind 分布、deprecated 命中与查询长度', () => {
      const syms = [
        { kind: 1 },
        { kind: 1, tags: [1] },
        { deprecated: true },
        { kind: 2 },
      ];
      const text = `workspaceSymbol: ${JSON.stringify(syms)}`;
      expect(
        extractToolMetrics(
          'workspaceSymbol',
          ok(text),
          { query: 'foo' },
          '',
          ''
        )
      ).toEqual({
        resultTotal: 4,
        kindDist: { 1: 2, 2: 1 },
        deprecatedHit: 2,
        queryLen: 3,
      });
    });

    it('无 query 时不含 queryLen 键', () => {
      const text = `workspaceSymbol: ${JSON.stringify([{ kind: 1 }])}`;
      expect(
        extractToolMetrics('workspaceSymbol', ok(text), {}, '', '')
      ).toEqual({
        resultTotal: 1,
        kindDist: { 1: 1 },
        deprecatedHit: 0,
      });
    });

    it('tags 不含 1 且 deprecated 非 true 不计入 deprecatedHit', () => {
      const syms = [{ tags: [2] }, { deprecated: 'yes' }];
      const text = `workspaceSymbol: ${JSON.stringify(syms)}`;
      expect(
        extractToolMetrics('workspaceSymbol', ok(text), { query: 'x' }, '', '')
      ).toEqual({
        resultTotal: 2,
        kindDist: {},
        deprecatedHit: 0,
        queryLen: 1,
      });
    });

    it('非对象符号计入 resultTotal 不入 kindDist', () => {
      const text = `workspaceSymbol: ${JSON.stringify([null, { kind: 1 }])}`;
      expect(
        extractToolMetrics('workspaceSymbol', ok(text), { query: 'q' }, '', '')
      ).toEqual({
        resultTotal: 2,
        kindDist: { 1: 1 },
        deprecatedHit: 0,
        queryLen: 1,
      });
    });
  });
});
