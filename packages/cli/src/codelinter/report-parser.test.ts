/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  filterCodelinterNativeText,
  extractJsonFromNativeStdout,
  createCodelinterReport,
} from './report-parser.js';

const ESC = String.fromCharCode(27);

describe('filterCodelinterNativeText', () => {
  it('returns empty string for undefined or empty input', () => {
    expect(filterCodelinterNativeText(undefined)).toBe('');
    expect(filterCodelinterNativeText('')).toBe('');
  });

  it('keeps ordinary lines and appends a trailing newline', () => {
    expect(filterCodelinterNativeText('hello\nworld')).toBe('hello\nworld\n');
  });

  it('drops empty results entirely', () => {
    expect(
      filterCodelinterNativeText('Working...[/]50%\nWrite finished.')
    ).toBe('');
  });
});

describe('filterCodelinterNativeText (noise removal)', () => {
  it('strips ANSI escape sequences', () => {
    expect(filterCodelinterNativeText(`${ESC}[32mOK${ESC}[0m`)).toBe('OK\n');
  });

  it('splits carriage returns into lines', () => {
    expect(filterCodelinterNativeText('a\rb\rc')).toBe('a\nb\nc\n');
  });

  it('removes Working/Finished progress lines', () => {
    const out = filterCodelinterNativeText(
      'Working...[/////////          ]50%\nkeep\nFinished...[##################]100%'
    );
    expect(out).toBe('keep\n');
  });

  it('removes known status information lines', () => {
    const out = filterCodelinterNativeText(
      [
        'The configuration file /a/b.json is in use.',
        'The configuration file /a/b.json in the project is in use.',
        'Currently active product: default',
        'Writing the result to /tmp/out.json.',
        'Write finished.',
        'CodeLinter found some defects in your code.',
        'actual output',
      ].join('\n')
    );
    expect(out).toBe('actual output\n');
  });

  it('trims trailing whitespace per line', () => {
    expect(filterCodelinterNativeText('a   \nb\t')).toBe('a\nb\n');
  });
});

describe('filterCodelinterNativeText (native message protocol)', () => {
  it('unwraps JSON message lines into their content', () => {
    expect(
      filterCodelinterNativeText('{"content":"real message","messageType":2}')
    ).toBe('real message\n');
  });

  it('drops hidden messageType 1 lines', () => {
    expect(
      filterCodelinterNativeText(
        '{"content":"internal status","messageType":1}\nvisible'
      )
    ).toBe('visible\n');
  });

  it('keeps brace-prefixed lines that are not valid protocol JSON', () => {
    expect(filterCodelinterNativeText('{ not json')).toBe('{ not json\n');
    expect(filterCodelinterNativeText('{"content":"missing type"}')).toBe(
      '{"content":"missing type"}\n'
    );
  });
});

describe('extractJsonFromNativeStdout', () => {
  it('returns empty result for undefined input', () => {
    expect(extractJsonFromNativeStdout(undefined)).toEqual({
      jsonText: undefined,
      diagnostics: '',
    });
  });

  it('returns the whole text when it is pure JSON', () => {
    const result = extractJsonFromNativeStdout('{"issues":[]}');
    expect(result.jsonText).toBe('{"issues":[]}');
    expect(result.diagnostics).toBe('');
  });

  it('merges per-file JSON lines into a JSON array (Studio 6.0)', () => {
    const result = extractJsonFromNativeStdout('{"a":1}\n{"b":2}');
    expect(result.jsonText).toBe('[{"a":1},{"b":2}]');
    expect(result.diagnostics).toBe('');
  });

  it('returns diagnostics only when no JSON exists', () => {
    const result = extractJsonFromNativeStdout('plain failure text');
    expect(result.jsonText).toBeUndefined();
    expect(result.diagnostics).toBe('plain failure text\n');
  });
});

