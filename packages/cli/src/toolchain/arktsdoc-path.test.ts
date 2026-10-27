/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ToolProvider } from './tool-provider.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-doc-toolchain-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('discovers ArkTSDoc by the installed platform layout without depending on the folder suffix', async () => {
  const file = join(root, ...(process.platform === 'darwin' ? ['Contents'] : []), 'tools/arktsdoc/index.js');
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, '// installed producer\n');
  expect(ToolProvider.fromIDE(root).arktsdocPath).toBe(file);
});
it('rejects unavailable CLT/Studio producers and an entry resolving outside the installation root', async () => {
  expect(() => ToolProvider.fromIDE(root).arktsdocPath).toThrow('ArkTSDoc');
  expect(() => ToolProvider.fromCLT(root).arktsdocPath).toThrow('DevEco Studio');
  const inside = join(root, 'studio'), file = join(inside, ...(process.platform === 'darwin' ? ['Contents'] : []), 'tools/arktsdoc/index.js');
  await mkdir(dirname(file), { recursive: true }); await writeFile(join(root, 'outside.js'), '// outside\n');
  await symlink(join(root, 'outside.js'), file);
  expect(() => ToolProvider.fromIDE(inside).arktsdocPath).toThrow('outside');
});
