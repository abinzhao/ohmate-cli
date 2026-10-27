/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { findDocsZip } from './doc-paths.js';

interface DocsZipCache {
  zipPath: string;
  mtimeMs: number;
  size: number;
  zipfile: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
  readChain: Promise<void>;
}

let docsZipCache: DocsZipCache | null = null;

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false, autoClose: false },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(error ?? new Error(`Failed to open zip: ${zipPath}`));
          return;
        }
        resolve(zipfile);
      }
    );
  });
}

function normalizeEntryFileName(entry: yauzl.Entry): string {
  const rawFileName = entry.fileName as unknown;
  const fileName = Buffer.isBuffer(rawFileName)
    ? rawFileName.toString('utf-8')
    : String(rawFileName);
  return fileName.replace(/\\/g, '/');
}

function loadEntryIndex(
  zipfile: yauzl.ZipFile
): Promise<Map<string, yauzl.Entry>> {
  const entries = new Map<string, yauzl.Entry>();
  return new Promise((resolve, reject) => {
    zipfile.readEntry();
    zipfile.on('entry', (entry) => {
      const fileName = normalizeEntryFileName(entry);
      if (!fileName.endsWith('/')) {
        entries.set(fileName, entry);
      }
      zipfile.readEntry();
    });
    zipfile.on('end', () => {
      resolve(entries);
    });
    zipfile.on('error', reject);
  });
}

function closeDocsZipCache(): void {
  docsZipCache?.zipfile.close();
  docsZipCache = null;
}

async function getDocsZipCache(zipPath: string): Promise<DocsZipCache> {
  const resolvedPath = path.resolve(zipPath);
  const stat = await fs.promises.stat(resolvedPath);
  const cached = docsZipCache;
  if (
    cached &&
    cached.zipPath === resolvedPath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached;
  }

  closeDocsZipCache();
  const zipfile = await openZip(resolvedPath);
  let entries: Map<string, yauzl.Entry>;
  try {
    entries = await loadEntryIndex(zipfile);
  } catch (error) {
    zipfile.close();
    throw new Error(`Failed to read entries from zip: ${resolvedPath}`, { cause: error });
  }
  docsZipCache = {
    zipPath: resolvedPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    zipfile,
    entries,
    readChain: Promise.resolve(),
  };
  return docsZipCache;
}

function readEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          error ?? new Error(`Failed to read zip entry: ${entry.fileName}`)
        );
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', reject);
    });
  });
}

async function readEntryWithLock(
  cache: DocsZipCache,
  entry: yauzl.Entry
): Promise<Buffer> {
  const previous = cache.readChain;
  let release!: () => void;
  cache.readChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await readEntryStream(cache.zipfile, entry);
  } finally {
    release();
  }
}

function documentIdToZipEntries(documentId: string): string[] {
  const normalized = documentId.replace(/\\/g, '/').replace(/\.md$/, '');
  if (normalized.split('/').includes('..')) {
    throw new Error('Invalid document ID: path traversal is not allowed.');
  }
  return [
    `docs/${normalized}.md`,
    `${normalized}.md`,
    `docs/${normalized}`,
    normalized,
  ];
}

function lookupEntry(
  entries: Map<string, yauzl.Entry>,
  entryNames: string[]
): yauzl.Entry | null {
  for (const name of entryNames) {
    const entry = entries.get(name.replace(/\\/g, '/'));
    if (entry) {
      return entry;
    }
  }
  return null;
}

export async function readMarkdownFromDocsZip(
  documentId: string
): Promise<string> {
  const zipPath = findDocsZip();
  if (!zipPath) {
    throw new Error('docs.zip not found');
  }

  const cache = await getDocsZipCache(zipPath);
  const entry = lookupEntry(cache.entries, documentIdToZipEntries(documentId));
  if (!entry) {
    throw new Error(`Document not found: ${documentId}`);
  }

  const buffer = await readEntryWithLock(cache, entry);
  return buffer.toString('utf-8');
}

export function resolveDocsZipPath(): string {
  const zipPath = findDocsZip();
  if (!zipPath) {
    throw new Error('docs.zip not found');
  }
  return path.resolve(zipPath);
}

export function isDocsZipAvailable(): boolean {
  const zipPath = findDocsZip();
  return zipPath !== null && fs.existsSync(zipPath);
}

/** Clears the in-memory docs.zip entry index (for tests or after docs.zip replacement). */
export function resetDocsZipReaderCache(): void {
  closeDocsZipCache();
}
