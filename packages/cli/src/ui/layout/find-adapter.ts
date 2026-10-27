/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ArkUiDumpAdapter } from './dump-adapter.js';
import {
  parseSelector,
  matchNodes,
  resolveIndex,
} from './selector-parser.js';
import type { ParsedSelector } from './selector-parser.js';
import {
  findByXpath,
  isXpathSelector,
  extractXpathExpr,
} from './xpath-finder.js';
import type { XpathMatch } from './xpath-finder.js';
import { parseBounds } from './parsers.js';
import type { RawDumpNode, RawDumpAttributes } from './types.js';
import type { SelectorClause } from './selector-parser.js';

export interface FindMatch {
  index: number;
  id?: string;
  key?: string;
  type?: string;
  text?: string;
  description?: string;
  enabled?: string;
  focused?: string;
  checked?: string;
  selected?: string;
  visible?: string;
  clickable?: string;
  longClickable?: string;
  scrollable?: string;
  checkable?: string;
  bounds?: [number, number, number, number];
  attributes: RawDumpAttributes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMatch(node: RawDumpNode, index: number): FindMatch {
  const a: RawDumpAttributes = node.attributes ?? {};
  return {
    index,
    id: a.id || undefined,
    key: a.key || undefined,
    type: a.type || undefined,
    text: a.originalText || a.text || undefined,
    description: a.description || undefined,
    enabled: a.enabled || undefined,
    focused: a.focused || undefined,
    checked: a.checked || undefined,
    selected: a.selected || undefined,
    visible: a.visible || undefined,
    clickable: a.clickable || undefined,
    longClickable: a.longClickable || undefined,
    scrollable: a.scrollable || undefined,
    checkable: a.checkable || undefined,
    bounds: parseBounds(a.bounds),
    attributes: a,
  };
}

function xpathToFindMatch(m: XpathMatch, index: number): FindMatch {
  return {
    index,
    id: m.id,
    key: m.key,
    type: m.type,
    text: m.text,
    description: m.description,
    enabled: m.enabled,
    focused: m.focused,
    checked: m.checked,
    selected: m.selected,
    visible: m.visible,
    clickable: m.clickable,
    longClickable: m.longClickable,
    scrollable: m.scrollable,
    checkable: m.checkable,
    bounds: m.bounds,
    attributes: (m.attributes as unknown) as RawDumpAttributes,
  };
}

export interface FindOptions {
  window?: string;
  all?: boolean;
  timeoutMs?: number;
}

export function decodeSelector(selector: string): string {
  if (selector.startsWith('base64=')) {
    return Buffer.from(selector.slice(7).trim(), 'base64').toString('utf8');
  }
  return selector;
}

const ALIAS_KEYS = new Set(['text', 'desc', 'description']);

const pendingWarnings: string[] = [];

function collectAttributeKeys(node: RawDumpNode, keys: Set<string>): void {
  if (node.attributes) {
    for (const k of Object.keys(node.attributes)) {
      keys.add(k);
    }
  }
  if (node.children) {
    for (const child of node.children) {
      collectAttributeKeys(child, keys);
    }
  }
}

export function findUnknownKeys(tree: RawDumpNode, clauses: SelectorClause[]): string[] {
  const knownKeys = new Set<string>();
  collectAttributeKeys(tree, knownKeys);
  const unknown: string[] = [];
  for (const clause of clauses) {
    if (ALIAS_KEYS.has(clause.key)) {
      continue;
    }
    if (!knownKeys.has(clause.key)) {
      unknown.push(clause.key);
    }
  }
  return unknown;
}

function warnUnknownKeys(tree: RawDumpNode, clauses: SelectorClause[]): void {
  const unknown = findUnknownKeys(tree, clauses);
  for (const k of unknown) {
    pendingWarnings.push(`WARNING: attribute "${k}" not found in any node of the layout tree. No matches will be returned for this key.`);
  }
}

export function flushWarnings(): string[] {
  return pendingWarnings.splice(0);
}

export class ArkUiFindAdapter {
  private readonly dumper: ArkUiDumpAdapter;

  constructor(hdcPath: string) {
    this.dumper = new ArkUiDumpAdapter(hdcPath);
  }

  async find(
    serial: string,
    selector: string,
    options?: FindOptions
  ): Promise<FindMatch[]> {
    pendingWarnings.splice(0);
    const expr = decodeSelector(selector);
    if (isXpathSelector(expr)) {
      return this.runXpathFind(serial, extractXpathExpr(expr), options);
    }
    const parsed = parseSelector(expr);
    return this.runFind(serial, parsed, options);
  }

