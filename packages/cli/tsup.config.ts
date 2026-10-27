/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'tsup';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    runtime: 'src/runtime/index.ts',
    legacy: 'src/legacy/entry.ts',
    'task-worker': 'src/tasks/task-worker.ts',
    'web-worker': 'src/web/web-worker.ts',
    'mcp-server': 'mcp/src-server/standalone.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  shims: true,
  minify: true,
  splitting: false,
  onSuccess: async () => { fs.cpSync('../../apps/web', 'dist/web', { recursive: true }); },
  external: [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    'adm-zip',
    'proper-lockfile',
    'regedit',
    'socket.io-client',
  ],
  env: {
    npm_package_version: pkg.version,
    npm_package_name: pkg.name,
    npm_package_supported_docs_api: String(pkg.supportedDocsApi ?? 1),
    npm_config_tag: process.env.npm_config_tag || 'latest',
  },
});
