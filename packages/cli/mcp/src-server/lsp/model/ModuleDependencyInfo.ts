/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export class ModuleDependencyInfo {
    public registryType: string;
    public resolved: string;
    public name: string;
    public version: string;
    /** 新增为 'add'，删除为 'delete'，未变动不传（undefined/null） */
    public type?: string | null;

    constructor(data: unknown) {
        const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};

        this.name = typeof obj.name === 'string' ? obj.name : '';
        this.version = typeof obj.version === 'string' ? obj.version : '';

        if (typeof obj.registryType === 'string') {
            this.registryType = obj.registryType;
        } else {
            this.registryType = typeof obj.path === 'string' ? 'local' : 'ohpm';
        }

        if (typeof obj.resolved === 'string') {
            this.resolved = obj.resolved;
        } else if (typeof obj.storePath === 'string') {
            this.resolved = obj.storePath;
        } else {
            this.resolved = '';
        }

        this.type = typeof obj.type === 'string' ? obj.type : undefined;
    }
}
