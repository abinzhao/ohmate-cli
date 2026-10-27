/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export type SelectorOperator = '=' | '*=' | '^=' | '$=' | '/=';

export interface SelectorClause {
  key: string;
  op: SelectorOperator;
  value: string;
  flags?: string;
}

export interface ParsedSelector {
  clauses: SelectorClause[];
  index: number | undefined;
  raw: string;
}

export class SelectorParseError extends Error {
  readonly position: number;
  readonly input: string;
  constructor(message: string, position: number, input: string) {
    super(`Selector parse error at ${position}: ${message}`);
    this.name = 'SelectorParseError';
    this.position = position;
    this.input = input;
  }
}

const TWO_CHAR_OPS: readonly SelectorOperator[] = ['*=', '^=', '$=', '/='];
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const WS = /\s/;
const REGEX_FLAGS_TAIL = /^(.*)\/([gimsuy]+)$/;

class Scanner {
  readonly input: string;
  pos = 0;
  constructor(input: string) {
    this.input = input;
  }
  eof(): boolean {
    return this.pos >= this.input.length;
  }
  peek(offset = 0): string {
    const i = this.pos + offset;
    return i >= 0 && i < this.input.length ? this.input[i] : '';
  }
  next(): string {
    return this.pos < this.input.length ? this.input[this.pos++] : '';
  }
  startsWith(s: string): boolean {
    return this.input.slice(this.pos, this.pos + s.length) === s;
  }
}

function skipWs(sc: Scanner): void {
  while (!sc.eof() && WS.test(sc.peek())) {
    sc.next();
  }
}

function parseKey(sc: Scanner): string {
  const start = sc.pos;
  if (!IDENT_START.test(sc.peek())) {
    throw new SelectorParseError('expected attribute key', sc.pos, sc.input);
  }
  while (!sc.eof() && IDENT_PART.test(sc.peek())) {
    sc.next();
  }
  return sc.input.slice(start, sc.pos);
}

function parseOp(sc: Scanner, key: string): SelectorOperator {
  for (const op of TWO_CHAR_OPS) {
    if (sc.startsWith(op)) {
      sc.pos += op.length;
      return op;
    }
  }
  if (sc.peek() === '=') {
    sc.next();
    return '=';
  }
  throw new SelectorParseError(
    `expected operator (=, *=, ^=, $=, /=) after key "${key}"`,
    sc.pos,
    sc.input,
  );
}

function splitRegexFlags(value: string): { value: string; flags?: string } {
  const m = value.match(REGEX_FLAGS_TAIL);
  if (m) {
    return { value: m[1], flags: m[2] };
  }
  return { value };
}

function parseQuoted(sc: Scanner, quote: string): string {
  sc.next();
  let out = '';
  while (!sc.eof()) {
    const c = sc.next();
    if (c === '\\') {
      if (sc.eof()) {
        throw new SelectorParseError('dangling escape in quoted value', sc.pos, sc.input);
      }
      out += sc.next();
      continue;
    }
    if (c === quote) {
      return out;
    }
    out += c;
  }
  throw new SelectorParseError('unterminated quoted value', sc.pos, sc.input);
}

function isQuote(c: string): boolean {
  return c === '"' || c === "'";
}

function parseValue(sc: Scanner, op: SelectorOperator): { value: string; flags?: string } {
  const q = sc.peek();
  if (isQuote(q)) {
    const raw = parseQuoted(sc, q);
    if (op === '/=') {
      return splitRegexFlags(raw);
    }
    return { value: raw };
  }
  let out = '';
  while (!sc.eof()) {
    const c = sc.peek();
    if (c === ',' || c === '[' || isQuote(c)) {
      break;
    }
    if (WS.test(c)) {
      let j = sc.pos + 1;
      while (j < sc.input.length && WS.test(sc.input[j])) {
        j++;
      }
      const next = j < sc.input.length ? sc.input[j] : '';
      if (next === '' || next === ',' || next === '[' || isQuote(next)) {
        break;
      }
      out += sc.next();
      continue;
    }
    if (c === '\\') {
      sc.next();
      if (sc.eof()) {
        throw new SelectorParseError('dangling escape in value', sc.pos, sc.input);
      }
      out += sc.next();
      continue;
    }
    out += sc.next();
  }
  if (op === '/=') {
    return splitRegexFlags(out);
  }
  return { value: out };
}

