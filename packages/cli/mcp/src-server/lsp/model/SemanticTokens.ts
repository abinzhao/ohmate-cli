/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export class SemanticTokens {
    public refreshSupport = true;
    public tokenTypes = [
        'namespace',
        'type',
        'class',
        'enum',
        'interface',
        'struct',
        'parameter',
        'variable',
        'property',
        'function',
        'method',
    ];
    public tokenModifiers = ['declaration', 'definition', 'readonly', 'static', 'deprecated'];
}
