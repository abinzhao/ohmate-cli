/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Symbol } from '../Symbol.js';
import { SemanticTokens } from '../SemanticTokens.js';
import { getSymbolKindsValues } from '../Enum/SymbolKinds.js';
import { WorkspaceEdit } from './WorkspaceEdit.js';

export class Workspace {
    public applyEdit = true;
    public workspaceEdit = new WorkspaceEdit();
    public didChangeConfiguration: unknown = null;
    public didChangeWatchedFiles = { relativePatternSupport: {}, dynamicRegistration: {} };
    public symbol = new Symbol(getSymbolKindsValues());
    public executeCommand = { dynamicRegistration: {} };
    public workspaceFolders = false;
    public configuration = false;
    public semanticTokens = new SemanticTokens();
    public codeLens: unknown = null;
    public fileOperations: unknown = null;
    public inlayHint: unknown = null;
    public diagnostics: unknown = null;
}
