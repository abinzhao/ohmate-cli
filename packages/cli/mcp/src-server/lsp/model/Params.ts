/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { InitializationOptions } from './InitializationOptions.js';
import { Capabilities } from './Capabilities/Capabilities.js';

export class Params {
    constructor(
        public rootUri: string,
        public initializationOptions: InitializationOptions,
        public capabilities: Capabilities,
    ) {}
}
