/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, yellow } from 'colorette';
import * as path from 'path';
import { Project } from '../utils/project.js';
import { projectSkillChecker } from '../skills/index.js';
import { ToolProvider } from '../toolchain/index.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { DeviceManager } from '../service/device-manager.js';
import { ApplyManager } from '../apply/apply-manager.js';
import { BuildConfigManager } from '../apply/build-config.js';
import { HotReloadBuildConfigManager } from '../apply/hotreload/build-config-hotreload.js';
import { HvigorDaemonClient } from '../apply/hotreload/hvigor-daemon-client.js';
import {
  executeHotReloadApply,
  assertSingleHotReloadModule,
  warnUnsupportedModules,
  resolveHotReloadArtifacts,
  stopHotReloadDaemon,
} from '../apply/hotreload/hotreload-manager.js';
import { withBuildLock } from '../utils/build-lock.js';
import { executeBuildSteps, processModuleTasks } from './build.js';
import { runPostLaunchSmoke } from '../smoke/index.js';
import { resolveRunArtifacts } from '../quality/index.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { telemetry, EventType, toTraceErrorCode, type CommandExecuted, type TrackMeasurement, TraceError } from '../trace/index.js';

interface RunOptions {
  module?: string[];
  device?: string;
  product?: string;
  buildMode?: string;
  ability?: string;
  uninstall?: boolean;
  skipBuild?: boolean;
  apply?: string;
  hotreload?: string;
  hotreloadApply?: string;
}

interface BuildMemoryStats {
  ohpmMemoryMb: string;
  syncMemoryMb: string;
  buildMemoryMb: string;
}

function parseModuleArg(moduleArg: string): { moduleName: string; targetName: string } {
  const splitIndex = moduleArg.indexOf('@');
  const moduleName = splitIndex !== -1 ? moduleArg.substring(0, splitIndex) : moduleArg;
  const targetName = splitIndex !== -1 ? moduleArg.substring(splitIndex + 1) : 'default';
  return { moduleName, targetName };
}

async function selectDevice(
  deviceManager: DeviceManager,
  deviceArg?: string
): Promise<string> {
  const devices = await deviceManager.listDevices();
  if (devices.length === 0) {
    throw new Error(
      'No active devices found. Start an emulator or connect a physical device.'
    );
  }

  if (!deviceArg && devices.length > 1) {
    const named = await deviceManager.listDevicesWithName();
    throw new TraceError(
      'Multiple devices found. Specify a target device using `--device <Name>` or `--device <ID>`.\nAvailable devices:\n' +
        named.map((d) => `  - ${d.name} (${d.serial})`).join('\n'),
      'Multiple devices found.'
    );
  }

  const picked = await deviceManager.getDeviceInfo(devices, deviceArg);
  if (!picked) {
    throw new Error('No active devices found.');
  }
  if (!deviceArg) {
    const name = await deviceManager.getDeviceName(picked.serial);
    console.log(`Auto-selected device: ${name} (${picked.serial})`);
  }
  return picked.serial;
}

function identifyModules(project: Project, moduleArgs?: string[]): string[] {
  if (moduleArgs && moduleArgs.length > 0) {
    return moduleArgs;
  }

  const runnableModules = project.profile.modules.filter((m) => {
    const type = project.getModuleType(m.name);
    return type === 'entry' || type === 'feature' || type === 'shared';
  });

  if (runnableModules.length === 1) {
    const selected = runnableModules[0].name;
    console.log(`Auto-selected module: ${selected}`);
    return [selected];
  }

  throw new TraceError(`Specify module(s) using --module <name> [<name>...].\nAvailable runnable modules:\n` +
      runnableModules.map((m) => `  - ${m.name}`).join('\n'),
    'Specify module error.'
  );
}

function resolveMainAbility(
  project: Project,
  parsedModules: { moduleName: string; targetName: string }[],
  ability?: string
): string | undefined {
  if (ability) {
    return ability;
  }

  const entryModule = parsedModules.find(
    ({ moduleName }) => project.getModuleType(moduleName) === 'entry'
  );
  if (entryModule) {
    return project.getMainAbility(entryModule.moduleName);
  }

  const featureModule = parsedModules.find(
    ({ moduleName }) => project.getModuleType(moduleName) === 'feature'
  );
  if (featureModule) {
    return project.getMainAbility(featureModule.moduleName);
  }

  return undefined;
}

