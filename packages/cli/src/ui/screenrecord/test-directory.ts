/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(
  new URL('../../../../../.test-screenrecord/', import.meta.url)
);

export async function createTestDirectory(prefix: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}

export async function removeTestDirectory(directory: string): Promise<void> {
  if (path.dirname(path.resolve(directory)) !== path.resolve(root)) {
    throw new Error(`Test directory outside workspace: ${directory}`);
  }
  await fs.rm(directory, { recursive: true, force: true });
}
