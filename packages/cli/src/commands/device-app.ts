/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { yellow } from 'colorette';
import { existsSync } from 'node:fs';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { HdcAdapter, type InstallOptions } from '../utils/hdc-adapter.js';
import {
  AppControlAdapter,
  parseForegroundApp,
  parseAppList,
  parseAppInfo,
  extractAppInfoFields,
  parseStartAppResult,
  type AppEntry,
  type ForegroundAppInfo,
} from '../device/app/index.js';
import { CommonUtils } from '../utils/common-utils.js';

interface AppStartOptions {
  device?: string;
  bundle?: string;
  ability?: string;
  action?: string;
  uri?: string;
}

interface AppStopOptions {
  device?: string;
  bundle: string;
}

interface AppInstallOptions {
  device?: string;
  replace?: boolean;
  shared?: string[];
  wait?: number;
  user?: string;
}

interface AppUninstallOptions {
  device?: string;
  bundle: string;
}

function printAppList(apps: AppEntry[], format: 'default' | 'json'): void {
  if (format === 'json') {
    console.log(JSON.stringify(apps, null, 2));
  } else {
    if (apps.length > 0) {
      for (const app of apps) {
        const label = app.label || '';
        console.log(`${app.bundleName}  ${label}`);
      }
    } else {
      console.log(yellow('No installed apps found.'));
    }
  }
}

async function appListAction(
  toolProvider: ToolProvider,
  device?: string,
  format: 'default' | 'json' = 'default'
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const spinner = ora({
    text: 'Listing installed apps...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.listInstalledApps(serial);
    spinner.stop();
    const apps = parseAppList(output);
    printAppList(apps, format);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to list apps: ${(error as Error).message}`,
      'Failed to list apps.'
    );
  }
}

function printForegroundApp(apps: ForegroundAppInfo[], format: 'default' | 'json'): void {
  if (apps.length > 0) {
    if (format === 'json') {
      console.log(JSON.stringify(apps, null, 2));
    } else {
      for (const app of apps) {
        console.log(`${app.bundleName ?? ''}#${app.abilityName ?? ''}`);
      }
    }
  } else {
    if (format === 'json') {
      console.log('[]');
    } else {
      console.log(yellow('No foreground app.'));
    }
  }
}

async function appForegroundAction(
  toolProvider: ToolProvider,
  device?: string,
  format: 'default' | 'json' = 'default'
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const spinner = ora({
    text: 'Querying foreground app...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getForegroundApp(serial);
    spinner.stop();
    const apps = parseForegroundApp(output);
    printForegroundApp(apps, format);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to get foreground app: ${(error as Error).message}`,
      'Failed to get foreground app.'
    );
  }
}

async function appInfoAction(
  toolProvider: ToolProvider,
  bundleName: string,
  device?: string,
  format: 'default' | 'json' = 'default'
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const spinner = ora({
    text: `Querying app info for ${bundleName}...`,
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getAppInfo(serial, bundleName);
    spinner.stop();
    const data = parseAppInfo(output);
    if (!data) {
      throw new TraceError(
        `No app info found for ${bundleName}. The app may not be installed.`,
        'No app info found. The app may not be installed.'
      );
    }
    if (format === 'json') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const f = extractAppInfoFields(data);
      console.log(`  bundleName:      ${f.bundleName ?? '-'}`);
      console.log(`  entryModuleName: ${f.entryModuleName ?? '-'}`);
      console.log(`  mainAbility:     ${f.mainAbility ?? '-'}`);
      console.log(`  versionCode:     ${f.versionCode ?? '-'}`);
      console.log(`  versionName:     ${f.versionName ?? '-'}`);
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to get app info: ${(error as Error).message}`,
      'Failed to get app info.'
    );
  }
}

