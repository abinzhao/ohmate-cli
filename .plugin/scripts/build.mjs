/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'tsup';
import { execFileSync } from 'node:child_process';
import { validateDirectory, validateArchive } from './validate.mjs';
import {
  repoRoot,
  sourceRoot,
  outputRoot,
  loadPlatforms,
  artifactPaths,
  templateVariables,
  renderTemplate,
} from './platforms.mjs';

export { repoRoot, sourceRoot };
const require = createRequire(path.join(repoRoot, 'packages/cli/package.json'));
const AdmZip = require('adm-zip');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function generateSkill(skill, guidance) {
  const source = skill.replaceAll('\r\n', '\n');
  const match = source.match(/^---\n[\s\S]*?\n---\n/);
  if (!match || !/^name: deveco-cli$/m.test(match[0])) {
    throw new Error('Root SKILL.md must declare name: deveco-cli.');
  }
  return (
    match[0] + '\n' + guidance.trim() + '\n' + source.slice(match[0].length)
  );
}

function git(...args) {
  if (process.env.DEVECO_CLI_DEBUG) {
    console.error(`Executing: git ${args.join(' ')}`);
  }
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

// eslint-disable-next-line max-lines-per-function -- Keep artifact assembly in one build flow.
export async function buildPlugin(
  platform,
  platformRoot = path.join(outputRoot, platform.platform)
) {
  const { manifest, manifestPath } = platform;
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'packages/cli-wrapper/package.json'), 'utf8')
  );
  const root = path.resolve(platformRoot);
  const { target, zipPath } = artifactPaths(platform, root);
  if (path.dirname(target) !== root) {
    throw new Error('Invalid output directory.');
  }
  // Only remove this build's fixed plugin directory, never the output root.
  await fs.rm(target, { recursive: true, force: true });
  for (const dir of ['skills/deveco-cli', path.dirname(manifestPath), 'bin']) {
    await fs.mkdir(path.join(target, dir), { recursive: true });
  }
  const entries = ['devecocli', 'devecocli-install', 'devecocli-runtime-check'];
  for (const name of entries.flatMap((name) => [name, `${name}.cmd`])) {
    const data = (
      await fs.readFile(path.join(sourceRoot, 'bin', name), 'utf8')
    ).replaceAll('\r\n', '\n');
    await fs.writeFile(path.join(target, 'bin', name), data);
    await fs.chmod(
      path.join(target, 'bin', name),
      name.endsWith('.cmd') ? 0o644 : 0o755
    );
  }
  for (const name of ['LICENSE', 'PRIVACY.md']) {
    await fs.copyFile(path.join(repoRoot, name), path.join(target, name));
  }
  const variables = templateVariables(platform);
  const readSource = async (name) =>
    renderTemplate(
      await fs.readFile(path.join(sourceRoot, name), 'utf8'),
      variables
    );
  await fs.writeFile(
    path.join(target, 'README.md'),
    await readSource('README.md')
  );
  const skill = await fs.readFile(path.join(repoRoot, 'SKILL.md'), 'utf8');
  await fs.writeFile(
    path.join(target, 'skills/deveco-cli/SKILL.md'),
    generateSkill(skill, await readSource('runtime-skill-supplement.md'))
  );
  const metadata = {
    packageName: pkg.name,
    packageVersion: pkg.version,
    nodeMajorMinimum: 22,
  };
  const json = async (name, data) =>
    fs.writeFile(path.join(target, name), JSON.stringify(data, null, 2) + '\n');
  await json(manifestPath, manifest);
  await json('runtime.json', { ...metadata, ...platform.runtime });
  await json('provenance.json', {
    sourceCommit: git('rev-parse', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain')),
    platform: platform.platform,
    pluginVersion: manifest.version,
    ...metadata,
    skillSha256: sha256(skill),
  });
  await build({
    entry: { main: path.join(sourceRoot, 'runtime/main.ts') },
    outDir: path.join(target, 'runtime'),
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    target: 'node22',
    platform: 'node',
    splitting: false,
    sourcemap: false,
    dts: false,
    clean: false,
    silent: true,
    config: false,
  });
  await validateDirectory(target, platform);
  const zip = new AdmZip();
  for (const file of await fs.readdir(target, { recursive: true })) {
    const full = path.join(target, file);
    if (!(await fs.stat(full)).isFile()) {
      continue;
    }
    const entry = file.replaceAll('\\', '/');
    const mode =
      entry.startsWith('bin/') && !entry.endsWith('.cmd') ? 0o100755 : 0o100644;
    zip.addFile(entry, await fs.readFile(full), '', mode);
  }
  await fs.writeFile(zipPath, zip.toBuffer());
  await validateArchive(zipPath, platform);
  await fs.writeFile(
    `${zipPath}.sha256`,
    `${sha256(await fs.readFile(zipPath))}  ${path.basename(zipPath)}\n`
  );
  return { platform: platform.platform, target, zipPath };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const results = [];
    for (const platform of await loadPlatforms()) {
      results.push(await buildPlugin(platform));
    }
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
