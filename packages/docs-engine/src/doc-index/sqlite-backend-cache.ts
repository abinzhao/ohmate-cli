/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { createSqliteBackend } from './sqlite-backend.js';
import type { SqliteBackend } from './sqlite-types.js';

let backendPromise: Promise<SqliteBackend> | null = null;
let activeBackend: SqliteBackend | null = null;

export async function getSqliteBackend(): Promise<SqliteBackend> {
  if (!backendPromise) {
    backendPromise = createSqliteBackend().then((backend) => {
      activeBackend = backend;
      return backend;
    });
  }
  return backendPromise;
}

export function resetSqliteBackendCache(): void {
  activeBackend?.resetCache();
  backendPromise = null;
  activeBackend = null;
}
