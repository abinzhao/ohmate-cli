/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Argument, Command, Option } from 'commander';
import type { ToolSpec } from '../runtime/index.js';

export function nativeInput(spec: ToolSpec, argv: string[]): unknown {
  const parser = new Command(spec.command.join(' ')).exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  for (const argument of spec.arguments) {
    const name = `${argument.name}${argument.variadic ? '...' : ''}`;
    parser.addArgument(new Argument(argument.required ? `<${name}>` : `[${name}]`));
  }
  for (const option of spec.options) {
    const item = new Option(option.flags, option.description).makeOptionMandatory(option.mandatory);
    if (option.defaultValue !== undefined) { item.default(option.defaultValue); }
    if (option.choices) { item.choices(option.choices); }
    parser.addOption(item);
  }
  parser.parse(argv, { from: 'user' });
  return {
    ...Object.fromEntries(spec.arguments.map((argument, index) => [argument.name, parser.processedArgs[index]])
      .filter(([, value]) => value !== undefined)),
    ...parser.opts(),
  };
}
