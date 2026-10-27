/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentIndexSource,
  buildDocumentIndexSources,
} from './markdown-splitter.js';

describe('buildDocumentIndexSource', () => {
  const meta = {
    documentId: 'guides/demo-doc',
    catalogId: 0,
    docTitle: '演示文档',
  };
  const md = '# 演示文档\n\n第一段内容。\n\n第二段内容。';

  it('returns a single whole-document source with meta passed through', () => {
    const source = buildDocumentIndexSource(md, meta);
    expect(source.documentId).toBe('guides/demo-doc');
    expect(source.catalogId).toBe(0);
    expect(source.docTitle).toBe('演示文档');
    expect(source.sectionTitle).toBe('');
    expect(source.titleTokens).toBe('演示文档');
    expect(source.headingsText).toBe('演示文档');
    expect(source.bodySample).toBe('第一段内容。 第二段内容。');
    expect(source.leadText).toBe('第一段内容。 第二段内容。');
    expect(source.excerptTruncated).toBe(false);
    expect(source.apiSymbols).toEqual([]);
  });

  it('falls back to the document id when docTitle is blank', () => {
    const source = buildDocumentIndexSource(md, { ...meta, docTitle: '' });
    expect(source.docTitle).toBe('guides/demo-doc');
    expect(source.titleTokens).toBe('guides/demo-doc');
  });

  it('extracts qualified API symbols from the body', () => {
    const qualified =
      '# 演示文档\n\n调用 UIAbility.startAbility 接口完成跳转。';
    const source = buildDocumentIndexSource(qualified, meta);
    expect(source.apiSymbols).toEqual(['UIAbility.startAbility']);
  });

  it('extracts decorator tokens as API symbols', () => {
    const decorated = '# 演示文档\n\n使用 @State 装饰器管理状态。';
    const source = buildDocumentIndexSource(decorated, meta);
    expect(source.apiSymbols).toEqual(['@State']);
  });
});

describe('buildDocumentIndexSources', () => {
  const buildPlainDocument = (lineCount: number): string =>
    [
      '# 普通文档',
      '',
      '总体说明。',
      ...Array.from({ length: lineCount }, (_, i) => `内容行 ${i + 1}。`),
    ].join('\n');

  it('returns a single source for a short plain document', () => {
    const sources = buildDocumentIndexSources(buildPlainDocument(60), {
      documentId: 'guides/plain',
      catalogId: 0,
      docTitle: '普通文档',
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].sectionTitle).toBe('');
  });

  it('returns a single source for a large non-api document below the chunk line threshold', () => {
    const sources = buildDocumentIndexSources(buildPlainDocument(250), {
      documentId: 'guides/plain-large',
      catalogId: 0,
      docTitle: '普通文档',
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].sectionTitle).toBe('');
  });

  const buildApiReferenceDocument = (): string => {
    const lines: string[] = ['# 接口文档', '', '接口总体说明。'];
    for (let i = 1; i <= 3; i++) {
      lines.push('', `#### StartAbility${i}12+`, `第${i}个接口的说明文字。`);
      for (let j = 0; j < 32; j++) {
        lines.push(`补充说明行 ${i}-${j}。`);
      }
    }
    return lines.join('\n');
  };

  it('chunks an api-reference document into per-section sources', () => {
    const markdown = buildApiReferenceDocument();
    const sources = buildDocumentIndexSources(markdown, {
      documentId: 'API参考/intf-demo',
      catalogId: 1,
      docTitle: '演示接口文档',
    });

    expect(sources).toHaveLength(4);
    expect(sources[0].sectionTitle).toBe('');
    expect(sources[0].excerptTruncated).toBe(false);
    expect(sources.slice(1).map((s) => s.sectionTitle)).toEqual([
      'StartAbility112+',
      'StartAbility212+',
      'StartAbility312+',
    ]);
  });

  it('marks section slices as truncated excerpts', () => {
    const markdown = buildApiReferenceDocument();
    const sources = buildDocumentIndexSources(markdown, {
      documentId: 'API参考/intf-demo',
      catalogId: 1,
      docTitle: '演示接口文档',
    });
    expect(sources.slice(1).every((s) => s.excerptTruncated)).toBe(true);
  });

  it('appends the section symbol to section title tokens', () => {
    const markdown = buildApiReferenceDocument();
    const sources = buildDocumentIndexSources(markdown, {
      documentId: 'API参考/intf-demo',
      catalogId: 1,
      docTitle: '演示接口文档',
    });
    expect(sources[1].titleTokens).toBe('演示接口文档 StartAbility');
  });
});
