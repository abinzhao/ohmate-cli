/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import * as fs from 'fs';
import { ModuleModel } from '../model/ModuleModel.js';
import { ModuleDependencies } from '../model/ModuleDependencies.js';
import { ModuleDependencyInfo } from '../model/ModuleDependencyInfo.js';
import { ModuleJsonParam } from '../model/ModuleJsonParam.js';
import { ModuleModelDependency } from './ModuleModelDependency.js';
import { PackageJsonParser } from './PackageJsonParser.js';
import { LockJson5Parser } from './LockJson5Parser.js';
import { Constants, DEPENDENCY_MAP_PATH, DEPENDENCY_MAP_JSON5 } from './Constants.js';
import { logger } from '../logger.js';
import { findJsonObject, toUnixPath } from '../utils.js';
import { DependencyMapParseResult, DependencyMapParseStatus } from '../constant.js';
import { isRecord } from '../common/typeGuards.js';
import { ModuleInfoParse } from './ModuleInfoParse.js';
import { CommonUtils } from '../../../../src/utils/common-utils.js';

/** getDependenciesOnly 返回项：在 ModuleDependencies 基础上增加 moduleName */
export interface DepsOnlyItem extends ModuleDependencies {
    moduleName?: string;
}

type DependencyModuleEntry = {
    name: string;
    srcPath: string;
};

function isDependencyModuleEntry(value: unknown): value is DependencyModuleEntry {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.name === 'string' && typeof value.srcPath === 'string';
}

export class ModulesDependencyParse {
    private moduleInfoParse: ModuleInfoParse;
    /** 复用单个 LockJson5Parser 实例：lock.json5 只读取/解析一次，按模块名提取各自依赖 */
    private lockJson5Parser: LockJson5Parser | null = null;
    /** sdk-pkg.json 对所有模块相同，只读取/解析一次 */
    private sdkPkgCache: unknown | null | undefined = undefined;
    /** build-profile.json5 对所有模块相同，只读取/解析一次 */
    private buildProfileCache: unknown | null | undefined = undefined;
    constructor(
        public projectPath: string,
        public sdkPath: string,
    ) {
        this.moduleInfoParse = new ModuleInfoParse(this.projectPath);
    }

    public getAllDependencyMap(moduleModels: ModuleModel[], onProgress?: (current: number, total: number) => void): DependencyMapParseResult {
        const basePath = this.projectPath;
        const dependencyMapPath = path.join(basePath, DEPENDENCY_MAP_PATH);
        const dependencyJsonPath = path.join(dependencyMapPath, DEPENDENCY_MAP_JSON5);

        if (!fs.existsSync(dependencyMapPath) || !fs.existsSync(dependencyJsonPath)) {
            const message = 'Dependency map or JSON not found';
            logger.warn(`[Parser] getAllDependencyMap failed: ${message}.`);
            return { status: DependencyMapParseStatus.ERROR, message: `${message}, please rebuild project` };
        }

        const projectModuleDependency = new ModuleModelDependency(this.projectPath, '.', this.projectPath);
        this.parseProjectDependencies(dependencyMapPath, projectModuleDependency);
        this.parseLockJson(projectModuleDependency);

        const modules = this.moduleInfoParse.getAllModuleInfo();
        if (modules.length === 0) {
            const message = 'No modules found in build-profile.json5';
            logger.warn(`[Parser] getAllDependencyMap failed: ${message}.`);
            return { status: DependencyMapParseStatus.ERROR, message };
        }

        const startMs = Date.now();
        for (let i = 0; i < modules.length; i++) {
            const mod = modules[i];
            if (!isDependencyModuleEntry(mod)) {
                continue;
            }
            try {
                CommonUtils.assertModuleName(mod.name);
            } catch {
                logger.warn(`[Parser] Skipping module with invalid name: ${mod.name}`);
                continue;
            }
            this.parseSingleModule(mod, dependencyMapPath, projectModuleDependency, moduleModels);
            if ((i + 1) % 50 === 0 || i + 1 === modules.length) {
                logger.info(`[Parser] getAllDependencyMap progress: ${i + 1}/${modules.length} (${Date.now() - startMs}ms)`);
                onProgress?.(i + 1, modules.length);
            }
        }
        logger.info(`[Parser] getAllDependencyMap parsed ${moduleModels.length} modules in ${Date.now() - startMs}ms`);
        return { status: DependencyMapParseStatus.OK };
    }

