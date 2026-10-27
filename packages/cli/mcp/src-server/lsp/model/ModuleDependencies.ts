/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ModuleDependencyInfo } from './ModuleDependencyInfo.js';

export class ModuleDependencies {
    public modulePath?: string;
    public dependencies: { [key: string]: ModuleDependencyInfo } = {};
    public dynamicDependencies: { [key: string]: ModuleDependencyInfo } = {};
}
