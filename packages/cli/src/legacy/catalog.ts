/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option, Argument } from 'commander';
import { z } from 'zod';
import { createLegacyProgram } from './commands.js';
import { executeLegacy } from './runner.js';
import type { Risk, ToolSpec } from '../runtime/types.js';

const resultSchema = z.object({ exitCode: z.number(), data: z.unknown() }).passthrough();

function classify(command: string[]): Risk {
  const name = command.join(' ');
  if (['device list', 'device view', 'emulator list', 'emulator image list', 'emulator license view',
    'docs search', 'docs read', 'docs catalog', 'ui layout', 'ui find', 'ui wait',
    'ui window list', 'check versions', 'skills list', 'skills find', 'auth status', 'auth team list',
  ].includes(name)) {
    return 'R0';
  }
  if (['check compat', 'log', 'ui screenshot', 'ui screenrecord', 'serve mcp', 'serve lsp'].includes(name)) {
    return 'R1';
  }
  if (command[0] === 'ui' || ['build', 'emulator start', 'emulator stop', 'emulator create', 'create', 'init', 'skills add', 'run'].includes(name)) {
    return 'R2';
  }
  return 'R3';
}

function cloneForValidation(source: Command, select: (command: Command) => void): Command {
  const clone = new Command(source.name());
  for (const arg of source.registeredArguments) {
    const name = `${arg.name()}${arg.variadic ? '...' : ''}`;
    clone.addArgument(new Argument(arg.required ? `<${name}>` : `[${name}]`));
  }
  for (const option of source.options) {
    const copy = new Option(option.flags, option.description).makeOptionMandatory(option.mandatory);
    if (option.defaultValue !== undefined) { copy.default(option.defaultValue); }
    if (option.argChoices) { copy.choices(option.argChoices); }
    if (option.parseArg) { copy.argParser(option.parseArg); }
    clone.addOption(copy);
  }
  clone.action(() => select(source));
  for (const child of source.commands) { clone.addCommand(cloneForValidation(child, select)); }
  return clone;
}

function validateArguments(command: Command, argv: string[]): boolean {
  let selected: Command | undefined;
  const validator = cloneForValidation(command, (target) => { selected = target; });
  validator.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  try {
    validator.parse(argv, { from: 'user' });
    return selected === command;
  } catch {
    return false;
  }
}

function argumentSchema(command: Command) {
  return z.strictObject({ argv: z.array(z.string()).default([]) }).refine((input) =>
    validateArguments(command, input.argv) && !input.argv.some((arg) => arg === '--api-key' || arg.startsWith('--api-key=')),
  { message: 'Select the exact registered subcommand; credentials must use a secure reference' });
}

function describe(command: Command, parent: string[]): ToolSpec {
  const path = [...parent, command.name()];
  const risk = classify(path);
  return {
    id: `deveco.${path.join('.')}`, command: path, description: command.description(),
    risk, inputSchema: argumentSchema(command), outputSchema: resultSchema,
    requirements: path[0] === 'serve' ? ['toolchain'] :
      ['ui', 'run', 'log', 'verify', 'emulator'].includes(path[0]) ? ['device'] : [],
    timeoutMs: ['serve', 'log'].includes(path[0]) ? 0 : 30 * 60 * 1000,
    cancellable: true, idempotency: risk === 'R0' ? 'read' : risk === 'R1' ? 'artifact' : 'none',
    recovery: risk === 'R0' ? 'verify-and-retry' : 'manual',
    evidence: ['tool-exit-code', 'stdout', 'stderr'], adapter: 'legacy-child',
    hidden: command.name().startsWith('_'), protocol: path[0] === 'serve',
    arguments: command.registeredArguments.map((arg) => ({ name: arg.name(), required: arg.required, variadic: arg.variadic })),
    options: command.options.map((option) => ({
      flags: option.flags, description: option.description,
      required: option.required, optional: option.optional, mandatory: option.mandatory,
      defaultValue: option.defaultValue, choices: option.argChoices,
    })),
    execute: (input, context) => executeLegacy([...path, ...(input as { argv: string[] }).argv], context, path[0] === 'serve'),
  };
}

function collect(command: Command, parent: string[]): ToolSpec[] {
  const spec = describe(command, parent);
  return [spec, ...command.commands.flatMap((child) => collect(child, spec.command))];
}

export function getLegacySpecs(): ToolSpec[] {
  return createLegacyProgram().commands.flatMap((command) => collect(command, []));
}

export function parseLegacyBuildArguments(argv: string[]): unknown {
  const command = createLegacyProgram().commands.find((item) => item.name() === 'build')!;
  let selected: Command | undefined;
  const parser = cloneForValidation(command, (item) => { selected = item; });
  parser.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  parser.parse(argv, { from: 'user' });
  if (selected !== command) { throw new Error('Select the exact build command'); }
  return parser.opts();
}

export function effectiveLegacyRisk(spec: ToolSpec, input: unknown): Risk {
  const argv = (input as { argv?: string[] }).argv ?? [];
  if (spec.id === 'deveco.build' && argv.some((arg) => arg === '--signing-config' || arg.startsWith('--signing-config='))) {
    return 'R3';
  }
  if (argv.some((arg) => ['--uninstall', '--force', '-f'].includes(arg) || arg.startsWith('--force=') || arg.startsWith('--uninstall='))) {
    return 'R3';
  }
  return spec.risk;
}
