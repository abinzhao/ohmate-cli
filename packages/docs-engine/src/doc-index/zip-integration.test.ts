/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchIndex } from './index-builder.js';
import { installBundledIndex, isBundledIndexUsable } from './index-bundle.js';
import { resetSearchDbCache, searchSqliteIndex } from './sqlite-index.js';
import { INDEX_LEXICON_FILES } from './lexicon.js';
import { CATALOG_TITLE_TO_ID } from './constants.js';
import { findBundledIndexZip, getIndexDir } from './doc-paths.js';
import { setCacheDir } from '../data-dir.js';

vi.mock('./doc-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./doc-paths.js')>()),
  findBundledIndexZip: vi.fn(),
}));

describe('documentation ZIP integration with real adm-zip', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-doc-zip-'));
    setCacheDir(path.join(root, 'data'));
    vi.mocked(findBundledIndexZip).mockReturnValue(
      path.join(root, 'index.zip')
    );
  });

  afterEach(async () => {
    resetSearchDbCache();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds, packs, installs and searches a ZIP containing Chinese Markdown and JSON metadata', async () => {
    const docs = new AdmZip();
    const catalog = Object.keys(CATALOG_TITLE_TO_ID)[0];
    docs.addFile(
      `docs/${catalog}/示例.md`,
      Buffer.from('# ZipRegression\n\nZipRegression searchable documentation.')
    );
    docs.addFile(
      `docs/${catalog}/示例.json`,
      Buffer.from(JSON.stringify({ title: 'ZipRegression 文档' }))
    );
    docs.addFile(`docs/${catalog}/.hidden.md`, Buffer.from('# HiddenOnly'));
    docs.addFile('docs/empty/', Buffer.alloc(0));
    const docsZipPath = path.join(root, 'docs.zip');
    docs.writeZip(docsZipPath);
    const buildDir = path.join(root, 'build');
    const meta = await buildSearchIndex({
      docsZipPath,
      tmpDir: buildDir,
      docsZipSha256: 'test-docs-hash',
      termsHash: 'test-terms-hash',
      synonymsHash: 'test-synonyms-hash',
      builtBy: 'doc-init',
      lexiconDir: path.resolve('packages/docs-index-builder/data'),
    });
    expect(meta.segmentCount).toBe(1);
    const bundle = new AdmZip();
    const files = ['search.db', 'build-meta.json', ...INDEX_LEXICON_FILES];
    for (const name of files) {
      bundle.addLocalFile(path.join(buildDir, name));
    }
    bundle.writeZip(path.join(root, 'index.zip'));

    expect(isBundledIndexUsable('different-hash')).toBe(false);
    await expect(installBundledIndex('different-hash')).rejects.toThrow(
      'does not match docs.zip'
    );
    expect(isBundledIndexUsable('test-docs-hash')).toBe(true);
    expect(await installBundledIndex('test-docs-hash')).toEqual(meta);
    for (const name of files) {
      expect(await fs.readFile(path.join(getIndexDir(), name))).toEqual(
        await fs.readFile(path.join(buildDir, name))
      );
    }
    const results = await searchSqliteIndex(['ZipRegression']);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: `${catalog}/示例`,
          title: 'ZipRegression 文档',
        }),
      ])
    );
  });
});
