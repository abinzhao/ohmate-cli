/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import JSON5 from 'json5';

export interface ValueSpan {
  start: number; end: number; children?: Map<string | number, ValueSpan>;
  kind?: 'object' | 'array'; closeStart?: number; memberStart?: number; comma?: Token;
}
interface Token { text: string; start: number; end: number }

function tokens(text: string): Token[] {
  const output: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const start = index, char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (text.startsWith('//', index)) {
      while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index])) { index++; }
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) { throw new Error('Unterminated JSON5 comment'); }
      index = end + 2; continue;
    }
    if (char === '"' || char === "'") {
      index++;
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\') { index++; }
        index++;
      }
      if (index === text.length) { throw new Error('Unterminated JSON5 string'); }
      index++;
    } else if ('{}[]:,'.includes(char)) { index++; }
    else {
      while (index < text.length && !/\s/.test(text[index]) && !'{}[]:,/'.includes(text[index])) { index++; }
      if (index === start) { throw new Error('Ambiguous JSON5 token'); }
    }
    output.push({ text: text.slice(start, index), start, end: index });
  }
  return output;
}

class SpanReader {
  private index = 0;
  constructor(private readonly input: Token[]) {}
  read(depth = 0): ValueSpan {
    if (depth > 100) { throw new Error('JSON5 nesting exceeds 100'); }
    const first = this.input[this.index++];
    if (!first) { throw new Error('Missing JSON5 value'); }
    if (first.text !== '{' && first.text !== '[') { return { start: first.start, end: first.end }; }
    const closing = first.text === '{' ? '}' : ']', children = new Map<string | number, ValueSpan>();
    while (this.input[this.index]?.text !== closing) {
      const memberStart = this.input[this.index]?.start;
      const key = first.text === '{' ? this.key() : children.size;
      if (children.has(key)) { throw new Error('Duplicate JSON5 key cannot be edited losslessly'); }
      const child: ValueSpan = { ...this.read(depth + 1), memberStart };
      children.set(key, child);
      if (this.input[this.index]?.text !== ',') { break; }
      child.comma = this.input[this.index++];
    }
    const end = this.input[this.index++];
    if (end?.text !== closing) { throw new Error('Ambiguous JSON5 container'); }
    return { start: first.start, end: end.end, children,
      kind: first.text === '{' ? 'object' : 'array', closeStart: end.start };
  }
  private key(): string {
    const key = this.input[this.index++], colon = this.input[this.index++];
    if (!key || colon?.text !== ':') { throw new Error('Missing JSON5 property key'); }
    const decoded = JSON5.parse(`{${key.text}:null}`) as Record<string, unknown>;
    const names = Object.keys(decoded);
    if (names.length !== 1) { throw new Error('Ambiguous JSON5 property key'); }
    return names[0];
  }
  complete(): boolean { return this.index === this.input.length; }
}

export function parseSpans(text: string): ValueSpan {
  JSON5.parse(text);
  const reader = new SpanReader(tokens(text)), tree = reader.read();
  if (!reader.complete()) { throw new Error('Unconsumed JSON5 tokens'); }
  return tree;
}

export function findSpan(tree: ValueSpan, field: (string | number)[]): ValueSpan {
  let node = tree;
  for (const key of field) {
    const child = node.children?.get(key);
    if (!child) { throw new Error('JSON5 field does not exist or uses the wrong index type'); }
    node = child;
  }
  return node;
}
