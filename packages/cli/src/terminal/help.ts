/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { OHMateRuntime, Receipt, ToolSpec } from '../runtime/index.js';

export function resolveCommand(runtime: OHMateRuntime, args: string[]): ToolSpec | undefined {
  return runtime.registry.list().filter((spec) =>
    spec.command.every((part, index) => args[index] === part),
  ).sort((a, b) => b.command.length - a.command.length ||
    Number(b.adapter === 'native') - Number(a.adapter === 'native'))[0];
}

export function renderHelp(runtime: OHMateRuntime, spec?: ToolSpec, group: string[] = []): string {
  const bin = process.env.OHMATE_BIN_NAME ?? 'ohmatecli';
  const prefix = spec?.command ?? group;
  const children = new Map(runtime.registry.list().filter((item) =>
    !item.hidden && item.command.length > prefix.length && prefix.every((part, index) => item.command[index] === part),
  ).sort((a, b) => b.command.length - a.command.length).map((item) =>
    [item.command[prefix.length], item.description],
  ));
  const lines = [`Usage: ${bin} ${prefix.join(' ')}${spec?.arguments.map((arg) =>
    ` ${arg.required ? '<' : '['}${arg.name}${arg.variadic ? '...' : ''}${arg.required ? '>' : ']'}`,
  ).join('') ?? ''} [options]`, '', spec?.description ?? 'OHMate CLI — HarmonyOS development tools', ''];
  if (children.size) {
    lines.push('Commands:', ...[...children].map(([name, description]) => `  ${name.padEnd(18)} ${description}`), '');
  }
  lines.push('Options:', ...(spec?.options.map((option) => `  ${option.flags.padEnd(28)} ${option.description}`) ?? []),
    '  --web                        Open the local Web workbench',
    '  --project <path>             Project root',
    '  --format human|json|ndjson   Unified result format (NDJSON for task events)',
    '  --lang zh-CN|en-US           Output locale',
    '  --non-interactive            Return an approval plan without prompting',
    '  --approve-plan <sha256>      Approve the exact displayed operation',
    '  --input <json>               Structured tool input',
    '  --input-file <path>          Explicit public JSON input file (max 1 MiB)',
    '  --raw                        Forward the original tool stream',
    '  -h, --help                   Show help',
    '', `${bin} execute <toolId> --input <json> or --input-file <path> provides the same registered tools to automation.`);
  return `${lines.join('\n')}\n`;
}

export function renderReceipt(receipt: Receipt): string {
  const summary = `${receipt.command}: ${receipt.status} (exit ${receipt.exitCode})`;
  return `${summary}\n${JSON.stringify(receipt.data, null, 2)}\n${receipt.warnings.map((warning) =>
    `[${warning.code}] ${warning.message}\n`,
  ).join('')}`;
}
