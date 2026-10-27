/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedRuntime, RuntimeMetadata } from './types.js';
import { readJson, resolveRuntime, installRoot } from './resolve.js';
import { INSTALL_USAGE, installRuntime, parseVersion } from './install.js';
import { runProcess } from './process.js';

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function isPrivateEntry(metadata: RuntimeMetadata, runtime: ResolvedRuntime) {
  const relative = path.relative(
    path.join(installRoot(metadata), 'installs'),
    runtime.entry
  );
  return (
    runtime.source === 'private' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

// Only standalone help forms are exempt: an option value may itself be '--help'.
function changesAgentSetup(args: string[]) {
  const help = (value: string) => ['--help', '-h', 'help'].includes(value);
  if (args[0] === 'init') {
    return !(args.length === 2 && help(args[1]));
  }
  if (args[0] !== 'skills') {
    return false;
  }
  if (args.length === 1 || (args.length === 2 && help(args[1]))) {
    return false;
  }
  if (['list', 'find'].includes(args[1])) {
    return false;
  }
  return !(args.length === 3 && help(args[2]));
}

// eslint-disable-next-line max-lines-per-function -- Keep entry-point mode routing together.
async function main(): Promise<number> {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('DevEco CLI requires Node.js 22 or later.');
  }
  const metadata = await readJson(path.join(pluginRoot, 'runtime.json'));
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'install') {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      console.log(
        [
          INSTALL_USAGE,
          `Package: ${metadata.packageName}`,
          `Minimum and default version: ${metadata.packageVersion}`,
          `Plugin-managed directory: ${installRoot(metadata)}`,
          'Global and host-managed CLIs are never modified.',
        ].join('\n')
      );
      return 0;
    }
    return installRuntime(
      metadata,
      parseVersion(args, metadata.packageVersion),
      pluginRoot
    );
  }
  if (mode !== 'run' && mode !== 'check') {
    throw new Error('Invalid plugin entry mode.');
  }
  if (mode === 'check' && args.length) {
    throw new Error('Usage: devecocli-runtime-check');
  }
  const runtime = await resolveRuntime(metadata);
  if (mode === 'check') {
    // Inspect the entry without running the CLI or triggering its initialization.
    console.log(
      JSON.stringify(
        {
          ...runtime,
          launcher: path.join(
            pluginRoot,
            'bin',
            process.platform === 'win32' ? 'devecocli.cmd' : 'devecocli'
          ),
          nodeVersion: process.versions.node,
          minimumVersion: metadata.packageVersion,
          defaultPackage: `${metadata.packageName}@${metadata.packageVersion}`,
        },
        null,
        2
      )
    );
    return 0;
  }
  const managed = isPrivateEntry(metadata, runtime);
  const cliArgs = args[0] === '--' ? args.slice(1) : args;
  if (
    managed &&
    cliArgs[0] === 'update' &&
    (cliArgs.length === 1 || cliArgs[1] === '--')
  ) {
    throw new Error(
      'This Runtime is plugin-managed. Use devecocli-install to install the plugin default, or devecocli-install --version <version-or-tag> to update it.'
    );
  }
  if (managed && changesAgentSetup(cliArgs)) {
    throw new Error(
      'This Runtime is plugin-managed. init and skill installation/removal are disabled; existing skills and agent configuration must stay unchanged. To refresh a global skill, first update and verify the global CLI, then run init --skill --agent <agent> --force through that global CLI with user authorization. Otherwise use the private Runtime without changing skills.'
    );
  }
  const result = await runProcess(runtime.command, [...runtime.args, ...args]);
  return result.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