async function performDeployment(
  hdcAdapter: HdcAdapter,
  targetDeviceId: string,
  bundleName: string,
  artifactsToInstall: string[],
  mainAbility: string | undefined,
  uninstall: boolean
): Promise<void> {
  if (uninstall) {
    console.log(`Uninstalling ${bundleName}...`);
    const uninstalled = await hdcAdapter.uninstallApp(
      targetDeviceId,
      bundleName
    );
    if (!uninstalled) {
      console.log(`App ${bundleName} not installed; skipping uninstallation.`);
    }
  }

  console.log(`\nInstalling artifacts to device ${targetDeviceId}...`);
  await hdcAdapter.installApp(targetDeviceId, artifactsToInstall);

  if (mainAbility) {
    console.log(`Launching ${bundleName}/${mainAbility}...`);
    const launchResult = await hdcAdapter.launchApp(
      targetDeviceId,
      bundleName,
      mainAbility
    );
    console.log(green(`\nApplication '${bundleName}': ${launchResult}`));
  } else {
    console.log(`\nApplication '${bundleName}' installed successfully (no ability to launch).`);
  }
}

function buildRunEvent(options: RunOptions): CommandExecuted {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: [
      'run',
      ...(options.module ? ['--module'] : []),
      ...(options.device ? ['--device'] : []),
      ...(options.product ? ['--product'] : []),
      ...(options.buildMode ? ['--build-mode'] : []),
      ...(options.ability ? ['--ability'] : []),
      ...(options.uninstall ? ['--uninstall'] : []),
      ...(options.skipBuild ? ['--skip-build'] : []),
      ...(options.apply ? ['--apply'] : []),
      ...(options.hotreload ? ['--hotreload'] : []),
      ...(options.hotreloadApply ? ['--hotreload-apply'] : []),
    ],
  };
  if (options.buildMode) {
    event.build_mode = options.buildMode;
  }
  if (options.module) {
    event.module_count = options.module.length;
  }
  return event;
}

const runCommand = new Command('run')
  .description('Build and run the project on a connected device')
  .option(
    '--module <modules...>',
    'Module(s) to run (format: module or module@target)'
  )
  .option('--device <device>', 'Target device name or serial')
  .option('--product <product>', 'Product name (default: default)')
  .option('--build-mode <mode>', 'Build mode (options: debug, release; default: debug)')
  .option('--ability <ability>', 'Ability name to launch')
  .option('--uninstall', 'Uninstall existing app before installation')
  .option('--skip-build', 'Skip build step and deploy existing artifacts')
  .option('--apply <fileName>', 'Quick-apply changed files via quickfix (incremental hqf) and restart. <fileName> under project .hvigor/')
  .option('--hotreload [action]', 'Start hot-reload mode (build+deploy with daemon, then exit). Use "stop" to shut down the hvigor daemon.')
  .option('--hotreload-apply <fileName>', 'Hot-reload changed files (.hvigor/<fileName> list) via daemon hot compile + signed hqf + quickfix, without restarting the app.')
  .action(async (options: RunOptions) => {
    const event = buildRunEvent(options);
    const start = Date.now();
    let success = true;
    let errorCode: string | null = null;

    try {
      const memStats = await runActionImpl(options, event);
      if (memStats) {
        if (memStats.ohpmMemoryMb) {
          event.ohpm_install_memory = memStats.ohpmMemoryMb;
        }
        if (memStats.syncMemoryMb) {
          event.hvigor_sync_memory = memStats.syncMemoryMb;
        }
        if (memStats.buildMemoryMb) {
          event.hvigor_build_memory = memStats.buildMemoryMb;
        }
      }
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
  });

async function runBuildPhase(
  project: Project,
  toolProvider: ToolProvider,
  parsedModules: { moduleName: string; targetName: string }[],
  productName: string,
  buildMode: string
): Promise<BuildMemoryStats> {
  const ohpmAdapter = new OhpmAdapter(toolProvider, project.rootDir);
  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);

  const moduleSet = new Set<string>();
  for (const { moduleName, targetName } of parsedModules) {
    for (const m of project.collectNonHarDependentModuleList(moduleName)) {
      moduleSet.add(`${m}@${targetName}`);
    }
  }
  const modulesToBuild = [...moduleSet];
  const moduleTasks = processModuleTasks(project, modulesToBuild);
  const buildTarget = { type: 'modules' as const, modulesToBuild, moduleTasks };

  const memStats = await withBuildLock(
    project.rootDir,
    () => {
      BuildConfigManager.removeAll(project);
      return executeBuildSteps(ohpmAdapter, hvigorAdapter, productName, buildMode, buildTarget, project.rootDir);
    },
    () => console.log('Another build is already running for this project. Waiting for completion...')
  );

  console.log('\n' + green('Build completed successfully.'));
  return memStats;
}