    /**
     * 仅解析依赖：从 .hvigor/dependencyMap/ 读取模块列表与 oh-package/lock，
     * 只返回各模块的 (moduleName, modulePath, dependencies)，不构建 ModuleModel。
     *
     * @param moduleNames 若传入且非空，则只解析这些模块的依赖（增量）；不传或空则解析全部模块。
     */
    public getDependenciesOnly(moduleNames?: string[]): DepsOnlyItem[] {
        const result: DepsOnlyItem[] = [];
        const basePath = this.projectPath;
        const dependencyMapPath = path.join(basePath, DEPENDENCY_MAP_PATH);
        const dependencyJsonPath = path.join(dependencyMapPath, DEPENDENCY_MAP_JSON5);

        if (!fs.existsSync(dependencyMapPath) || !fs.existsSync(dependencyJsonPath)) {
            logger.warn('[Parser] Dependency map or JSON not found.');
            return result;
        }

        const filterSet =
            moduleNames && moduleNames.length > 0 ? new Set(moduleNames.map((n) => n.trim()).filter(Boolean)) : null;

        const projectModuleDependency = new ModuleModelDependency(this.projectPath, '.', this.projectPath);
        this.parseProjectDependencies(dependencyMapPath, projectModuleDependency);
        this.parseLockJson(projectModuleDependency);

        const modules = this.moduleInfoParse.getAllModuleInfo();
        if (modules.length === 0) {
            const message = 'No modules found in build-profile.json5';
            logger.warn(`[Parser] getAllDependencyMap failed: ${message}.`);
            return result;
        }

        for (const mod of modules) {
            if (!isDependencyModuleEntry(mod)) {
                continue;
            }
            const name = mod.name;
            try {
                CommonUtils.assertModuleName(name);
            } catch {
                logger.warn(`[Parser] Skipping module with invalid name: ${name}`);
                continue;
            }
            if (filterSet && !filterSet.has(name)) {
                continue;
            }
            const modulePath = path.resolve(this.projectPath, mod.srcPath);
            const depPathForModule = path.join(dependencyMapPath, name);
            const modulePathStr = toUnixPath(modulePath);

            const dependencies = this.buildModuleDependencies(
                name,
                modulePathStr,
                depPathForModule,
                projectModuleDependency,
            );
            (dependencies as DepsOnlyItem).moduleName = name;
            result.push(dependencies as DepsOnlyItem);
        }
        return result;
    }

    /**
     * 解析单个模块。
     */
    private parseSingleModule(
        mod: DependencyModuleEntry,
        dependencyMapPath: string,
        projectModuleDependency: ModuleModelDependency,
        moduleModels: ModuleModel[],
    ): void {
        const name = mod.name;
        const modulePath = path.resolve(this.projectPath, mod.srcPath);
        const depPathForModule = path.join(dependencyMapPath, name);
        const modulePathStr = toUnixPath(modulePath);

        const moduleModel = new ModuleModel(modulePathStr);
        const dependencies = this.buildModuleDependencies(
            name,
            modulePathStr,
            depPathForModule,
            projectModuleDependency,
        );

        this.parseModuleJson5(modulePathStr, moduleModel);
        const mainPagesList = this.parseMainPages(modulePathStr);
        this.parseSdkJson(moduleModel);
        this.parseCompatibleSdkVersion(moduleModel);

        moduleModel.moduleName = name;
        moduleModel.moduleType = name;
        moduleModel.packageName = name;
        moduleModel.moduleDependencies = dependencies;
        moduleModel.moduleJsonParam = new ModuleJsonParam(mainPagesList);

        moduleModels.push(moduleModel);
    }

