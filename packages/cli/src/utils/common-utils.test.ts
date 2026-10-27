/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CommonUtils } from './common-utils.js';

describe('parsePositiveInteger', () => {
  it('parses plain positive integers', () => {
    expect(CommonUtils.parsePositiveInteger('42')).toBe(42);
    expect(CommonUtils.parsePositiveInteger('1')).toBe(1);
  });
  it('trims surrounding whitespace', () => {
    expect(CommonUtils.parsePositiveInteger('  100 \t')).toBe(100);
  });
  it('rejects zero, negatives, floats and non-digits', () => {
    expect(() => CommonUtils.parsePositiveInteger('0')).toThrow(
      'value must be a positive integer'
    );
    expect(() => CommonUtils.parsePositiveInteger('-5')).toThrow();
    expect(() => CommonUtils.parsePositiveInteger('3.5')).toThrow();
    expect(() => CommonUtils.parsePositiveInteger('12a')).toThrow();
    expect(() => CommonUtils.parsePositiveInteger('')).toThrow();
  });
  it('uses the custom field name in the error message', () => {
    expect(() => CommonUtils.parsePositiveInteger('x', 'tail')).toThrow(
      'tail must be a positive integer'
    );
  });
});
describe('getLastLines', () => {
  it('returns the full log when lineCount is missing or non-positive', () => {
    const logs = 'a\nb\nc';
    expect(CommonUtils.getLastLines(logs)).toBe(logs);
    expect(CommonUtils.getLastLines(logs, 0)).toBe(logs);
    expect(CommonUtils.getLastLines(logs, -1)).toBe(logs);
  });

  it('keeps only the trailing N lines', () => {
    expect(CommonUtils.getLastLines('a\nb\nc', 2)).toBe('b\nc');
    expect(CommonUtils.getLastLines('a\nb\nc', 1)).toBe('c');
  });
  it('returns everything when lineCount exceeds the total', () => {
    expect(CommonUtils.getLastLines('a\nb', 10)).toBe('a\nb');
  });
  it('normalizes CRLF line endings', () => {
    expect(CommonUtils.getLastLines('a\r\nb\r\nc', 2)).toBe('b\nc');
  });
});
describe('parseDurationToSeconds', () => {
  it('parses seconds and bare numbers as integer seconds', () => {
    expect(CommonUtils.parseDurationToSeconds('30s')).toBe(30);
    expect(CommonUtils.parseDurationToSeconds('120')).toBe(120);
  });
  it('parses minutes including one decimal place', () => {
    expect(CommonUtils.parseDurationToSeconds('5m')).toBe(300);
    expect(CommonUtils.parseDurationToSeconds('2.5m')).toBe(150);
    expect(CommonUtils.parseDurationToSeconds('0.5m')).toBe(30);
  });
  it('trims and lowercases the input', () => {
    expect(CommonUtils.parseDurationToSeconds(' 5M ')).toBe(300);
  });
  it('rejects unsupported units and malformed values', () => {
    expect(() => CommonUtils.parseDurationToSeconds('1h')).toThrow(
      'value must be like 30s, 5m or 2.5m'
    );
    expect(() => CommonUtils.parseDurationToSeconds('30x')).toThrow();
    expect(() => CommonUtils.parseDurationToSeconds('s')).toThrow();
    expect(() => CommonUtils.parseDurationToSeconds('-5s')).toThrow();
  });
  it('rejects fractional seconds and minutes beyond one decimal', () => {
    expect(() => CommonUtils.parseDurationToSeconds('2.5s')).toThrow();
    expect(() => CommonUtils.parseDurationToSeconds('2.55m')).toThrow(
      'value supports a maximum of 1 decimal place for minutes'
    );
  });
  it('rejects zero durations', () => {
    expect(() => CommonUtils.parseDurationToSeconds('0s')).toThrow();
    expect(() => CommonUtils.parseDurationToSeconds('0m')).toThrow(
      'value must be a positive duration.'
    );
  });
});
describe('filterLogsByRelativeWindow', () => {
  const NOW = new Date(2026, 0, 15, 12, 0, 0, 0);
  function buildLogs(): string {
    return [
      '01-15 11:58:00.000 old block',
      'continuation of old block',
      '01-15 11:59:30.000 in-window block',
      '  at foo (bar.ts:1)',
      '01-15 12:00:30.000 after-window block',
      '01-15 12:01:00.000 later block',
    ].join('\n');
  }
  it('returns the original logs when no window is given', () => {
    const logs = buildLogs();
    expect(
      CommonUtils.filterLogsByRelativeWindow(logs, undefined, undefined, NOW)
    ).toBe(logs);
  });
  it('keeps only blocks within the from/to window', () => {
    const result = CommonUtils.filterLogsByRelativeWindow(
      buildLogs(),
      60,
      30,
      NOW
    );
    expect(result).toBe(
      '01-15 11:59:30.000 in-window block\n  at foo (bar.ts:1)'
    );
  });
  it('keeps continuation lines of a matched block but drops them for unmatched blocks', () => {
    const result = CommonUtils.filterLogsByRelativeWindow(
      buildLogs(),
      60,
      30,
      NOW
    );
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('  at foo (bar.ts:1)');
  });
  it('with only --from, treats now as the upper bound', () => {
    const result = CommonUtils.filterLogsByRelativeWindow(
      buildLogs(),
      60,
      undefined,
      NOW
    );
    const kept = result.split('\n');
    expect(kept[0]).toBe('01-15 11:59:30.000 in-window block');
    expect(kept).not.toContain('01-15 11:58:00.000 old block');
  });
  it('with only --to, keeps only blocks at or before the bound', () => {
    const result = CommonUtils.filterLogsByRelativeWindow(
      buildLogs(),
      undefined,
      120,
      NOW
    );
    expect(result).toBe(
      '01-15 11:58:00.000 old block\ncontinuation of old block'
    );
  });
  it('normalizes a reversed from/to pair', () => {
    const result = CommonUtils.filterLogsByRelativeWindow(
      buildLogs(),
      30,
      60,
      NOW
    );
    expect(result).toBe(
      '01-15 11:59:30.000 in-window block\n  at foo (bar.ts:1)'
    );
  });
});
describe('assertBundleName', () => {
  it('accepts letters, digits, underscores and dots', () => {
    expect(() =>
      CommonUtils.assertBundleName('com.example.app_1')
    ).not.toThrow();
  });
  it('accepts the maximum length of 128', () => {
    expect(() => CommonUtils.assertBundleName('a'.repeat(128))).not.toThrow();
  });
  it('rejects empty, oversize and invalid characters', () => {
    expect(() => CommonUtils.assertBundleName('')).toThrow(
      'Invalid bundleName'
    );
    expect(() => CommonUtils.assertBundleName('a'.repeat(129))).toThrow();
    expect(() => CommonUtils.assertBundleName('com example')).toThrow();
    expect(() => CommonUtils.assertBundleName('com.example.app!')).toThrow();
    expect(() => CommonUtils.assertBundleName('com.example.应用')).toThrow();
  });
});
describe('assertBundleNameStrict', () => {
  it('accepts a well-formed bundle name', () => {
    expect(() =>
      CommonUtils.assertBundleNameStrict('com.example.myapplication')
    ).not.toThrow();
  });
  it('allows non-first segments to start with a digit', () => {
    expect(() =>
      CommonUtils.assertBundleNameStrict('com.2x.app')
    ).not.toThrow();
  });
  it('enforces the 7-128 length range', () => {
    expect(() => CommonUtils.assertBundleNameStrict('ab.cd')).toThrow(
      'Bundle name length must be 7-128 characters. Current: 5'
    );
    expect(() =>
      CommonUtils.assertBundleNameStrict(`com.${'a'.repeat(125)}.x`)
    ).toThrow('length must be 7-128');
  });
  it('rejects consecutive dots', () => {
    expect(() => CommonUtils.assertBundleNameStrict('com..example')).toThrow(
      'cannot contain consecutive dots'
    );
  });
  it('requires at least three segments', () => {
    expect(() => CommonUtils.assertBundleNameStrict('com.example')).toThrow(
      'at least 3 dot-separated segments'
    );
  });
  it('requires the first segment to start with a letter', () => {
    expect(() => CommonUtils.assertBundleNameStrict('123.example.app')).toThrow(
      'First segment "123" must start with a letter'
    );
  });
  it('rejects invalid characters inside segments', () => {
    expect(() =>
      CommonUtils.assertBundleNameStrict('com.exa mple.app')
    ).toThrow('contains invalid characters');
  });
  it('requires segments to end with a letter or digit', () => {
    expect(() => CommonUtils.assertBundleNameStrict('com.exa_.app')).toThrow(
      'must end with a letter or digit'
    );
    expect(() =>
      CommonUtils.assertBundleNameStrict('com.example.app_')
    ).toThrow();
  });
});
describe('assertModuleName and assertAbilityName', () => {
  it('accepts letters, digits, underscores and dots', () => {
    expect(() => CommonUtils.assertModuleName('entry')).not.toThrow();
    expect(() => CommonUtils.assertModuleName('my_module.v2')).not.toThrow();
    expect(() => CommonUtils.assertAbilityName('EntryAbility_1')).not.toThrow();
  });
  it('rejects empty names and unsafe characters', () => {
    expect(() => CommonUtils.assertModuleName('')).toThrow(
      'Invalid module name'
    );
    expect(() => CommonUtils.assertModuleName('a b')).toThrow();
    expect(() => CommonUtils.assertModuleName('a/b')).toThrow();
    expect(() => CommonUtils.assertAbilityName('a-b')).toThrow(
      'Invalid ability name'
    );
  });
});
describe('assertHilogToken', () => {
  it('accepts letters, digits, underscore, dot, colon and hyphen', () => {
    expect(() =>
      CommonUtils.assertHilogToken('abc_DEF-123:456.789', 'tag')
    ).not.toThrow();
  });
  it('allows up to 64 characters', () => {
    expect(() =>
      CommonUtils.assertHilogToken('a'.repeat(64), 'tag')
    ).not.toThrow();
    expect(() => CommonUtils.assertHilogToken('a'.repeat(65), 'tag')).toThrow(
      'Invalid tag'
    );
  });
  it('rejects empty values and characters outside the allowlist', () => {
    expect(() => CommonUtils.assertHilogToken('', 'domain')).toThrow(
      'Invalid domain'
    );
    expect(() => CommonUtils.assertHilogToken('a b', 'tag')).toThrow();
    expect(() => CommonUtils.assertHilogToken('a"b', 'tag')).toThrow();
  });
});
describe('assertHilogKeyword', () => {
  it('accepts plain and unicode keywords up to 128 chars', () => {
    expect(() => CommonUtils.assertHilogKeyword('crash')).not.toThrow();
    expect(() => CommonUtils.assertHilogKeyword('k'.repeat(128))).not.toThrow();
    expect(() => CommonUtils.assertHilogKeyword('启动失败')).not.toThrow();
  });
  it('rejects empty and oversize keywords', () => {
    expect(() => CommonUtils.assertHilogKeyword('')).toThrow('Invalid keyword');
    expect(() => CommonUtils.assertHilogKeyword('k'.repeat(129))).toThrow();
  });
  it('rejects control characters including DEL', () => {
    expect(() => CommonUtils.assertHilogKeyword('bad\nkeyword')).toThrow();
    expect(() => CommonUtils.assertHilogKeyword('tab\there')).toThrow();
    expect(() => CommonUtils.assertHilogKeyword('del\x7fchar')).toThrow();
  });
});
describe('quotePosixShellArg', () => {
  it('wraps plain values in single quotes', () => {
    expect(CommonUtils.quotePosixShellArg('simple')).toBe("'simple'");
    expect(CommonUtils.quotePosixShellArg('a b"c')).toBe("'a b\"c'");
  });
  it('escapes embedded single quotes using the close-escape-reopen pattern', () => {
    expect(CommonUtils.quotePosixShellArg("it's")).toBe("'it'\\''s'");
    expect(CommonUtils.quotePosixShellArg("'")).toBe("''\\'''");
  });
  it('returns an empty quoted string for empty input', () => {
    expect(CommonUtils.quotePosixShellArg('')).toBe("''");
  });
});
describe('assertCrashFilename', () => {
  it('accepts well-formed fault log filenames', () => {
    expect(() =>
      CommonUtils.assertCrashFilename(
        'jscrash-com.example.myapplication-20020059-20260512170652'
      )
    ).not.toThrow();
    expect(() =>
      CommonUtils.assertCrashFilename('cppcrash-com.app-123-456')
    ).not.toThrow();
  });
  it('rejects traversal, spaces and malformed shapes', () => {
    expect(() => CommonUtils.assertCrashFilename('../etc/passwd')).toThrow(
      'Invalid crash log filename'
    );
    expect(() => CommonUtils.assertCrashFilename('jscrash-x')).toThrow();
    expect(() =>
      CommonUtils.assertCrashFilename('jscrash-com.app-1-2 extra')
    ).toThrow();
    expect(() =>
      CommonUtils.assertCrashFilename('cppcrash-com.app-abc-123')
    ).toThrow();
  });
});
describe('assertHilogLevel', () => {
  it('accepts the five single-letter levels', () => {
    for (const level of ['D', 'I', 'W', 'E', 'F']) {
      expect(() => CommonUtils.assertHilogLevel(level)).not.toThrow();
    }
  });
  it('rejects anything else', () => {
    expect(() => CommonUtils.assertHilogLevel('d')).toThrow(
      'Invalid log level'
    );
    expect(() => CommonUtils.assertHilogLevel('X')).toThrow();
    expect(() => CommonUtils.assertHilogLevel('DD')).toThrow();
    expect(() => CommonUtils.assertHilogLevel('')).toThrow();
  });
});
describe('resolvePathWithinRoot / ensurePathWithinRoot', () => {
  const root = path.resolve(path.sep, 'proj');
  it('joins a relative path inside the root', () => {
    const resolved = CommonUtils.resolvePathWithinRoot(
      root,
      path.join('sub', 'file.txt')
    );
    expect(resolved).toBe(path.join(root, 'sub', 'file.txt'));
  });
  it('normalizes inner .. segments that stay inside the root', () => {
    const resolved = CommonUtils.resolvePathWithinRoot(
      root,
      path.join('a', '..', 'b')
    );
    expect(resolved).toBe(path.join(root, 'b'));
  });
  it('rejects absolute paths', () => {
    expect(() =>
      CommonUtils.resolvePathWithinRoot(root, path.join(path.sep, 'elsewhere'))
    ).toThrow('Absolute paths are not allowed');
  });
  it('rejects traversal outside the root', () => {
    expect(() =>
      CommonUtils.resolvePathWithinRoot(root, '..' + path.sep + 'x')
    ).toThrow('Path escapes project root');
  });
  it('ensurePathWithinRoot passes through paths inside the root', () => {
    const inside = path.join(root, 'sub');
    expect(CommonUtils.ensurePathWithinRoot(root, inside)).toBe(inside);
  });
  it('ensurePathWithinRoot rejects escaping paths', () => {
    const outside = path.join(root, '..', 'outside');
    expect(() => CommonUtils.ensurePathWithinRoot(root, outside)).toThrow(
      'Path escapes project root'
    );
  });
});
describe('isPathContained', () => {
  const root = path.resolve(path.sep, 'proj');

  it('marks paths inside the project as contained', () => {
    expect(CommonUtils.isPathContained(path.join('a', 'b.txt'), root)).toEqual({
      contained: true,
    });
    expect(CommonUtils.isPathContained('.', root).contained).toBe(true);
  });
  it('flags relative traversal with a reason', () => {
    const result = CommonUtils.isPathContained('..' + path.sep + 'x', root);
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('Path traversal');
  });
  it('flags absolute paths outside the root', () => {
    const outside = path.join(path.sep, 'elsewhere');
    expect(CommonUtils.isPathContained(outside, root).contained).toBe(false);
  });
});
describe('isPathContainedWithSymlink', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'common-utils-ut-'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'x');
  });
  it('contains regular files inside the root', () => {
    const result = CommonUtils.isPathContainedWithSymlink(
      path.join('sub', 'file.txt'),
      root
    );
    expect(result).toEqual({ contained: true });
  });
  it('reports a reason when the path does not exist', () => {
    const result = CommonUtils.isPathContainedWithSymlink(
      path.join('sub', 'missing.txt'),
      root
    );
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('does not exist');
  });
  it('reports a reason when the project root does not exist', () => {
    const result = CommonUtils.isPathContainedWithSymlink(
      'x',
      path.join(os.tmpdir(), 'common-utils-ut-no-such-root')
    );
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('Project root directory does not exist');
  });
  it('rejects traversal before touching the filesystem', () => {
    const result = CommonUtils.isPathContainedWithSymlink(
      '..' + path.sep + 'x',
      root
    );
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('Path traversal');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});
describe('isPathContainedWithSymlink with real symlinks', () => {
  let root: string;
  let outsideRoot: string;
  let fileLinkCreated: boolean;
  const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'common-utils-link-ut-'));
    outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'common-utils-link-out-')
    );
    fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'top secret');
    fs.symlinkSync(outsideRoot, path.join(root, 'escape-dir'), dirLinkType);
    fs.symlinkSync(
      path.join(root, 'inside'),
      path.join(root, 'inside-link'),
      dirLinkType
    );
    try {
      fs.symlinkSync(
        path.join(outsideRoot, 'secret.txt'),
        path.join(root, 'escape-file.txt'),
        'file'
      );
      fileLinkCreated = true;
    } catch {
      fileLinkCreated = false;
    }
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  it('rejects a directory link that escapes the project root', () => {
    const result = CommonUtils.isPathContainedWithSymlink('escape-dir', root);
    expect(result.contained).toBe(false);
    expect(result.reason).toBeTruthy();
  });
  it('rejects a file link that escapes the project root', () => {
    if (!fileLinkCreated) {
      return;
    }
    const result = CommonUtils.isPathContainedWithSymlink(
      'escape-file.txt',
      root
    );
    expect(result.contained).toBe(false);
    expect(result.reason).toBeTruthy();
  });
  it('accepts a legitimate link that stays inside the project root', () => {
    const result = CommonUtils.isPathContainedWithSymlink('inside-link', root);
    expect(result).toEqual({ contained: true });
  });
});
