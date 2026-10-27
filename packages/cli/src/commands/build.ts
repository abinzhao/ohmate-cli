/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, yellow } from 'colorette';
import json5 from 'json5';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project } from '../utils/project.js';
import { projectSkillChecker } from '../skills/index.js';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter, DEFAULT_CLEAN_MODE } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { withBuildLock } from '../utils/build-lock.js';
import { BuildConfigManager } from '../apply/build-config.js';
import { checkSyncRequired } from '../utils/project-check.js';
import {
  findCppModules,
  findAndMergeCompileCommands,
} from '../../mcp/src-server/lsp/sync/cpp-compile.js';
import { debugLog } from '../utils/logger.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
  TraceError,
} from '../trace/index.js';

interface BuildOptions {
  product?: string;
  modules?: string[];
  buildMode?: string;
  assembleType?: string;
  signingConfig?: string;
}

const VALID_ASSEMBLE_TYPES = [
  'assembleHap',
  'assembleApp',
  'assembleHsp',
  'assembleHar',
];

interface CleanOptions {
  mode?: string;
  modules?: string[];
}

interface BuildResult {
  bundleName: string;
  ohpmMemoryMb: string;
  syncMemoryMb: string;
  buildMemoryMb: string;
}

export function validateProjectConfig(project: Project, options: BuildOptions) {
  // Validate product
  if (options.product) {
    project.validateProduct(options.product);
  }

  // Validate build mode
  if (options.buildMode) {
    const defaultModes = ['debug', 'release'];
    const customModes = (
      project.profile.app.buildModeSet?.map((m) => m.name) ?? []
    ).filter((m) => !defaultModes.includes(m));
    const allModes = [...defaultModes, ...customModes];
    if (!allModes.includes(options.buildMode)) {
      throw new Error(
        `Build mode '${options.buildMode}' not found. Available modes: ${allModes.join(', ')}`
      );
    }
  }

  // Validate assemble type
  if (options.assembleType) {
    if (!VALID_ASSEMBLE_TYPES.includes(options.assembleType)) {
      throw new Error(
        `Invalid assemble type '${options.assembleType}'. Valid types: ${VALID_ASSEMBLE_TYPES.join(', ')}`
      );
    }
  }

  // Validate signing config
  if (options.signingConfig) {
    if (!/^[\da-zA-Z_-]+$/.test(options.signingConfig)) {
      throw new Error(
        `Invalid signing config name '${options.signingConfig}'. Only letters, digits, hyphens and underscores are allowed.`
      );
    }
    const availableConfigs =
      project.profile.app.signingConfigs?.map((c) => c.name) ?? [];
    if (!availableConfigs.includes(options.signingConfig)) {
      const configList =
        availableConfigs.length > 0
          ? `Available configs: ${availableConfigs.join(', ')}.`
          : 'No signing configs found in build-profile.json5.';
      const hint = options.signingConfig.endsWith('_release')
        ? 'Run `devecocli signature generate --type release` to generate release signing materials.'
        : 'Run `devecocli signature generate` to generate signing materials.';
      throw new Error(
        `Signing config '${options.signingConfig}' not found in build-profile.json5. ` +
          `${configList} ${hint}`
      );
    }
  }
}

function validateRequestedModules(project: Project, modules: string[]) {
  const availableModules = project.profile.modules.map((module) => module.name);
  const availableModuleSet = new Set(availableModules);

  for (const moduleArg of modules) {
    const moduleName = moduleArg.split('@', 1)[0];
    if (!availableModuleSet.has(moduleName)) {
      throw new Error(
        `Module '${moduleName}' not found in project-level build-profile.json5. ` +
          `Available modules: ${availableModules.join(', ') || 'none'}`
      );
    }
  }
}

function determineModulesToBuild(
  project: Project,
  options: BuildOptions
): string[] {
  let initialModules: string[];

  if (options.modules && options.modules.length > 0) {
    initialModules = options.modules;
    validateRequestedModules(project, initialModules);
  } else {
    // Default behavior: find entry module or the only module
    const allModules = project.profile.modules;
    const entryModules = allModules.filter((m) => {
      const type = project.getModuleType(m.name);
      return type === 'entry';
    });

    if (allModules.length === 1) {
      initialModules = [allModules[0].name];
    } else if (entryModules.length === 1) {
      initialModules = [entryModules[0].name];
    } else if (entryModules.length > 1) {
      throw new TraceError(
        `Multiple entry modules found (${entryModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`,
        'Multiple entry modules found.'
      );
    } else {
      throw new TraceError(
        `No entry module found and multiple modules available (${allModules.map((m) => m.name).join(', ')}). ` +
          `Please specify which module to build with --modules.`,
        'No entry module found and multiple modules available.'
      );
    }
  }

  // Resolve HSP dependencies for each initial module
  const finalModulesSet = new Set<string>();
  for (const moduleArg of initialModules) {
    const splitIndex = moduleArg.indexOf('@');
    const moduleName =
      splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
    const targetName =
      splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : 'default';
    finalModulesSet.add(`${moduleName}@${targetName}`);
  }

  return Array.from(finalModulesSet);
}

