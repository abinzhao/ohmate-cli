/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Workspace } from './Workspace.js';
import { TextDocument } from './TextDocument.js';

export class Capabilities {
    public workspace = new Workspace();
    public textDocument = new TextDocument();
    public notebookDocument: unknown = null;
    public window: unknown = null;
    public general: unknown = null;
    public experimental: unknown = null;
}
