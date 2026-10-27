/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import {
  readIndexLexiconFile,
  readBuildLexiconFile,
  type IndexLexiconFile,
} from './lexicon.js';
import { sha256Text } from './hash-utils.js';

type SynonymGroups = string[][];

let synonymMap: Map<string, Set<string>> | null = null;

function loadSynonymGroups(): SynonymGroups {
  const raw = readIndexLexiconFile('harmonyos-synonyms.json');
  return JSON.parse(raw) as SynonymGroups;
}

function buildSynonymIndex(groups: string[][]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const group of groups) {
    const normalized = group.map((item) => item.trim()).filter(Boolean);
    for (const term of normalized) {
      const others = normalized.filter((item) => item !== term);
      idx.set(term.toLowerCase(), others);
      if (term !== term.toLowerCase()) {
        idx.set(term, others);
      }
    }
  }
  return idx;
}

function buildSynonymMap(): Map<string, Set<string>> {
  const idx = buildSynonymIndex(loadSynonymGroups());
  const map = new Map<string, Set<string>>();
  for (const [key, others] of idx) {
    map.set(key, new Set(others));
  }
  return map;
}

function getSynonymMap(): Map<string, Set<string>> {
  if (!synonymMap) {
    synonymMap = buildSynonymMap();
  }
  return synonymMap;
}

export function expandSynonymsLimited(query: string, maxParts: number): string {
  const map = getSynonymMap();
  const parts = query.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  const limit = Number.isFinite(maxParts) ? maxParts : parts.length;

  for (
    let index = 0;
    index < parts.length && expanded.size < limit;
    index += 1
  ) {
    const part = parts[index];
    expanded.add(part);

    const synonyms = map.get(part) ?? map.get(part.toLowerCase());
    if (!synonyms) {
      continue;
    }
    for (const synonym of synonyms) {
      if (expanded.size >= limit) {
        break;
      }
      expanded.add(synonym);
    }
  }

  return [...expanded].join(' ');
}

function hashLexiconFile(name: IndexLexiconFile, lexiconDir?: string): string {
  const content = lexiconDir
    ? readBuildLexiconFile(name, lexiconDir)
    : readIndexLexiconFile(name);
  return sha256Text(content);
}

export function getSynonymsHash(lexiconDir?: string): string {
  return hashLexiconFile('harmonyos-synonyms.json', lexiconDir);
}

export function getTermsHash(lexiconDir?: string): string {
  return hashLexiconFile('harmonyos-terms.txt', lexiconDir);
}
