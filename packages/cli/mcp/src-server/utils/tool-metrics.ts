/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import path from 'node:path';

/**
 * MCP 工具返回结果的派生指标提取。仅产出计数/分布/布尔/来源分类等聚合指标，
 * **不采集** 代码内容、符号名、路径原文、range 等敏感字段（见 docs 下打点合规建议）。
 * router 在 handler 返回后调用，把结果**平铺**进 devecocli_serve_mcp 事件的 event_detail。
 * 返回 camelCase 键（经 snake_case 序列化器 → diag_total 等下划线 wire 名），
 * 与 events.ts 中各 *ToolCall 接口字段一一对应。
 */

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };

/**
 * @param tool 工具名（check/hover/definition/...）
 * @param result handler 返回的 ToolCallResult
 * @param args handler 入参（用于 same_file/query_len/direction）
 * @param projectPath 工程根（来源分类用）
 * @param sdkPath SDK 根（来源分类用）
 */
export function extractToolMetrics(
  tool: string,
  result: ToolResult,
  args: Record<string, unknown>,
  projectPath: string,
  sdkPath: string,
): Record<string, unknown> {
  if (result.isError) {
    return {};
  }
  const text = result.content?.[0]?.text ?? '';
  if (!text) {
    return {};
  }
  let m: Record<string, unknown>;
  switch (tool) {
    case 'check':
      m = extractCheck(text);
      break;
    case 'hover':
      m = { hit: parsePayload(text) != null };
      break;
    case 'definition':
    case 'declaration':
      m = extractLocationLike(text, args, projectPath, sdkPath, true);
      break;
    case 'references':
      m = extractReferences(text);
      break;
    case 'implementation':
      m = extractLocationLike(text, args, projectPath, sdkPath, false);
      break;
    case 'documentSymbol':
      m = extractDocumentSymbol(text);
      break;
    case 'callHierarchy':
      m = extractCallHierarchy(text, args, projectPath, sdkPath);
      break;
    case 'workspaceSymbol':
      m = extractWorkspaceSymbol(text, args);
      break;
    default:
      m = {};
  }
  return m;
}

/** 触发文件扩展名（小写无点，如 ets/ts/cpp）；check 取 args.files[0]，无文件返回 undefined。 */
export function triggerFileExt(args: Record<string, unknown>): string | undefined {
  const f = Array.isArray(args.files) ? args.files[0] : args.file;
  if (typeof f !== 'string' || !f) {
    return undefined;
  }
  const ext = path.extname(f).toLowerCase().replace(/^\./, '');
  return ext || undefined;
}

/** 取 `<prefix>: <json>` 中首个 `: ` 之后的 JSON；`no result`/无 JSON 返回 undefined。 */
function parsePayload(text: string): unknown {
  const idx = text.indexOf(': ');
  if (idx < 0) {
    return undefined;
  }
  const rest = text.slice(idx + 2).trim();
  if (!rest || rest === 'no result') {
    return undefined;
  }
  try {
    return JSON.parse(rest);
  } catch {
    return undefined;
  }
}

function extractCheck(text: string): Record<string, unknown> {
  const acc = { total: 0, error: 0, warn: 0, info: 0 };
  const rules = new Set<string>();
  const marker = ' => Diagnostic: ';
  for (const line of text.split('\n')) {
    const i = line.indexOf(marker);
    if (i < 0) {
      continue;
    }
    let arr: unknown;
    try {
      arr = JSON.parse(line.slice(i + marker.length));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const d of arr) {
      if (d && typeof d === 'object') {
        tallyDiagnostic(d as Record<string, unknown>, acc, rules);
      }
    }
  }
  const m: Record<string, unknown> = {
    diagTotal: acc.total,
    diagError: acc.error,
    diagWarn: acc.warn,
    diagInfo: acc.info,
  };
  if (rules.size > 0) {
    m.rules = [...rules];
  }
  return m;
}

function tallyDiagnostic(d: Record<string, unknown>, acc: { total: number; error: number; warn: number; info: number }, rules: Set<string>): void {
  acc.total++;
  const sev = d.severity;
  if (sev === 1) {
    acc.error++;
  } else if (sev === 2) {
    acc.warn++;
  } else if (sev === 3 || sev === 4) {
    acc.info++;
  }
  if (typeof d.source === 'string') {
    rules.add(d.source);
  }
}

function extractReferences(text: string): Record<string, unknown> {
  const p = parsePayload(text);
  const locs = Array.isArray(p) ? p : [];
  const uris = new Set<string>();
  for (const l of locs) {
    const u = (l as { uri?: unknown })?.uri;
    if (typeof u === 'string') {
      uris.add(u);
    }
  }
  return { refTotal: locs.length, fileCount: uris.size };
}

