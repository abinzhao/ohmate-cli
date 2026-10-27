/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { workspaceFingerprint } from '../runtime/workspace-fingerprint.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import { describeReadonlyProtocol } from '../debug-protocol/index.js';

export async function workbenchFingerprint(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = here.endsWith('/web') || here.endsWith('\\web');
  const code = source ? await workspaceFingerprint(resolve(here, '..'), join(here, '.unused-data')) :
    createHash('sha256').update(await readFile(join(here, 'web-worker.js'))).digest('hex');
  const webRoot = source ? resolve(here, '../../../../apps/web') : join(here, 'web');
  const assets = await workspaceFingerprint(webRoot, join(webRoot, '.unused-data'));
  return hashContract({ version: 'workbench-2', code, assets, protocol: describeReadonlyProtocol(), node: process.version });
}