    private buildModuleDependencies(
        name: string,
        modulePathStr: string,
        depPathForModule: string,
        projectModuleDependency: ModuleModelDependency,
    ): ModuleDependencies {
        const moduleModelDependency = new ModuleModelDependency(this.projectPath, name, modulePathStr);

        const packageJsonParser = PackageJsonParser.getInstance(depPathForModule, modulePathStr, this.projectPath);
        packageJsonParser.parseDependency(moduleModelDependency);

        this.parseLockJson(moduleModelDependency);

        moduleModelDependency.finalDependencies.push(...projectModuleDependency.finalDependencies);
        moduleModelDependency.finalDevDependencies.push(...projectModuleDependency.finalDevDependencies);
        moduleModelDependency.finalDynamicDependencies.push(...projectModuleDependency.finalDynamicDependencies);
        moduleModelDependency.finalDependencies.push(...moduleModelDependency.finalDevDependencies);

        const dependencies = new ModuleDependencies();
        dependencies.modulePath = modulePathStr;
        this.toModuleDependencies(moduleModelDependency, dependencies);
        return dependencies;
    }

    private toModuleDependencies(moduleModelDependency: ModuleModelDependency, dependencies: ModuleDependencies): void {
        const depMap: { [key: string]: ModuleDependencyInfo } = {};
        const dynDepMap: { [key: string]: ModuleDependencyInfo } = {};

        for (const info of moduleModelDependency.finalDependencies) {
            depMap[info.name] = new ModuleDependencyInfo(info);
        }
        for (const info of moduleModelDependency.finalDynamicDependencies) {
            dynDepMap[info.name] = new ModuleDependencyInfo(info);
        }

        dependencies.dependencies = depMap;
        dependencies.dynamicDependencies = dynDepMap;
    }

    public parseProjectDependencies(dependencyMapPath: string, moduleDependency: ModuleModelDependency): void {
        const ohPackagePath = path.join(dependencyMapPath, Constants.OH_PACKAGE_JSON5);
        if (!fs.existsSync(ohPackagePath)) {
            return;
        }

        const packageJsonParser = PackageJsonParser.getInstance(dependencyMapPath, this.projectPath, this.projectPath);
        packageJsonParser.parseDependency(moduleDependency);
    }

    public parseLockJson(moduleModelDependency: ModuleModelDependency): void {
        const lockJson5Parser = this.getLockJson5Parser();
        if (lockJson5Parser.parseDependencies(moduleModelDependency.moduleName)) {
            moduleModelDependency.finalDependencies = lockJson5Parser.finalDependencies;
            moduleModelDependency.finalDevDependencies = lockJson5Parser.finalDevDependencies;
            moduleModelDependency.finalDynamicDependencies = lockJson5Parser.finalDynamicDependencies;
        } else {
            moduleModelDependency.finalDependencies = moduleModelDependency.dependencies;
            moduleModelDependency.finalDevDependencies = moduleModelDependency.devDependencies;
            moduleModelDependency.finalDynamicDependencies = moduleModelDependency.dynamicDependencies;
        }
    }

    /** 复用单个 LockJson5Parser 实例，使 lock.json5 在大工程下只解析一次。 */
    private getLockJson5Parser(): LockJson5Parser {
        if (!this.lockJson5Parser) {
            this.lockJson5Parser = new LockJson5Parser(this.projectPath);
        }
        return this.lockJson5Parser;
    }

    private parseModuleJson5(basePath: string, moduleModel: ModuleModel): void {
        const moduleJson5Path = path.join(basePath, 'src', 'main', 'module.json5');
        const obj = findJsonObject(moduleJson5Path);
        if (!isRecord(obj) || !isRecord(obj.module)) {
            return;
        }

        const mod = obj.module;
        moduleModel.permissions = this.parseRequestPermissions(mod);
        moduleModel.deviceType = this.parseDeviceTypes(mod);
    }