  private async runFind(
    serial: string,
    parsed: ParsedSelector,
    options?: FindOptions
  ): Promise<FindMatch[]> {
    const timeoutMs = options?.timeoutMs ?? 3000;
    const intervalMs = 300;
    const start = Date.now();
    let matches: RawDumpNode[] = [];
    let ready = false;
    let warned = false;
    while (!ready) {
      const raw = await this.dumper.dumpRawTree(serial, options?.window);
      if (!warned) {
        warnUnknownKeys(raw, parsed.clauses);
        warned = true;
      }
      matches = matchNodes(raw, parsed);
      ready = options?.all
        ? matches.length > 0
        : resolveIndex(matches, parsed.index) !== undefined;
      if (ready) {
        break;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Timed out (${timeoutMs}ms) waiting for selector: ${parsed.raw}`
        );
      }
      await sleep(intervalMs);
    }
    if (options?.all) {
      return matches.map((n, i) => toMatch(n, i));
    }
    const picked = resolveIndex(matches, parsed.index);
    if (!picked) {
      const total = matches.length;
      const asked = parsed.index === undefined ? 0 : parsed.index;
      throw new Error(
        `Index ${asked} out of range (matched ${total} element(s)) for selector: ${parsed.raw}`
      );
    }
    return [toMatch(picked, parsed.index ?? 0)];
  }

  private async runXpathFind(
    serial: string,
    expr: string,
    options?: FindOptions
  ): Promise<FindMatch[]> {
    const timeoutMs = options?.timeoutMs ?? 3000;
    const intervalMs = 300;
    const start = Date.now();
    let matches: XpathMatch[] = [];
    let ready = false;
    while (!ready) {
      const raw = await this.dumper.dumpRawTree(serial, options?.window);
      matches = findByXpath(raw, expr);
      ready = matches.length > 0;
      if (ready) {
        break;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out (${timeoutMs}ms) waiting for xpath: ${expr}`);
      }
      await sleep(intervalMs);
    }
    if (options?.all) {
      return matches.map((m, i) => xpathToFindMatch(m, i));
    }
    return [xpathToFindMatch(matches[0], 0)];
  }

  async waitForAppearance(
    serial: string,
    selector: string,
    timeoutMs: number,
    window?: string
  ): Promise<FindMatch> {
    pendingWarnings.splice(0);
    const expr = decodeSelector(selector);
    if (isXpathSelector(expr)) {
      const matches = await this.runXpathFind(serial, extractXpathExpr(expr), {
        timeoutMs,
        window,
      });
      return matches[0]!;
    }
    const parsed = parseSelector(expr);
    return (await this.runWaitFor(serial, parsed, timeoutMs, window, true))!;
  }

  async waitForDisappear(
    serial: string,
    selector: string,
    timeoutMs: number,
    window?: string
  ): Promise<void> {
    pendingWarnings.splice(0);
    const expr = decodeSelector(selector);
    if (isXpathSelector(expr)) {
      return this.runXpathWaitFor(serial, extractXpathExpr(expr), timeoutMs, window, false);
    }
    const parsed = parseSelector(expr);
    await this.runWaitFor(serial, parsed, timeoutMs, window, false);
    return undefined;
  }

  private async runWaitFor(
    serial: string,
    parsed: ParsedSelector,
    timeoutMs: number,
    window: string | undefined,
    waitForAppear: boolean
  ): Promise<FindMatch | undefined> {
    const intervalMs = 300;
    const start = Date.now();
    let warned = false;
    while (true) {
      const raw = await this.dumper.dumpRawTree(serial, window);
      if (!warned) {
        warnUnknownKeys(raw, parsed.clauses);
        warned = true;
      }
      const matches = matchNodes(raw, parsed);
      const found = resolveIndex(matches, parsed.index) !== undefined;
      if (waitForAppear && found) {
        const picked = resolveIndex(matches, parsed.index)!;
        return toMatch(picked, parsed.index ?? 0);
      }
      if (!waitForAppear && !found) {
        return undefined;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Timed out (${timeoutMs}ms) waiting for selector to ${waitForAppear ? 'appear' : 'disappear'}: ${parsed.raw}`
        );
      }
      await sleep(intervalMs);
    }
  }

  private async runXpathWaitFor(
    serial: string,
    expr: string,
    timeoutMs: number,
    window: string | undefined,
    waitForAppear: boolean
  ): Promise<void> {
    const intervalMs = 300;
    const start = Date.now();
    while (true) {
      const raw = await this.dumper.dumpRawTree(serial, window);
      const matches = findByXpath(raw, expr);
      const found = matches.length > 0;
      if (waitForAppear && found) {
        return;
      }
      if (!waitForAppear && !found) {
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Timed out (${timeoutMs}ms) waiting for xpath to ${waitForAppear ? 'appear' : 'disappear'}: ${expr}`
        );
      }
      await sleep(intervalMs);
    }
  }
}
