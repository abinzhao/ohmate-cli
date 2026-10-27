/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCacheDir } from '../data-dir.js';
import { getBuildLexiconDir, getIndexDir } from './doc-paths.js';
import {
  assertIndexLexiconReady,
  copyLexiconFilesToDir,
  INDEX_LEXICON_FILES,
  isLexiconNotFoundError,
  LexiconNotFoundError,
  readBuildLexiconFile,
  readIndexLexiconFile,
  setLexiconDirOverride,
} from './lexicon.js';

vi.mock('./doc-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./doc-paths.js')>()),
  getBuildLexiconDir: vi.fn(),
}));

const TERMS_FILE = INDEX_LEXICON_FILES[0];

function writeLexiconSet(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of INDEX_LEXICON_FILES) {
    fs.writeFileSync(path.join(dir, name), `${marker}:${name}`);
  }
}

describe('lexicon', () => {
  let root: string;
  let indexDir: string;
  let buildDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-doc-lexicon-'));
    setCacheDir(path.join(root, 'data'));
    indexDir = getIndexDir();
    buildDir = path.join(root, 'build-data');
    vi.mocked(getBuildLexiconDir).mockReturnValue(buildDir);
  });

  afterEach(() => {
    setLexiconDirOverride(null);
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads lexicon files from the override directory', () => {
    const overrideDir = path.join(root, 'override');
    writeLexiconSet(overrideDir, 'override');
    setLexiconDirOverride(overrideDir);
    expect(readIndexLexiconFile(TERMS_FILE)).toBe(`override:${TERMS_FILE}`);
  });

  it('prefers the override even when an installed index exists', () => {
    writeLexiconSet(indexDir, 'index');
    const overrideDir = path.join(root, 'override');
    writeLexiconSet(overrideDir, 'override');
    setLexiconDirOverride(overrideDir);
    expect(readIndexLexiconFile(TERMS_FILE)).toBe(`override:${TERMS_FILE}`);
  });

  it('prefers the installed index directory when the full set exists there', () => {
    writeLexiconSet(indexDir, 'index');
    writeLexiconSet(buildDir, 'build');
    expect(readIndexLexiconFile(TERMS_FILE)).toBe(`index:${TERMS_FILE}`);
    expect(() => assertIndexLexiconReady()).not.toThrow();
  });

  it('falls back to the build lexicon directory when the index is incomplete', () => {
    // Only one of the three files is installed in the index directory.
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, INDEX_LEXICON_FILES[0]), 'partial');
    writeLexiconSet(buildDir, 'build');
    expect(readIndexLexiconFile(TERMS_FILE)).toBe(`build:${TERMS_FILE}`);
  });

  it('throws LexiconNotFoundError when no directory has the full set', () => {
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, INDEX_LEXICON_FILES[0]), 'partial');
    expect(() => readIndexLexiconFile(TERMS_FILE)).toThrow(
      LexiconNotFoundError
    );
    expect(() => readIndexLexiconFile(TERMS_FILE)).toThrow(
      /Lexicon files not found/
    );
    expect(() => assertIndexLexiconReady()).toThrow(LexiconNotFoundError);
  });

  it('classifies only LexiconNotFoundError via isLexiconNotFoundError', () => {
    const error = new LexiconNotFoundError('missing');
    expect(isLexiconNotFoundError(error)).toBe(true);
    expect(isLexiconNotFoundError(new Error('missing'))).toBe(false);
    expect(isLexiconNotFoundError('missing')).toBe(false);
  });

  it('readBuildLexiconFile reads from the given directory', () => {
    writeLexiconSet(buildDir, 'build');
    expect(readBuildLexiconFile(TERMS_FILE, buildDir)).toBe(
      `build:${TERMS_FILE}`
    );
  });

  it('copyLexiconFilesToDir copies the full file set into a nested destination', async () => {
    const sourceDir = path.join(root, 'source');
    writeLexiconSet(sourceDir, 'source');
    const destDir = path.join(root, 'dest', 'nested');
    await copyLexiconFilesToDir(destDir, sourceDir);
    for (const name of INDEX_LEXICON_FILES) {
      expect(fs.readFileSync(path.join(destDir, name), 'utf8')).toBe(
        `source:${name}`
      );
    }
  });

  it('copyLexiconFilesToDir defaults to the resolved source directory', async () => {
    writeLexiconSet(indexDir, 'index');
    const destDir = path.join(root, 'dest');
    await copyLexiconFilesToDir(destDir);
    expect(fs.readFileSync(path.join(destDir, TERMS_FILE), 'utf8')).toBe(
      `index:${TERMS_FILE}`
    );
  });
});