describe('extractJsonFromNativeStdout (mixed output)', () => {
  it('extracts an embedded JSON array with surrounding diagnostics', () => {
    const result = extractJsonFromNativeStdout(
      'before noise\n[{"issue":1}]\nafter noise'
    );
    expect(result.jsonText).toBe('[{"issue":1}]');
    expect(result.diagnostics).toBe('before noise\nafter noise\n');
  });

  it('extracts the first complete JSON object in mixed text', () => {
    const result = extractJsonFromNativeStdout('x{"m":1}y');
    expect(result.jsonText).toBe('{"m":1}');
    expect(result.diagnostics).toBe('x\ny\n');
  });

  it('matches closing braces inside JSON strings', () => {
    const result = extractJsonFromNativeStdout('x{"m":"a}b"}y');
    expect(result.jsonText).toBe('{"m":"a}b"}');
    expect(result.diagnostics).toBe('x\ny\n');
  });

  it('handles nested objects inside an embedded array', () => {
    const result = extractJsonFromNativeStdout('x[{"a":{"b":1}}]y');
    expect(result.jsonText).toBe('[{"a":{"b":1}}]');
  });

  it('ignores progress noise when extracting JSON', () => {
    const result = extractJsonFromNativeStdout(
      `Working...[/]50%\n${ESC}[32m[{"ok":true}]${ESC}[0m`
    );
    expect(result.jsonText).toBe('[{"ok":true}]');
    expect(result.diagnostics).toBe('');
  });
});

describe('extractJsonFromNativeStdout (oversized output)', () => {
  it('truncates diagnostics instead of parsing huge output', () => {
    const huge = 'x'.repeat(50 * 1024 * 1024 + 1);
    const result = extractJsonFromNativeStdout(huge);
    expect(result.jsonText).toBeUndefined();
    expect(result.diagnostics.startsWith('x'.repeat(1024))).toBe(true);
    expect(result.diagnostics).toContain(
      '[output truncated: exceeded 52428800 bytes]'
    );
  });
});

describe('createCodelinterReport (severity normalization)', () => {
  it.each([
    ['2', 'Error'],
    ['error', 'Error'],
    ['ERR', 'Error'],
    ['２', 'Error'],
    [2, 'Error'],
    ['1', 'Warning'],
    ['warn', 'Warning'],
    ['Warning', 'Warning'],
    ['3', 'Suggestion'],
    ['suggest', 'Suggestion'],
    ['info', 'Info'],
    ['information', 'Info'],
    ['0', 'Off'],
    ['off', 'Off'],
    ['bizarre', 'Unknown'],
  ])('maps severity %j to %s', (input, expected) => {
    const report = createCodelinterReport([{ severity: input, message: 'm' }]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].severity).toBe(expected);
  });

  it('falls back to the level key when severity is absent', () => {
    const report = createCodelinterReport([{ level: 'error', message: 'm' }]);
    expect(report.issues[0].severity).toBe('Error');
  });
});

describe('createCodelinterReport (field aliases)', () => {
  it('picks the first present alias for each field', () => {
    const report = createCodelinterReport([
      {
        filePath: 'a.ets',
        ruleId: 'no-unused-vars',
        description: 'unused variable',
        reportLine: 3,
        reportColumn: 7,
        severity: '1',
      },
    ]);
    expect(report.issues[0]).toEqual({
      file: 'a.ets',
      line: 3,
      column: 7,
      severity: 'Warning',
      rule: 'no-unused-vars',
      message: 'unused variable',
    });
  });

  it('accepts file/path and rule/ruleName aliases', () => {
    const report = createCodelinterReport([
      { file: 'b.ets', ruleName: 'Rule-Name', detail: 'd', level: 'info' },
      { path: 'c.ets', rule: 'r', message: 'm', level: 'info' },
    ]);
    expect(report.issues[0].file).toBe('b.ets');
    expect(report.issues[0].rule).toBe('rule-name');
    expect(report.issues[1].file).toBe('c.ets');
  });

  it('normalizes rule names via NFKC and angle-bracket stripping', () => {
    const report = createCodelinterReport([
      { rule: '<  @style/Name  >', message: 'm' },
      { rule: '＜ＲＵＬＥ＞', message: 'm' },
    ]);
    expect(report.issues[0].rule).toBe('@style/name');
    expect(report.issues[1].rule).toBe('rule');
  });

  it('ignores non-numeric line/column values', () => {
    const report = createCodelinterReport([
      { line: '5', column: '9', message: 'm' },
    ]);
    expect(report.issues[0].line).toBeUndefined();
    expect(report.issues[0].column).toBeUndefined();
  });

  it('drops rows without message, rule, or severity', () => {
    const report = createCodelinterReport([{}, { file: 'a.ets' }]);
    expect(report.issues).toHaveLength(0);
  });
});

