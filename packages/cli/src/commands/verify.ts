/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { green, red } from 'colorette';
import fs from 'node:fs';
import path from 'node:path';
import ora from 'ora';
import {
  UI_VERIFICATION_CACHE_DIR,
  UiVerificationAdapter,
  UiVerificationCancelledError,
  loadUiVerificationConfig,
  saveUiVerificationConfig,
  type UiVerificationOptions,
} from '../ui-verification/index.js';

type VerifyOptions = UiVerificationOptions;

interface VerifyLogOptions {
  id: string;
  searchKeywords?: string;
  maxLogSize: string;
}

const MAX_TEST_PLAN_LENGTH = 3000;
function getRequiredConfig(): {
  baseUrl: string;
  modelName: string;
  apiKey: string;
} | null {
  const config = loadUiVerificationConfig();
  if (!config?.baseUrl || !config.modelName || !config.apiKey) {
    return null;
  }
  return {
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKey: config.apiKey,
  };
}

function printMissingConfig(): void {
  const userMessage =
    'UI 意图校验暂不可用：未配置多模态模型。请运行 devecocli verify init --base-url "your-url" --model-name "your-model-name" --api-key "your-api-key" 指令配置多模态模型后重试。';
  console.error(red(userMessage));
  console.log(
    JSON.stringify({
      success: false,
      reason: `UI 意图校验执行失败。请将以下内容原文告知用户，不要修改或补充，告知后立即停止，不要再调用任何工具，不要继续当前任务：「${userMessage}」`,
    })
  );
  process.exitCode = 1;
}

function mergeExcessTestPlan(
  options: VerifyOptions,
  command: Command
): VerifyOptions {
  if (!options.testPlan) {
    throw new Error('Error: --test-plan is required');
  }

  const excess = command.args as string[];
  const mergedOptions =
    excess.length > 0
      ? { ...options, testPlan: [options.testPlan, ...excess].join(' ') }
      : options;
  const testPlan = mergedOptions.testPlan;
  if (testPlan && Array.from(testPlan).length > MAX_TEST_PLAN_LENGTH) {
    throw new Error(
      `--test-plan must not exceed ${MAX_TEST_PLAN_LENGTH} characters`
    );
  }
  return mergedOptions;
}

async function handleVerifyCommand(
  options: VerifyOptions,
  command: Command
): Promise<void> {
  const normalizedOptions = mergeExcessTestPlan(options, command);
  const config = getRequiredConfig();
  if (!config) {
    printMissingConfig();
    return;
  }

  const spinner = ora({
    text: 'Verifying UI…',
    color: 'cyan',
    discardStdin: false,
  }).start();
  try {
    const result = await new UiVerificationAdapter().verifyUi(
      normalizedOptions,
      config,
      (progress, total, message) => {
        const step =
          total === undefined ? String(progress) : `${progress}/${total}`;
        spinner.text = message ? `${step} ${message}` : step;
      }
    );
    if (result.success) {
      spinner.succeed(green('Verification passed'));
    } else {
      spinner.fail(red('Verification failed'));
      process.exitCode = 1;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    spinner.fail(red(error instanceof Error ? error.message : String(error)));
    process.exitCode =
      error instanceof UiVerificationCancelledError ? error.exitCode : 1;
  }
}

function handleVerifyLogCommand(options: VerifyLogOptions): void {
  const logFile = path.join(
    UI_VERIFICATION_CACHE_DIR,
    options.id,
    'verify.log'
  );
  if (!fs.existsSync(logFile)) {
    throw new Error(`No log found for ID: ${options.id}`);
  }
  let log = fs.readFileSync(logFile, 'utf8');
  if (options.searchKeywords) {
    log = log
      .split('\n')
      .filter((line) => line.includes(options.searchKeywords!))
      .map((line) => `${line}\n`)
      .join('');
    if (!log) {
      console.log(
        `The log does not contain the keyword '${options.searchKeywords}'.`
      );
      return;
    }
  }

  const maxSize = Number.parseInt(options.maxLogSize, 10);
  if (maxSize === -1) {
    console.log(log);
    return;
  }
  if (maxSize < 0 || Number.isNaN(maxSize)) {
    throw new Error('Please enter the correct max-log-size.');
  }
  if (maxSize === 0) {
    process.stdout.write('');
    return;
  }
  if (log.length > maxSize) {
    log = `(exceeded log size limit, showing last ${maxSize} characters)...\n${log.slice(-maxSize)}`;
  }
  console.log(log);
}

function handleVerifyScreenshotCommand(options: {
  id: string;
  savePath: string;
}): void {
  const sourceDir = path.join(
    UI_VERIFICATION_CACHE_DIR,
    options.id,
    'screenshots'
  );
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`No screenshots found for ID: ${options.id}`);
  }
  fs.mkdirSync(options.savePath, { recursive: true });
  const filenames = fs.readdirSync(sourceDir).map((filename) => {
    const destination = path.join(options.savePath, filename);
    fs.copyFileSync(path.join(sourceDir, filename), destination);
    return destination;
  });
  console.log(
    JSON.stringify(
      { filenames, message: 'Screenshots saved successfully' },
      null,
      2
    )
  );
}

const verifyCommand = new Command('verify')
  .description('Run UI verification on a connected device')
  .option(
    '--test-plan <plan>',
    'Natural-language test plan describing steps and expected results'
  )
  .option('--bundle-name <name>', 'Bundle name of the app to be tested')
  .option('--no-fresh-start', 'Skip relaunching the app before verification')
  .option('--device <name|serial>', 'Target device name or serial')
  .allowExcessArguments(true)
  .action(handleVerifyCommand);

verifyCommand
  .command('init')
  .description('Configure the vision model for UI verification')
  .option('--base-url <url>', 'Base URL of the vision model')
  .option('--model-name <name>', 'Vision model name')
  .option('--api-key <key>', 'API key for the vision model')
  .action(
    (options: { baseUrl?: string; modelName?: string; apiKey?: string }) => {
      if (!options.baseUrl && !options.modelName && !options.apiKey) {
        throw new Error(
          'Error: at least one of --base-url, --model-name, --api-key is required'
        );
      }
      const configPath = saveUiVerificationConfig(options);
      console.log(`UI verification config saved to ${configPath}`);
    }
  );

verifyCommand
  .command('log')
  .description('Get verification log by ID')
  .requiredOption('--id <id>', 'Verification task ID')
  .option('--search-keywords <keywords>', 'Filter log by keywords')
  .option(
    '--max-log-size <n>',
    'Max characters to show (-1 for unlimited)',
    '5000'
  )
  .action(handleVerifyLogCommand);

verifyCommand
  .command('screenshot')
  .description('Save verification screenshots by ID')
  .requiredOption('--id <id>', 'Verification task ID')
  .requiredOption('--save-path <path>', 'Absolute path to save screenshots')
  .action(handleVerifyScreenshotCommand);

export default verifyCommand;
