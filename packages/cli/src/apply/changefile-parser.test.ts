/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseApplyFileList } from './changefile-parser.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changefile-ut-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, rel: string, content = 'x'): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeList(root: string, content: string): string {
  const listPath = path.join(root, 'changed-files.txt');
  fs.writeFileSync(listPath, content);
  return listPath;
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('parseApplyFileList', () => {
  it('resolves relative entries to absolute paths preserving order', () => {
    const root = makeRoot();
    const a = writeFile(root, path.join('entry', 'src', 'a.ets'));
    const b = writeFile(root, path.join('entry', 'b.json5'));
    const listPath = writeList(
      root,
      [path.join('entry', 'src', 'a.ets'), path.join('entry', 'b.json5')].join(
        '\n'
      )
    );
    expect(parseApplyFileList(listPath, root)).toEqual([a, b]);
  });

  it('skips blank lines and comment lines and trims whitespace', () => {
    const root = makeRoot();
    const a = writeFile(root, 'a.ets');
    const listPath = writeList(
      root,
      ['  a.ets  ', '# a comment', '', '   ', '\t'].join('\n')
    );
    expect(parseApplyFileList(listPath, root)).toEqual([a]);
  });

  it('normalizes CRLF line endings', () => {
    const root = makeRoot();
    const a = writeFile(root, 'a.ets');
    const b = writeFile(root, 'b.ets');
    const listPath = writeList(root, 'a.ets\r\nb.ets\r\n');
    expect(parseApplyFileList(listPath, root)).toEqual([a, b]);
  });

  it('deduplicates entries that resolve to the same absolute path', () => {
    const root = makeRoot();
    const a = writeFile(root, path.join('entry', 'a.ets'));
    const listPath = writeList(
      root,
      [
        path.join('entry', 'a.ets'),
        `.${path.sep}${path.join('entry', 'a.ets')}`,
        `entry${path.sep}..${path.sep}${path.join('entry', 'a.ets')}`,
      ].join('\n')
    );
    expect(parseApplyFileList(listPath, root)).toEqual([a]);
  });

  it('accepts absolute paths inside the project root', () => {
    const root = makeRoot();
    const a = writeFile(root, 'a.ets');
    const listPath = writeList(root, a);
    expect(parseApplyFileList(listPath, root)).toEqual([a]);
  });

  it('rejects relative traversal outside the project root', () => {
    const root = makeRoot();
    const listPath = writeList(root, `..${path.sep}evil.ets`);
    expect(() => parseApplyFileList(listPath, root)).toThrow(
      'File path is outside the project directory'
    );
  });

  it('rejects absolute paths outside the project root', () => {
    const root = makeRoot();
    const outside = path.resolve(root, '..', 'outside.ets');
    const listPath = writeList(root, outside);
    expect(() => parseApplyFileList(listPath, root)).toThrow(
      'File path is outside the project directory'
    );
  });

  it('rejects symlinks that escape the project root', (ctx) => {
    const root = makeRoot();
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'changefile-ut-out-')
    );
    tempRoots.push(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'secret.ets'), 'x');
    let entry = 'link.ets';
    try {
      fs.symlinkSync(
        path.join(outsideRoot, 'secret.ets'),
        path.join(root, entry),
        'file'
      );
    } catch {
      try {
        fs.symlinkSync(outsideRoot, path.join(root, 'jdir'), 'junction');
        entry = path.join('jdir', 'secret.ets');
      } catch {
        ctx.skip();
        return;
      }
    }
    const listPath = writeList(root, entry);
    expect(() => parseApplyFileList(listPath, root)).toThrow(
      `File path is outside the project directory: ${entry}`
    );
  });

  it('throws when the list file is missing', () => {
    const root = makeRoot();
    expect(() =>
      parseApplyFileList(path.join(root, 'no-such.txt'), root)
    ).toThrow('Apply file list not found');
  });

  it('throws when the list contains no valid entries', () => {
    const root = makeRoot();
    const listPath = writeList(root, '# only comments\n\n');
    expect(() => parseApplyFileList(listPath, root)).toThrow(
      'Apply file list is empty'
    );
  });

  it('throws File not found for entries missing on disk', () => {
    const root = makeRoot();
    const listPath = writeList(root, 'missing.ets');
    expect(() => parseApplyFileList(listPath, root)).toThrow(
      'File not found: missing.ets'
    );
  });
});
