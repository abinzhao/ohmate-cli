/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import { toUnixPath } from '../utils.js';

export class BuildProfileParam {
    public productName = 'default';
    public buildModeName = 'debug';
    public targetName = 'default';
    public arkTSVersion = '1.1';
    public resourceDirectories: string[] = [];
    public targetESVersion = 'ES2021';
    public maxFlowDepth = 2000;
    public caseSensitiveCheck = true;
    public tsImportSendable = false;
    public compatibleSdkVersionStage = '';
    public useNormalizedOHMUrl = true;
    public reExportCheckMode = 'noCheck';
    public skipOhModulesLint = false;
    public byteCodeHar = true;
    public obfuscationRuleOptionsEnable = false;
    public enableStrictCheckOHModules = false;
    public sourceRoots: string[] = [];

    constructor(modulePath?: string) {
        if (modulePath) {
            this.resourceDirectories.push(toUnixPath(path.join(modulePath, 'src', 'main', 'resources')));
        }
    }
}
