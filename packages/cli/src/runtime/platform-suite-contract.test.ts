/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('defines a serial platform smoke suite for actual macOS, Linux and Windows hosts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'));
  expect(manifest.scripts['pretest:platform']).toBe('npm run build');
  const command = manifest.scripts['test:platform'];
  expect(command).toContain('--maxWorkers=1');
  for (const path of [
    'runtime/process-tree.test.ts',
    'runtime/process-runner.test.ts',
    'agent/trae-cli-process.test.ts',
    'utils/build-lock.test.ts',
    'web/web-lifecycle.test.ts',
  ]) {
    expect(command).toContain(path);
  }
});
