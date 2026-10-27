/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  formatTerminalPreview,
  formatTerminalSavedReport,
  formatMarkdownReport,
  formatJsonReport,
} from './report-renderer.js';
import type {
  CodelinterIssueRow,
  CodelinterReport,
  CodelinterSummary,
} from './types.js';

function makeSummary(over: Partial<CodelinterSummary> = {}): CodelinterSummary {
  return {
    filesChecked: 1,
    issues: 1,
    errors: 1,
    warnings: 0,
    suggestions: 0,
    ...over,
  };
}

function makeReport(
  issues: CodelinterIssueRow[],
  summary: CodelinterSummary = makeSummary({ issues: issues.length })
): CodelinterReport {
  return { issues, summary };
}

function makeRow(over: Partial<CodelinterIssueRow> = {}): CodelinterIssueRow {
  return {
    file: 'a.ets',
    line: 3,
    column: 7,
    severity: 'Error',
    rule: 'r1',
    message: 'm1',
    ...over,
  };
}

describe('formatTerminalPreview', () => {
  it('renders the empty case with the summary line', () => {
    const out = formatTerminalPreview(
      makeReport([], makeSummary({ issues: 0, errors: 0 }))
    );
    expect(out).toBe(
      'No defects found.\n' +
        'Summary: Issues: 0 | Errors: 0 | Warnings: 0 | Suggestions: 0 | Files checked: 1\n'
    );
  });

  it('renders a table with row numbering and the summary line', () => {
    const out = formatTerminalPreview(makeReport([makeRow()]));
    expect(out).toBe(
      [
        'CodeLinter report',
        '',
        'No  File   Line  Column  Severity  Rule  Message',
        '--  -----  ----  ------  --------  ----  -------',
        '1   a.ets  3     7       Error     r1    m1',
        'Summary: Issues: 1 | Errors: 1 | Warnings: 0 | Suggestions: 0 | Files checked: 1',
        '',
      ].join('\n')
    );
  });

  it('renders missing cells as n/a', () => {
    const row = makeRow({
      line: undefined,
      column: undefined,
      rule: undefined,
    });
    const out = formatTerminalPreview(makeReport([row]));
    expect(out).toContain('n/a');
    expect(out).not.toContain('  3 ');
  });

  it('formats counts with en-US separators', () => {
    const out = formatTerminalPreview(
      makeReport(
        [makeRow()],
        makeSummary({ issues: 1234, errors: 1000, warnings: 233 })
      )
    );
    expect(out).toContain(
      'Summary: Issues: 1,234 | Errors: 1,000 | Warnings: 233 | Suggestions: 0 | Files checked: 1'
    );
  });
});

describe('formatTerminalPreview (limit)', () => {
  function threeIssues(): CodelinterIssueRow[] {
    return [
      makeRow({ file: 'a.ets' }),
      makeRow({ file: 'b.ets', severity: 'Warning' }),
      makeRow({ file: 'c.ets', severity: 'Warning' }),
    ];
  }

  it('slices rows and appends the limit hint when truncated', () => {
    const out = formatTerminalPreview(
      makeReport(
        threeIssues(),
        makeSummary({ issues: 3, errors: 1, warnings: 2 })
      ),
      2
    );
    expect(out).toContain('1   a.ets');
    expect(out).toContain('2   b.ets');
    expect(out).not.toContain('c.ets');
    expect(out).toContain(
      'Showing 2 of 3 issues. Use --output-path <path> to write all results.'
    );
  });

  it('omits the hint when the limit equals the issue count', () => {
    const out = formatTerminalPreview(
      makeReport(threeIssues(), makeSummary({ issues: 3 })),
      3
    );
    expect(out).toContain('3   c.ets');
    expect(out).not.toContain('Showing');
  });

  it('omits the hint when the limit exceeds the issue count', () => {
    const out = formatTerminalPreview(
      makeReport(threeIssues(), makeSummary({ issues: 3 })),
      10
    );
    expect(out).not.toContain('Showing');
  });
});

describe('formatTerminalPreview (path handling)', () => {
  it('shortens absolute paths under cwd to relative ones', () => {
    const file = path.join(process.cwd(), 'entry', 'src', 'MainPage.ets');
    const out = formatTerminalPreview(makeReport([makeRow({ file })]));
    expect(out).toContain('entry/src/MainPage.ets');
    expect(out).not.toContain(process.cwd());
  });

  it('keeps absolute paths outside cwd, normalized to forward slashes', () => {
    const file = path.join(
      path.resolve(process.cwd(), '..'),
      'outside',
      'x.ets'
    );
    const out = formatTerminalPreview(makeReport([makeRow({ file })]));
    expect(out).toContain(file.replace(/\\/g, '/'));
  });

  it('keeps relative paths untouched', () => {
    const out = formatTerminalPreview(
      makeReport([makeRow({ file: 'rel/a.ets' })])
    );
    expect(out).toContain('rel/a.ets');
  });
});

describe('formatTerminalSavedReport', () => {
  it('renders the summary and the normalized full report path', () => {
    const out = formatTerminalSavedReport(
      makeReport([], makeSummary({ issues: 0, errors: 0 })),
      'dir\\report.md'
    );
    expect(out).toBe(
      'Summary: Issues: 0 | Errors: 0 | Warnings: 0 | Suggestions: 0 | Files checked: 1\n' +
        'Full report: dir/report.md\n'
    );
  });
});

describe('formatMarkdownReport (rows)', () => {
  it('renders a markdown table with escaped cells', () => {
    const report = makeReport([
      makeRow({
        file: 'src\\a.ets',
        message: 'has | pipe and \\ backslash',
      }),
      makeRow({
        file: 'src\\b.ets',
        line: undefined,
        column: undefined,
        rule: undefined,
        severity: 'Warning',
        message: 'first\nsecond',
      }),
    ]);
    const out = formatMarkdownReport(report);
    expect(out).toContain(
      '| No | File | Line | Column | Severity | Rule | Message |'
    );
    expect(out).toContain('| ---: | --- | ---: | ---: | --- | --- | --- |');
    expect(out).toContain(
      '| 1 | src/a.ets | 3 | 7 | Error | r1 | has \\| pipe and \\\\ backslash |'
    );
    expect(out).toContain(
      '| 2 | src/b.ets | n/a | n/a | Warning | n/a | first<br>second |'
    );
  });

  it('escapes carriage-return line breaks as <br>', () => {
    const out = formatMarkdownReport(
      makeReport([makeRow({ message: 'a\r\nb' })])
    );
    expect(out).toContain('| a<br>b |');
  });
});

describe('formatMarkdownReport (structure)', () => {
  it('renders the empty case with header and summary', () => {
    const out = formatMarkdownReport(
      makeReport([], makeSummary({ issues: 0, errors: 0 }))
    );
    expect(out).toBe(
      [
        '# CodeLinter report',
        '',
        'No defects found.',
        '',
        '## Summary',
        '',
        '- Issues: 0',
        '- Errors: 0',
        '- Warnings: 0',
        '- Suggestions: 0',
        '- Files checked: 1',
        '',
      ].join('\n')
    );
  });

  it('always ends with the summary section', () => {
    const out = formatMarkdownReport(makeReport([makeRow()]));
    expect(
      out.endsWith(
        '## Summary\n\n- Issues: 1\n- Errors: 1\n- Warnings: 0\n- Suggestions: 0\n- Files checked: 1\n'
      )
    ).toBe(true);
  });
});

describe('formatJsonReport', () => {
  it('serializes the report with a trailing newline', () => {
    const report = makeReport([makeRow()]);
    const out = formatJsonReport(report);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual(report);
  });
});
