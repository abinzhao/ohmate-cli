/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

async function loadedAfterRuntimeImport(): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-startup-import-'));
  try {
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, [
      "import Module from 'node:module';",
      'await import(process.argv[2]);',
      // ESM imports of CommonJS packages still register their files here.
      'const files = Object.keys(Module._cache);',
      'const heavy = files.filter((file) => /node_modules[\\\\/](regedit|adm-zip|socket\\.io-client|@modelcontextprotocol|node-forge|fs-extra|semver)[\\\\/]/.test(file));',
      'console.log(JSON.stringify({ heavy }));',
    ].join('\n'));
    const { stdout } = await execute(process.execPath,
      ['--import', 'tsx', probe, fileURLToPath(new URL('./index.ts', import.meta.url))],
      { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}').heavy ?? [];
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('loads command-only libraries lazily instead of during runtime import', async () => {
  expect(await loadedAfterRuntimeImport()).toEqual([]);
}, 90_000);
