/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe('ArkTS Producer sources', () => {
  it('keep their generated contracts aligned with the desktop source', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/generate-kit-contract.mjs', '--check'], {
      cwd: root,
      timeout: 20_000,
    });
    expect(result.stdout).toContain('Kit contract matches protocol sources');
  }, 25_000);

  it('pass the independent core and lifecycle matrix without claiming platform execution', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/verify-kit-core.mjs'], {
      cwd: root,
      timeout: 20_000,
    });
    expect(result.stdout).toContain('# fail 0');
    expect(result.stdout).toContain('background revocation drops a late metrics result');
    expect(result.stdout).toContain('# skipped 0');
  }, 25_000);
});
