/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Params } from './Params.js';

export class RequestInfo {
    public id = 1;
    public jsonrpc = '2.0';
    constructor(
        public method: string,
        public params: Params,
    ) {}
}
