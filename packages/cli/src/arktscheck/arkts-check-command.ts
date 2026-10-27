/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { red, yellow, green } from 'colorette';
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { telemetry, EventType } from '../trace/index.js';
import type { CheckCommand, TrackMeasurement } from '../trace/index.js';
import { SpinnerHelper } from '../utils/spinner-helper.js';
import { readProcessRss, formatBytesMb } from '../utils/process-rss.js';
import { ArktsCheckAdapter } from './arkts-check-adapter.js';
import type { ArktsCheckResult, ArktsDiagnostic } from './types.js';

interface ArktsOptions {
  fix: boolean;
  project?: string;
}

function deriveArktsErrorCode(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return e.code ?? e.name ?? 'UnknownError';
}

async function trackArkts(
  start: number,
  success: boolean,
  errorCode: string | null,
  cmdArgs: string[]
): Promise<void> {
  const rssKb = await readProcessRss(process.pid);
  const mcpMemory =
    rssKb !== null ? formatBytesMb(Number(rssKb) * 1024) : 'unknown';
  const event: CheckCommand = {
    event: EventType.CheckCommand,
    args: cmdArgs,
    mcpMemory,
    lspMemory: 'unknown',
  };
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(event, measurement).catch(() => {});
}

export function createArktsCommand(): Command {
  return new Command('arkts')
    .description('Run ArkTS static checks on .ets source files')
    .arguments('[files...]')
    .option('--fix', 'Auto-fix high-confidence errors before reporting')
    .option(
      '--project <path>',
      'Project root directory (default: auto-detected from cwd)'
    )
    .action(async (files: string[], options: ArktsOptions) => {
      await handleArktsCommand(files, options);
    });
}

async function handleArktsCommand(
  files: string[],
  options: ArktsOptions
): Promise<void> {
  const start = Date.now();
  const cmdArgs = ['check', 'arkts'];
  try {
    const toolProvider = await ToolProvider.new();
    const adapter = new ArktsCheckAdapter(toolProvider, process.cwd());
    const spinner = new SpinnerHelper();
    if (process.stderr.isTTY) {
      spinner.start('Checking ArkTS...');
    }

    let result: ArktsCheckResult;
    try {
      result = await adapter.check({
        files,
        fix: options.fix,
        projectRoot: options.project,
      });
    } catch (error) {
      spinner.fail('ArkTS check failed');
      throw error;
    }

    if (result.error && result.errors.length === 0) {
      spinner.fail('ArkTS check failed');
      console.error(red(result.error));
      process.exitCode = 1;
      await trackArkts(start, false, 'CheckFailed', cmdArgs);
      return;
    }

    spinner.stop();
    renderResult(result);
    await trackArkts(start, true, null, cmdArgs);
  } catch (error) {
    await trackArkts(start, false, deriveArktsErrorCode(error), cmdArgs);
    throw error;
  }
}

function renderResult(result: ArktsCheckResult): void {
  const { errorCount, warnCount, fixedCount, fileCount } = result.summary;

  renderFixed(result.fixed, fixedCount, result.alsoModified);

  if (errorCount === 0) {
    console.log(green(`No errors found in ${fileCount} file(s).`));
    renderWarnings(result.errors);
    return;
  }

  renderDiagnostics(result.errors, errorCount, warnCount);
  process.exitCode = 1;
}

function renderFixed(
  fixed: ArktsDiagnostic[],
  fixedCount: number,
  alsoModified: string[]
): void {
  if (fixed.length === 0) {
    return;
  }
  console.log(green(`✓ Auto-fixed ${fixedCount} issue(s):`));
  for (const d of fixed) {
    console.log(`  ${d.file}:${d.line}:${d.column} - ${d.message}`);
  }
  if (alsoModified.length > 0) {
    console.log(
      yellow(
        `Note: auto-fix also modified ${alsoModified.length} ` +
          `file(s) outside the checked list (added missing 'export'):`
      )
    );
    for (const f of alsoModified) {
      console.log(`  ${f}`);
    }
  }
  console.log();
}

function renderDiagnostics(
  errors: ArktsDiagnostic[],
  errorCount: number,
  warnCount: number
): void {
  const fatal = errors.filter((d) => d.severity === 'error');
  console.error(red(`ArkTS check found ${errorCount} error(s):`));
  for (const d of fatal) {
    const ruleSuffix = d.rule ? ` (${d.rule})` : '';
    console.error(
      red(
        `${d.file}:${d.line}:${d.column} - ${d.severity}: ${d.message}${ruleSuffix}`
      )
    );
  }

  renderWarnings(errors, warnCount);
}

function renderWarnings(errors: ArktsDiagnostic[], warnCount?: number): void {
  const warnings = errors.filter((d) => d.severity !== 'error');
  if (warnings.length === 0) {
    return;
  }
  const count = warnCount ?? warnings.length;
  console.warn(yellow(`\nWarnings (${count}):`));
  for (const d of warnings) {
    const ruleSuffix = d.rule ? ` (${d.rule})` : '';
    console.warn(
      yellow(
        `${d.file}:${d.line}:${d.column} - ${d.severity}: ${d.message}${ruleSuffix}`
      )
    );
  }
}
