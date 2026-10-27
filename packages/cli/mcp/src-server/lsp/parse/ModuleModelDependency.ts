/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { DependencyInfo } from './DependencyInfo.js';

export class ModuleModelDependency {
    public dependencies: DependencyInfo[] = [];
    public devDependencies: DependencyInfo[] = [];
    public dynamicDependencies: DependencyInfo[] = [];
    public finalDependencies: DependencyInfo[] = [];
    public finalDevDependencies: DependencyInfo[] = [];
    public finalDynamicDependencies: DependencyInfo[] = [];

    constructor(
        public projectPath: string,
        public moduleName: string,
        public modulePath: string,
    ) {}
}
