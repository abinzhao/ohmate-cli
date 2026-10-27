/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { CATALOG_TITLE_TO_ID, INDEX_VERSION } from './constants.js';
import { buildSqliteSearchIndex } from './sqlite-index.js';
import type { BuildMeta, DocumentIndexSource } from './segment-types.js';
import {
  buildDocumentIndexSources,
  resolveDocTitle,
} from './markdown-splitter.js';
import { copyLexiconFilesToDir, setLexiconDirOverride } from './lexicon.js';

export interface IndexBuildProgress {
  current: number;
  total: number;
  message: string;
}

interface DocMetadata {
  title: string;
}

async function insertDocumentsIntoIndex(
  documents: DocumentIndexSource[],
  tmpDir: string,
  onProgress?: (progress: IndexBuildProgress) => Promise<void> | void
): Promise<number> {
  const searchDbPath = path.join(tmpDir, 'search.db');
  await buildSqliteSearchIndex(
    searchDbPath,
    documents,
    async (current, total) => {
      await onProgress?.({
        current,
        total,
        message: `Building search index… ${current.toLocaleString()} / ${total.toLocaleString()} segments`,
      });
    }
  );
  return documents.length;
}

function collectZipMarkdownEntries(zip: AdmZip): AdmZip.IZipEntry[] {
  return zip.getEntries().filter((entry) => {
    if (entry.isDirectory) {
      return false;
    }
    if (!entry.entryName.endsWith('.md')) {
      return false;
    }
    const parts = entry.entryName.split('/');
    return parts.every((p) => !p.startsWith('.'));
  });
}

function resolveZipDocumentMeta(
  entryName: string
): { documentId: string; catalogId: number; docTitle: string } | null {
  let parts = entryName.split('/');
  if (parts[0] === 'docs') {
    parts = parts.slice(1);
  }
  if (parts.length < 2) {
    return null;
  }

  const catalogFolder = parts[0];
  const catalogId = CATALOG_TITLE_TO_ID[catalogFolder];
  if (catalogId === undefined) {
    return null;
  }

  const fileName = parts[parts.length - 1].replace(/\.md$/, '');
  parts[parts.length - 1] = fileName;
  return {
    documentId: parts.join('/'),
    catalogId,
    docTitle: fileName,
  };
}

function readZipJsonTitle(
  zip: AdmZip,
  mdEntryName: string
): string | undefined {
  const jsonEntryName = mdEntryName.replace(/\.md$/, '.json');
  const entry = zip.getEntry(jsonEntryName);
  if (!entry) {
    return undefined;
  }
  try {
    const metadata = JSON.parse(
      entry.getData().toString('utf-8')
    ) as DocMetadata;
    return metadata.title?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildDocumentSourcesFromZipEntry(
  entry: AdmZip.IZipEntry,
  zip: AdmZip
): DocumentIndexSource[] {
  const meta = resolveZipDocumentMeta(entry.entryName);
  if (!meta) {
    return [];
  }

  const markdown = entry.getData().toString('utf-8');
  const docTitle = resolveDocTitle(markdown, {
    jsonTitle: readZipJsonTitle(zip, entry.entryName),
    fileName: meta.docTitle,
  });
  return buildDocumentIndexSources(markdown, { ...meta, docTitle });
}

async function collectDocumentSourcesFromZip(
  docsZipPath: string
): Promise<DocumentIndexSource[]> {
  const zip = new AdmZip(docsZipPath);
  const entries = collectZipMarkdownEntries(zip);
  const documents: DocumentIndexSource[] = [];

  for (const entry of entries) {
    const sources = buildDocumentSourcesFromZipEntry(entry, zip);
    documents.push(...sources);
  }

  return documents;
}

function buildIndexMeta(
  options: {
    docsZipSha256: string;
    termsHash: string;
    synonymsHash: string;
    builtBy: BuildMeta['builtBy'];
  },
  segmentCount: number
): BuildMeta {
  return {
    indexVersion: INDEX_VERSION,
    docsZipSha256: options.docsZipSha256,
    termsHash: options.termsHash,
    synonymsHash: options.synonymsHash,
    segmentCount,
    builtAt: Date.now(),
    builtBy: options.builtBy,
  };
}

export async function buildSearchIndex(options: {
  docsZipPath: string;
  tmpDir: string;
  docsZipSha256: string;
  termsHash: string;
  synonymsHash: string;
  builtBy: BuildMeta['builtBy'];
  lexiconDir?: string;
  onProgress?: (progress: IndexBuildProgress) => Promise<void> | void;
}): Promise<BuildMeta> {
  if (options.lexiconDir) {
    setLexiconDirOverride(options.lexiconDir);
  }

  try {
    const documents = await collectDocumentSourcesFromZip(options.docsZipPath);

    await options.onProgress?.({
      current: 0,
      total: documents.length,
      message: `Building search index… 0 / ${documents.length.toLocaleString()} segments`,
    });

    await fs.promises.mkdir(options.tmpDir, { recursive: true });
    const total = await insertDocumentsIntoIndex(
      documents,
      options.tmpDir,
      options.onProgress
    );

    const meta = buildIndexMeta(options, total);
    await fs.promises.writeFile(
      path.join(options.tmpDir, 'build-meta.json'),
      JSON.stringify(meta, null, 2)
    );
    await copyLexiconFilesToDir(options.tmpDir);

    return meta;
  } finally {
    if (options.lexiconDir) {
      setLexiconDirOverride(null);
    }
  }
}
