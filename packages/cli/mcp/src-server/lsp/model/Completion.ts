/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { CompletionItemKind } from './CompletionItemKind.js';
import { CompletionItem } from './CompletionItem.js';
import { getCompletionItemKindsValues } from './Enum/CompletionItemKinds.js';

export class Completion {
    public completionItemKind = new CompletionItemKind(getCompletionItemKindsValues());
    public completionItem = new CompletionItem();
    public contextSupport: unknown = null;
    public insertTextSupport: unknown = null;
    public completionList: unknown = null;
    public dynamicRegistration: unknown = null;
}
