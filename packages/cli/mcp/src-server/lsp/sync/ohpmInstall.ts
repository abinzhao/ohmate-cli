/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import { logger } from '../logger.js';

const OHPM_ARGS = ['install', '--all'];

/** 将缓冲区按行拆分，完整行立即 log 并回调，末尾不完整部分保留返回。 */
function flushLines(buf: string, onLine?: (line: string) => void): string {
    const lines = buf.split(/\r?\n/);
    const last = lines.pop() ?? '';
    for (const line of lines) {
        if (line) {
            logger.info('[ohpm] %s', line);
            onLine?.(line);
        }
    }
    return last;
}

async function runOhpmCommand(
    nodePath: string,
    ohpmJsPath: string,
    projectPath: string,
    sdkPath: string,
    onLine?: (line: string) => void,
): Promise<{ exitCode: number }> {
    return new Promise<{ exitCode: number }>((resolve) => {
        logger.info('[ohpm] spawning: %s %s %s, cwd=%s', nodePath, ohpmJsPath, OHPM_ARGS.join(' '), projectPath);

        const child = spawn(nodePath, [ohpmJsPath, ...OHPM_ARGS], {
            cwd: projectPath,
            env: { ...process.env, DEVECO_SDK_HOME: sdkPath },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let stderrBuf = '';

        child.stdout?.on('data', (data: Buffer | string) => {
            stdoutBuf = flushLines(stdoutBuf + data.toString(), onLine);
        });
        child.stderr?.on('data', (data: Buffer | string) => {
            stderrBuf = flushLines(stderrBuf + data.toString(), onLine);
        });

        child.on('close', (code: number | null) => {
            if (stdoutBuf) {
                logger.info('[ohpm] %s', stdoutBuf);
                onLine?.(stdoutBuf);
            }
            if (stderrBuf) {
                logger.info('[ohpm] %s', stderrBuf);
                onLine?.(stderrBuf);
            }
            logger.info('[ohpm] process exited, code=%s', code);
            resolve({ exitCode: code ?? -1 });
        });

        child.on('error', (err: Error) => {
            logger.error('[ohpm] process error: %s', err.message);
            resolve({ exitCode: -1 });
        });
    });
}

/**
 * 安装所有依赖（异步，不阻塞事件循环）。stdout/stderr 流式实时输出到日志。
 * @param projectPath 项目路径
 * @param sdk DevEco SDK 路径
 * @param nodePath 启动期由 ToolProvider 解析固定的 node 可执行文件路径
 * @param ohpmJsPath 启动期由 ToolProvider 解析固定的 ohpm pm-cli.js 路径
 * @returns 是否成功
 */
export async function ohpmInstallAll(
    projectPath: string,
    sdk: string,
    nodePath: string,
    ohpmJsPath: string,
    onLine?: (line: string) => void,
): Promise<boolean> {
    try {
        if (!nodePath) {
            logger.error('node 路径不存在');
            return false;
        }
        if (!ohpmJsPath) {
            logger.error('ohpm (pm-cli.js) 不存在');
            return false;
        }

        const { exitCode } = await runOhpmCommand(nodePath, ohpmJsPath, projectPath, sdk, onLine);

        if (exitCode === 0) {
            logger.info('ohpm 安装成功');
            return true;
        }
        logger.error('ohpm 安装失败，退出码: %s', exitCode);
        return false;
    } catch (e) {
        logger.error('ohpm 安装异常', e as Error);
        return false;
    }
}
