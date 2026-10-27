/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import { ModuleModel } from './ModuleModel.js';
import { CompletionSortSetting } from './CompletionSortSetting.js';
import { GutterIconsSetting } from './GutterIconsSetting.js';
import { InlayHintsSetting } from './InlayHintsSetting/InlayHintsSetting.js';
import { toUnixPath } from '../utils.js';

export class InitializationOptions {
    public modules: ModuleModel[] = [];
    public clientType = 'intellij';
    public indexingDataLocation = '';
    public completionSortSetting = new CompletionSortSetting();
    public gutterIconsSetting = new GutterIconsSetting();
    public inlayHintsSetting = new InlayHintsSetting();
    public lspMaxOldSpaceSize = '8192';
    public projectType = 'OHOS';
    public loggerPath = '';
    public lspServerWorkspacePath: string;

    constructor(
        public rootUri: string,
        lspServerWorkspacePath: string,
        logPath: string,
        indexingDataLocation: string,
    ) {
        this.lspServerWorkspacePath = toUnixPath(path.dirname(lspServerWorkspacePath));
        this.indexingDataLocation = toUnixPath(indexingDataLocation);
        this.loggerPath = toUnixPath(path.join(logPath, 'lspLog'));
    }
}
