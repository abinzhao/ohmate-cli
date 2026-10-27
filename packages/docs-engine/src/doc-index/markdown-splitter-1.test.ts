/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  extractDocTitle,
  extractMarkdownHeadings,
  isFilenameLikeTitle,
  resolveDocTitle,
} from './markdown-splitter.js';

describe('extractDocTitle', () => {
  it('reads an atx heading as the title', () => {
    expect(extractDocTitle('# 标题\n内容')).toBe('标题');
  });

  it('reads any atx level as the title', () => {
    expect(extractDocTitle('## 二级标题\n内容')).toBe('二级标题');
    expect(extractDocTitle('###### 六级标题')).toBe('六级标题');
  });

  it('reads a setext title with equals underline', () => {
    expect(extractDocTitle('标题\n===\n内容')).toBe('标题');
  });

  it('reads a setext title with dashes underline', () => {
    expect(extractDocTitle('标题\n---\n内容')).toBe('标题');
  });

  it('skips leading blank lines before the title', () => {
    expect(extractDocTitle('\n\n# 延迟标题')).toBe('延迟标题');
  });

  it('falls back to the first non-empty line when no heading exists', () => {
    expect(extractDocTitle('没有标题的内容\n\n后续段落。')).toBe(
      '没有标题的内容'
    );
  });

  it('returns the fallback for empty markdown', () => {
    expect(extractDocTitle('', 'fb')).toBe('fb');
  });

  it('returns the fallback for whitespace-only markdown', () => {
    expect(extractDocTitle('\n  \n', 'fb')).toBe('fb');
  });

  it('unescapes markdown inline escapes in the title', () => {
    expect(extractDocTitle('# \\*转义\\*')).toBe('*转义*');
  });
});

describe('isFilenameLikeTitle', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['is-inner-application', true],
    ['some_doc_name', true],
    ['doc1-v2', true],
    ['singleword', false],
    ['开发指南', false],
    ['Development Guide', false],
  ])('isFilenameLikeTitle(%s) → %s', (input, expected) => {
    expect(isFilenameLikeTitle(input)).toBe(expected);
  });

  it('accepts long single-word lowercase slugs above 28 chars', () => {
    expect(isFilenameLikeTitle('x'.repeat(29))).toBe(true);
  });

  it('rejects lowercase slugs at exactly 28 chars', () => {
    expect(isFilenameLikeTitle('x'.repeat(28))).toBe(false);
  });
});

describe('resolveDocTitle', () => {
  it('prefers a human-readable json title over the markdown heading', () => {
    expect(
      resolveDocTitle('# MD 标题', {
        jsonTitle: 'JSON 标题',
        fileName: 'f.md',
      })
    ).toBe('JSON 标题');
  });

  it('falls back to the markdown heading for filename-like json titles', () => {
    expect(
      resolveDocTitle('# MD 标题', {
        jsonTitle: 'some-doc-name',
        fileName: 'f.md',
      })
    ).toBe('MD 标题');
  });

  it('falls back to the json title when both sources are filename-like', () => {
    expect(
      resolveDocTitle('just-a-title-body', {
        jsonTitle: 'some-doc-name',
        fileName: 'f.md',
      })
    ).toBe('some-doc-name');
  });

  it('uses the markdown heading when the json title is blank', () => {
    expect(
      resolveDocTitle('# MD 标题', { jsonTitle: '   ', fileName: 'f.md' })
    ).toBe('MD 标题');
  });

  it('uses the file name when both sources are empty', () => {
    expect(resolveDocTitle('', { jsonTitle: '', fileName: 'f.md' })).toBe(
      'f.md'
    );
  });
});

describe('extractMarkdownHeadings', () => {
  it('collects headings of every depth in order', () => {
    expect(extractMarkdownHeadings('# A\n## B\n### C')).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('returns an empty array for markdown without headings', () => {
    expect(extractMarkdownHeadings('普通段落文本。')).toEqual([]);
  });

  it('ignores hash lines inside fenced code blocks', () => {
    const md = '# A\n```\n# not-heading\n```\n## B';
    expect(extractMarkdownHeadings(md)).toEqual(['A', 'B']);
  });

  it('skips headings whose text is blank', () => {
    expect(extractMarkdownHeadings('##   \n# A')).toEqual(['A']);
  });
});