/** definition/declaration 与 implementation 共用 Location|Location[]|null 形状。 */
function extractLocationLike(
  text: string,
  args: Record<string, unknown>,
  projectPath: string,
  sdkPath: string,
  withSameFileAndSource: boolean,
): Record<string, unknown> {
  const p = parsePayload(text);
  if (p == null) {
    return { found: false };
  }
  const locs = Array.isArray(p) ? p : [p];
  const firstUri = (locs[0] as { uri?: unknown })?.uri;
  if (withSameFileAndSource) {
    return {
      found: true,
      sameFile: isSameFile(firstUri, args),
      sourceType: classifySource(firstUri, projectPath, sdkPath),
    };
  }
  return { implTotal: locs.length, found: true };
}

function extractDocumentSymbol(text: string): Record<string, unknown> {
  const p = parsePayload(text);
  const syms = Array.isArray(p) ? p : [];
  let total = 0;
  const kindDist = new Map<number, number>();
  const walk = (arr: unknown[]): void => {
    for (const s of arr) {
      if (!s || typeof s !== 'object') {
        continue;
      }
      total++;
      const k = (s as { kind?: unknown }).kind;
      if (typeof k === 'number') {
        kindDist.set(k, (kindDist.get(k) ?? 0) + 1);
      }
      const children = (s as { children?: unknown }).children;
      if (Array.isArray(children)) {
        walk(children);
      }
    }
  };
  walk(syms);
  return { symbolTotal: total, kindDist: toObject(kindDist) };
}

function extractCallHierarchy(
  text: string,
  args: Record<string, unknown>,
  projectPath: string,
  sdkPath: string,
): Record<string, unknown> {
  const p = parsePayload(text);
  const calls = (p as { calls?: unknown })?.calls;
  const arr = Array.isArray(calls) ? calls : [];
  const dir = args.direction;
  const dist = new Map<string, number>();
  for (const c of arr) {
    if (!c || typeof c !== 'object') {
      continue;
    }
    const target = dir === 'incoming' ? (c as { from?: unknown }).from : (c as { to?: unknown }).to;
    const uri = (target as { uri?: unknown })?.uri;
    const src = classifySource(uri, projectPath, sdkPath);
    dist.set(src, (dist.get(src) ?? 0) + 1);
  }
  return { callsTotal: arr.length, calleeSrcDist: toObject(dist) };
}

function extractWorkspaceSymbol(text: string, args: Record<string, unknown>): Record<string, unknown> {
  const p = parsePayload(text);
  const syms = Array.isArray(p) ? p : [];
  const kindDist = new Map<number, number>();
  let deprecated = 0;
  for (const s of syms) {
    if (!s || typeof s !== 'object') {
      continue;
    }
    const k = (s as { kind?: unknown }).kind;
    if (typeof k === 'number') {
      kindDist.set(k, (kindDist.get(k) ?? 0) + 1);
    }
    const tags = (s as { tags?: unknown }).tags;
    if ((Array.isArray(tags) && tags.includes(1)) || (s as { deprecated?: unknown }).deprecated === true) {
      deprecated++;
    }
  }
  const m: Record<string, unknown> = {
    resultTotal: syms.length,
    kindDist: toObject(kindDist),
    deprecatedHit: deprecated,
  };
  const q = args.query;
  if (typeof q === 'string') {
    m.queryLen = q.length;
  }
  return m;
}

/** uri → 本地路径（剥 file:// 前缀）。 */
function uriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) {
    return null;
  }
  let s = uri;
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    if (process.platform === 'win32' && s.startsWith('/')) {
      s = s.slice(1);
    }
  }
  return s;
}

/** 来源分类：user_project / sdk / system。 */
function classifySource(uri: unknown, projectPath: string, sdkPath: string): string {
  const p = uriToPath(uri);
  if (!p) {
    return 'unknown';
  }
  if (projectPath && isWithin(p, projectPath)) {
    return 'user_project';
  }
  if (sdkPath && isWithin(p, sdkPath)) {
    return 'sdk';
  }
  return 'system';
}

/** 同文件判定：result 首个 Location.uri 与 args.file 是否同一文件（best-effort）。 */
function isSameFile(uri: unknown, args: Record<string, unknown>): boolean {
  const p = uriToPath(uri);
  const f = args.file;
  if (!p || typeof f !== 'string') {
    return false;
  }
  return normPath(p) === normPath(f);
}

function normPath(p: string): string {
  try {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
  } catch {
    return p.replace(/\\/g, '/').toLowerCase();
  }
}

/** child 是否在 parent 内（路径穿越式判断）。 */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(normPath(parent), normPath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function toObject(m: Map<number | string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of m) {
    o[String(k)] = v;
  }
  return o;
}
