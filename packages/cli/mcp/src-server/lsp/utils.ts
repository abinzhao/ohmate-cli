/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';
import {
    SERVER_MAX_SIZE_BASE_MB,
    SERVER_MAX_SIZE_MODULE_THRESHOLD,
    SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB,
    SERVER_MAX_SIZE_PHYSICAL_CAP_RATIO,
} from './constant.js';
import { logger } from './logger.js';

export function findJsonObject(filePath: string): unknown | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) {
            return null;
        }
        return JSON5.parse(content);
    } catch {
        return null;
    }
}

/**
 * 动态计算 LSP 进程的 --max-old-space-size（单位 MB）。
 *
 * 规则：
 * - 模块数 <= 100：默认 8192 MB (8 GB)
 * - 模块数  > 100：8 GB + (模块数 - 100) * 0.03 GB
 * - 上限为机器物理内存的 70%
 *
 * 当 overrideSize 为有效正数时（来自环境变量 NODE_MAX_OLD_SPACE_SIZE 的显式覆盖），
 * 以该值为基础计算，但同样不得高于物理内存的 70%。
 */
export function computeLspServerMaxSize(moduleCount: number, overrideSize?: number): number {
    const physicalTotalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const physicalCapMb = Math.floor(physicalTotalMb * SERVER_MAX_SIZE_PHYSICAL_CAP_RATIO);

    let sizeMb: number;
    let source: string;
    if (overrideSize !== undefined && Number.isFinite(overrideSize) && overrideSize > 0) {
        sizeMb = overrideSize;
        source = `override(${overrideSize})`;
    } else {
        sizeMb = SERVER_MAX_SIZE_BASE_MB;
        if (moduleCount > SERVER_MAX_SIZE_MODULE_THRESHOLD) {
            sizeMb +=
                (moduleCount - SERVER_MAX_SIZE_MODULE_THRESHOLD) *
                SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB *
                1024;
        }
        source = `formula(moduleCount=${moduleCount})`;
    }

    const capped = physicalCapMb > 0 && sizeMb > physicalCapMb;
    if (capped) {
        sizeMb = physicalCapMb;
    }
    const finalSizeMb = Math.round(sizeMb);
    logger.info(
        `[computeLspServerMaxSize] source=${source}, physicalTotal=${physicalTotalMb}MB, physicalCap(70%)=${physicalCapMb}MB, finalSize=${finalSizeMb}MB${capped ? ' (capped)' : ''}`,
    );
    return finalSizeMb;
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export function toFileUri(filePath: string): string {
    if (filePath.startsWith('file:')) {
        return filePath;
    }
    try {
        const absPath = path.resolve(filePath);
        let uriStr = new URL(`file://${absPath}`).toString();

        if (os.platform() === 'win32') {
            const match = uriStr.match(/^file:\/\/\/([A-Za-z]):/);
            if (match) {
                const driveLetter = match[1].toUpperCase();
                const rest = uriStr.substring(`file:///${match[1]}:`.length);
                uriStr = `file:///${driveLetter}%3A${rest}`;
            }
        }
        return uriStr;
    } catch {
        return filePath;
    }
}

export function normalizePath(p: string): string {
    if (!p) {
        return p;
    }
    return p.replace(/\\/g, '/');
}

export function toUnixPath(p: string): string {
    let normalized = path.normalize(p).replace(/\\/g, '/');
    if (os.platform() === 'win32') {
        // 匹配盘符 C: → 转为大写
        const match = normalized.match(/^([A-Za-z]):/);
        if (match) {
            const drive = match[1].toUpperCase();
            normalized = `${drive}:${normalized.substring(2)}`;
        }
    }
    return normalized;
}

/**
 * 解析用于 spawn ace-server 的 node 可执行文件路径。
 * 优先用工具链 bundled node（toolProvider.nodePath），未注入时回退 process.execPath。
 */
export function resolveNodePath(nodePath?: string): string {
    return nodePath || process.execPath || 'node';
}

/** buildAceServerArgs 的可选参数。 */
export interface AceServerArgsOptions {
    /** ace-server 入口 js 路径。 */
    serverPath: string;
    /** LSP 日志目录（原始路径，函数内部转 unix）。 */
    lspLogPath: string;
    /** --max-old-space-size 值（MB）。 */
    serverMaxSize: number;
    /** 传输模式 flag，默认 '--stdio'。socket 模式传 '--scope=multi'。 */
    transportFlag?: string;
    /** 工程根路径；非空时追加 --projectPath。 */
    projectPath?: string;
    /** SDK 根路径；非空时追加 --sdkPath。 */
    sdkPath?: string;
}

/**
 * 构造 spawn ace-server 的完整参数数组（server 入口 + 传输 flag + 日志参数 + 可选 --projectPath / --sdkPath）。
 * 供 LspClient（stdio / socket）与 serve-lsp 命令共用，保证参数一致。
 */
export function buildAceServerArgs(options: AceServerArgsOptions): string[] {
    const lspPathStr = toUnixPath(options.lspLogPath);
    const args = [
        '--expose-gc',
        `--max-old-space-size=${options.serverMaxSize}`,
        '--report-on-fatalerror',
        '--report-uncaught-exception',
        `--report-filename=nodejs_error_${Date.now()}.txt`,
        `--report-dir=${lspPathStr}`,
        options.serverPath,
        options.transportFlag ?? '--stdio',
        `--logger-path=${lspPathStr}`,
        '--logger-level=TRACE',
    ];
    if (options.projectPath) {
        args.push(`--projectPath=${toUnixPath(options.projectPath)}`);
    }
    if (options.sdkPath) {
        args.push(`--sdkPath=${toUnixPath(options.sdkPath)}`);
    }
    return args;
}

export function isSdkValid(sdkPath: string | undefined): boolean {
    if (!sdkPath || typeof sdkPath !== 'string') {
        return false;
    }

    const normalizedSdkPath = normalizePath(sdkPath);

    try {
        if (!fs.existsSync(normalizedSdkPath)) {
            return false;
        }
        const stats = fs.lstatSync(normalizedSdkPath);
        if (!stats.isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    const defaultDir = path.join(normalizedSdkPath, 'default');
    const sdkPkgPath = path.join(defaultDir, 'sdk-pkg.json');

    try {
        if (!fs.existsSync(defaultDir)) {
            return false;
        }
        const defaultStats = fs.lstatSync(defaultDir);
        if (!defaultStats.isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    try {
        if (!fs.existsSync(sdkPkgPath)) {
            return false;
        }
        const pkgStats = fs.lstatSync(sdkPkgPath);
        if (!pkgStats.isFile()) {
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

export function getOsType(): string {
    const p = process.platform;
    if (p === 'win32') {
        return 'Windows';
    }
    if (p === 'darwin') {
        return 'Mac';
    }
    return 'Linux';
}

/**
 * 获取 build-profile.json5 的路径
 */
export function getBuildProfilePath(profilePath: string): string {
    return path.join(profilePath, 'build-profile.json5');
}
