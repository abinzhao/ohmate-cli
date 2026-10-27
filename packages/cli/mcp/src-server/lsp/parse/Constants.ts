/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ProjectConstants } from '../../../../src/config/project.js';

export const Constants = {
    HVIGOR_CACHE: '.hvigor',
    DEPENDENCY: 'dependencyMap',
    JSON5: '.json5',
    KEY_DEPENDENCY: 'dependencies',
    KEY_DYNAMIC_DEPENDENCY: 'dynamicDependencies',
    KEY_DEV_DEPENDENCY: 'devDependencies',
    OH_MODULES_PATH: 'oh_modules',
    OHPM_PATH: '.ohpm',
    LOCK_JSON5_FILE: 'lock.json5',
    OH_PACKAGE_JSON5: ProjectConstants.OH_PACKAGE_JSON5,
};

export const DEPENDENCY_MAP_PATH = `${Constants.HVIGOR_CACHE}/${Constants.DEPENDENCY}`;
export const DEPENDENCY_MAP_JSON5 = `${Constants.DEPENDENCY}${Constants.JSON5}`;
export const SYNC_OUTPUT_PATH = ProjectConstants.SYNC_OUTPUT_PATH;
