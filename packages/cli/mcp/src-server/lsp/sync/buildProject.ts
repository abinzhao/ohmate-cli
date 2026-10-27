/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { logger } from '../logger.js';

/** 构建结果 */
export interface BuildResult {
    success: boolean;
    output: string;
    exitCode: number;
}

const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

function buildCommand(
    nodePath: string,
    hvigorPath: string,
    hvigorArgs: string,
): [string, string[]] {
    const args = hvigorArgs.split(/\s+/).filter(arg => arg.length > 0);
    return [nodePath, [hvigorPath, ...args]];
}

function collectChildOutput(child: ChildProcess, onLine?: (line: string) => void): { stdout: string[]; stderr: string[]; flush: () => void } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (data: Buffer | string) => {
        const text = data.toString();
        stdout.push(text);
        stdoutBuf = flushOutputLines(stdoutBuf + text, onLine);
    });
    child.stderr?.on('data', (data: Buffer | string) => {
        const text = data.toString();
        stderr.push(text);
        stderrBuf = flushOutputLines(stderrBuf + text, (line) => {
            logger.info('[hvigor:err] %s', line);
            onLine?.(line);
        });
    });
    return {
        stdout,
        stderr,
        flush: () => {
            if (stdoutBuf) {
                onLine?.(stdoutBuf);
            }
            if (stderrBuf) {
                logger.info('[hvigor:err] %s', stderrBuf);
                onLine?.(stderrBuf);
            }
        },
    };
}

/** 将缓冲区按行拆分，完整行回调，末尾不完整部分保留返回。 */
function flushOutputLines(buf: string, onLine?: (line: string) => void): string {
    const lines = buf.split(/\r?\n/);
    const last = lines.pop() ?? '';
    for (const line of lines) {
        if (line) {
            onLine?.(line);
        }
    }
    return last;
}

function joinOutput(buffers: string[]): string {
    return buffers.join('');
}

function resolveBuildResult(code: number | null, signal: string | null, output: string): BuildResult {
    if (signal) {
        const msg = 'Build process killed by signal ' + signal + '.\nOutput so far:\n' + output;
        return { success: false, output: msg, exitCode: -1 };
    }
    const exitCode = code ?? -1;
    return { success: exitCode === 0, output, exitCode };
}

function spawnBuildProcess(
    cmdParts: [string, string[]],
    projectPath: string,
    env: Record<string, string>,
    onLine?: (line: string) => void,
): Promise<BuildResult> {
    return new Promise<BuildResult>((resolve) => {
        const child = spawn(cmdParts[0], cmdParts[1], {
            cwd: projectPath,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const { stdout, stderr, flush } = collectChildOutput(child, onLine);

        const timeout = setTimeout(() => {
            child.kill();
            flush();
            const output = [joinOutput(stdout), joinOutput(stderr)].filter(Boolean).join('\n').trim();
            resolve({
                success: false,
                output: 'Build process timeout after 10 minutes.\nOutput so far:\n' + output,
                exitCode: -1,
            });
        }, BUILD_TIMEOUT_MS);

        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            flush();
            const output = [joinOutput(stdout), joinOutput(stderr)].filter(Boolean).join('\n').trim() || '';
            resolve(resolveBuildResult(code, signal, output));
        });

        child.on('error', (err: Error) => {
            clearTimeout(timeout);
            resolve({ success: false, output: `Build execution exception: ${err.message}`, exitCode: -1 });
        });
    });
}

/**
 * 执行构建命令（异步，不阻塞事件循环）
 */
export async function executeBuildCommand(
    projectPath: string,
    nodePath: string,
    hvigorPath: string,
    sdkPath: string,
    hvigorArgs: string,
    onLine?: (line: string) => void,
): Promise<BuildResult> {
    const env = { ...process.env, DEVECO_SDK_HOME: sdkPath };
    const cmdParts = buildCommand(nodePath, hvigorPath, hvigorArgs);
    return await spawnBuildProcess(cmdParts, projectPath, env, onLine);
}

function getEnvConfig(sdkPath: string, nodePath: string, hvigorJsPath: string): Record<string, string> {
    return {
        node_path: nodePath,
        hvigor_path: hvigorJsPath,
        sdk_path: sdkPath,
    };
}

function validateConfig(config: Record<string, string>): string | null {
    if (!config.node_path || !fs.existsSync(config.node_path)) {
        return `Node path not found or invalid: ${config.node_path}`;
    }
    if (!config.hvigor_path || !fs.existsSync(config.hvigor_path)) {
        return `Hvigor path not found or invalid: ${config.hvigor_path}`;
    }
    if (!config.sdk_path || !fs.existsSync(config.sdk_path)) {
        return `SDK path not found or invalid: ${config.sdk_path}`;
    }
    return null;
}

const DEFAULT_HVIGOR_ARGS = '--sync -p product=default';

/**
 * 同步工程：校验配置后执行 hvigor 构建（异步，不阻塞事件循环）
 */
export async function syncProject(
    projectPath: string,
    sdkPath: string,
    nodePath: string,
    hvigorJsPath: string,
    onLine?: (line: string) => void,
): Promise<boolean> {
    try {
        const config = getEnvConfig(sdkPath, nodePath, hvigorJsPath);
        const validation = validateConfig(config);
        if (validation != null) {
            logger.info(`Config validation failed: ${validation}`);
            return false;
        }
        const buildResult = await executeBuildCommand(
            projectPath,
            config.node_path,
            config.hvigor_path,
            sdkPath,
            DEFAULT_HVIGOR_ARGS,
            onLine,
        );
        logger.info(`[hvigor] sync finished: success=${buildResult.success}, exitCode=${buildResult.exitCode}`);
        return buildResult.success;
    } catch (e) {
        logger.info(`syncProject failed: ${JSON.stringify(e)}`);
        return false;
    }
}