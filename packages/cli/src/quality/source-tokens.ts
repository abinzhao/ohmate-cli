/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import JSON5 from 'json5';

export interface SourceToken { text: string; literal?: string; offset: number }
export function sourceTokens(source: string): SourceToken[] {
  const result: SourceToken[] = [];
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\/(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|[^/\\\n])+\/[gimsuyd]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|\S/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[0], offset = match.index;
    if (text.startsWith('/')) { continue; }
    if (text[0] === '"' || text[0] === "'") { result.push({ text, offset, literal: JSON5.parse(text) as string }); }
    else { result.push({ text, offset }); }
  }
  return result;
}