export function processModuleTasks(
  project: Project,
  modulesToBuild: string[],
  assembleType?: string
): Set<string> {
  const moduleTasks = new Set<string>();

  for (const moduleArg of modulesToBuild) {
    const splitIndex = moduleArg.indexOf('@');
    const moduleName =
      splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;

    if (assembleType) {
      // User explicitly specified the assemble task type
      const moduleType = project.getModuleType(moduleName);
      const expectedTask =
        moduleType === 'shared'
          ? 'assembleHsp'
          : moduleType === 'har'
            ? 'assembleHar'
            : 'assembleHap';
      if (assembleType !== expectedTask && assembleType !== 'assembleApp') {
        console.warn(
          yellow(
            `Warning: --assemble-type ${assembleType} may not be compatible with module '${moduleName}' (type: ${moduleType}, expected: ${expectedTask}).`
          )
        );
      }
      moduleTasks.add(assembleType);
    } else {
      // Determine module type and required task
      const moduleType = project.getModuleType(moduleName);
      if (moduleType === 'shared') {
        moduleTasks.add('assembleHsp');
      } else if (moduleType === 'har') {
        moduleTasks.add('assembleHar');
      } else {
        moduleTasks.add('assembleHap');
      }
    }
  }

  return moduleTasks;
}

type ToolRunError = Error & { stdout?: string; stderr?: string };

export function logAdapterFailureAndThrow(
  stepLabel: string,
  error: unknown
): never {
  const e = error as ToolRunError;
  const failMsg = `${stepLabel} failed`;
  console.error(red(failMsg));
  const errText = e.stdout || e.message;
  if (errText) {
    console.error(errText);
  }
  if (e.stderr) {
    console.error(e.stderr);
  }
  throw new Error(failMsg, { cause: error });
}

export type BuildTarget =
  | { type: 'product' }
  | { type: 'modules'; modulesToBuild: string[]; moduleTasks: Set<string> };

async function runSyncIfNeeded(
  ohpmAdapter: OhpmAdapter,
  hvigorAdapter: HvigorAdapter,
  productName: string,
  buildMode: string,
  projectRoot: string
): Promise<string> {
  const checkResult = checkSyncRequired(projectRoot);
  if (!checkResult.required) {
    console.log('\n[ohpm install] Skipped (configurations unchanged)');
    console.log('\n[hvigor sync] Skipped (configurations unchanged)');
    return '';
  }
  console.log('\n[ohpm install] Running...');
  try {
    await ohpmAdapter.install();
  } catch (error) {
    logAdapterFailureAndThrow('ohpm install', error);
  }
  console.log('\n[hvigor sync] Running...');
  try {
    return await hvigorAdapter.sync(productName, buildMode);
  } catch (error) {
    logAdapterFailureAndThrow('hvigor sync', error);
  }
  return '';
}

export async function executeBuildSteps(
  ohpmAdapter: OhpmAdapter,
  hvigorAdapter: HvigorAdapter,
  productName: string,
  buildMode: string,
  buildTarget: BuildTarget,
  projectRoot: string
): Promise<{
  ohpmMemoryMb: string;
  syncMemoryMb: string;
  buildMemoryMb: string;
}> {
  const syncMemoryMb = await runSyncIfNeeded(
    ohpmAdapter,
    hvigorAdapter,
    productName,
    buildMode,
    projectRoot
  );

  console.log('\n[hvigor build] Running...');
  let buildMemoryMb = '';
  try {
    if (buildTarget.type === 'product') {
      buildMemoryMb = await hvigorAdapter.buildProduct(productName, buildMode);
    } else {
      buildMemoryMb = await hvigorAdapter.buildModules(
        productName,
        buildMode,
        buildTarget.modulesToBuild,
        buildTarget.moduleTasks
      );
    }
  } catch (error) {
    logAdapterFailureAndThrow('hvigor build', error);
  }

  mergeCppCompileCommands(projectRoot);
  return {
    ohpmMemoryMb: ohpmAdapter.peakMemoryMb,
    syncMemoryMb,
    buildMemoryMb,
  };
}

