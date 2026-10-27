/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export const SQLITE_INDEX_SCHEMA_SQL = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  catalog_id INTEGER NOT NULL,
  doc_title TEXT NOT NULL
);

CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id),
  section_title TEXT NOT NULL DEFAULT '',
  lead_text TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL,
  excerpt_truncated INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  search_text,
  content='segments',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
END;

CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
  INSERT INTO segments_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE INDEX segments_doc_id_idx ON segments(doc_id);
`;
