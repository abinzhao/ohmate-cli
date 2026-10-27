/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import * as fs from 'fs';
import { DependencyInfo } from './DependencyInfo.js';
import { Constants } from './Constants.js';
import { ModuleModelDependency } from './ModuleModelDependency.js';
import { logger } from '../logger.js';
import { findJsonObject } from '../utils.js';
import { isRecord } from '../common/typeGuards.js';

export class PackageJsonParser {
    public dependencyPath: string;
    public modulePath: string;
    public projectPath: string;

    private static readonly FILE_DEPENDENCY_PREFIX = 'file:';
    private static readonly PARAMETER_PREFIX = '@param:';

    private readonly fileSpecPattern: RegExp;
    private readonly fileNameForOhpm = /[.](?:har|tgz|tar.gz|tar)$/;

    private static readonly PACKAGE_JSON_PARSER_MAP = new Map<string, PackageJsonParser>();

    public dependencies: DependencyInfo[] = [];
    public devDependencies: DependencyInfo[] = [];
    public dynamicDependencies: DependencyInfo[] = [];

    public static getInstance(dependencyPath: string, modulePath: string, projectPath: string): PackageJsonParser {
        let parser = this.PACKAGE_JSON_PARSER_MAP.get(dependencyPath);
        if (!parser) {
            parser = new PackageJsonParser(dependencyPath, modulePath, projectPath);
            this.PACKAGE_JSON_PARSER_MAP.set(dependencyPath, parser);
        }
        return parser;
    }

    private constructor(dependencyPath: string, modulePath: string, projectPath: string) {
        this.dependencyPath = dependencyPath;
        this.modulePath = modulePath;
        this.projectPath = projectPath;

        this.fileSpecPattern = PackageJsonParser.isWindows()
            ? /^(?:[.]|~[/]|[/\\]|[a-zA-Z]:)/
            : /^(?:[.]|~[/]|[/]|[a-zA-Z]:)/;
    }

    /**
     * 判断当前操作系统是否为 Windows
     */
    public static isWindows(): boolean {
        return process.platform === 'win32';
    }

    public parseDependency(moduleModelDependency: ModuleModelDependency): void {
        const ohPackagePath = path.join(this.dependencyPath, Constants.OH_PACKAGE_JSON5);
        const jsonObject = findJsonObject(ohPackagePath);

        if (!jsonObject) {
            return;
        }

        this.dependencies = this.getDependencyList(jsonObject, Constants.KEY_DEPENDENCY);
        this.devDependencies = this.getDependencyList(jsonObject, Constants.KEY_DEV_DEPENDENCY);
        this.dynamicDependencies = this.getDependencyList(jsonObject, Constants.KEY_DYNAMIC_DEPENDENCY);

        moduleModelDependency.dependencies = this.dependencies;
        moduleModelDependency.dynamicDependencies = this.devDependencies;
        moduleModelDependency.devDependencies = this.dynamicDependencies;
    }

    public getDependencyList(jsonObject: unknown, key: string): DependencyInfo[] {
        const dependencies: DependencyInfo[] = [];
        if (!isRecord(jsonObject)) {
            return dependencies;
        }
        const dependencyObject = jsonObject[key];

        if (!isRecord(dependencyObject)) {
            return dependencies;
        }

        for (const [json5Key, value] of Object.entries(dependencyObject)) {
            if (typeof value !== 'string') {
                logger.error(`${json5Key} package dependency value is not String ${key}`);
                continue;
            }

            const dependencyInfo = new DependencyInfo();
            dependencyInfo.name = json5Key;

            const version = value.replace(/\s/g, '');
            dependencyInfo.version = version;

            if (!version.startsWith(PackageJsonParser.PARAMETER_PREFIX)) {
                this.parseDependencyPath(json5Key, version, dependencyInfo, false);
            }

            dependencies.push(dependencyInfo);
        }
        return dependencies;
    }

    private parseDependencyPath(
        name: string,
        version: string,
        dependencyInfo: DependencyInfo,
        isParameter: boolean,
    ): void {
        if (!name || !version) {
            return;
        }

        try {
            let dependencyPath = path.normalize(path.join(this.modulePath, Constants.OH_MODULES_PATH, name));

            if (!(version.startsWith(PackageJsonParser.FILE_DEPENDENCY_PREFIX) || this.fileSpecPattern.test(version))) {
                dependencyInfo.dependencyPath = dependencyPath;
                return;
            }

            dependencyInfo.path = version;

            if (this.fileNameForOhpm.test(version)) {
                dependencyInfo.dependencyPath = dependencyPath;
                return;
            }

            let filePathStr = version;
            if (version.startsWith(PackageJsonParser.FILE_DEPENDENCY_PREFIX)) {
                filePathStr = version.substring(PackageJsonParser.FILE_DEPENDENCY_PREFIX.length);
            }

            if (path.isAbsolute(filePathStr)) {
                dependencyInfo.dependencyPath = dependencyPath;
                return;
            }

            if (!isParameter) {
                const resolved = path.resolve(this.modulePath, filePathStr);
                dependencyPath = resolved;
            }

            if (fs.existsSync(dependencyPath) && fs.statSync(dependencyPath).isDirectory()) {
                dependencyInfo.dependencyPath = dependencyPath;
            }
        } catch (e) {
            logger.error('parser dependency path is invalid', e);
        }
    }
}
