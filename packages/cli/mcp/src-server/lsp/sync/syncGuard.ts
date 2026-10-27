/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { logger } from '../logger.js';
// 从 src/utils/project-check 导入共享的同步必要性检查函数，与run/build复用相同逻辑
import { checkSyncRequired as checkSyncRequiredCore, SyncCheckResult } from '../../../../src/utils/project-check.js';

/**
 * 判断 MCP 启动时是否需要执行 sync
 *
 * 核心逻辑：
 *   取 .hvigor/outputs/sync/output.json 的 mtime 作为 sync 基准时间戳
 *   该文件每次 sync 必定会被更新，跨平台（Windows / macOS）行为一致
 *   逐一比对各源 oh-package.json5 的 mtime 是否晚于该基准
 *
 * @param projectRoot 项目根目录
 */
export function checkSyncRequired(projectRoot: string): SyncCheckResult {
    const result = checkSyncRequiredCore(projectRoot);
    logger.info(`[SyncGuard] ${result.reason}`);
    return result;
}
