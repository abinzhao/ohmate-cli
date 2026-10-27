/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { logger } from '../logger.js';
import { findJsonObject, getBuildProfilePath } from '../utils.js';

/**
 * build-profile.json5 中的模块信息
 */
interface BuildProfileModule {
    name: string;
    srcPath: string;
}

export class ModuleInfoParse {
    constructor(public projectRoot: string) {}

    /**
     * 从 build-profile.json5 解析模块列表
     */
    public getAllModuleInfo(): BuildProfileModule[] {
        const buildProfilePath = getBuildProfilePath(this.projectRoot);
        try {
            const obj = findJsonObject(buildProfilePath);
            if (typeof obj !== 'object' || obj === null) {
                return [];
            }
            const modules = (obj as Record<string, unknown>).modules;
            if (!Array.isArray(modules)) {
                return [];
            }
            return modules.filter((m): m is BuildProfileModule => {
                if (typeof m !== 'object' || m === null) {
                    return false;
                }
                const rec = m as Record<string, unknown>;
                return typeof rec.name === 'string' && typeof rec.srcPath === 'string';
            });
        } catch (e) {
            logger.warn(
                `[ConfigFileWatcher] Failed to parse build-profile.json5: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
        }
    }
}
