/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMcpLogDirectory } from './common.js';

/** 活跃日志文件名 */
const ACTIVE_LOG_FILE_NAME = 'mcp-server.log';
/** 轮转日志文件名前缀 */
const ROTATED_LOG_FILE_PREFIX = 'mcp-server';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志轮转配置
 */
interface LogRotationOptions {
  /** 单个日志文件最大大小，默认 10MB */
  maxSize?: number;
  /** 保留的轮转日志文件最大数量，默认 4 个 */
  maxFiles?: number;
}

const DEFAULT_ROTATION_OPTIONS: LogRotationOptions = {
  maxSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 4,
};

/**
 * MCP Server Logger
 * - debug=true: 输出到 console.error (stderr)
 * - debug=false: 输出到文件（带轮转）
 */
class McpServerLogger {
  private fd: number | null = null;
  private logDir: string | null = null;
  private currentLogFile: string | null = null;
  private mode: 'file' | 'console' | 'silent';
  private rotationOptions: LogRotationOptions;
  private currentFileSize: number = 0;
  private currentDate: string = '';
  private isRotating: boolean = false;
  /** 最小输出级别：低于此级别的日志（如 debug）直接丢弃 */
  private readonly minLevel: LogLevel;
  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(debug: boolean, rotationOptions?: LogRotationOptions) {
    this.rotationOptions = { ...DEFAULT_ROTATION_OPTIONS, ...rotationOptions };
    // 默认（非 debug）只输出 info 及以上；debug 模式放行全部级别
    this.minLevel = debug ? 'debug' : 'info';

    if (debug) {
      // debug 模式：输出到 console
      this.mode = 'console';
      this.logDir = null;
      this.currentLogFile = null;
    } else {
      // 非 debug 模式：输出到文件
      this.mode = 'file';
      this.logDir = getMcpLogDirectory();
      this.currentLogFile = path.join(this.logDir, ACTIVE_LOG_FILE_NAME);

      // 确保日志目录存在
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // 启动时清理孤儿日志文件
      this.cleanupOrphanLogFiles();
      this.openLogFile();
    }
  }

  private getCurrentDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getRotatedFileName(date: string, index: number): string {
    return path.join(this.logDir!, `${ROTATED_LOG_FILE_PREFIX}-${date}.log.${index}`);
  }

