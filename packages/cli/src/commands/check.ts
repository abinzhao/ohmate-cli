/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError } from 'commander';
import { createLintCommand } from '../codelinter/index.js';
import { createArktsCommand } from '../arktscheck/index.js';
import {
  handleCheckCommand,
  handleVersionsCommand,
  type CheckOptions,
} from '../compat/compat.js';

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(
      `--limit must be a positive integer (got "${value}")`
    );
  }
  return n;
}

const compatCommand = new Command('compat').description(
  'Compatibility checking utilities.'
);

compatCommand
  .description(
    'Check source code compatibility against a target SDK version. ' +
      'By default, performs a project-level scan; pass positional `files...` for file-level scanning; pass `--modules` for module-level scanning.'
  )
  .arguments('[files...]')
  .option(
    '--source-version <version>',
    'Current project SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--target-version <version>',
    'Target SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--modules <modules...>',
    'Modules to check (default: all modules in the project). Mutually exclusive with positional file arguments.'
  )
  .option(
    '--format <format>',
    'Output format: "json" or "default" (text) for console; "csv", "json", or "default" for file output (--output-path). "csv" requires --output-path.',
    'default'
  )
  .option(
    '--output-path <path>',
    'Directory to write the detailed report CSV to (default: ./compat-output)'
  )
  .option(
    '--limit <num>',
    'Maximum number of change records to display (default: 100)',
    parseLimit,
    100
  )
  .action(async (files: string[], options: CheckOptions) => {
    await handleCheckCommand(files, options);
  });

compatCommand
  .command('versions')
  .description(
    'List all available target SDK versions for compatibility checking'
  )
  .option('--format <format>', 'Output format: default or json')
  .action(async (_options: { format?: string }, command: Command) => {
    // compatCommand 与 versions 都定义了 --format，父级的 option 会先消费掉该值，
    // 因此从 command.optsWithGlobals()（父级优先）读取，而非子命令自身的 opts。
    const format = command.optsWithGlobals<{ format?: string }>().format;
    await handleVersionsCommand(format);
  });

const checkCommand = new Command('check')
  .description('Run DevEco project checks')
  .addCommand(compatCommand)
  .addCommand(createLintCommand())
  .addCommand(createArktsCommand());

export default checkCommand;
