/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export class ModuleJsonParam {
    public pagesFileName = 'main_pages.json';
    public metaDataList: string[] = [];
    constructor(public pages: string[] = []) {}
}
