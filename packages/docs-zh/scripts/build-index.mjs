/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Build script: calls docs-index-builder to generate index.zip from docs.zip.
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const builderCli = join(root, '..', 'docs-index-builder', 'dist', 'cli.js');
const docsZip = join(root, 'docs.zip');
const indexZip = join(root, 'index.zip');

const child = spawn(process.execPath, [builderCli, '--docs-zip', docsZip, '--output', indexZip], {
  stdio: 'inherit',
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('docs-zh: index.zip generated');
  } else {
    console.error(`docs-zh: index build failed (exit ${code})`);
    process.exit(1);
  }
});
