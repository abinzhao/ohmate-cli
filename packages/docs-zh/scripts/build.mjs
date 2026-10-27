/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Build script: copies docs-engine dist to docs-zh/dist/engine/
 * and writes apiVersion into docs-zh/package.json.
 */
import { cp, readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const engineDist = join(root, '..', 'docs-engine', 'dist');
const targetDir = join(root, 'dist', 'engine');

await mkdir(targetDir, { recursive: true });
await cp(engineDist, targetDir, { recursive: true });

// Remove build-time artifacts from published package (D11)
await rm(join(targetDir, 'builder.js'), { force: true }).catch(() => {});
await rm(join(targetDir, 'builder.d.ts'), { force: true }).catch(() => {});

// Write apiVersion into package.json (read from engine's export)
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
pkg.apiVersion = 1;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

console.log('docs-zh: engine dist copied + apiVersion written');
