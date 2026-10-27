/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CommandInvocation,
  InstallDependencies,
  RuntimeMetadata,
} from './types.js';
import { installRoot, readJson, isSemver, meetsMinimum } from './resolve.js';
import { runProcess } from './process.js';

export const INSTALL_USAGE =
  'Usage: devecocli-install [--version <version-or-tag>]';

export function parseVersion(args: string[], defaultVersion: string) {
  if (args.length === 0) {
    return defaultVersion;
  }
  if (
    args.length !== 2 ||
    args[0] !== '--version' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(args[1])
  ) {
    throw new Error(INSTALL_USAGE);
  }
  return args[1];
}

async function assertMinimum(
  metadata: RuntimeMetadata,
  version: string,
  suffix = ''
) {
  if (!(await meetsMinimum(version, metadata.packageVersion))) {
    throw new Error(
      `${metadata.packageName}@${version} is below the minimum version ${metadata.packageVersion} required by this plugin.${suffix}`
    );
  }
}

export async function npmInvocation(
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandInvocation> {
  // npm's own JavaScript entry avoids cmd.exe quoting and preserves registry configuration.
  const dirs = [
    path.dirname(process.execPath),
    ...(env.PATH || env.Path || '').split(path.delimiter),
  ];
  for (const dir of dirs.filter(Boolean)) {
    for (const relative of [
      'node_modules/npm/bin/npm-cli.js',
      '../lib/node_modules/npm/bin/npm-cli.js',
    ]) {
      const entry = path.resolve(dir, relative);
      if ((await fs.stat(entry).catch(() => null))?.isFile()) {
        return { command: process.execPath, args: [entry] };
      }
    }
    const file = path.resolve(dir, 'npm');
    const real = await fs.realpath(file).catch(() => null);
    if (real?.endsWith('npm-cli.js')) {
      return { command: process.execPath, args: [real] };
    }
  }
  throw new Error(
    'npm is required. Install Node.js 22 or later with npm, then retry.'
  );
}

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export async function npmEnvironment(
  target: string,
  input: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const env = { ...input };
  const key = Object.keys(env).find(
    (name) => name.toLowerCase() === 'npm_config_allow_scripts'
  );
  if (!key) {
    return env;
  }
  const policy = env[key];
  if (policy && /[\r\n]/.test(policy)) {
    throw new Error('npm allow-scripts policy must be a single line.');
  }
  // npm 12 rejects this policy in env for prefix installs; retain it in project config.
  await fs.writeFile(
    path.join(target, '.npmrc'),
    `allow-scripts=${JSON.stringify(policy)}\n`
  );
  delete env[key];
  return env;
}

// Installs only into the plugin-managed directory; never touches a global or host-managed CLI.
// eslint-disable-next-line max-lines-per-function -- The install lifecycle owns lock cleanup.
export async function installRuntime(
  metadata: RuntimeMetadata,
  version: string,
  pluginRoot: string,
  dependencies: InstallDependencies = {}
) {
  if (isSemver(version)) {
    await assertMinimum(metadata, version);
  }
  const root = path.resolve(installRoot(metadata));
  if (
    inside(pluginRoot, root) ||
    inside(process.cwd(), root) ||
    root === path.parse(root).root
  ) {
    throw new Error(
      'The private Runtime directory must be outside the plugin and current project directories.'
    );
  }
  const npm = await (dependencies.npmInvocation || npmInvocation)();
  const run = dependencies.runProcess || runProcess;
  await fs.mkdir(root, { recursive: true });
  const lockFile = path.join(root, 'install.lock');
  const lock = await fs.open(lockFile, 'wx').catch((error) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    throw new Error(
      `Another installation holds ${lockFile}. If it was interrupted, confirm its process has stopped before removing this lock.`
    );
  });
  const installId = randomUUID();
  const target = path.join(root, 'installs', installId);
  const next = path.join(root, `current-${installId}.json`);
  let activated = false;
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        packageName: metadata.packageName,
        version,
      })
    );
    await fs.mkdir(target, { recursive: true });
    const spec = `${metadata.packageName}@${version}`;
    console.error(`Installing ${spec} into ${target}`);
    const env = await npmEnvironment(target);
    const result = await run(
      npm.command,
      [
        ...npm.args,
        'install',
        '--prefix',
        target,
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        spec,
      ],
      { cwd: target, env }
    );
    if (result.exitCode !== 0) {
      return result.exitCode;
    }
    const packageRoot = path.join(target, 'node_modules', metadata.packageName);
    const pkg = await readJson(path.join(packageRoot, 'package.json'));
    const binEntry = pkg.bin?.devecocli;
    if (
      pkg.name !== metadata.packageName ||
      typeof binEntry !== 'string'
    ) {
      throw new Error(
        'npm installed an unexpected package or CLI entry. The previous Runtime is unchanged.'
      );
    }
    await assertMinimum(metadata, pkg.version, ' The previous Runtime is unchanged.');
    const entry = path.join(packageRoot, binEntry);
    const verify = await run(process.execPath, [entry, '--version'], {
      capture: true,
      timeout: 30000,
      cwd: target,
    });
    if (verify.exitCode !== 0 || verify.stdout.trim() !== pkg.version) {
      throw new Error(
        `Runtime verification failed: ${verify.stderr || verify.stdout}. The previous Runtime is unchanged.`
      );
    }
    await fs.writeFile(
      next,
      JSON.stringify(
        { installId, packageName: pkg.name, version: pkg.version },
        null,
        2
      ) + '\n'
    );
    await fs.rename(next, path.join(root, 'current.json'));
    activated = true;
    console.error(
      `Installed ${pkg.name}@${pkg.version}. A global CLI that meets the minimum version still takes priority; run devecocli-runtime-check to see the selected entry.`
    );
    return 0;
  } finally {
    await fs.rm(next, { force: true });
    if (!activated) {
      await fs.rm(target, { recursive: true, force: true });
    }
    await lock.close();
    await fs.unlink(lockFile);
  }
}
