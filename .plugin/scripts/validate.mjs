/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  repoRoot,
  VERSION_PATTERN,
  loadPlatforms,
  artifactPaths,
} from './platforms.mjs';

const require = createRequire(path.join(repoRoot, 'packages/cli/package.json'));
const AdmZip = require('adm-zip');
const shared = [
  'runtime.json',
  'provenance.json',
  'runtime/main.mjs',
  'skills/deveco-cli/SKILL.md',
  'README.md',
  'LICENSE',
  'PRIVACY.md',
  ...['devecocli', 'devecocli-install', 'devecocli-runtime-check'].flatMap(
    (name) => [`bin/${name}`, `bin/${name}.cmd`]
  ),
];

// eslint-disable-next-line max-lines-per-function -- Keep artifact checks in one validation flow.
async function validateFiles(read, files, platform) {
  const required = [platform.manifestPath, ...shared];
  for (const file of required) {
    if (!files.includes(file)) {
      throw new Error(`Missing plugin file: ${file}`);
    }
  }
  for (const file of files) {
    if (!required.includes(file)) {
      throw new Error(`Unexpected plugin file: ${file}`);
    }
  }
  const manifest = JSON.parse(await read(platform.manifestPath));
  if (JSON.stringify(manifest) !== JSON.stringify(platform.manifest)) {
    throw new Error('Invalid plugin manifest.');
  }
  const metadata = JSON.parse(await read('runtime.json'));
  if (
    !/^@[a-z0-9-]+\/deveco-cli$/.test(metadata.packageName) ||
    !VERSION_PATTERN.test(metadata.packageVersion) ||
    metadata.nodeMajorMinimum !== 22 ||
    ['hostBinDirs', 'installRoot'].some(
      (key) =>
        JSON.stringify(metadata[key]) !== JSON.stringify(platform.runtime[key])
    )
  ) {
    throw new Error('Invalid Runtime metadata.');
  }
  const provenance = JSON.parse(await read('provenance.json'));
  if (
    provenance.platform !== platform.platform ||
    provenance.pluginVersion !== manifest.version ||
    provenance.packageName !== metadata.packageName ||
    provenance.packageVersion !== metadata.packageVersion ||
    !/^[a-f0-9]{64}$/.test(provenance.skillSha256)
  ) {
    throw new Error('Plugin provenance does not match metadata.');
  }
  const skill = await read('skills/deveco-cli/SKILL.md');
  const heading = new RegExp(
    `^## ${platform.hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Plugin Runtime$`,
    'gm'
  );
  if (
    !/^---\n[\s\S]*?name: deveco-cli\n[\s\S]*?\n---\n/.test(skill) ||
    (skill.match(heading) || []).length !== 1
  ) {
    throw new Error('Invalid generated skill.');
  }
  for (const file of ['README.md', 'skills/deveco-cli/SKILL.md']) {
    if (/\{\{\w+\}\}/.test(await read(file))) {
      throw new Error(`Unrendered template variable in ${file}`);
    }
  }
  for (const file of required.filter((file) => file.startsWith('bin/'))) {
    const text = await read(file);
    if (
      text.includes('\r') ||
      !text.includes('deveco-cli-plugin-entry') ||
      !text.includes('runtime')
    ) {
      throw new Error(`Invalid launcher: ${file}`);
    }
  }
}

export async function validateDirectory(root, platform) {
  const files = [];
  for (const file of await fs.readdir(root, { recursive: true })) {
    const stat = await fs.lstat(path.join(root, file));
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin must not contain symbolic links: ${file}`);
    }
    if (stat.isFile()) {
      files.push(file.replaceAll('\\', '/'));
    }
  }
  await validateFiles(
    (file) => fs.readFile(path.join(root, file), 'utf8'),
    files,
    platform
  );
}

export async function validateArchive(file, platform) {
  const zip = new AdmZip(await fs.readFile(file));
  const entries = zip.getEntries();
  await validateFiles(
    (name) => zip.readAsText(name),
    entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.entryName),
    platform
  );
  for (const entry of entries.filter(
    (entry) =>
      entry.entryName.startsWith('bin/') && !entry.entryName.endsWith('.cmd')
  )) {
    if (((entry.attr >>> 16) & 0o111) !== 0o111) {
      throw new Error(`Missing executable permissions: ${entry.entryName}`);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    for (const platform of await loadPlatforms()) {
      const { target, zipPath } = artifactPaths(platform);
      await validateDirectory(target, platform);
      await validateArchive(zipPath, platform);
      console.log(`${platform.platform} plugin directory and ZIP are valid.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