async function runActionImpl(options: RunOptions, event: CommandExecuted): Promise<BuildMemoryStats | undefined> {
  const project = Project.discover(process.cwd());
  await projectSkillChecker.warnInvalidBundledLinks(project.rootDir);
  console.warn(yellow('Ensure the project source is trusted before proceeding.'));
  const toolProvider = await ToolProvider.new();
  if (!options.skipBuild) {
    toolProvider.assertJava();
  }

  event.bundle_name = project.getBundleName();

  if (options.hotreloadApply) {
    await runHotReloadApplyFlow(options, project, toolProvider);
    return undefined;
  }

  if (options.hotreload) {
    await runHotReloadFlow(options, project, toolProvider);
    return undefined;
  }

  if (options.apply) {
    await runApplyFlow(options, project, toolProvider);
    return undefined;
  }

  return runNormalFlow(options, project, toolProvider);
}

async function handleHotReloadClear(daemonClient: HvigorDaemonClient, toolProvider: ToolProvider, project: Project) {
  daemonClient.onSocketDisconnect(() => {
    console.log('Daemon disconnected (likely via --hotreload stop). Exiting watch session.');
    process.exit(0);
  });

  // Poll daemon liveness — on macOS socket.io disconnect detection is slow
  // (25s+ heartbeat timeout). Polling the registry catches --hotreload stop
  // within 3 seconds regardless of OS.
  const hvigorAdapterPoll = new HvigorAdapter(toolProvider, project.rootDir);
  const pollTimer = setInterval(async () => {
    if (!(await hvigorAdapterPoll.isDaemonAlive())) {
      clearInterval(pollTimer);
      console.log('Daemon stopped (via --hotreload stop). Exiting watch session.');
      process.exit(0);
    }
  }, 3000);

  await new Promise<void>(() => {
    // Never resolves: the CLI process stays alive holding the watch-session
    // socket open so the daemon's watch worker stays (for --hotreload-apply).
    // When the daemon is stopped (--hotreload stop), either the socket
    // disconnect handler or the poll timer catches it and exits.
    // Ctrl+C also exits (SIGINT default handler).
  });
}

async function runHotReloadFlow(
  options: RunOptions, project: Project, toolProvider: ToolProvider
): Promise<void> {
  if (options.hotreload === 'stop') {
    await stopHotReloadDaemon(toolProvider, project);
    return;
  }

  const moduleArgs = identifyModules(project, options.module);
  const parsedModules = moduleArgs.map(parseModuleArg);
  const { moduleName, targetName } = parsedModules[0];

  assertSingleHotReloadModule(options.module, moduleName);

  const hdcAdapter = new HdcAdapter(toolProvider);
  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);
  const isEmulator = targetDeviceId.includes('127.0.0.1') || targetDeviceId.includes('localhost');

  const productName = options.product || 'default';
  project.validateProduct(productName);
  const bundleName = project.getBundleName(productName);
  const mainAbility = resolveMainAbility(project, parsedModules, options.ability);

  HotReloadBuildConfigManager.generate(
    project.rootDir, moduleName, productName, toolProvider
  );

  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);
  console.log(green('Ensuring hvigor daemon is running (via --sync --daemon, no hap build)...'));
  await hvigorAdapter.ensureDaemonRunning();

  const moduleSpecs = [`${moduleName}@${productName}`];
  for (const dep of project.collectNonHarDependentModuleList(moduleName)) {
    if (!moduleSpecs.includes(`${dep}@${productName}`)) {
      moduleSpecs.push(`${dep}@${productName}`);
    }
  }

  console.log(green('Building hap + starting watch session (socket -> CommonBuild assembleHap --hot-reload-build --watch, kept open)...'));
  const daemonClient = new HvigorDaemonClient(project.rootDir, toolProvider);
  await daemonClient.startWatchSession({ moduleSpecs, productName });

  const artifacts = resolveHotReloadArtifacts(
    project, moduleName, targetName, isEmulator, productName
  );

  await performDeployment(
    hdcAdapter, targetDeviceId, bundleName, artifacts, mainAbility, !!options.uninstall
  );

  console.log(
    green('Hot-reload watch session active (socket persistent). Edit code, write .hvigor/<file>, then `devecocli run --hotreload-apply <file>` in another terminal. Ctrl+C here to stop.')
  );

  await handleHotReloadClear(daemonClient, toolProvider, project);
}