async function appStartAction(
  toolProvider: ToolProvider,
  options: AppStartOptions
): Promise<void> {
  // Parameter combination validation:
  // - --action alone is valid (action-only start)
  // - --uri alone is valid (uri-only start, other params optional)
  // - --bundle requires --ability (bundle without ability is rejected)
  // - At least one of --bundle, --action, or --uri must be provided
  if (!options.bundle && !options.action && !options.uri) {
    throw new TraceError(
      'At least one of --bundle, --action, or --uri must be provided.',
      'At least one of --bundle, --action, or --uri must be provided.'
    );
  }
  if (options.bundle && !options.ability) {
    throw new TraceError(
      '--ability is required when --bundle is specified.',
      '--ability is required when --bundle is specified.'
    );
  }
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const label = options.bundle ?? '(no bundle)';
  const spinner = ora({
    text: `Starting app ${label}...`,
    color: 'cyan',
  }).start();

  try {
    const result = await adapter.startApp(
      serial,
      options.bundle,
      options.ability,
      options.action,
      options.uri
    );
    spinner.stop();
    const { success, message } = parseStartAppResult(result);
    if (!success) {
      throw new TraceError(
        `Failed to start app: ${message}`,
        'Failed to start app. The app or ability may not be installed.'
      );
    }
    console.log(`App ${label}: ${message}`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to start app: ${(error as Error).message}`,
      'Failed to start app.'
    );
  }
}

async function appStopAction(
  toolProvider: ToolProvider,
  options: AppStopOptions
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  const adapter = new HdcAdapter(toolProvider);
  const spinner = ora({
    text: `Stopping app ${options.bundle}...`,
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.forceStopApp(serial, options.bundle);
    spinner.stop();
    const result = output.trim();
    if (result && /error|failed|not found|not installed/i.test(result)) {
      throw new TraceError(result, 'Failed to stop app.');
    }
    console.log(`Stopped app ${options.bundle}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      (error as Error).message,
      'Failed to stop app.'
    );
  }
}

function validateInstallInputs(files: string[], options: AppInstallOptions): void {
  if (files.length === 0 && !options.shared?.length) {
    throw new TraceError(
      'At least one package file or --shared must be provided.',
      'At least one package file or --shared must be provided.'
    );
  }
  for (const f of files) {
    if (!existsSync(f)) {
      throw new TraceError(`HAP file not found: ${f}`, 'HAP file not found.');
    }
  }
  if (options.shared) {
    for (const s of options.shared) {
      if (!existsSync(s)) {
        throw new TraceError(`Shared HSP file not found: ${s}`, 'Shared HSP file not found.');
      }
    }
  }
}

function buildInstallLabel(files: string[], options: AppInstallOptions): string {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(files.length === 1 ? files[0] : `${files.length} packages`);
  }
  if (options.shared?.length) {
    parts.push(`${options.shared.length} shared HSP(s)`);
  }
  return parts.join(' + ');
}

async function appInstallAction(
  toolProvider: ToolProvider,
  files: string[],
  options: AppInstallOptions
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  validateInstallInputs(files, options);
  const installOpts: InstallOptions = {
    replace: options.replace,
    shared: options.shared,
    wait: options.wait,
    user: options.user,
  };
  const adapter = new HdcAdapter(toolProvider);
  const label = buildInstallLabel(files, options);
  const spinner = ora({
    text: `Installing ${label}...`,
    color: 'cyan',
  }).start();

  try {
    await adapter.installApp(serial, files, installOpts);
    spinner.stop();
    console.log(`Installed ${label}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      (error as Error).message,
      'Failed to install app.'
    );
  }
}

async function appUninstallAction(
  toolProvider: ToolProvider,
  options: AppUninstallOptions
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  const adapter = new HdcAdapter(toolProvider);
  const spinner = ora({
    text: `Uninstalling ${options.bundle}...`,
    color: 'cyan',
  }).start();

  try {
    const existed = await adapter.uninstallApp(serial, options.bundle);
    spinner.stop();
    if (existed) {
      console.log(`Uninstalled ${options.bundle}.`);
    } else {
      console.log(
        yellow(`${options.bundle} was not installed.`)
      );
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to uninstall app: ${(error as Error).message}`,
      'Failed to uninstall app.'
    );
  }
}

async function appClearCacheAction(
  toolProvider: ToolProvider,
  options: AppStopOptions
): Promise<void> {
  CommonUtils.assertBundleNameStrict(options.bundle);
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const spinner = ora({
    text: `Clearing cache for ${options.bundle}...`,
    color: 'cyan',
  }).start();

  try {
    const result = await adapter.clearAppCache(serial, options.bundle);
    spinner.stop();
    const trimmed = result.trim();
    if (trimmed && /error|failed|not found|not installed/i.test(trimmed)) {
      throw new TraceError(trimmed, 'Failed to clear app cache.');
    }
    console.log(`Cleared cache for ${options.bundle}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      (error as Error).message,
      'Failed to clear app cache.'
    );
  }
}

async function appClearDataAction(
  toolProvider: ToolProvider,
  options: AppStopOptions
): Promise<void> {
  CommonUtils.assertBundleNameStrict(options.bundle);
  const serial = await resolveDeviceSerial(toolProvider, options.device);
  const adapter = new AppControlAdapter(toolProvider.hdcPath);
  const spinner = ora({
    text: `Clearing data for ${options.bundle}...`,
    color: 'cyan',
  }).start();

  try {
    const result = await adapter.clearAppData(serial, options.bundle);
    spinner.stop();
    const trimmed = result.trim();
    if (trimmed && /error|failed|not found|not installed/i.test(trimmed)) {
      throw new TraceError(trimmed, 'Failed to clear app data.');
    }
    console.log(`Cleared data for ${options.bundle}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      (error as Error).message,
      'Failed to clear app data.'
    );
  }
}