    private parseRequestPermissions(moduleObject: unknown): string[] {
        const list: string[] = [];
        if (isRecord(moduleObject) && Array.isArray(moduleObject.requestPermissions)) {
            for (const perm of moduleObject.requestPermissions) {
                if (isRecord(perm) && typeof perm.name === 'string') {
                    list.push(perm.name);
                }
            }
        }
        return list;
    }

    public parseMainPages(basePath: string): string[] {
        const mainPagesPath = path.join(basePath, 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json');
        const obj = findJsonObject(mainPagesPath);
        if (!isRecord(obj) || !Array.isArray(obj.src)) {
            return [];
        }
        return obj.src.filter((s): s is string => typeof s === 'string');
    }

    public parseSdkJson(moduleModel: ModuleModel): void {
        const obj = this.getSdkPkg();
        if (!isRecord(obj) || !isRecord(obj.data)) {
            return;
        }
        if (typeof obj.data.apiVersion === 'string') {
            const apiVersion = parseInt(obj.data.apiVersion, 10);
            if (!Number.isNaN(apiVersion) && apiVersion >= 26 && typeof obj.data.platformVersion === 'string') {
                moduleModel.compileSdkLevel = obj.data.platformVersion;
            } else {
                moduleModel.compileSdkLevel = obj.data.apiVersion;
            }
        }
        if (typeof obj.data.releaseType === 'string') {
            moduleModel.compileSdkType = obj.data.releaseType;
        }
        if (typeof obj.data.version === 'string') {
            moduleModel.compileSdkVersion = obj.data.version;
        }
    }

    /** sdk-pkg.json 对所有模块相同，只读取/解析一次。 */
    private getSdkPkg(): unknown | null {
        if (this.sdkPkgCache === undefined) {
            const sdkPkgPath = path.join(this.sdkPath, 'default', 'sdk-pkg.json');
            this.sdkPkgCache = findJsonObject(sdkPkgPath);
        }
        return this.sdkPkgCache;
    }

    public parseCompatibleSdkVersion(moduleModel: ModuleModel): void {
        const obj = this.getBuildProfile();
        if (!isRecord(obj) || !isRecord(obj.app) || !Array.isArray(obj.app.products) || obj.app.products.length === 0) {
            return;
        }
        const product = obj.app.products[0];
        if (!isRecord(product) || typeof product.compatibleSdkVersion !== 'string') {
            return;
        }
        const [version, level] = this.parseBySplit(product.compatibleSdkVersion);
        moduleModel.compatibleSdkVersion = version;
        moduleModel.compatibleSdkLevel = level;
    }

    /** build-profile.json5 对所有模块相同，只读取/解析一次。 */
    private getBuildProfile(): unknown | null {
        if (this.buildProfileCache === undefined) {
            const buildProfilePath = path.join(this.projectPath, 'build-profile.json5');
            this.buildProfileCache = findJsonObject(buildProfilePath);
        }
        return this.buildProfileCache;
    }

    private parseBySplit(input: string): [string, string] {
        const openParen = input.indexOf('(');
        if (openParen === -1 || !input.endsWith(')')) {
            return [input, input];
        }
        const version = input.substring(0, openParen);
        const level = input.substring(openParen + 1, input.length - 1);
        return [version, level];
    }

    private parseDeviceTypes(moduleObject: unknown): number[] {
        if (!isRecord(moduleObject) || !Array.isArray(moduleObject.deviceTypes)) {
            return [];
        }
        return moduleObject.deviceTypes
            .filter((t): t is string => typeof t === 'string')
            .map((t) => this.getDeviceType(t));
    }

    private getDeviceType(value: string): number {
        const types: { [key: string]: number } = {
            liteWearable: 1,
            wearable: 2,
            tv: 3,
            car: 4,
            phone: 5,
            default: 5,
            smartVision: 6,
            tablet: 7,
            router: 8,
            pc: 9,
            '2in1': 10,
        };
        return types[value] || 0;
    }
}
