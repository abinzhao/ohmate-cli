/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';
import { DependencyInfo } from './DependencyInfo.js';
import { Constants } from './Constants.js';
import { logger } from '../logger.js';
import { isRecord } from '../common/typeGuards.js';

export class LockJson5Parser {
    public projectPath: string;
    private static readonly FILE_DEPENDENCY_PREFIX = 'file:';
    private static readonly MAX_LOCK_FILE_SIZE = 20 * 1024 * 1024;
    private static readonly MAX_KEYS_PER_OBJECT = 50000;
    private static readonly MAX_JSON_DEPTH = 50;
    private readonly fileNameForOhpm = /[.](?:har|tgz|tar.gz|tar)$/;

    public finalDependencies: DependencyInfo[] = [];
    public finalDevDependencies: DependencyInfo[] = [];
    public finalDynamicDependencies: DependencyInfo[] = [];
    private storePathMap: Map<string, string> = new Map();
    /** lock.json5 解析缓存：同一实例多次 parseDependencies(moduleName) 时只读/解析一次 */
    private lockFileCache: { modules: unknown; storePathMap: Map<string, string> } | null = null;
    private lockFileParsed = false;

    constructor(projectPath: string = '') {
        this.projectPath = projectPath;
    }

    public parseDependencies(moduleModelName: string): boolean {
        if (!this.ensureLockFileParsed()) {
            return false;
        }
        const cache = this.lockFileCache!;
        this.extractDependencies(cache.modules, cache.storePathMap, moduleModelName);
        return true;
    }

    /**
     * 读取 + 解析 + 校验 lock.json5 一次并缓存到实例上。
     *
     * 同一个 LockJson5Parser 实例多次调用 parseDependencies(moduleModelName) 时，
     * lock 文件只读取/解析一次，storePathMap 只构建一次，
     */
    private ensureLockFileParsed(): boolean {
        if (this.lockFileParsed) {
            return this.lockFileCache !== null;
        }
        this.lockFileParsed = true;

        const lockFilePath = this.getLockFilePath();
        const lockFileJsonObject = this.readLockFile(lockFilePath);
        if (!lockFileJsonObject) {
            return false;
        }

        const validationResult = this.validateLockFile(lockFileJsonObject);
        if (!validationResult.valid) {
            return false;
        }

        this.lockFileCache = {
            modules: validationResult.modules,
            storePathMap: this.parseStorePathMap(validationResult.packages),
        };
        return true;
    }

    private getLockFilePath(): string {
        return path.join(
            this.projectPath,
            Constants.OH_MODULES_PATH,
            Constants.OHPM_PATH,
            Constants.LOCK_JSON5_FILE,
        );
    }

