/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import initSqliteWasm from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SQLITE_INDEX_SCHEMA_SQL } from './sqlite-schema.js';

type Sqlite3Module = Awaited<ReturnType<typeof initSqliteWasm>>;
type WasmDb = InstanceType<Sqlite3Module['oo1']['DB']>;

let sqlite3: Sqlite3Module;
let db: WasmDb;

function columnNames(table: string): string[] {
  return (
    db.selectObjects(`PRAGMA table_info(${table})`) as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function insertDocument(documentId: string, title: string): number {
  db.exec({
    sql: 'INSERT INTO documents(document_id, catalog_id, doc_title) VALUES (?, 1, ?)',
    bind: [documentId, title],
  });
  return Number(db.selectValue('SELECT last_insert_rowid()'));
}

function insertSegment(docId: number, searchText: string): number {
  db.exec({
    sql: 'INSERT INTO segments(doc_id, search_text) VALUES (?, ?)',
    bind: [docId, searchText],
  });
  return Number(db.selectValue('SELECT last_insert_rowid()'));
}

function ftsMatchCount(term: string): number {
  return Number(
    db.selectValue(
      'SELECT count(*) FROM segments_fts WHERE segments_fts MATCH ?',
      [term]
    )
  );
}

describe('SQLITE_INDEX_SCHEMA_SQL applied to a fresh in-memory database', () => {
  beforeAll(async () => {
    sqlite3 = await initSqliteWasm();
  });

  beforeEach(() => {
    db = new sqlite3.oo1.DB(':memory:', 'c');
    db.exec(SQLITE_INDEX_SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the documents and segments tables with the expected columns', () => {
    expect(columnNames('documents')).toEqual([
      'id',
      'document_id',
      'catalog_id',
      'doc_title',
    ]);
    expect(columnNames('segments')).toEqual([
      'id',
      'doc_id',
      'section_title',
      'lead_text',
      'search_text',
      'excerpt_truncated',
    ]);
  });

  it('creates an external-content fts5 virtual table with the unicode61 tokenizer', () => {
    const rows = db.selectObjects(
      "SELECT type, sql FROM sqlite_schema WHERE name = 'segments_fts'"
    ) as { type: string; sql: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('table');
    expect(rows[0].sql).toContain('USING fts5(');
    expect(rows[0].sql).toContain("content='segments'");
    expect(rows[0].sql).toContain("content_rowid='id'");
    expect(rows[0].sql).toContain("tokenize='unicode61'");
  });

  it('creates the sync triggers and the doc_id index', () => {
    const triggers = (
      db.selectObjects(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name"
      ) as { name: string }[]
    ).map((trigger) => trigger.name);
    expect(triggers).toEqual(['segments_ad', 'segments_ai', 'segments_au']);
    const indexes = (
      db.selectObjects(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'segments_doc_id_idx'"
      ) as { name: string }[]
    ).map((index) => index.name);
    expect(indexes).toEqual(['segments_doc_id_idx']);
  });

  it('keeps segments_fts in sync when inserting segments', () => {
    const docId = insertDocument('doc-1', 'Document One');
    const segmentId = insertSegment(docId, 'alpha beta');

    expect(Number(db.selectValue('SELECT count(*) FROM segments_fts'))).toBe(1);
    expect(
      db.selectValue(
        'SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?',
        ['beta']
      )
    ).toBe(segmentId);
  });

  it('keeps segments_fts in sync when updating segment search text', () => {
    const docId = insertDocument('doc-1', 'Document One');
    const segmentId = insertSegment(docId, 'alpha beta');

    db.exec({
      sql: 'UPDATE segments SET search_text = ? WHERE id = ?',
      bind: ['gamma delta', segmentId],
    });

    expect(ftsMatchCount('beta')).toBe(0);
    expect(ftsMatchCount('delta')).toBe(1);
  });

  it('keeps segments_fts in sync when deleting segments', () => {
    const docId = insertDocument('doc-1', 'Document One');
    const segmentId = insertSegment(docId, 'alpha beta');

    db.exec('DELETE FROM segments WHERE id = ' + segmentId);

    expect(Number(db.selectValue('SELECT count(*) FROM segments_fts'))).toBe(0);
    expect(ftsMatchCount('beta')).toBe(0);
  });

  it('passes the fts5 integrity check after mixed insert, update and delete', () => {
    const docId = insertDocument('doc-1', 'Document One');
    insertSegment(docId, 'kept text');
    const changed = insertSegment(docId, 'old text');
    insertSegment(docId, 'removed text');

    db.exec({
      sql: 'UPDATE segments SET search_text = ? WHERE id = ?',
      bind: ['new text', changed],
    });
    db.exec('DELETE FROM segments WHERE search_text = ' + "'removed text'");

    expect(() =>
      db.exec(
        "INSERT INTO segments_fts(segments_fts) VALUES('integrity-check')"
      )
    ).not.toThrow();
    expect(ftsMatchCount('kept')).toBe(1);
    expect(ftsMatchCount('new')).toBe(1);
    expect(Number(db.selectValue('SELECT count(*) FROM segments_fts'))).toBe(2);
  });

  it('rejects duplicate or NULL document_id and NULL catalog_id', () => {
    expect(() =>
      db.exec(
        "INSERT INTO documents(document_id, catalog_id, doc_title) VALUES ('dup', 1, 'first')"
      )
    ).not.toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO documents(document_id, catalog_id, doc_title) VALUES ('dup', 1, 'second')"
      )
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(
        "INSERT INTO documents(document_id, catalog_id, doc_title) VALUES (NULL, 1, 't')"
      )
    ).toThrow(/NOT NULL/);
    expect(() =>
      db.exec(
        "INSERT INTO documents(document_id, catalog_id, doc_title) VALUES ('x', NULL, 't')"
      )
    ).toThrow(/NOT NULL/);
  });

  it('rejects segments with NULL search_text', () => {
    const docId = insertDocument('doc-1', 'Document One');
    expect(() =>
      db.exec(
        `INSERT INTO segments(doc_id, search_text) VALUES (${docId}, NULL)`
      )
    ).toThrow(/NOT NULL/);
  });

  it('applies the documented defaults for optional segment columns', () => {
    const docId = insertDocument('doc-1', 'Document One');
    insertSegment(docId, 'alpha beta');

    const segment = db.selectObjects(
      'SELECT section_title, lead_text, excerpt_truncated FROM segments'
    ) as {
      section_title: string;
      lead_text: string;
      excerpt_truncated: number;
    }[];
    expect(segment).toEqual([
      { section_title: '', lead_text: '', excerpt_truncated: 0 },
    ]);
  });

  it('supports full-text search joined back to documents', () => {
    const docId = insertDocument('doc-1', 'ArkTS Guide');
    const otherDocId = insertDocument('doc-2', 'SQLite Guide');
    insertSegment(docId, 'arkts state management basics');
    insertSegment(otherDocId, 'sqlite database internals');

    const hits = db.selectObjects(
      `SELECT d.doc_title, s.search_text
       FROM segments_fts f
       JOIN segments s ON s.id = f.rowid
       JOIN documents d ON d.id = s.doc_id
       WHERE segments_fts MATCH 'arkts'`
    ) as { doc_title: string; search_text: string }[];
    expect(hits).toEqual([
      {
        doc_title: 'ArkTS Guide',
        search_text: 'arkts state management basics',
      },
    ]);
  });
});