function parseClause(sc: Scanner): SelectorClause {
  skipWs(sc);
  const key = parseKey(sc);
  skipWs(sc);
  const op = parseOp(sc, key);
  skipWs(sc);
  if (sc.eof() || sc.peek() === ',' || sc.peek() === '[') {
    throw new SelectorParseError(`missing value for key "${key}"`, sc.pos, sc.input);
  }
  const { value, flags } = parseValue(sc, op);
  if (op === '/=') {
    try {
      new RegExp(value, flags);
    } catch (e) {
      throw new SelectorParseError(
        `invalid regex "${value}"${flags ? ` with flags "${flags}"` : ''}: ${(e as Error).message}`,
        sc.pos,
        sc.input,
      );
    }
  }
  const clause: SelectorClause = { key, op, value };
  if (flags !== undefined) {
    clause.flags = flags;
  }
  return clause;
}

function parseIndex(sc: Scanner): number {
  let token = '';
  while (!sc.eof() && sc.peek() !== ']') {
    token += sc.next();
  }
  token = token.trim();
  if (token === 'last') {
    return -1;
  }
  if (/^-?\d+$/.test(token)) {
    return parseInt(token, 10);
  }
  throw new SelectorParseError(
    `invalid index "${token}" (expected N, -N, or "last")`,
    sc.pos,
    sc.input,
  );
}

export function parseSelector(input: string): ParsedSelector {
  if (typeof input !== 'string') {
    throw new SelectorParseError('input must be a string', 0, String(input));
  }
  const sc = new Scanner(input);
  const clauses: SelectorClause[] = [];
  skipWs(sc);
  if (sc.eof()) {
    throw new SelectorParseError('empty selector', sc.pos, input);
  }
  clauses.push(parseClause(sc));
  while (true) {
    skipWs(sc);
    if (sc.peek() !== ',') {
      break;
    }
    sc.next();
    skipWs(sc);
    if (sc.eof() || sc.peek() === ',') {
      throw new SelectorParseError('expected clause after comma', sc.pos, input);
    }
    clauses.push(parseClause(sc));
  }
  let index: number | undefined;
  skipWs(sc);
  if (sc.peek() === '[') {
    sc.next();
    index = parseIndex(sc);
    skipWs(sc);
    if (sc.peek() !== ']') {
      throw new SelectorParseError("expected ']' after index", sc.pos, input);
    }
    sc.next();
    skipWs(sc);
  }
  if (!sc.eof()) {
    throw new SelectorParseError(
      `unexpected trailing input "${sc.input.slice(sc.pos)}"`,
      sc.pos,
      input,
    );
  }
  return { clauses, index, raw: input };
}

export function parseSelectorB64(base64: string): ParsedSelector {
  if (typeof base64 !== 'string') {
    throw new SelectorParseError('base64 input must be a string', 0, String(base64));
  }
  const trimmed = base64.trim();
  if (trimmed === '') {
    throw new SelectorParseError('empty base64 input', 0, base64);
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  return parseSelector(decoded);
}

export function isSelectorParseError(e: unknown): e is SelectorParseError {
  return e instanceof SelectorParseError;
}

export interface MatchableNode {
  attributes?: Record<string, unknown> | null;
  children?: MatchableNode[] | null;
}

export function attrValue(
  a: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (a == null) {
    return undefined;
  }
  if (key === 'text') {
    const t = a.originalText ?? a.text;
    return t === undefined || t === null ? undefined : String(t);
  }
  if (key === 'desc' || key === 'description') {
    const d = a.description;
    return d === undefined || d === null ? undefined : String(d);
  }
  const v = a[key];
  return v === undefined || v === null ? undefined : String(v);
}

export function clauseMatches(
  a: Record<string, unknown> | null | undefined,
  clause: SelectorClause,
): boolean {
  const raw = attrValue(a, clause.key);
  if (raw === undefined) {
    return false;
  }
  switch (clause.op) {
    case '=':
      return raw === clause.value;
    case '*=':
      return raw.includes(clause.value);
    case '^=':
      return raw.startsWith(clause.value);
    case '$=':
      return raw.endsWith(clause.value);
    case '/=':
      try {
        const re = clause.flags ? new RegExp(clause.value, clause.flags) : new RegExp(clause.value);
        return re.test(raw);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function matchNodes<N extends MatchableNode>(root: N, selector: ParsedSelector): N[] {
  const found: N[] = [];
  const stack: MatchableNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const a = (n.attributes ?? null) as Record<string, unknown> | null | undefined;
    if (selector.clauses.every((c) => clauseMatches(a, c))) {
      found.push(n as N);
    }
    const kids = n.children;
    if (kids) {
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]);
      }
    }
  }
  return found;
}

export function resolveIndex<T>(matches: T[], index: number | undefined): T | undefined {
  if (index === undefined) {
    return matches[0];
  }
  if (index >= 0) {
    return matches[index];
  }
  return matches[matches.length + index];
}