/**
 * 构建成功后，若工程含 C++ 模块，合并各模块 .cxx 下的 compile_commands.json 到中央文件
 * （.idea/.deveco/cxx/compile_commands.json），供 devecocli serve lsp --cpp / MCP 的 clangd 使用。
 * assembleHap 已为被构建的 C++ 模块生成每模块 compile_commands.json，此处只需合并，不重复跑
 * compileNative。非 C++ 工程或合并失败时静默跳过，不影响构建产物。
 */
function mergeCppCompileCommands(projectRoot: string): void {
  try {
    const cppModules = findCppModules(projectRoot);
    if (cppModules.length === 0) {
      return;
    }
    findAndMergeCompileCommands(projectRoot);
    console.log(
      green('\nMerged central compile_commands.json for C++ language server.')
    );
  } catch (e) {
    console.warn(
      yellow(`\nFailed to merge compile_commands.json: ${(e as Error).message}`)
    );
  }
}

async function withTrace(
  event: CommandExecuted,
  action: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;

  try {
    await action();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    console.error(red((error as Error).message));
    process.exitCode = 1;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

function buildBuildEvent(options: BuildOptions): CommandExecuted {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: [
      'build',
      ...(options.product ? ['--product'] : []),
      ...(options.modules ? ['--modules'] : []),
      ...(options.buildMode ? ['--build-mode'] : []),
      ...(options.assembleType ? ['--assemble-type'] : []),
      ...(options.signingConfig ? ['--signing-config'] : []),
    ],
  };
  if (options.buildMode) {
    event.build_mode = options.buildMode;
  }
  if (options.modules) {
    event.module_count = options.modules.length;
  }
  if (options.assembleType) {
    event.assemble_type = options.assembleType;
  }
  if (options.signingConfig) {
    event.signing_config = options.signingConfig;
  }
  return event;
}

function buildCleanEvent(options: CleanOptions): CommandExecuted {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: [
      'build',
      'clean',
      ...(options.mode ? ['--mode'] : []),
      ...(options.modules ? ['--modules'] : []),
    ],
  };
  if (options.modules) {
    event.module_count = options.modules.length;
  }
  if (options.mode) {
    event.clean_mode = options.mode;
  }
  return event;
}

async function handleBuild(options: BuildOptions): Promise<BuildResult> {
  const project = Project.discover(process.cwd());
  await projectSkillChecker.warnInvalidBundledLinks(project.rootDir);
  console.warn(
    yellow('Ensure the project source is trustworthy before proceeding.')
  );
  const toolProvider = await ToolProvider.new();
  toolProvider.assertJava();
  validateProjectConfig(project, options);
  const productName = options.product || 'default';
  const buildMode = options.buildMode || 'debug';
  const buildTarget = resolveBuildTarget(project, options);
  const ohpmAdapter = new OhpmAdapter(toolProvider, project.rootDir);
  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);
  const restoreSigningConfig = options.signingConfig
    ? overrideProductSigningConfig(
        project.rootDir,
        productName,
        options.signingConfig
      )
    : undefined;
  try {
    const memStats = await withBuildLock(
      project.rootDir,
      async () => {
        BuildConfigManager.removeAll(project);
        return executeBuildSteps(
          ohpmAdapter,
          hvigorAdapter,
          productName,
          buildMode,
          buildTarget,
          project.rootDir
        );
      },
      () =>
        console.log(
          'Another build is already running for this project. Waiting for completion...'
        )
    );
    console.log('\n' + green('Build completed successfully'));
    printBuildArtifacts(project, buildTarget, productName);
    return {
      bundleName: project.getBundleName(),
      ...memStats,
    };
  } finally {
    restoreSigningConfig?.();
  }
}

function resolveBuildTarget(
  project: Project,
  options: BuildOptions
):
  | { type: 'product' }
  | { type: 'modules'; modulesToBuild: string[]; moduleTasks: Set<string> } {
  if (
    options.assembleType === 'assembleApp' ||
    (options.product && !options.modules && !options.assembleType)
  ) {
    return { type: 'product' };
  }
  const modulesToBuild = determineModulesToBuild(project, options);
  const moduleTasks = processModuleTasks(
    project,
    modulesToBuild,
    options.assembleType
  );
  return { type: 'modules', modulesToBuild, moduleTasks };
}

/**
 * Temporarily override a product's signingConfig in build-profile.json5.
 * Returns a restore function that reverts the change.
 */
function overrideProductSigningConfig(
  projectRoot: string,
  productName: string,
  signingConfig: string
): () => void {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  const original = fs.readFileSync(profilePath, 'utf-8');
  const profile = json5.parse(original);
  const products = profile?.app?.products ?? [];
  const idx = products.findIndex(
    (p: { name: string }) => p.name === productName
  );
  if (idx >= 0) {
    products[idx].signingConfig = signingConfig;
  } else {
    products.push({ name: productName, signingConfig });
  }
  debugLog(
    `[build] temporarily setting product '${productName}' signingConfig to '${signingConfig}'`
  );
  fs.writeFileSync(profilePath, json5.stringify(profile, null, 2), 'utf-8');
  return () => {
    fs.writeFileSync(profilePath, original, 'utf-8');
    debugLog(`[build] restored original build-profile.json5`);
  };
}

