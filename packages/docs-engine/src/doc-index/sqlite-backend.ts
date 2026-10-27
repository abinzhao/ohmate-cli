/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { readFile, stat, writeFile } from 'fs/promises';
import type { CatalogName } from '../portal/catalog.js';
import type { LocalSearchResult } from '../service/local-doc-service.js';
import { INSERT_BATCH_SIZE } from './constants.js';
import type { DocumentIndexSource } from './segment-types.js';
import { buildDocumentSearchText, getJieba } from './tokenizer.js';
import type { FtsDbReader } from './sqlite-fts-search.js';
import { runFtsSearch } from './sqlite-fts-search.js';
import type { SqliteBackend } from './sqlite-types.js';
import { SQLITE_INDEX_SCHEMA_SQL } from './sqlite-schema.js';

type SqliteWasmModule = Awaited<
  ReturnType<typeof import('@sqlite.org/sqlite-wasm').default>
>;
type WasmDatabase = InstanceType<SqliteWasmModule['oo1']['DB']>;

interface CachedDb {
  dbPath: string;
  mtimeMs: number;
  db: WasmDatabase;
}

let sqliteModulePromise: Promise<SqliteWasmModule> | null = null;
let cachedDb: CachedDb | null = null;
let openChain: Promise<void> = Promise.resolve();

async function getSqliteModule(): Promise<SqliteWasmModule> {
  if (!sqliteModulePromise) {
    sqliteModulePromise = (async () => {
      const init = (await import('@sqlite.org/sqlite-wasm')).default;
      return init();
    })();
  }
  return sqliteModulePromise;
}

function createWasmReader(db: WasmDatabase): FtsDbReader {
  return {
    all<T>(sql: string, ...params: (string | number)[]): T[] {
      const stmt = db.prepare(sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.get({}) as T);
      }
      stmt.finalize();
      return rows;
    },
  };
}

async function openReadonlyDbInner(dbPath: string): Promise<WasmDatabase> {
  const fileStat = await stat(dbPath);
  if (
    cachedDb &&
    cachedDb.dbPath === dbPath &&
    cachedDb.mtimeMs === fileStat.mtimeMs
  ) {
    return cachedDb.db;
  }

  cachedDb?.db.close();
  const sqlite3 = await getSqliteModule();
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;
  const bytes = new Uint8Array(await readFile(dbPath));
  const ptr = wasm.allocFromTypedArray(bytes);
  let db: WasmDatabase | undefined;
  let stored = false;
  try {
    db = new sqlite3.oo1.DB(':memory:');
    const pointer = db.pointer;
    if (pointer === undefined) {
      throw new Error('SQLite database pointer unavailable');
    }
    const flags =
      capi.SQLITE_DESERIALIZE_READONLY |
      capi.SQLITE_DESERIALIZE_RESIZEABLE |
      capi.SQLITE_DESERIALIZE_FREEONCLOSE;
    const rc = capi.sqlite3_deserialize(
      pointer,
      'main',
      ptr,
      bytes.byteLength,
      bytes.byteLength,
      flags
    );
    if (rc !== capi.SQLITE_OK) {
      throw new Error(
        `Failed to open readonly database: sqlite3_deserialize returned code ${rc} for: ${dbPath}`
      );
    }
    cachedDb = { dbPath, mtimeMs: fileStat.mtimeMs, db };
    stored = true;
    return db;
  } finally {
    if (!stored) {
      db?.close();
      wasm.dealloc(ptr);
    }
  }
}

async function openReadonlyDb(dbPath: string): Promise<WasmDatabase> {
  let release!: () => void;
  const previous = openChain;
  openChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await openReadonlyDbInner(dbPath);
  } finally {
    release();
  }
}

function resetWasmCache(): void {
  cachedDb?.db.close();
  cachedDb = null;
}

async function insertIndexedBatch(
  db: WasmDatabase,
  insertSegment: ReturnType<WasmDatabase['prepare']>,
  getOrCreateDocId: (source: DocumentIndexSource) => number,
  batch: Array<{ source: DocumentIndexSource; searchText: string }>
): Promise<void> {
  db.exec('BEGIN');
  for (const row of batch) {
    const docId = getOrCreateDocId(row.source);
    insertSegment.bind([
      docId,
      row.source.sectionTitle,
      row.source.leadText,
      row.searchText,
      row.source.excerptTruncated ? 1 : 0,
    ]);
    insertSegment.step();
    insertSegment.reset();
  }
  db.exec('COMMIT');
}

function createDocIdResolver(
  db: WasmDatabase,
  cache: Map<string, number>,
  insertDocument: ReturnType<WasmDatabase['prepare']>
) {
  return (source: DocumentIndexSource): number => {
    const cached = cache.get(source.documentId);
    if (cached !== undefined) {
      return cached;
    }

    const existing = db.selectValue(
      'SELECT id FROM documents WHERE document_id = ?',
      [source.documentId]
    );
    if (existing !== undefined && existing !== null) {
      const docId = Number(existing);
      cache.set(source.documentId, docId);
      return docId;
    }

    insertDocument.bind([source.documentId, source.catalogId, source.docTitle]);
    insertDocument.step();
    insertDocument.reset();
    const docId = Number(db.selectValue('SELECT last_insert_rowid()'));
    cache.set(source.documentId, docId);
    return docId;
  };
}

async function buildWasmIndex(
  dbPath: string,
  sources: DocumentIndexSource[],
  onProgress?: (current: number, total: number) => Promise<void> | void
): Promise<void> {
  await getJieba();
  const sqlite3 = await getSqliteModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec(SQLITE_INDEX_SCHEMA_SQL);

  const docIdCache = new Map<string, number>();
  const insertDocument = db.prepare(
    'INSERT INTO documents(document_id, catalog_id, doc_title) VALUES (?, ?, ?)'
  );
  const insertSegment = db.prepare(
    'INSERT INTO segments(doc_id, section_title, lead_text, search_text, excerpt_truncated) VALUES (?, ?, ?, ?, ?)'
  );

  const getOrCreateDocId = createDocIdResolver(db, docIdCache, insertDocument);

  const total = sources.length;
  for (let i = 0; i < total; i += INSERT_BATCH_SIZE) {
    const batch = sources.slice(i, i + INSERT_BATCH_SIZE);
    const indexedBatch = await Promise.all(
      batch.map(async (source) => ({
        source,
        searchText: await buildDocumentSearchText(source),
      }))
    );
    await insertIndexedBatch(db, insertSegment, getOrCreateDocId, indexedBatch);
    await onProgress?.(Math.min(i + batch.length, total), total);
  }

  db.exec('ANALYZE');
  const exported = sqlite3.capi.sqlite3_js_db_export(db);
  await writeFile(dbPath, exported);
  db.close();
  resetWasmCache();
}

async function searchWasmIndex(
  dbPath: string,
  catalog: CatalogName | undefined,
  limit: number,
  match: string,
  query: string,
  rawQuery: string
): Promise<LocalSearchResult[]> {
  const db = await openReadonlyDb(dbPath);
  return runFtsSearch(
    createWasmReader(db),
    catalog,
    limit,
    match,
    query,
    rawQuery
  );
}

export async function createSqliteBackend(): Promise<SqliteBackend> {
  await getSqliteModule();
  return {
    resetCache: resetWasmCache,
    buildSearchIndex: buildWasmIndex,
    searchIndex: (_keywords, catalog, limit, dbPath, match, query, rawQuery) =>
      searchWasmIndex(dbPath, catalog, limit, match, query, rawQuery),
  };
}
