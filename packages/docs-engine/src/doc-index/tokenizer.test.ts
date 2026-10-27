/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEX_LEXICON_FILES, setLexiconDirOverride } from './lexicon.js';
import {
  buildDocumentSearchText,
  getJieba,
  tokenizeForIndex,
  tokenizeForQuery,
} from './tokenizer.js';
import type { DocumentIndexSource } from './segment-types.js';

const TERMS_DICT =
  'UIAbility 1500 n\nWant 1500 n\n组件 999 n\n鸿蒙星河超级组件 1500 n';
const STOPWORDS = '的\n\n  和  \n模块\nthe\n';

function lexiconFileName(suffix: string): string {
  const match = INDEX_LEXICON_FILES.find((name) => name.endsWith(suffix));
  if (!match) {
    throw new Error(`unknown lexicon file suffix: ${suffix}`);
  }
  return match;
}

const TERMS_FILE = lexiconFileName('terms.txt');
const STOPWORDS_FILE = lexiconFileName('stopwords.txt');

function makeSource(
  overrides: Partial<DocumentIndexSource> = {}
): DocumentIndexSource {
  return {
    documentId: 'guides/sample',
    catalogId: 0,
    docTitle: 'Sample',
    sectionTitle: '',
    titleTokens: '',
    headingsText: '',
    apiSymbols: [],
    bodySample: '',
    leadText: '',
    excerptTruncated: false,
    ...overrides,
  };
}

describe('tokenizer', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-doc-tokenizer-'));
    fs.writeFileSync(path.join(root, TERMS_FILE), TERMS_DICT);
    fs.writeFileSync(path.join(root, STOPWORDS_FILE), STOPWORDS);
    setLexiconDirOverride(root);
  });

  afterAll(() => {
    setLexiconDirOverride(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('getJieba', () => {
    it('resolves a single shared instance, including concurrent init', async () => {
      const [first, second] = await Promise.all([getJieba(), getJieba()]);
      expect(first).toBe(second);
      expect(await getJieba()).toBe(first);
    });
  });

  describe('tokenizeForIndex', () => {
    it('emits search-mode subtokens and both casings for mixed-case words', async () => {
      await expect(tokenizeForIndex('UIAbility 生命周期管理')).resolves.toEqual(
        ['uiability', 'UIAbility', '生命', '周期', '生命周期', '管理']
      );
    });

    it('drops stop words, blank tokens and pure-whitespace input', async () => {
      await expect(tokenizeForIndex('的组件和模块')).resolves.toEqual(['组件']);
      await expect(tokenizeForIndex('the 组件')).resolves.toEqual(['组件']);
      await expect(tokenizeForIndex('   ')).resolves.toEqual([]);
      await expect(tokenizeForIndex('')).resolves.toEqual([]);
    });
  });

  describe('tokenizeForQuery', () => {
    it('cuts in precise mode without search-mode subtokens', async () => {
      await expect(tokenizeForQuery('UIAbility 生命周期管理')).resolves.toEqual(
        ['uiability', 'UIAbility', '生命周期', '管理']
      );
    });

    it('keeps a whole camel-case identifier and both casings', async () => {
      await expect(
        tokenizeForQuery('buildDocumentSearchText component')
      ).resolves.toEqual([
        'builddocumentsearchtext',
        'buildDocumentSearchText',
        'component',
      ]);
    });

    it('merges @ with a following capitalized identifier', async () => {
      await expect(tokenizeForQuery('@Entry 装饰器')).resolves.toEqual([
        '@entry',
        '@Entry',
        '装饰',
        '器',
      ]);
    });

    it('does not merge @ with a lowercase segment', async () => {
      await expect(
        tokenizeForQuery('@ohos.app.ability.UIAbility')
      ).resolves.toEqual([
        '@',
        'ohos',
        '.',
        'app',
        '.',
        'ability',
        '.',
        'uiability',
        'UIAbility',
      ]);
    });

    it('keeps a custom-lexicon term whole that the default dictionary would split', async () => {
      await expect(tokenizeForQuery('鸿蒙星河超级组件')).resolves.toEqual([
        '鸿蒙星河超级组件',
      ]);
    });
  });

  describe('buildDocumentSearchText', () => {
    it('joins tokenized title, api symbols, headings and body for a document row', async () => {
      const text = await buildDocumentSearchText(
        makeSource({
          titleTokens: 'UIAbility 生命周期',
          apiSymbols: ['Want'],
          headingsText: '组件',
          bodySample: '管理',
        })
      );
      expect(text).toBe(
        'uiability UIAbility 生命 周期 生命周期 want Want 组件 管理'
      );
    });

    it('returns an empty string when every field is blank', async () => {
      await expect(
        buildDocumentSearchText(makeSource({ titleTokens: '   ' }))
      ).resolves.toBe('');
    });

    it('caps the body budget for document rows', async () => {
      const text = await buildDocumentSearchText(
        makeSource({ bodySample: 'a'.repeat(1500) })
      );
      expect(text).toBe('a'.repeat(500));
    });

    it('caps the api-symbol budget of document rows', async () => {
      const text = await buildDocumentSearchText(
        makeSource({ apiSymbols: Array(40).fill('SomeLongSymbolName') })
      );
      expect(text.length).toBe(450);
      expect(text.startsWith('somelongsymbolname')).toBe(true);
    });

    it('uses the section budgets and dedupes api symbols for section rows', async () => {
      const text = await buildDocumentSearchText(
        makeSource({
          sectionTitle: '生命周期',
          apiSymbols: ['UIAbility', 'uiability', 'Want'],
        })
      );
      expect(text).toBe('uiability UIAbility want Want');
    });

    it('caps the title budget of section rows', async () => {
      const text = await buildDocumentSearchText(
        makeSource({
          sectionTitle: '生命周期',
          titleTokens:
            '组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件 组件',
        })
      );
      expect(text.length).toBe(80);
      expect(text.startsWith('组件')).toBe(true);
    });
  });
});
