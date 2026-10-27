/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { TypeSetting } from './TypeSetting.js';
import { ParameterName } from './ParameterName.js';

export class InlayHintsSetting {
    public typeSetting = new TypeSetting();
    public parameterNames = new ParameterName();
}