async function runHotReloadApplyFlow(
  options: RunOptions, project: Project, toolProvider: ToolProvider
): Promise<void> {
  const applyFileName = options.hotreloadApply;
  if (!applyFileName) {
    throw new Error('hotreload-apply requires --hotreload-apply <fileName> (under .hvigor/)');
  }
  if (path.basename(applyFileName) !== applyFileName) {
    throw new Error(`apply file must be a plain file name (under .hvigor/), got: ${applyFileName}`);
  }

  const moduleArgs = identifyModules(project, options.module);
  const { moduleName } = parseModuleArg(moduleArgs[0]);

  assertSingleHotReloadModule(options.module, moduleName);

  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);

  const productName = options.product || 'default';
  project.validateProduct(productName);
  const bundleName = project.getBundleName(productName);

  warnUnsupportedModules(project, moduleName, applyFileName);

  const moduleSpecs = [`${moduleName}@${productName}`];

  const result = await executeHotReloadApply({
    applyFileName,
    projectPath: project.rootDir,
    moduleName,
    productName,
    bundleName,
    toolProvider,
    targetDeviceId,
    moduleSpecs,
  });

  if (!result.success) {
    throw new Error(result.message);
  }
}

async function runNormalFlow(
  options: RunOptions, project: Project, toolProvider: ToolProvider
): Promise<BuildMemoryStats | undefined> {
  const moduleArgs = identifyModules(project, options.module);
  const parsedModules = moduleArgs.map(parseModuleArg);

  for (const { moduleName } of parsedModules) {
    const type = project.getModuleType(moduleName);
    if (type !== 'entry' && type !== 'feature' && type !== 'shared') {
      throw new TraceError(
        `Module '${moduleName}' '${type}' is not runnable. Specify an entry or feature module.`,
        'Module is not runnable.'
      );
    }
  }

  const hdcAdapter = new HdcAdapter(toolProvider);
  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);
  const isEmulator =
    targetDeviceId.includes('127.0.0.1') ||
    targetDeviceId.includes('localhost');

  const productName = options.product || 'default';
  project.validateProduct(productName);
  const buildMode = options.buildMode || 'debug';

  let memStats: BuildMemoryStats | undefined;
  if (!options.skipBuild) {
    memStats = await runBuildPhase(project, toolProvider, parsedModules, productName, buildMode);
  }

  const allArtifacts = await resolveRunArtifacts({ project, modules: parsedModules, isEmulator,
    product: productName, buildMode, provider: toolProvider, dataDir: getCliDataDir() });
  const bundleName = project.getBundleName(productName);
  const mainAbility = resolveMainAbility(project, parsedModules, options.ability);

  await performDeployment(
    hdcAdapter,
    targetDeviceId,
    bundleName,
    allArtifacts,
    mainAbility,
    !!options.uninstall
  );

  if (mainAbility) {
    await runPostLaunchSmoke({
      toolProvider,
      projectRoot: project.rootDir,
      hdcAdapter,
      targetDeviceId,
      bundleName,
    });
  }

  return memStats;
}

async function runApplyFlow(
  options: RunOptions, project: Project, toolProvider: ToolProvider
): Promise<void> {
  const applyFileName = options.apply;
  if (!applyFileName) {
    throw new Error('apply requires --apply <fileName> (under .hvigor/)');
  }
  // 文件名安全校验：必须是纯文件名（无路径分隔符/..），从 .hvigor 固定目录读，防穿越
  if (path.basename(applyFileName) !== applyFileName) {
    throw new Error(`apply file must be a plain file name (under .hvigor/), got: ${applyFileName}`);
  }
  const applyFile = path.join(project.rootDir, '.hvigor', applyFileName);

  const deviceManager = DeviceManager.from(toolProvider);
  const targetDeviceId = await selectDevice(deviceManager, options.device);

  const productName = options.product || 'default';
  project.validateProduct(productName);
  const bundleName = project.getBundleName(productName);
  // ability: --ability 指定，否则从 entry 模块取（apply 构建模块从 txt 自动识别，不依赖 --module）
  const entryModule = project.profile.modules.find(
    (m) => project.getModuleType(m.name) === 'entry'
  )?.name;
  const abilityName = entryModule
    ? project.getMainAbility(entryModule, options.ability)
    : (options.ability || 'EntryAbility');

  const mgr = new ApplyManager(toolProvider, project.rootDir);
  try {
    await mgr.execute({
      applyFile,
      productName,
      targetDeviceId,
      bundleName,
      abilityName,
    });
  } catch (e) {
    console.warn(yellow(`[Apply] failed: ${(e as Error).message}`));
    console.warn(yellow('[Apply] Falling back to full "devecocli run"...'));
    await runNormalFlow(options, project, toolProvider);
    return;
  }

  console.log(
    yellow('[Apply] Done. If changes did not take effect, run "devecocli run" for a full build.')
  );

  await runPostLaunchSmoke({
    toolProvider,
    projectRoot: project.rootDir,
    targetDeviceId,
    bundleName,
  });
}

export default runCommand;
