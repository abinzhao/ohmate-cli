/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ContextOptions } from '../runtime/index.js';

export interface TerminalArguments {
  args: string[];
  context: ContextOptions;
  format: 'human' | 'json' | 'ndjson';
  raw: boolean;
  web: boolean;
  input?: unknown;
  inputFile?: string;
}

export function parseTerminalArguments(argv: string[]): TerminalArguments {
  const result: TerminalArguments = { args: [], context: {}, format: 'human', raw: false, web: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      result.args.push(...argv.slice(index));
      break;
    }
    if (arg === '--web') { result.web = true; continue; }
    if (['--format', '--lang', '--project', '--approve-plan', '--input', '--input-file'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) { throw new Error(`Missing value: ${arg}`); }
      if (arg === '--format' && !['human', 'json', 'ndjson'].includes(value)) {
        result.args.push(arg, value); index++; continue;
      }
      index++;
      if (arg === '--format') { result.format = value as TerminalArguments['format']; }
      if (arg === '--lang') {
        if (value !== 'zh-CN' && value !== 'en-US') { throw new Error('Invalid --lang'); }
        result.context.locale = value;
      }
      if (arg === '--project') { result.context.projectRoot = value; }
      if (arg === '--approve-plan') { result.context.approvedPlan = value; }
      if (arg === '--input' || arg === '--input-file') {
        if (result.input !== undefined || result.inputFile !== undefined) { throw new Error('Provide exactly one --input or --input-file'); }
        if (arg === '--input') { result.input = JSON.parse(value); }
        else { result.inputFile = value; }
      }
      continue;
    }
    if (arg === '--non-interactive') { result.context.nonInteractive = true; continue; }
    if (arg === '--raw') { result.raw = true; continue; }
    result.args.push(arg);
  }
  return result;
}

export function normalizeTerminalArguments(parsed: TerminalArguments): void {
  if (!parsed.web || parsed.args[0] === 'ui') { return; }
  if (parsed.args.length && !parsed.args[0].startsWith('-')) {
    throw new Error('--web cannot be combined with another command');
  }
  parsed.args = ['ui', ...parsed.args];
}
