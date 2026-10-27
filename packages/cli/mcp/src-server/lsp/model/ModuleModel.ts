/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { BuildProfileParam } from './BuildProfileParam.js';
import { ModuleDependencies } from './ModuleDependencies.js';
import { ModuleJsonParam } from './ModuleJsonParam.js';

const os = 'OS';
export class ModuleModel {
    // 默认设备类型，5 通常代表 phone/default
    public deviceType: number[] = [5];
    public aceLoaderPath?: string;
    public modulePath?: string;
    public jsComponentType: string = 'declarative';
    public sdkJsPath?: string;
    public compatibleSdkVersion?: string;
    public compatibleSdkLevel?: string;
    public compileSdkLevel?: string;
    public compileSdkVersion: string = '6.0.1.112';
    public compileSdkType: string = 'Release';

    // 对应 Java 的 Map.of 结构
    public syscap: { [key: string]: string[] } = {
        NDeviceSysCaps: [],
        addedSysCaps: [],
    };

    public apiType: string = 'stageMode';
    public hosSdkPath?: string;
    public runtimeOs: string = `Harmony${os}`;
    public moduleName?: string;
    public moduleType?: string;
    public compileMode: string = 'jsbundle';
    public crossPlatform: boolean = false;
    public ignoreCrossPlatform: boolean = false;
    public packageManagerType: string = 'ohpm';
    public permissions: string[] = [];
    public testPermissions: string[] = [];
    public buildProfileParam: BuildProfileParam;

    // 对应 Java 的 appParam = Map.of("bundleType", "app")
    public appParam: Record<string, string> = {
        bundleType: 'app',
    };

    public packageName?: string;
    public projectType: string = 'OHOS';
    public projectName?: string;
    public moduleDependencies?: ModuleDependencies;
    public moduleJsonParam: ModuleJsonParam | null = null;
    public globalDeclarationFiles: string[] = [];

    /**
     * 构造函数
     * @param modulePath 模块路径，如果提供则会自动初始化 buildProfileParam
     */
    constructor(modulePath?: string) {
        if (modulePath) {
            this.modulePath = modulePath;
            this.buildProfileParam = new BuildProfileParam(modulePath);
        } else {
            this.buildProfileParam = new BuildProfileParam();
        }
    }

    /**
     * 辅助方法：返回对象的 JSON 字符串表示（用于调试）
     */
    public toString(): string {
        return JSON.stringify(this);
    }
}