    /**
     * 校验对象嵌套深度，防止恶意构造的深嵌套 JSON 导致栈溢出或解析阻塞。
     */
    private static checkObjectDepth(obj: unknown, maxDepth: number, currentDepth: number = 0): boolean {
        if (currentDepth > maxDepth) {
            return false;
        }
        if (typeof obj !== 'object' || obj === null) {
            return true;
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (!LockJson5Parser.checkObjectDepth(item, maxDepth, currentDepth + 1)) {
                    return false;
                }
            }
            return true;
        }

        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                if (!LockJson5Parser.checkObjectDepth((obj as Record<string, unknown>)[key], maxDepth, currentDepth + 1)) {
                    return false;
                }
            }
        }
        return true;
    }

    private readLockFile(lockFilePath: string): unknown | null {
        if (!fs.existsSync(lockFilePath)) {
            logger.error('lock file does not exist');
            this.clearDependencies();
            return null;
        }

        // 限制文件大小，防止恶意大文件导致 OOM 或事件循环阻塞
        try {
            const stats = fs.statSync(lockFilePath);
            if (stats.size > LockJson5Parser.MAX_LOCK_FILE_SIZE) {
                logger.error(`lock file is too large (${stats.size} bytes), read aborted`);
                this.clearDependencies();
                return null;
            }
        } catch (e) {
            logger.error(`Failed to stat lock file: ${e instanceof Error ? e.message : String(e)}`);
            this.clearDependencies();
            return null;
        }

        try {
            const lockFileContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockFileJsonObject = JSON5.parse(lockFileContent);

            if (!lockFileJsonObject) {
                logger.error('lockFileJsonObject is null');
                this.clearDependencies();
                return null;
            }

            // 校验嵌套深度，防御内存炸弹
            if (!LockJson5Parser.checkObjectDepth(lockFileJsonObject, LockJson5Parser.MAX_JSON_DEPTH)) {
                logger.error('lock.json5 nesting depth exceeds limit');
                this.clearDependencies();
                return null;
            }

            return lockFileJsonObject;
        } catch (e) {
            logger.error(`Error parsing lock.json5: ${e instanceof Error ? e.message : String(e)}`);
            this.clearDependencies();
            return null;
        }
    }

    private validateLockFile(lockFileJsonObject: unknown): { valid: boolean; modules?: unknown; packages?: unknown } {
        if (!isRecord(lockFileJsonObject)) {
            logger.error('lockFileJsonObject is not a valid object');
            this.clearDependencies();
            return { valid: false };
        }

        const modulesJsonObject = lockFileJsonObject.modules;
        if (!modulesJsonObject) {
            logger.error('modulesJsonObject is null');
            this.clearDependencies();
            return { valid: false };
        }

        const packagesJsonObject = lockFileJsonObject.packages;
        if (!packagesJsonObject) {
            logger.error('packagesJsonObject is null');
            this.clearDependencies();
            return { valid: false };
        }

        return { valid: true, modules: modulesJsonObject, packages: packagesJsonObject };
    }

    private extractDependencies(
        modulesJsonObject: unknown,
        storePathMap: Map<string, string>,
        moduleModelName: string,
    ): void {
        this.storePathMap = storePathMap;
        this.finalDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DEPENDENCY,
            moduleModelName,
        );
        this.finalDevDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DEV_DEPENDENCY,
            moduleModelName,
        );
        this.finalDynamicDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DYNAMIC_DEPENDENCY,
            moduleModelName,
        );
    }

    public parseStorePathMap(packagesJsonObject: unknown): Map<string, string> {
        const storePathMap = new Map<string, string>();
        if (!isRecord(packagesJsonObject)) {
            return storePathMap;
        }

        let keyCount = 0;
        for (const key in packagesJsonObject) {
            if (!Object.prototype.hasOwnProperty.call(packagesJsonObject, key)) {
                continue;
            }
            const value = packagesJsonObject[key];
            if (!isRecord(value)) {
                logger.error(`${key} value is not json object`);
                continue;
            }
            if (++keyCount > LockJson5Parser.MAX_KEYS_PER_OBJECT) {
                logger.warn('lock.json5 packages object exceeds key limit, truncating');
                break;
            }
            if (typeof value.storePath === 'string') {
                storePathMap.set(key, value.storePath);
            }
        }
        return storePathMap;
    }

    public getDependencyList(modulesJsonObject: unknown, dependencyType: string, moduleName: string): DependencyInfo[] {
        if (!isRecord(modulesJsonObject)) {
            return [];
        }

        let keyCount = 0;
        for (const relativeModulePath in modulesJsonObject) {
            if (!Object.prototype.hasOwnProperty.call(modulesJsonObject, relativeModulePath)) {
                continue;
            }
            if (++keyCount > LockJson5Parser.MAX_KEYS_PER_OBJECT) {
                logger.warn('lock.json5 modules object exceeds key limit, truncating');
                break;
            }

            const value = modulesJsonObject[relativeModulePath];
            if (isRecord(value)) {
                const name = typeof value.name === 'string' ? value.name : '';
                if (('.' === moduleName && name === '') || name === moduleName) {
                    return this.getFinalDependencyList(modulesJsonObject, dependencyType, relativeModulePath);
                }
            }
        }
        return [];
    }

    public getFinalDependencyList(
        modulesJsonObject: Record<string, unknown>,
        dependencyType: string,
        relativeModulePath: string,
    ): DependencyInfo[] {
        const moduleJsonObject = modulesJsonObject[relativeModulePath];
        if (!isRecord(moduleJsonObject)) {
            logger.error('moduleJsonObject is null');
            return [];
        }

        const dependencies: DependencyInfo[] = [];
        const dependenciesObject = moduleJsonObject[dependencyType];
        if (!isRecord(dependenciesObject)) {
            return [];
        }

        let keyCount = 0;
        for (const key in dependenciesObject) {
            if (!Object.prototype.hasOwnProperty.call(dependenciesObject, key)) {
                continue;
            }
            if (++keyCount > LockJson5Parser.MAX_KEYS_PER_OBJECT) {
                logger.warn('lock.json5 dependencies object exceeds key limit, truncating');
                break;
            }

            const value = dependenciesObject[key];
            if (!isRecord(value)) {
                continue;
            }

            const specifier = typeof value.specifier === 'string' ? value.specifier : '';
            const version = typeof value.version === 'string' ? value.version : '';
            const dependencyInfo = new DependencyInfo();
            dependencyInfo.name = key;
            dependencyInfo.version = version.startsWith(LockJson5Parser.FILE_DEPENDENCY_PREFIX)
                ? version.substring(LockJson5Parser.FILE_DEPENDENCY_PREFIX.length)
                : version;

            this.parseDependencyPath(dependencyInfo, relativeModulePath, key, specifier, version);

            const packageName = `${key}@${version}`;
            if (this.storePathMap.has(packageName)) {
                dependencyInfo.storePath = this.storePathMap.get(packageName) || '';
            }

            dependencies.push(dependencyInfo);
        }
        return dependencies;
    }

    private parseDependencyPath(
        dependencyInfo: DependencyInfo,
        relativeModulePath: string,
        dependencyKey: string,
        specifier: string,
        version: string,
    ): void {
        const defaultDepPath = path.resolve(
            this.projectPath,
            path.join(relativeModulePath, Constants.OH_MODULES_PATH, dependencyKey),
        );

        try {
            const fileDepPath = version.startsWith(LockJson5Parser.FILE_DEPENDENCY_PREFIX)
                ? version.substring(LockJson5Parser.FILE_DEPENDENCY_PREFIX.length)
                : version;

            const resolved = path.isAbsolute(fileDepPath)
                ? fileDepPath
                : path.resolve(this.projectPath, fileDepPath);

            if (fs.existsSync(resolved)) {
                dependencyInfo.path = specifier;
                dependencyInfo.dependencyPath = this.fileNameForOhpm.test(version)
                    ? defaultDepPath
                    : resolved;
            } else {
                dependencyInfo.dependencyPath = defaultDepPath;
            }
        } catch (e) {
            logger.error('Invalid dependency path in lock.json5, msg:', e instanceof Error ? e.message : String(e));
        }
    }

    public clearDependencies(): void {
        this.finalDependencies = [];
        this.finalDevDependencies = [];
        this.finalDynamicDependencies = [];
    }
}
