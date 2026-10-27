/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { renderTable } from './text-table.js';

const ESC = '\x1b';

describe('renderTable', () => {
  it('renders headers, a separator and rows with two-space gutters', () => {
    const out = renderTable(
      ['Name', 'Status'],
      [{ cells: ['emu-a', 'running'] }, { cells: ['emu-b', 'stopped'] }]
    );
    expect(out).toBe(
      [
        'Name   Status ',
        '-----  -------',
        'emu-a  running',
        'emu-b  stopped',
      ].join('\n')
    );
  });

  it('sizes each column to its widest cell', () => {
    const out = renderTable(['A', 'B'], [{ cells: ['long-cell', 'x'] }]);
    expect(out.split('\n')[0]).toBe('A          B');
    expect(out.split('\n')[2]).toBe('long-cell  x');
  });

  it('treats missing trailing cells as empty and trims trailing spaces', () => {
    const out = renderTable(['A', 'B'], [{ cells: ['only-a'] }]);
    expect(out.split('\n')[2]).toBe('only-a');
  });

  it('aligns East Asian wide characters by their display width', () => {
    const out = renderTable(
      ['Name', 'State'],
      [{ cells: ['中文', 'ok'] }, { cells: ['abcd', 'ok'] }]
    );
    expect(out.split('\n')[2]).toBe('中文  ok');
    expect(out.split('\n')[3]).toBe('abcd  ok');
  });

  it.each([
    { name: '非 BMP 宽字符', cell: '𠮷𠮷', reference: 'abcd' },
    { name: '零宽字符', cell: 'a\u200bb\u0301c', reference: 'abc' },
    {
      name: 'ANSI 转义',
      cell: `${ESC}[31mabc${ESC}[0m`,
      reference: 'abc',
    },
  ])('按显示宽度对齐：$name', ({ cell, reference }) => {
    const out = renderTable(['A', 'B'], [
      { cells: [cell, 'x'] },
      { cells: [reference, 'x'] },
    ]);

    expect(out.split('\n').slice(2)).toEqual([
      `${cell}  x`,
      `${reference}  x`,
    ]);
});

  it('renders empty tables with only the header and separator', () => {
    expect(renderTable(['A'], [])).toBe('A\n-');
  });

  it('renders highlighted rows without losing cell content', () => {
    const out = renderTable(['Name'], [{ cells: ['emu-a'], highlight: true }]);
    expect(out).toContain('emu-a');
  });
});
