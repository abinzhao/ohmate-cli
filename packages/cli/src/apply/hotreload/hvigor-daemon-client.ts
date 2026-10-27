/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'path';
import os from 'os';
import type { Socket } from 'socket.io-client';
import { ToolProvider } from '../../toolchain';

const STATIC_COMPONENT = new Int8Array([
  49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119,
]);

interface DaemonInfo {
  pid: number;
  state: string;
  cwdPath: string;
  port: number;
  sessionId?: string;
}

interface BuildMessage {
  status: string;
  exitCode?: number;
  reason?: string;
}

interface OutputMessage {
  type: string;
  text: string | Uint8Array;
  encoding?: BufferEncoding;
}

export class HvigorDaemonClient {
  private readonly projectRoot: string;
  private toolProvider: ToolProvider;
  private cachedSocket: Socket | null = null;
  private cachedDaemonPort: number = 0;

  constructor(projectRoot: string, toolProvider: ToolProvider) {
    this.projectRoot = projectRoot;
    this.toolProvider = toolProvider;
  }

  public async sendHotCompile(options: {
    moduleSpecs: string[];
    productName: string;
  }): Promise<number> {
    await this.waitForDaemonReady();

    const daemon = this.findProjectDaemon();
    if (!daemon?.sessionId) {
      throw new Error(
        'No running hvigor daemon with sessionId found. Run `devecocli run --hotreload` first.'
      );
    }

    return this.sendViaSocket(daemon, options);
  }

  public async startWatchSession(options: {
    moduleSpecs: string[];
    productName: string;
  }): Promise<void> {
    await this.waitForDaemonReady();
    console.log(
      `[DaemonClient] Compiling, build with: ${JSON.stringify(options)}`
    );

    const daemon = this.findProjectDaemon();
    if (!daemon?.sessionId) {
      throw new Error(
        'No running hvigor daemon with sessionId found. Build the hap first.'
      );
    }

    const socket = await this.getOrCreateSocket(daemon);

    // Persist a WatchLog/WatchResult listener for the lifetime of the watch
    // session (NOT removed after the initial build). The apply's --hot-compile
    // routes its ArkTS compile output/errors via WatchLog to THIS socket (the
    // watch session that owns the worker). WatchLog is too noisy to stream to
    // console — buffer the FULL current compile session in memory and flush it
    // to the file on each WatchResult (the session boundary), overwriting the
    // previous session so the file stays bounded to one segment. The buffer is
    // cleared after each flush, ready for the next compile session. A generous
    // line cap guards against pathological growth (WatchResult never arriving);
    // when exceeded the EARLIEST lines are dropped first so the tail — where
    // compile errors live — is always preserved for readWatchLogTail.
    const watchLogPath = this.watchLogPath;
    fs.mkdirSync(path.dirname(watchLogPath), { recursive: true });
    fs.writeFileSync(watchLogPath, '');
    const watchLogBuffer = this.createWatchLogBuffer(watchLogPath);
    socket.on('WatchLog', watchLogBuffer.onWatchLog);
    socket.on('WatchResult', watchLogBuffer.onWatchResult);

    await this.awaitInitialBuild(socket, options);
  }

  private createWatchLogBuffer(watchLogPath: string) {
    const WATCH_LOG_BUFFER_MAX = 100;
    const buffer: string[] = [];
    const onWatchLog = (msg: unknown) => {
      const text = HvigorDaemonClient.extractText(msg);
      if (!text.trim()) {
        return;
      }
      buffer.push(text.endsWith('\n') ? text : text + '\n');
      if (buffer.length > WATCH_LOG_BUFFER_MAX) {
        buffer.shift();
      }
    };
    const onWatchResult = (msg: unknown) => {
      const text = HvigorDaemonClient.extractText(msg);
      if (!text.trim()) {
        return;
      }
      const line = `[WatchResult] ${text}`;
      console.log(line);
      fs.writeFileSync(watchLogPath, [...buffer, line + '\n'].join(''));
      buffer.length = 0;
    };
    return { onWatchLog, onWatchResult };
  }

