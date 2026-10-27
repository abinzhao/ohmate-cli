/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { debugLog } from './logger.js';
import { ProjectConstants } from '../config/constants.js';

/**
 * mtime 容差（毫秒）。部分文件系统（FAT32、网络挂载）的 mtime 精度为 2s，引入 1s 容差避免误判。
 */
const MTIME_TOLERANCE_MS = 1000;

/** sync 必要性检查结果 */
export interface SyncCheckResult {
    required: boolean;
    reason: string;
}

interface ModuleEntry {
    name: string;
    srcPath: string;
}

/**
 * 判断是否需要执行 hvigor sync
 *
 * 核心逻辑：
 *   取 .hvigor/outputs/sync/output.json 的 mtime 作为 sync 基准时间戳
 *   该文件每次 sync 必定会被更新，跨平台（Windows / macOS）行为一致
 *   逐一比对各源 oh-package.json5 的 mtime 是否晚于该基准
 *
 * @param projectRoot 项目根目录
 */
/** compareWithBaseline + required 检查的 helper：变了就返回 result，没变返回 null。 */
function checkIfNewer(
    filePath: string,
    syncBaseline: number,
    label: string,
): SyncCheckResult | null {
    const result = compareWithBaseline(filePath, syncBaseline, label);
    if (result.required) {
        debugLog(`[ProjectCheck] ${label} check: ${result.reason}`);
        return result;
    }
    return null;
}

export function checkSyncRequired(projectRoot: string): SyncCheckResult {
    debugLog(`[ProjectCheck] Checking sync required at project root: ${projectRoot}`);
    // 取 sync 基准时间戳
    const baselineFile = path.join(projectRoot, ProjectConstants.SYNC_OUTPUT_PATH);
    if (!fs.existsSync(baselineFile)) {
        const result = { required: true, reason: `sync baseline file not found: ${baselineFile}` };
        debugLog(`[ProjectCheck] ${result.reason}`);
        return result;
    }
    const syncBaseline = fs.statSync(baselineFile).mtimeMs;
    // oh_modules lock 不存在 → 依赖缺失，必须重新 install
    const lockFile = path.join(projectRoot, ProjectConstants.LOCK_JSON5_PATH);
    if (!fs.existsSync(lockFile)) {
        const result = { required: true, reason: `oh_modules lock not found: ${lockFile}` };
        debugLog(`[ProjectCheck] ${result.reason}`);
        return result;
    }
    const modules = parseModules(projectRoot);
    if (modules === null) {
        return { required: true, reason: 'failed to parse build-profile.json5' };
    }
    let r: SyncCheckResult | null = checkIfNewer(path.join(projectRoot, ProjectConstants.OH_PACKAGE_JSON5), syncBaseline, 'root');
    if (r) {
        return r;
    }
    r = checkIfNewer(path.join(projectRoot, ProjectConstants.BUILD_PROFILE_JSON5), syncBaseline, 'build-profile');
    if (r) {
        return r;
    }
    r = checkIfNewer(path.join(projectRoot, ProjectConstants.HVIGOR_CONFIG), syncBaseline, 'hvigor-config');
    if (r) {
        return r;
    }
    r = checkIfNewer(path.join(projectRoot, ProjectConstants.HVIGOR_CONFIG), syncBaseline, 'hvigor-config');
    if (r) {
        return r;
    }
    for (const mod of modules) {
        r = checkIfNewer(path.join(projectRoot, mod.srcPath, ProjectConstants.OH_PACKAGE_JSON5), syncBaseline, mod.name);
        if (r) {
            return r;
        }
        r = checkIfNewer(path.join(projectRoot, mod.srcPath, ProjectConstants.BUILD_PROFILE_JSON5), syncBaseline, mod.name);
        if (r) {
            return r;
        }
    }

    const reason = `all configuration files are up-to-date (sync baseline: ${new Date(syncBaseline).toISOString()})`;
    debugLog(`[ProjectCheck] ${reason}`);
    return { required: false, reason };
}

/**
 * 比对单个源文件 mtime 与 sync 基准时间戳。
 * 源文件不存在时跳过（返回 required=false），不视为需要 sync。
 */
function compareWithBaseline(
    srcPath: string,
    syncBaseline: number,
    label: string,
): SyncCheckResult {
    if (!fs.existsSync(srcPath)) {
        return { required: false, reason: `${label}: source not found, skip` };
    }

    const srcMtime = fs.statSync(srcPath).mtimeMs;

    if ((srcMtime - syncBaseline) > MTIME_TOLERANCE_MS) {
        return {
            required: true,
            reason:
                `${label}: source mtime (${new Date(srcMtime).toISOString()}) ` +
                `is newer than sync baseline (${new Date(syncBaseline).toISOString()})`,
        };
    }

    return { required: false, reason: `${label}: up-to-date` };
}

function parseModules(projectRoot: string): ModuleEntry[] | null {
    const buildProfilePath = path.join(projectRoot, ProjectConstants.BUILD_PROFILE_JSON5);
    try {
        const content = fs.readFileSync(buildProfilePath, 'utf-8');
        if (!content.trim()) {
            return null;
        }
        const obj = json5.parse(content);
        if (typeof obj !== 'object' || obj === null) {
            return null;
        }
        const modules = (obj as Record<string, unknown>).modules;
        if (!Array.isArray(modules)) {
            return null;
        }
        return modules.filter((m): m is ModuleEntry => {
            if (typeof m !== 'object' || m === null) {
                return false;
            }
            const rec = m as Record<string, unknown>;
            return typeof rec.name === 'string' && typeof rec.srcPath === 'string';
        });
    } catch {
        return null;
    }
}
