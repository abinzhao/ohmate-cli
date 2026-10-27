/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

const OBJECT_DESC_RE = /^(.+?)(\d+\+)?(对象|枚举|错误码)说明$/;
const H2_METHOD_RE = /^\[h2\]([A-Za-z][A-Za-z0-9]*)(\d+\+)?$/;
const PAREN_PAIR_RE = /^(.{2,20}?)\s*[(（]([A-Za-z][a-zA-Z0-9]{1,40})[)）]\s*$/;
const VERSION_SUFFIX_RE = /^([A-Za-z@][A-Za-z0-9@]*?)(\d+\+)?$/;

const DEFINITION_SKIP_RE =
  /^(系统能力|元服务API|参数|返回值|说明|\*\*|表格|\|)/;

export interface NormalizedApiHeading {
  displayTitle: string;
  symbolName?: string;
  searchExtras: string[];
}

export function stripApiVersionSuffix(symbol: string): string {
  const trimmed = symbol.trim();
  const match = trimmed.match(VERSION_SUFFIX_RE);
  if (!match) {
    return trimmed;
  }
  return match[1];
}

function normalizeFromObjectDesc(
  displayTitle: string
): NormalizedApiHeading | undefined {
  const objectMatch = displayTitle.match(OBJECT_DESC_RE);
  if (!objectMatch) {
    return undefined;
  }
  const symbolName = stripApiVersionSuffix(objectMatch[1].trim());
  return {
    displayTitle,
    symbolName,
    searchExtras: [symbolName, objectMatch[3]],
  };
}

function normalizeFromUpperSymbol(
  displayTitle: string
): NormalizedApiHeading | undefined {
  const bare = stripApiVersionSuffix(displayTitle.replace(/\([^)]*\)$/, ''));
  if (/^[A-Z][A-Za-z0-9]*$/.test(bare)) {
    return { displayTitle, symbolName: bare, searchExtras: [bare] };
  }
  if (/^[A-Z][A-Za-z0-9]*(\([^)]*\))?$/.test(displayTitle)) {
    return { displayTitle, symbolName: bare, searchExtras: [bare] };
  }
  return undefined;
}

export function normalizeApiHeading(raw: string): NormalizedApiHeading {
  const displayTitle = raw.trim();
  if (!displayTitle) {
    return { displayTitle: '', searchExtras: [] };
  }

  return (
    normalizeFromObjectDesc(displayTitle) ??
    (() => {
      const methodMatch = displayTitle.match(H2_METHOD_RE);
      if (methodMatch) {
        const symbolName = methodMatch[1];
        return { displayTitle, symbolName, searchExtras: [symbolName] };
      }
      return undefined;
    })() ??
    (() => {
      const parenMatch = displayTitle.match(PAREN_PAIR_RE);
      if (!parenMatch) {
        return undefined;
      }
      const cn = parenMatch[1].trim();
      const en = parenMatch[2].trim();
      return { displayTitle, symbolName: en, searchExtras: [cn, en] };
    })() ??
    normalizeFromUpperSymbol(displayTitle) ?? { displayTitle, searchExtras: [] }
  );
}

function isDefinitionCandidate(text: string): boolean {
  if (text.length < 2 || text.length > 36) {
    return false;
  }
  if (DEFINITION_SKIP_RE.test(text)) {
    return false;
  }
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) {
    return false;
  }
  const chinese = chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
  return chinese / chars.length >= 0.4;
}

export function extractFirstDefinitionLine(bodyParts: string[]): string {
  for (const part of bodyParts) {
    const line = part
      .trim()
      .replace(/[。.!！?？；;]+$/u, '')
      .trim();
    if (isDefinitionCandidate(line)) {
      return line;
    }
  }
  return '';
}

export function buildSectionHeadingsText(
  sectionTitle: string,
  definitionLine: string,
  normalized: NormalizedApiHeading
): string {
  const parts = [
    sectionTitle,
    ...normalized.searchExtras,
    definitionLine,
  ].filter(Boolean);
  return [...new Set(parts)].join(' ');
}
