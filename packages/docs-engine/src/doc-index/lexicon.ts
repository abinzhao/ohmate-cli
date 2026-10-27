/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBuildLexiconDir, getIndexDir } from './doc-paths.js';

export const INDEX_LEXICON_FILES = [
  'harmonyos-terms.txt',
  'harmonyos-synonyms.json',
  'harmonyos-stopwords.txt',
] as const;

export type IndexLexiconFile = (typeof INDEX_LEXICON_FILES)[number];

export class LexiconNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LexiconNotFoundError';
  }
}

export function isLexiconNotFoundError(
  error: unknown
): error is LexiconNotFoundError {
  return error instanceof LexiconNotFoundError;
}

let lexiconDirOverride: string | null = null;

export function setLexiconDirOverride(dir: string | null): void {
  lexiconDirOverride = dir;
}

function resolveLexiconSourceDir(): string {
  if (lexiconDirOverride) {
    return lexiconDirOverride;
  }

  const indexDir = getIndexDir();
  const fromIndex = INDEX_LEXICON_FILES.every((name) =>
    fs.existsSync(path.join(indexDir, name))
  );
  if (fromIndex) {
    return indexDir;
  }

  const buildDir = getBuildLexiconDir();
  const fromBuild = INDEX_LEXICON_FILES.every((name) =>
    fs.existsSync(path.join(buildDir, name))
  );
  if (fromBuild) {
    return buildDir;
  }

  throw new LexiconNotFoundError(
    'Lexicon files not found. Install the documentation index first (index.zip).'
  );
}

export function assertIndexLexiconReady(): void {
  resolveLexiconSourceDir();
}

export function readIndexLexiconFile(name: IndexLexiconFile): string {
  const filePath = path.join(resolveLexiconSourceDir(), name);
  return fs.readFileSync(filePath, 'utf-8');
}

export function readBuildLexiconFile(
  name: IndexLexiconFile,
  lexiconDir: string
): string {
  return fs.readFileSync(path.join(lexiconDir, name), 'utf-8');
}

export async function copyLexiconFilesToDir(
  destDir: string,
  sourceDir = resolveLexiconSourceDir()
): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  for (const name of INDEX_LEXICON_FILES) {
    const source = path.join(sourceDir, name);
    const target = path.join(destDir, name);
    await fs.promises.copyFile(source, target);
  }
}