/**
 * Print the paths of build artifacts (.hap/.hsp/.har/.app) produced for the
 * modules that were just built.  For a whole-product build, targets are
 * resolved per module via applyToProducts, and the project-level .app package
 * is also collected.  For a module build, the requested modules plus any
 * dependent modules built by hvigor are checked.
 */
function printBuildArtifacts(
  project: Project,
  buildTarget: BuildTarget,
  productName: string
): void {
  const moduleSpecs =
    buildTarget.type === 'product'
      ? project.resolveModuleSpecsForProduct(productName)
      : buildTarget.modulesToBuild;

  const artifacts = project.collectBuildArtifacts(
    buildTarget.type === 'product',
    moduleSpecs,
    productName
  );

  if (artifacts.length === 0) {
    return;
  }

  console.log(green('Build artifacts:'));
  for (const artifact of artifacts) {
    console.log(`  ${artifact}`);
  }
}

async function handleClean(options: CleanOptions): Promise<string> {
  const currentDir = process.cwd();
  const project = Project.discover(currentDir);
  await projectSkillChecker.warnInvalidBundledLinks(project.rootDir);
  console.warn(
    yellow('Ensure the project source is trusted before proceeding.')
  );
  const toolProvider = await ToolProvider.new();
  toolProvider.assertJava();

  // --modules 限定作用域时校验模块名（复用 build 的校验），去掉 @target 后缀
  let modules: string[] | undefined;
  if (options.modules && options.modules.length > 0) {
    validateRequestedModules(project, options.modules);
    modules = options.modules.map((m) => m.split('@', 1)[0]);
  }

  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);
  await withBuildLock(
    project.rootDir,
    async () => {
      const scope =
        modules && modules.length > 0
          ? `mode=${options.mode ?? DEFAULT_CLEAN_MODE}, modules=${modules.join(',')}`
          : `mode=${options.mode ?? DEFAULT_CLEAN_MODE}`;
      console.log(`\nRunning hvigor clean (${scope})...`);
      try {
        await hvigorAdapter.clean(options.mode, modules);
      } catch (error) {
        logAdapterFailureAndThrow('hvigor clean', error);
      }
    },
    () => {
      console.log(
        'Another build is already running for this project. Waiting for it to finish...'
      );
    }
  );

  console.log('\n' + green('Clean completed successfully.'));
  return project.getBundleName();
}

const buildCommand = new Command('build')
  .description('Build HarmonyOS project')
  .option(
    '--product <product>',
    'Product name defined in build-profile.json5 (default: default)'
  )
  .option(
    '--modules <modules...>',
    'Modules to build (format: module or module@target)'
  )
  .option(
    '--build-mode <mode>',
    'Build mode (buildModeSet in build-profile.json5; e.g. debug, release; default: debug)'
  )
  .option(
    '--assemble-type <type>',
    'Assemble task type: assembleHap, assembleApp, assembleHsp, assembleHar (default: auto-detect by module type)'
  )
  .option(
    '--signing-config <name>',
    'Signing config name defined in build-profile.json5 (overrides product default)'
  )
  .action(async (options: BuildOptions) => {
    const event = buildBuildEvent(options);
    await withTrace(event, async () => {
      const result = await handleBuild(options);
      event.bundle_name = result.bundleName;
      if (result.ohpmMemoryMb) {
        event.ohpm_install_memory = result.ohpmMemoryMb;
      }
      if (result.syncMemoryMb) {
        event.hvigor_sync_memory = result.syncMemoryMb;
      }
      if (result.buildMemoryMb) {
        event.hvigor_build_memory = result.buildMemoryMb;
      }
    });
  });

buildCommand
  .command('clean')
  .description('Clean HarmonyOS project build outputs')
  .option('--mode <mode>', 'hvigor --mode value (default: module)')
  .option('--modules <modules...>', 'Scope clean to specific modules')
  .action(async (options: CleanOptions, command: Command) => {
    // build also declares --modules, so commander parses those onto the
    // parent before dispatching clean; recover them from the parent.
    const parentOpts =
      command.parent?.opts<Pick<BuildOptions, 'modules'>>() ?? {};
    const opts: CleanOptions = {
      mode: options.mode,
      modules: options.modules ?? parentOpts.modules,
    };
    const event = buildCleanEvent(opts);
    await withTrace(event, async () => {
      event.bundle_name = await handleClean(opts);
    });
  });

export default buildCommand;