describe('createCodelinterReport (nested structures)', () => {
  it('collects rows from nested message lists and inherits the parent file', () => {
    const report = createCodelinterReport({
      files: [
        {
          filePath: 'a.ets',
          messages: [{ rule: 'r1', severity: '1', message: 'm1' }],
        },
        {
          file: 'b.ets',
          defects: [{ rule: 'r2', severity: '2', message: 'm2' }],
        },
      ],
    });
    expect(report.issues.map((r) => [r.file, r.rule])).toEqual([
      ['b.ets', 'r2'],
      ['a.ets', 'r1'],
    ]);
    expect(report.summary.filesChecked).toBe(2);
  });

  it('walks arbitrary nesting depth via issues/results keys', () => {
    const report = createCodelinterReport({
      results: [{ path: 'a.ets', issues: [{ level: 'info', message: 'm' }] }],
    });
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].file).toBe('a.ets');
  });

  it('returns an empty report for non-object input', () => {
    const report = createCodelinterReport('nope');
    expect(report.issues).toEqual([]);
    expect(report.summary).toEqual({
      filesChecked: 0,
      issues: 0,
      errors: 0,
      warnings: 0,
      suggestions: 0,
    });
  });
});

describe('createCodelinterReport (sorting)', () => {
  it('orders issues by severity rank', () => {
    const report = createCodelinterReport([
      { file: 'b.ets', line: 1, severity: 'info', message: 'm' },
      { file: 'a.ets', line: 9, severity: '1', message: 'm' },
      { file: 'a.ets', line: 2, severity: '2', message: 'm' },
      { file: 'a.ets', severity: 'off', message: 'm' },
      { file: 'z.ets', severity: 'bizarre', message: 'm' },
    ]);
    expect(report.issues.map((r) => [r.file, r.severity])).toEqual([
      ['a.ets', 'Error'],
      ['a.ets', 'Warning'],
      ['b.ets', 'Info'],
      ['a.ets', 'Off'],
      ['z.ets', 'Unknown'],
    ]);
  });

  it('breaks ties by file, line, then column', () => {
    const report = createCodelinterReport([
      { file: 'b.ets', line: 1, column: 1, severity: '1', message: 'm' },
      { file: 'a.ets', line: 5, column: 9, severity: '1', message: 'm' },
      { file: 'a.ets', line: 5, column: 3, severity: '1', message: 'm' },
      { file: 'a.ets', line: 2, severity: '1', message: 'm' },
    ]);
    expect(report.issues.map((r) => r.line)).toEqual([2, 5, 5, 1]);
    expect(report.issues[1].column).toBe(3);
    expect(report.issues[2].column).toBe(9);
    expect(report.issues[3].file).toBe('b.ets');
  });

  it('sorts rows without a line number after rows with one', () => {
    const report = createCodelinterReport([
      { file: 'a.ets', severity: '1', message: 'm' },
      { file: 'a.ets', line: 5, severity: '1', message: 'm' },
    ]);
    expect(report.issues.map((r) => r.line)).toEqual([5, undefined]);
  });
});

describe('createCodelinterReport (summary)', () => {
  it('counts issues by severity and unique files', () => {
    const report = createCodelinterReport([
      { filePath: 'a.ets', severity: '2', message: 'm1' },
      { filePath: 'a.ets', severity: 'error', message: 'm2' },
      { filePath: 'b.ets', severity: '1', message: 'm3' },
      { filePath: 'b.ets', severity: '3', message: 'm4' },
      { filePath: 'c.ets' },
    ]);
    expect(report.summary).toEqual({
      filesChecked: 3,
      issues: 4,
      errors: 2,
      warnings: 1,
      suggestions: 1,
    });
  });

  it('counts container files even when they hold no issue rows', () => {
    const report = createCodelinterReport({
      filePath: 'd.ets',
      messages: [],
    });
    expect(report.summary.filesChecked).toBe(1);
    expect(report.summary.issues).toBe(0);
  });
});
