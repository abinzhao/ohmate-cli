/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import * as net from 'net';
import * as path from 'path';
import { ToolProvider } from '../toolchain/index.js';
import * as fs from 'fs';
import * as os from 'os';
import { debugLog } from './logger.js';
import { startMemoryTracker, formatBytesMb } from './process-rss.js';

/** clean 命令的默认 --mode 值 */
export const DEFAULT_CLEAN_MODE = 'module';
import { isTelemetryDisabled } from '../trace/index.js';

interface DaemonInfo {
  pid: number;
  state: string;
  cwdPath: string;
  port: number;
}

export class HvigorAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;
  private env: Record<string, string>;
  private silent: boolean;

  constructor(toolProvider: ToolProvider, projectRoot: string, silent = false,
    private readonly executor?: (args: string[]) => Promise<void>) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;
    this.silent = silent;

    const javaBinDir = path.dirname(toolProvider.javaPath);
    const newPath = `${javaBinDir}${path.delimiter}${process.env.PATH || ''}`;

    const env: Record<string, string> = {
      ...process.env,
      PATH: newPath,
      DEVECO_SDK_HOME: toolProvider.sdkPath,
    };
    const isSystemJavaLauncher =
      os.platform() === 'darwin' && toolProvider.javaPath === '/usr/bin/java';
    if (
      toolProvider.sourceType === 'clt' &&
      toolProvider.javaPath &&
      !isSystemJavaLauncher
    ) {
      env.JAVA_HOME = path.dirname(javaBinDir);
    }

    this.env = env as Record<string, string>;
  }

  public async sync(productName: string, buildMode: string): Promise<string> {
    const args: string[] = [
      '--sync',
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
    ];

    return this.runHvigor(args);
  }

  public async tasks(productName?: string, modules?: string[], buildMode = 'debug'): Promise<string> {
    const args = ['tasks'];
    if (modules?.length) { args.push('--mode', 'module', '-p', `module=${modules.join(',')}`); }
    if (productName) { args.push('-p', `product=${productName}`, '-p', `buildMode=${buildMode}`); }
    return this.runHvigor(args);
  }

  public async test(kind: 'local' | 'instrument', modules: string[], scope: string[],
    coverage: boolean, asan = false, buildOnly = false): Promise<string> {
    const task = kind === 'local' ? buildOnly ? 'UnitTestBuild' : 'test' : 'onDeviceTest';
    const args = [task, '-p', `module=${modules.join(',')}`, '-p', `coverage=${coverage}`];
    if (scope.length) { args.push('-p', `scope=${scope.join(',')}`); }
    if (kind === 'instrument') { args.push('-p', `ohos-debug-asan=${asan}`); }
    return this.runHvigor(args);
  }

  public async buildProduct(
    productName: string,
    buildMode: string
  ): Promise<string> {
    const args: string[] = [
      'assembleApp',
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
    ];

    return this.runHvigor(args);
  }

  public async buildModules(
    productName: string,
    buildMode: string,
    modules: string[],
    moduleTasks: Set<string>
  ): Promise<string> {
    const args: string[] = [
      ...Array.from(moduleTasks),
      '--mode',
      'module',
      '-p',
      `module=${modules.join(',')}`,
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
    ];

    return this.runHvigor(args);
  }

  /**
   * 清理构建产物。--mode 默认 module（模块模式）；传 modules 时限定到指定模块。
   */
  public async clean(mode?: string, modules?: string[]): Promise<string> {
    const args: string[] = ['clean', '--mode', mode ?? DEFAULT_CLEAN_MODE];
    if (modules && modules.length > 0) {
      args.push('-p', `module=${modules.join(',')}`);
    }

    return this.runHvigor(args);
  }

  public async stopDaemon(): Promise<string> {
    return this.runHvigor(['--stop-daemon']);
  }

  public async ensureDaemonRunning(): Promise<void> {
    if (this.findProjectDaemon()) {
      debugLog('[HvigorAdapter] Daemon already running.');
      return;
    }
    debugLog(
      '[HvigorAdapter] No daemon running, starting via --sync --daemon (no hap build).'
    );
    await this.runHvigor(['--sync', '--daemon']);
  }

  public isDaemonRunning(projectRoot?: string): boolean {
    return this.findProjectDaemon(projectRoot) !== null;
  }

  public async isDaemonAlive(projectRoot?: string): Promise<boolean> {
    const daemon = this.findProjectDaemon(projectRoot);
    if (!daemon) {
      return false;
    }
    return this.isPortListening(daemon.port);
  }

  private isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  public findProjectDaemon(projectRoot?: string): DaemonInfo | null {
    const registryPath = this.getDaemonRegistryPath();
    if (!fs.existsSync(registryPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(registryPath, 'utf-8');
      const registry = JSON.parse(content) as Record<string, DaemonInfo>;
      const cwd = projectRoot ?? this.projectRoot;

      const alive = Object.values(registry).filter(
        (d) =>
          d.cwdPath === cwd &&
          (d.state === 'idle' ||
            d.state === 'half_busy' ||
            d.state === 'busy') &&
          this.isProcessAlive(d.pid)
      );

      return alive.length > 0 ? alive[alive.length - 1] : null;
    } catch {
      return null;
    }
  }

  private getDaemonRegistryPath(): string {
    const hvigorHome =
      process.env.HVIGOR_USER_HOME || path.join(os.homedir(), '.hvigor');
    return path.join(hvigorHome, 'daemon', 'cache', 'daemon-sec.json');
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 只触发 native（c/c++）编译，不生成 hap/har。
   */
  public async compileNative(
    productName: string,
    moduleName?: string
  ): Promise<string> {
    const args: string[] = ['--mode', 'module'];
    if (moduleName) {
      args.push('-p', `module=${moduleName}`);
    }
    args.push('-p', `product=${productName}`, 'compileNative');
    return this.runHvigor(args);
  }

  private async runHvigor(args: string[]): Promise<string> {
    if (this.executor) { await this.executor(args); return ''; }
    const cmd = this.toolProvider.nodePath;
    const cmdArgs = [this.toolProvider.hvigorJsPath, ...args];

    debugLog(`Executing: ${cmd} ${cmdArgs.join(' ')}`);

    const stdioOpt =
      this.silent && !process.env.DEVECO_CLI_DEBUG ? 'pipe' : 'inherit';

    const child = execa(cmd, cmdArgs, {
      cwd: this.projectRoot,
      env: this.env,
      stdout: stdioOpt,
      stderr: stdioOpt,
    });

    const tracker = !isTelemetryDisabled()
      ? startMemoryTracker(child.pid, 2000, true)
      : undefined;
    let peakMemoryMb = '';

    try {
      await child;
    } finally {
      if (tracker) {
        const peakBytes = await tracker.stop();
        if (peakBytes > 0) {
          peakMemoryMb = formatBytesMb(peakBytes);
          debugLog(`Hvigor peak memory: ${peakMemoryMb}`);
        }
      }
    }
    return peakMemoryMb;
  }
}
