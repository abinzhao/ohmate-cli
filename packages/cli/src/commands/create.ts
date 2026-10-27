/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import fs from 'fs';
import process from 'process';
import os from 'os';
import { Command } from 'commander';
import { green, red, cyan, yellow } from 'colorette';
import { ToolProvider } from '../toolchain/index.js';
import {
  createProject,
  CreateProjectResult,
  SUPPORTED_DEVICE_TYPES,
} from '../utils/template-provider.js';
import { telemetry, EventType } from '../trace/index.js';
import type { CommandExecuted, TrackMeasurement } from '../trace/index.js';
import { CommonUtils } from '../utils/common-utils.js';

interface CreateOptions {
  projectPath?: string;
  appName?: string;
  bundleName?: string;
  apiLevel?: string;
  deviceTypes?: string[];
}

function validateAppName(name: string): void {
  if (name.length < 1 || name.length > 200) {
    throw new ValidationError(
      'errorCode',
      `App name length must be 1-200 characters. Current: ${name.length}`
    );
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    throw new ValidationError(
      'errorCode',
      'Application name must start with a letter (a-z, A-Z) and contain only letters, digits, and underscores'
    );
  }
}

function validateDeviceTypes(deviceTypes?: string[]): string[] {
  if (!deviceTypes || deviceTypes.length === 0) {
    return [SUPPORTED_DEVICE_TYPES[0]];
  }

  const lowercased = deviceTypes.map((dt) => dt.toLowerCase());
  const unsupported = deviceTypes.filter(
    (dt, i) =>
      !(SUPPORTED_DEVICE_TYPES as readonly string[]).includes(lowercased[i])
  );

  if (unsupported.length > 0) {
    throw new ValidationError(
      'errorCode',
      `Unsupported device type(s): ${unsupported
        .map((dt) => `"${dt}"`)
        .join(', ')}. Supported types: ${SUPPORTED_DEVICE_TYPES.join(', ')}`
    );
  }

  return [...new Set(lowercased)];
}

function normalizeProjectPath(projectPath: string): string {
  const platform = os.platform();
  if (platform === 'win32') {
    let normalized = projectPath.replace(/\\/g, '/');
    normalized = normalized.replace(/\/+/g, '/');
    return normalized;
  }
  return projectPath.replace(/\/+/g, '/');
}

function validateProjectPath(projectPath: string): void {
  if (projectPath.length === 0) {
    throw new ValidationError('errorCode', 'Project path cannot be empty.');
  }

  if (projectPath.length > 120) {
    throw new ValidationError(
      'errorCode',
      `Project path cannot exceed 120 characters (current: ${projectPath.length}).`
    );
  }

  const platform = os.platform();

  const rawValidRegex =
    platform === 'win32' ? /^[a-zA-Z0-9._\-:\\/]+$/ : /^[a-zA-Z0-9._\-/]+$/;

  if (!rawValidRegex.test(projectPath)) {
    const allowedChars =
      platform === 'win32'
        ? 'letters, digits, dots, underscores, hyphens, colons, slashes (/) or backslashes (\\)'
        : 'letters, digits, dots, underscores, hyphens or slashes (/)';
    throw new ValidationError(
      'errorCode',
      `Project path can only contain ${allowedChars}.`
    );
  }

  const normalizedPath = normalizeProjectPath(projectPath);

  const chineseRegex = /[\u4e00-\u9fff]/;
  if (chineseRegex.test(normalizedPath)) {
    throw new ValidationError(
      'errorCode',
      'Project path cannot contain Chinese characters.'
    );
  }

  if (normalizedPath.endsWith('.')) {
    throw new ValidationError(
      'errorCode',
      'Project path cannot end with a dot (.)'
    );
  }
}