  private awaitInitialBuild(
    socket: Socket,
    options: { moduleSpecs: string[]; productName: string }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onOutput = this.createOutputHandler();
      const onBuildStatus = (msg: BuildMessage) => {
        if (!msg?.status || settled) {
          return;
        }
        if (msg.status === 'finish') {
          settled = true;
          socket.off('disconnect', onDisconnect);
          socket.off('Output', onOutput);
          socket.off('BuildStatus', onBuildStatus);
          resolve();
        } else if (msg.status === 'reject' || msg.status === 'close') {
          settled = true;
          socket.off('disconnect', onDisconnect);
          socket.off('Output', onOutput);
          socket.off('BuildStatus', onBuildStatus);
          this.invalidateSocket();
          reject(new Error(msg.reason || `Watch-session build ${msg.status}`));
        }
      };
      const onDisconnect = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`Socket disconnected: ${reason}`));
      };
      socket.on('disconnect', onDisconnect);
      socket.on('Output', onOutput);
      socket.on('BuildStatus', onBuildStatus);
      socket.emit('CommonBuild', this.buildStartOptions(options));
      console.log('[DaemonClient] Compiling, waiting for build to finish...');
    });
  }

  public getWatchLogPath(): string {
    return this.watchLogPath;
  }

  private get watchLogPath(): string {
    return path.join(this.projectRoot, '.hvigor', 'hotreload-watch.log');
  }

  private buildStartOptions(options: {
    moduleSpecs: string[];
    productName: string;
  }) {
    const opts = {
      _: ['assembleHap'],
      daemon: true,
      watch: true,
      hotReloadBuild: true,
      mode: 'module',
      prop: [
        `module=${options.moduleSpecs.join(',')}`,
        `product=${options.productName}`,
        'debuggable=true',
        'hotReload=true',
        'requiredDeviceType=phone',
      ],
      parallel: true,
      incremental: true,
      analyze: 'normal',
      env: {
        DEVECO_SDK_HOME: this.toolProvider.sdkPath,
      },
    };
    console.log(
      '[DaemonClient] buildStartOptions:',
      JSON.stringify(opts, null, 2)
    );
    return opts;
  }

  public disconnect(): void {
    this.invalidateSocket();
  }

  public onSocketDisconnect(callback: () => void): void {
    if (this.cachedSocket) {
      this.cachedSocket.on('disconnect', callback);
    }
  }

  private async getOrCreateSocket(daemon: DaemonInfo): Promise<Socket> {
    if (this.cachedSocket && this.cachedDaemonPort === daemon.port) {
      if (this.cachedSocket.connected) {
        return this.cachedSocket;
      }
      this.invalidateSocket();
    }

    const sessionId = this.decryptSessionId(daemon.sessionId!);
    console.log(
      `[DaemonClient] Socket.IO connect: ws://127.0.0.1:${daemon.port} (${daemon.state})`
    );

    // Loaded on demand; daemon transport is only needed by an active apply session.
    const { io } = await import('socket.io-client');
    const socket = io(`ws://127.0.0.1:${daemon.port}`, {
      transports: ['websocket'],
      path: `/${sessionId}`,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Socket connect timeout (10s)'));
      }, 10_000);

      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });

      socket.once('connect_error', (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Socket connect error: ${err.message}`));
      });
    });

    this.cachedSocket = socket;
    this.cachedDaemonPort = daemon.port;
    return socket;
  }

  private invalidateSocket(): void {
    if (this.cachedSocket) {
      this.cachedSocket.removeAllListeners();
      this.cachedSocket.disconnect();
      this.cachedSocket = null;
      this.cachedDaemonPort = 0;
    }
  }

  private async sendViaSocket(
    daemon: DaemonInfo,
    options: { moduleSpecs: string[]; productName: string }
  ): Promise<number> {
    const socket = await this.getOrCreateSocket(daemon);

    return new Promise((resolve, reject) => {
      let settled = false;
      const tAbcCompileStart = Date.now();

      const handlers = this.createHotCompileHandlers(
        socket,
        () => settled,
        (v: boolean) => (settled = v),
        reject
      );
      const onBuildStatus = (msg: BuildMessage) => {
        if (!msg?.status || settled) {
          return;
        }
        if (msg.status === 'finish') {
          settled = true;
          handlers.detach();
          socket.off('BuildStatus', onBuildStatus);
          console.log(
            `[Timing] abc compile: ${Date.now() - tAbcCompileStart}ms`
          );
          resolve(msg.exitCode ?? 0);
        } else if (msg.status === 'reject' || msg.status === 'close') {
          settled = true;
          handlers.detach();
          socket.off('BuildStatus', onBuildStatus);
          this.invalidateSocket();
          reject(
            new Error(`Hot compile ${msg.status}: ${msg.reason || 'see WatchLog/Output above for compile errors'}`)
          );
        }
      };

      socket.on('disconnect', handlers.onDisconnect);
      socket.on('Output', handlers.onOutput);
      socket.on('BuildStatus', onBuildStatus);
      socket.on('WatchLog', handlers.onWatchLog);
      socket.on('WatchResult', handlers.onWatchResult);
      socket.on('WatchCompileResult', handlers.onWatchCompileResult);
      socket.on('WatchCompileData', handlers.onWatchCompileData);
      socket.emit('CommonBuild', this.buildCompileOptions(options));
      console.log(
        '[DaemonClient] Compiling, waiting for hot compile to finish...'
      );
    });
  }

  private static extractText(msg: unknown): string {
    if (msg == null) {
      return '';
    }
    if (typeof msg === 'string') {
      return msg;
    }
    if (typeof msg === 'object') {
      const obj = msg as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        return obj.text;
      }
      if (typeof obj.msg === 'string') {
        return obj.msg;
      }
      if (typeof obj.message === 'string') {
        return obj.message;
      }
    }
    return JSON.stringify(msg);
  }

  private createHotCompileHandlers(
    socket: Socket,
    isSettled: () => boolean,
    setSettled: (v: boolean) => void,
    onDisconnectError: (err: Error) => void
  ): {
    onDisconnect: (reason: string) => void;
    onOutput: (msg: OutputMessage) => void;
    onWatchLog: (msg: unknown) => void;
    onWatchResult: (msg: unknown) => void;
    onWatchCompileResult: (msg: unknown) => void;
    onWatchCompileData: (msg: unknown) => void;
    detach: () => void;
  } {
    const onDisconnect = (reason: string) => {
      if (isSettled()) {
        return;
      }
      setSettled(true);
      detach();
      this.invalidateSocket();
      onDisconnectError(new Error(`Socket disconnected: ${reason}`));
    };
    const onOutput = this.createOutputHandler();
    const { onWatchLog, onWatchResult, onWatchCompileResult, onWatchCompileData } = this.getDataHandler();
    const detach = (): void => {
      socket.off('disconnect', onDisconnect);
      socket.off('Output', onOutput);
      socket.off('WatchLog', onWatchLog);
      socket.off('WatchResult', onWatchResult);
      socket.off('WatchCompileResult', onWatchCompileResult);
      socket.off('WatchCompileData', onWatchCompileData);
    };
    return {
      onDisconnect,
      onOutput,
      onWatchLog,
      onWatchResult,
      onWatchCompileResult,
      onWatchCompileData,
      detach,
    };
  }

  private getDataHandler() {
    const extractText = HvigorDaemonClient.extractText;
    const onWatchLog = (msg: unknown) => {
      const text = extractText(msg);
      if (text.trim()) {
        process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
      }
    };
    const onWatchResult = (msg: unknown) => {
      const text = extractText(msg);
      if (text.trim()) {
        console.log(`[WatchResult] ${text}`);
      }
    };
    const onWatchCompileResult = (msg: unknown) => {
      const text = extractText(msg);
      if (text.trim()) {
        console.log(`[WatchCompileResult] ${text}`);
      }
    };
    const onWatchCompileData = (msg: unknown) => {
      const text = extractText(msg);
      if (text.trim()) {
        console.log(`[WatchCompileData] ${text}`);
      }
    };
    return { onWatchLog, onWatchResult, onWatchCompileResult, onWatchCompileData };
  }

  private createOutputHandler(): (msg: OutputMessage) => void {
    return (msg: OutputMessage) => {
      const text =
        typeof msg.text === 'string'
          ? msg.text
          : Buffer.from(msg.text).toString(msg.encoding ?? 'utf-8');
      if (text.trim()) {
        if (msg.type === 'stderr') {
          process.stderr.write(text);
        } else {
          process.stdout.write(text);
        }
      }
    };
  }

  private buildCompileOptions(options: {
    moduleSpecs: string[];
    productName: string;
  }) {
    const opts = {
      _: ['assembleDevHqf'],
      daemon: true,
      hotCompile: true,
      mode: 'module',
      prop: [
        `module=${options.moduleSpecs.join(',')}`,
        `product=${options.productName}`,
        'debuggable=true',
        'hotReload=true',
        'requiredDeviceType=phone',
      ],
      parallel: true,
      incremental: true,
      analyze: 'normal',
      env: {
        DEVECO_SDK_HOME: this.toolProvider.sdkPath,
      },
    };
    console.log(
      '[DaemonClient] buildCompileOptions:',
      JSON.stringify(opts, null, 2)
    );
    return opts;
  }

  private async waitForDaemonReady(): Promise<void> {
    const maxWaitMs = 30_000;
    const pollIntervalMs = 1_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const daemon = this.findProjectDaemon();
      if (daemon && (daemon.state === 'half_busy' || daemon.state === 'idle')) {
        return;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      'No running hvigor daemon found. Run `devecocli run --hotreload` first.'
    );
  }

  public findProjectDaemon(): DaemonInfo | null {
    const registryPath = this.getRegistryPath();
    if (!fs.existsSync(registryPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(registryPath, 'utf-8');
      const registry = JSON.parse(content) as Record<string, DaemonInfo>;

      const alive = Object.values(registry).filter(
        (d) =>
          d.cwdPath === this.projectRoot &&
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

  private decryptSessionId(encryptedHex: string): string {
    const metaDir = this.getMetaDir();

    const fdDir = path.join(metaDir, 'fd');
    const acDir = path.join(metaDir, 'ac');
    const ceDir = path.join(metaDir, 'ce');

    const components = this.readComponents(fdDir);
    const xorResult = this.xorBuffers([
      components[0],
      components[1],
      components[2],
      Buffer.from(STATIC_COMPONENT),
    ]);

    const salt = this.readSingleFile(acDir);
    const rootKey = crypto.pbkdf2Sync(
      Buffer.from(xorResult).toString(),
      salt,
      10000,
      16,
      'sha256'
    );

    const encryptedWorkKey = this.readSingleFile(ceDir);
    const workKey = this.aesGcmDecrypt(rootKey, encryptedWorkKey);

    const encrypted = Buffer.from(encryptedHex, 'hex');
    return this.aesGcmDecrypt(workKey, encrypted).toString('utf-8');
  }

  private aesGcmDecrypt(key: Buffer, data: Buffer): Buffer {
    let offset = 0;
    const contentLength = data.readUInt32BE(offset);
    offset += 4;

    const iv = data.subarray(offset, offset + 12);
    offset += 12;

    const ciphertextLen = contentLength - 16;
    const ciphertext = data.subarray(offset, offset + ciphertextLen);
    offset += ciphertextLen;

    const authTag = data.subarray(offset, offset + 16);

    const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private readComponents(fdDir: string): Buffer[] {
    const subdirs = fs
      .readdirSync(fdDir)
      .map((name) => path.join(fdDir, name))
      .filter((p) => fs.statSync(p).isDirectory())
      .sort();

    if (subdirs.length < 3) {
      throw new Error(
        `Expected 3 subdirectories in ${fdDir}, found ${subdirs.length}`
      );
    }

    return subdirs.slice(0, 3).map((dir) => {
      const files = fs.readdirSync(dir);
      if (files.length === 0) {
        throw new Error(`No file in ${dir}`);
      }
      return fs.readFileSync(path.join(dir, files[0]));
    });
  }

  private readSingleFile(dir: string): Buffer {
    const files = fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((p) => fs.statSync(p).isFile());

    if (files.length === 0) {
      throw new Error(`No file in ${dir}`);
    }
    return fs.readFileSync(files[0]);
  }

  private xorBuffers(buffers: Buffer[]): Buffer {
    const result = Buffer.alloc(buffers[0].length);
    result.set(buffers[0]);
    for (let i = 1; i < buffers.length; i++) {
      const buf = Buffer.isBuffer(buffers[i])
        ? buffers[i]
        : Buffer.from(buffers[i]);
      for (let j = 0; j < result.length; j++) {
        result[j] ^= buf[j];
      }
    }
    return result;
  }

  private getRegistryPath(): string {
    const hvigorHome =
      process.env.HVIGOR_USER_HOME || path.join(os.homedir(), '.hvigor');
    return path.join(hvigorHome, 'daemon', 'cache', 'daemon-sec.json');
  }

  private getMetaDir(): string {
    const hvigorHome =
      process.env.HVIGOR_USER_HOME || path.join(os.homedir(), '.hvigor');
    return path.join(hvigorHome, 'meta');
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
