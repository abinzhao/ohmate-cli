/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from 'tsup';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: ['src/index.ts', 'src/builder.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: true,
  shims: true,
  minify: false,
  splitting: false,
  external: [
    'jieba-wasm',
    '@sqlite.org/sqlite-wasm',
    'yauzl',
    'adm-zip',
    'proper-lockfile',
    'ora',
  ],
  env: {
    npm_package_version: pkg.version,
    npm_package_name: pkg.name,
  },
});