export const appCommand = new Command('app').description(
  'Manage apps on a connected device'
);

appCommand
  .command('list')
  .description('List installed apps')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .action(async (options: { device?: string; format: 'default' | 'json' }) => {
    const { device, format } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'list',
        ...(format === 'json' ? ['--format', 'json'] : []),
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appListAction(toolProvider, device, format);
    });
  });

appCommand
  .command('foreground')
  .description('Show current foreground app info')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .action(async (options: { device?: string; format: 'default' | 'json' }) => {
    const { device, format } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'foreground',
        ...(format === 'json' ? ['--format', 'json'] : []),
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appForegroundAction(toolProvider, device, format);
    });
  });

appCommand
  .command('info')
  .description('Show app info')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .argument('<bundleName>', 'Bundle name to query')
  .action(
    async (
      bundleName: string,
      options: { device?: string; format: 'default' | 'json' }
    ) => {
      const { device, format } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'device',
          'app',
          'info',
          '<bundleName>',
          ...(format === 'json' ? ['--format', 'json'] : []),
          ...(device ? ['--device'] : []),
        ],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await appInfoAction(toolProvider, bundleName, device, format);
      });
    }
  );

appCommand
  .command('start')
  .description('Start an app on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--bundle <name>', 'Bundle name (e.g. com.example.app)')
  .option('--ability <name>', 'Ability to start (-a)')
  .option('--action <action>', 'Action to send (-A)')
  .option('--uri <uri>', 'URI to start with (-U)')
  .action(async (options: AppStartOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'start',
        ...(options.bundle ? ['--bundle'] : []),
        ...(options.ability ? ['--ability'] : []),
        ...(options.action ? ['--action'] : []),
        ...(options.uri ? ['--uri'] : []),
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appStartAction(toolProvider, options);
    });
  });

appCommand
  .command('install')
  .description('Install package(s) on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--replace', 'Override install')
  .option('--shared <path>', 'Inter-app shared HSP path (repeatable)', (v: string, p: string[]) => [...p, v], [])
  .option('--wait <seconds>', 'Install wait time in seconds', (v: string) => parseInt(v, 10))
  .option('--user <userId>', 'Target user ID')
  .argument('[files...]', 'Local package path(s) to install (hap/hsp)')
  .action(async (files: string[], options: AppInstallOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'install',
        ...files.map(() => '<file>'),
        ...(options.replace ? ['--replace'] : []),
        ...(options.shared?.length ? ['--shared'] : []),
        ...(options.wait !== undefined ? ['--wait'] : []),
        ...(options.user ? ['--user'] : []),
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appInstallAction(toolProvider, files, options);
    });
  });

appCommand
  .command('uninstall')
  .description('Uninstall an app from the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .requiredOption('--bundle <name>', 'Bundle name')
  .action(async (options: AppUninstallOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'uninstall',
        '--bundle',
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appUninstallAction(toolProvider, options);
    });
  });

appCommand
  .command('stop')
  .description('Stop an app on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .requiredOption('--bundle <name>', 'Bundle name')
  .action(async (options: AppStopOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'stop',
        '--bundle',
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appStopAction(toolProvider, options);
    });
  });

appCommand
  .command('clearcache')
  .description('Clear app cache on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .requiredOption('--bundle <name>', 'Bundle name')
  .action(async (options: AppStopOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'clearcache',
        '--bundle',
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appClearCacheAction(toolProvider, options);
    });
  });

appCommand
  .command('cleardata')
  .description('Clear app data on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .requiredOption('--bundle <name>', 'Bundle name')
  .action(async (options: AppStopOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'app',
        'cleardata',
        '--bundle',
        ...(options.device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await appClearDataAction(toolProvider, options);
    });
  });
