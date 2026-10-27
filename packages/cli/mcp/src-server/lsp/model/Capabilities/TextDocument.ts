/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Synchronization } from './Synchronization.js';
import { Completion } from '../Completion.js';
import { SemanticTokens } from '../SemanticTokens.js';

export class TextDocument {
    public synchronization = new Synchronization();
    public completion = new Completion();
    public hover = { contentFormat: {}, dynamicRegistration: {} };
    public signatureHelp = {
        signatureInformation: {},
        contextSupport: {},
        dynamicRegistration: {},
    };
    public references = { dynamicRegistration: {} };
    public documentHighlight = { dynamicRegistration: true };
    public documentSymbol: unknown = null;
    public formatting = { dynamicRegistration: {} };
    public rangeFormatting = { dynamicRegistration: {} };
    public onTypeFormatting = { dynamicRegistration: {} };
    public declaration: unknown = {};
    public definition = { linkSupport: {}, dynamicRegistration: {} };
    public codeLens: unknown = null;
    public documentLink = { tooltipSupport: {}, dynamicRegistration: {} };
    public colorProvider: unknown = null;
    public rename = {
        prepareSupport: true,
        prepareSupportDefaultBehavior: null,
        honorsChangeAnnotations: null,
        dynamicRegistrationSupport: null,
    };
    public publishDiagnostics: unknown = null;
    public foldingRage: unknown = null;
    public typeHierarchy: unknown = null;
    public callHierarchy = { dynamicRegistration: {} };
    public selectionRange: unknown = null;
    public semanticTokens = new SemanticTokens();
    public moniker: unknown = null;
    public linkedEditingRange: unknown = null;
    public inlayHint: unknown = null;
    public inlineValue: unknown = null;
    public diagnostic: unknown = null;
}