function findExistingParent(dirPath: string): string | null {
  let currentPath = dirPath;
  const root = path.parse(dirPath).root;

  while (currentPath !== root) {
    if (fs.existsSync(currentPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  if (fs.existsSync(root)) {
    return root;
  }

  return null;
}

function checkWritePermission(dirPath: string): void {
  const existingParent = findExistingParent(dirPath);

  if (!existingParent) {
    throw new ValidationError(
      'errorCode',
      `No existing parent directory found for '${dirPath}'. Cannot create project directory.`
    );
  }

  try {
    fs.accessSync(existingParent, fs.constants.W_OK);
  } catch {
    throw new ValidationError(
      'errorCode',
      `No write permission for directory '${existingParent}'. Cannot create project here.`
    );
  }

  const testFile = path.join(
    existingParent,
    `.deveco_write_test_${Date.now()}`
  );
  try {
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch {
    throw new ValidationError(
      'errorCode',
      `No write permission for directory '${existingParent}'. Cannot create project here.`
    );
  }
}

function deriveBundleName(appName: string): string {
  return `com.example.${appName.toLowerCase()}`;
}

function resolveProjectPath(appName: string, specifiedPath?: string): string {
  if (specifiedPath) {
    const normalizedPath = normalizeProjectPath(specifiedPath);
    const resolvedPath = path.resolve(normalizedPath);
    if (fs.existsSync(resolvedPath)) {
      const contents = fs.readdirSync(resolvedPath);
      if (contents.length > 0) {
        throw new ValidationError(
          'errorCode',
          `Directory '${resolvedPath}' is not empty. Cannot create project here.`
        );
      }
    } else {
      checkWritePermission(resolvedPath);
    }
    return resolvedPath;
  }

  const pwd = process.cwd();
  const basePath = path.join(pwd, appName);

  if (fs.existsSync(basePath)) {
    throw new ValidationError(
      'errorCode',
      `Directory '${basePath}' already exists. Cannot create project here.`
    );
  }

  checkWritePermission(basePath);
  return basePath;
}

function resolveApiLevel(
  options: CreateOptions,
  toolProvider?: ToolProvider
): number {
  const sdkMaxApi = toolProvider?.getMaxApiLevel();
  const noIdeMaxApi = 23;

  if (options.apiLevel) {
    const parsed = Number(options.apiLevel);

    if (!Number.isInteger(parsed) || parsed < 17) {
      throw new ValidationError(
        'errorCode',
        `Invalid API version ${options.apiLevel}. API version 17 or higher is required.`
      );
    }

    if (sdkMaxApi !== undefined) {
      if (parsed > sdkMaxApi) {
        throw new ValidationError(
          'errorCode',
          `Invalid API version ${options.apiLevel}. Your SDK supports API version 17-${sdkMaxApi}`
        );
      }
    } else {
      if (parsed > noIdeMaxApi) {
        throw new ValidationError(
          'errorCode',
          `Invalid API version ${options.apiLevel}. Without DevEco Studio, supported range is API version 17-${noIdeMaxApi}`
        );
      }
    }

    return parsed;
  }

  if (sdkMaxApi !== undefined) {
    return sdkMaxApi;
  }

  return 23;
}

async function tryGetToolProvider(): Promise<ToolProvider | undefined> {
  try {
    return await ToolProvider.new();
  } catch (error) {
    const e = error as Error;
    console.error(yellow(`DevEco Studio not found: ${e.message}`));
    console.log(yellow('Use placeholder API level instead.'));
    return undefined;
  }
}

class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

interface CreateOperation extends CommandExecuted {
  apiLevel: string | null;
}

async function trackCreate(
  start: number,
  success: boolean,
  errorCode: string | null,
  options?: CreateOptions
): Promise<void> {
  const event: CreateOperation = {
    event: EventType.CommandExecuted,
    args: ['create'],
    apiLevel: options?.apiLevel ?? null,
  };
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(event, measurement).catch(() => {});
}

function printCreateResult(result: CreateProjectResult): void {
  console.log('\n' + green('Project created successfully.'));
  console.log(`Project root: ${result.projectRoot}`);
  console.log(`App name: ${result.appName}`);
  console.log(`Bundle name: ${result.bundleName}`);
  console.log(`API level: ${result.apiLevel}`);
  console.log(`Device types: ${result.deviceTypes.join(', ')}`);
  console.log(green('Template integrity check passed.'));
}

const createCommand = new Command('create')
  .description('Scaffold a new HarmonyOS application project')
  .option(
    '--project-path <path>',
    'Project directory path (default: ./<app-name>)'
  )
  .option('--app-name <name>', 'Application name')
  .option(
    '--bundle-name <bundle>',
    'Bundle name (auto-derived as com.example.<app-name> if omitted)'
  )
  .option(
    '--api-level <level>',
    'API level (auto-detected from SDK if omitted; minimum: 17)'
  )
  .option(
    '--device-types <types...>',
    `Device types written to module.json5 (default: ${SUPPORTED_DEVICE_TYPES[0]}; supported: ${SUPPORTED_DEVICE_TYPES.join(', ')})`
  )
  .action(async (options: CreateOptions) => {
    const start = Date.now();

    try {
      if (!options.appName) {
        console.error(red('Error: --app-name is required'));
        await trackCreate(start, false, 'errorCode', options);
        process.exit(1);
      }

      const appName = options.appName;
      validateAppName(appName);

      const deviceTypes = validateDeviceTypes(options.deviceTypes);

      const bundleName = options.bundleName || deriveBundleName(appName);
      CommonUtils.assertBundleNameStrict(bundleName);

      if (options.projectPath) {
        validateProjectPath(options.projectPath);
      }

      const projectPath = resolveProjectPath(appName, options.projectPath);
      validateProjectPath(projectPath);

      console.log(cyan('Initializing project...'));
      console.log(`Project path: ${projectPath}`);
      console.log(`App name: ${appName}`);
      console.log(`Bundle name: ${bundleName}`);
      console.log(`Device types: ${deviceTypes.join(', ')}`);

      const toolProvider = await tryGetToolProvider();
      const apiLevel = resolveApiLevel(options, toolProvider);
      console.log(`API level: ${apiLevel}`);
      const devecoStudioPath = toolProvider?.devecoStudioPath;

      const result: CreateProjectResult = createProject(
        projectPath,
        appName,
        bundleName,
        apiLevel,
        deviceTypes,
        devecoStudioPath
      );

      printCreateResult(result);

      await trackCreate(start, true, null, options);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      const isValidationError = error instanceof ValidationError;
      const errorCode = isValidationError
        ? (error as ValidationError).code
        : (e.code ?? e.name ?? 'UnknownError');
      console.error(red('\nFailed to create project.'));
      console.error(red(e.message));
      await trackCreate(start, false, errorCode, options);
      process.exit(1);
    }
  });

export default createCommand;