  private fileExists(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private cleanupOrphanLogFiles(): void {
    if (!this.logDir) {
      return;
    }

    try {
      const files = fs.readdirSync(this.logDir);
      const logFiles: { name: string; mtime: Date; path: string }[] = [];

      for (const file of files) {
        if (file === ACTIVE_LOG_FILE_NAME || /^mcp-server-\d{4}-\d{2}-\d{2}\.log\.\d+$/.test(file)) {
          const filePath = path.join(this.logDir, file);
          const stat = fs.statSync(filePath);
          logFiles.push({ name: file, mtime: stat.mtime, path: filePath });
        }
      }

      logFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const maxTotalFiles = 1 + this.rotationOptions.maxFiles!;

      for (let i = maxTotalFiles; i < logFiles.length; i++) {
        try {
          fs.unlinkSync(logFiles[i].path);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  private rotateLog(): void {
    if (this.isRotating || !this.logDir || !this.currentLogFile) {
      return;
    }

    this.isRotating = true;

    try {
      this.closeLogFile();

      if (!this.fileExists(this.currentLogFile)) {
        this.isRotating = false;
        this.openLogFile();
        return;
      }

      const date = this.getCurrentDateString();

      // 删除最旧的日志文件
      const oldestFile = this.getRotatedFileName(date, this.rotationOptions.maxFiles!);
      if (this.fileExists(oldestFile)) {
        fs.unlinkSync(oldestFile);
      }

      // 重命名日志文件
      for (let i = this.rotationOptions.maxFiles! - 1; i >= 1; i--) {
        const currentName = this.getRotatedFileName(date, i);
        const nextName = this.getRotatedFileName(date, i + 1);
        if (this.fileExists(currentName)) {
          fs.renameSync(currentName, nextName);
        }
      }

      // 将当前日志重命名为 .log.1
      const firstRotatedFile = this.getRotatedFileName(date, 1);
      fs.renameSync(this.currentLogFile, firstRotatedFile);

      this.cleanupOrphanLogFiles();
      this.openLogFile();
    } catch {
      this.openLogFile();
    } finally {
      this.isRotating = false;
    }
  }

  private openLogFile(): void {
    if (!this.currentLogFile) {
      return;
    }

    this.currentDate = this.getCurrentDateString();

    try {
      if (this.fileExists(this.currentLogFile)) {
        const stat = fs.statSync(this.currentLogFile);
        this.currentFileSize = stat.size;
      } else {
        this.currentFileSize = 0;
      }
    } catch {
      this.currentFileSize = 0;
    }

    try {
      this.fd = fs.openSync(this.currentLogFile, 'a');
    } catch {
      this.fd = null;
    }
  }

  private closeLogFile(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }

  private checkRotation(dataLength: number): void {
    const newDate = this.getCurrentDateString();
    if (this.currentDate && this.currentDate !== newDate) {
      this.rotateLog();
      this.currentDate = newDate;
    }

    this.currentFileSize += dataLength;
    if (this.currentFileSize >= this.rotationOptions.maxSize!) {
      this.rotateLog();
    }
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    if (this.mode === 'silent') {
      return;
    }
    if (McpServerLogger.LEVEL_ORDER[level] < McpServerLogger.LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const formattedArgs = args.map(a =>
      a instanceof Error
        ? `${a.name}: ${a.message}`
        : typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
    ).join(' ');
    const fullMessage = formattedArgs ? `${message} ${formattedArgs}` : message;

    const timestamp = new Date().toLocaleString('sv-SE', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');

    const line = `[${timestamp}] [MCP/${level.toUpperCase()}] [pid=${process.pid}] ${fullMessage}\n`;

    if (this.mode === 'file' && this.currentLogFile) {
      if (this.fd === null) {
        this.openLogFile();
      }

      if (this.fd !== null) {
        try {
          const buf = Buffer.from(line);
          fs.writeSync(this.fd, buf);
          this.checkRotation(buf.byteLength);
        } catch {
          this.closeLogFile();
          this.openLogFile();
        }
      }
    } else if (this.mode === 'console') {
      process.stderr.write(line);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, ...args);
  }

  dispose(): void {
    this.closeLogFile();
  }

  flush(): void {
    if (this.mode !== 'file' || this.fd === null) {
      return;
    }
    try {
      fs.fsyncSync(this.fd);
    } catch {
      // ignore
    }
  }

  getLogFilePath(): string | null {
    return this.currentLogFile;
  }

  getLogDirectory(): string | null {
    return this.logDir;
  }
}

// 全局 logger 实例
let loggerInstance: McpServerLogger | null = null;

/**
 * 初始化 MCP Server Logger
 * @param debug - true: console 输出; false: 文件输出（带轮转）
 */
export function initMcpLogger(debug: boolean = false): void {
  if (loggerInstance) {
    loggerInstance.dispose();
  }
  loggerInstance = new McpServerLogger(debug);
}

/**
 * 关闭 Logger
 */
export function disposeMcpLogger(): void {
  if (loggerInstance) {
    loggerInstance.dispose();
    loggerInstance = null;
  }
}

/**
 * 刷新日志到磁盘
 */
export function flushMcpLogger(): void {
  if (loggerInstance) {
    loggerInstance.flush();
  }
}

/**
 * 获取日志文件路径
 */
export function getMcpLogFilePath(): string | null {
  return loggerInstance?.getLogFilePath() ?? null;
}

/**
 * 获取日志目录
 */
export function getMcpLogDir(): string | null {
  return loggerInstance?.getLogDirectory() ?? null;
}

/**
 * Logger 接口
 */
export interface McpLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 获取 Logger 实例
 */
export function getMcpLogger(): McpLogger {
  if (!loggerInstance) {
    // 默认初始化（非 debug 模式）
    initMcpLogger(false);
  }
  return loggerInstance!;
}

// 导出便捷方法
export const mcpLog = {
  debug: (message: string, ...args: unknown[]) => getMcpLogger().debug(message, ...args),
  info: (message: string, ...args: unknown[]) => getMcpLogger().info(message, ...args),
  warn: (message: string, ...args: unknown[]) => getMcpLogger().warn(message, ...args),
  error: (message: string, ...args: unknown[]) => getMcpLogger().error(message, ...args),
};