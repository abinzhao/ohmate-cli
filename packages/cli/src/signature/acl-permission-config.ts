/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project } from '../utils/project';
import { debuglog } from 'node:util';
import { ToolProvider } from '../toolchain';
import { getApiVersionFromFile } from './sdk-config';
import { getAclPermissionInsteadName } from './acl-permission-message';
import { fileURLToPath } from 'url';

export interface AclPermissionInfoLike {
  permissionName?: string;
  permissionDisplayName?: string;
  minSupportApiLevel?: string;
  permissionInsteadName?: string;
  permissionHelpUrlKey?: string;
}

export class AclPermissionInfo {
  public permissionName: string;
  public permissionDisplayName: string;
  public minSupportApiLevel: string;
  public permissionInsteadName?: string;
  public permissionHelpUrlKey?: string;

  constructor(init: AclPermissionInfoLike = {}) {
    this.permissionName = init.permissionName ?? '';
    this.permissionDisplayName = init.permissionDisplayName ?? '';
    this.minSupportApiLevel = init.minSupportApiLevel ?? '';
    this.permissionInsteadName = init.permissionInsteadName;
    this.permissionHelpUrlKey = init.permissionHelpUrlKey;
  }
}

// =====================================================
// 工具函数
// =====================================================

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value?: string | null): boolean {
  return value === undefined || value === null || value.length === 0;
}

function isNotEmpty(value?: string | null): boolean {
  return !isEmpty(value);
}

function getString(obj: JsonObject, key: string): string {
  const value = obj[key];

  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  return String(value);
}

function getBooleanValue(obj: JsonObject, key: string): boolean {
  const value = obj[key];

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  return false;
}

function getIntValue(obj: JsonObject, key: string): number {
  const value = obj[key];

  if (typeof value === 'number') {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

// =====================================================
// acl权限配置信息
// =====================================================

export class AclPermissionConfig {
  private static readonly MIN_API_TO_FIND_ACL_IN_SDK: number = 23;

  private static readonly ACL_PREFIX = 'ohos.permission.';

  private static readonly ACL_PERMISSIONS_CONFIG_PATH = path.join(
    'aclPermission',
    'aclPermissionsInfo.json'
  );

  private static readonly ACL_HAVE_INSTEAD_NAME: ReadonlySet<string> =
    new Set<string>([
      'ohos.permission.SYSTEM_FLOAT_WINDOW',
      'ohos.permission.READ_CONTACTS',
      'ohos.permission.READ_IMAGEVIDEO',
      'ohos.permission.WRITE_IMAGEVIDEO',
      'ohos.permission.READ_AUDIO',
      'ohos.permission.WRITE_AUDIO',
      'ohos.permission.READ_PASTEBOARD',
    ]);

  private static readonly ACL_AVAILABLE_LEVEL_VALUE = 'system_basic';
  private static readonly ACL_AVAILABLE_TYPE_VALUE = 'NORMAL';

  private static readonly ACL_AVAILABLE_LEVEL_KEY = 'availableLevel';
  private static readonly ACL_AVAILABLE_TYPE_KEY = 'availableType';
  private static readonly ACL_PROVISION_ENABLE_KEY = 'provisionEnable';
  private static readonly ACL_NAME_KEY = 'name';

  private static readonly ACL_CONFIG_PREFIX = 'acl.';
  private static readonly ACL_INSTEAD_NAME_SUFFIX = '.instead.name';
  private static readonly ACL_HELP_URL_KEY_SUFFIX = '.help.key';

  private static readonly ACL_DEFINE_PERMISSION_KEY = 'definePermissions';
  private static readonly ACL_SINCE_KEY = 'since';

  private static readonly PERMISSION_DEFINITIONS_RELATIVE_PATH = path.join(
    'lib',
    'PermissionDefinitions.json'
  );

  private static readonly INCLUDE_ACL_PERMISSIONS: ReadonlySet<string> =
    new Set([
      'ohos.permission.FILE_ACCESS_PERSIST',
      'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
      'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
    ]);

  private static readonly EXCLUDE_ACL_PERMISSIONS: ReadonlySet<string> =
    new Set([
      'ohos.permission.READ_DOCUMENT',
      'ohos.permission.WRITE_DOCUMENT',
    ]);

  public static handleSpecificAclPermissions(): void {
    this.addAclWhiteList(this.INCLUDE_ACL_PERMISSIONS);
    this.addAclBlackList(this.EXCLUDE_ACL_PERMISSIONS);
  }

  private static readonly aclPermissionInfoMap = new Map<
    string,
    Set<AclPermissionInfo>
  >();
  private static readonly aclPermissionNamesMap = new Map<
    string,
    Set<string>
  >();

  private static readonly aclWhiteList = new Set<string>();
  private static readonly aclBlackList = new Set<string>();

  private static builtInConfigTextLoader?: () => string | undefined;

  public static initAclPermission(
    project: Project,
    toolProvider: ToolProvider
  ): void {
    const projectPath = project.rootDir;

    const currentAclNames = this.getOrCreateSet(
      this.aclPermissionNamesMap,
      projectPath
    );
    const currentAclInfos = this.getOrCreateSet(
      this.aclPermissionInfoMap,
      projectPath
    );

    currentAclNames.clear();
    currentAclInfos.clear();

    const sdkPath = path.join(toolProvider.sdkPath, 'default', 'sdk-pkg.json');
    const fullCompileSdkVersion = getApiVersionFromFile(sdkPath);

    if (this.MIN_API_TO_FIND_ACL_IN_SDK - fullCompileSdkVersion > 0) {
      this.initAclPermissionFromBuiltInConfig(currentAclNames, currentAclInfos);
    } else {
      this.initAclPermissionFromSDK(
        toolProvider,
        currentAclNames,
        currentAclInfos
      );
    }
  }

  public static getAclPermissionInfos(
    project: Project
  ): Set<AclPermissionInfo> {
    return (
      this.aclPermissionInfoMap.get(project.rootDir) ??
      new Set<AclPermissionInfo>()
    );
  }

  public static getAclPermissionNames(project: Project): Set<string> {
    return this.aclPermissionNamesMap.get(project.rootDir) ?? new Set<string>();
  }

  public static addAclWhiteList(aclPermissionNames: Iterable<string>): void {
    for (const permissionName of aclPermissionNames) {
      this.aclWhiteList.add(permissionName);
    }
  }

  public static addAclBlackList(aclPermissionNames: Iterable<string>): void {
    for (const permissionName of aclPermissionNames) {
      this.aclBlackList.add(permissionName);
    }
  }

  private static getOrCreateSet<T>(
    map: Map<string, Set<T>>,
    key: string
  ): Set<T> {
    let value = map.get(key);

    if (!value) {
      value = new Set<T>();
      map.set(key, value);
    }

    return value;
  }

  private static readBuiltInConfigText(): string | undefined {
    if (this.builtInConfigTextLoader) {
      return this.builtInConfigTextLoader();
    }

    const configPath = path.join(
      this.getResourcesDir(),
      this.ACL_PERMISSIONS_CONFIG_PATH
    );

    if (fs.existsSync(configPath)) {
      return fs.readFileSync(configPath, 'utf-8');
    }

    return undefined;
  }

  private static getResourcesDir(): string {
    const currentFileUrl = import.meta.url;
    const currentFilePath = fileURLToPath(currentFileUrl);

    if (currentFilePath.includes('dist')) {
      const distDir = path.dirname(currentFilePath);
      const projectRoot = path.dirname(distDir);
      return path.join(projectRoot, 'src', 'resources');
    }

    const utilsDir = path.dirname(currentFilePath);
    const srcDir = path.dirname(utilsDir);
    const projectRoot = path.dirname(srcDir);
    return path.join(projectRoot, 'src', 'resources');
  }

  private static initAclPermissionFromBuiltInConfig(
    currentAclNames: Set<string>,
    currentAclInfos: Set<AclPermissionInfo>
  ): void {
    let text: string | undefined;

    try {
      text = this.readBuiltInConfigText();
    } catch {
      debuglog(`read builtin acl permission failed.`);
      return;
    }

    if (text === undefined) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(text);

      const rawList: unknown[] = Array.isArray(parsed)
        ? parsed
        : isJsonObject(parsed)
          ? Object.values(parsed)
          : [];

      const aclPermissions = rawList
        .filter(isJsonObject)
        .map((item) => new AclPermissionInfo(item as AclPermissionInfoLike));

      aclPermissions.forEach((aclPermissionInfo) => {
        const permissionInsteadName = aclPermissionInfo.permissionInsteadName;

        if (isNotEmpty(permissionInsteadName)) {
          aclPermissionInfo.permissionInsteadName = getAclPermissionInsteadName(
            permissionInsteadName as string
          );
        }

        currentAclNames.add(aclPermissionInfo.permissionName);
      });

      aclPermissions.forEach((aclPermissionInfo) => {
        currentAclInfos.add(aclPermissionInfo);
      });
    } catch (exception) {
      debuglog(`failed to parse aclPermissionsInfo.json: ${exception}`);
    }
  }

  private static initAclPermissionFromSDK(
    toolProvider: ToolProvider,
    currentAclNames: Set<string>,
    currentAclInfos: Set<AclPermissionInfo>
  ): void {
    const permissionArray = this.parsePermissionDefinitionFile(toolProvider);

    if (!permissionArray) {
      return;
    }

    permissionArray.forEach((jsonElement) => {
      if (!isJsonObject(jsonElement)) {
        return;
      }

      const permissionObject = jsonElement;
      const permissionName = getString(permissionObject, this.ACL_NAME_KEY);

      if (!this.isAclPermission(permissionObject, permissionName)) {
        return;
      }

      if (isEmpty(permissionName)) {
        return;
      }

      this.generateAclInfos(currentAclInfos, permissionName, permissionObject);
      currentAclNames.add(permissionName);
    });
  }

  private static isAclPermission(
    permissionObject: JsonObject,
    permissionName: string
  ): boolean {
    if (this.aclWhiteList.has(permissionName)) {
      return true;
    }

    if (this.aclBlackList.has(permissionName)) {
      return false;
    }

    const availableLevel = getString(
      permissionObject,
      this.ACL_AVAILABLE_LEVEL_KEY
    );
    if (availableLevel !== this.ACL_AVAILABLE_LEVEL_VALUE) {
      return false;
    }

    const availableType = getString(
      permissionObject,
      this.ACL_AVAILABLE_TYPE_KEY
    );
    if (availableType !== this.ACL_AVAILABLE_TYPE_VALUE) {
      return false;
    }

    return getBooleanValue(permissionObject, this.ACL_PROVISION_ENABLE_KEY);
  }

  private static generateAclInfos(
    aclPermissionInfos: Set<AclPermissionInfo>,
    permissionName: string,
    permissionObject: JsonObject
  ): void {
    const aclPermissionInfo = new AclPermissionInfo();

    aclPermissionInfo.permissionName = permissionName;

    const displayName = permissionName.startsWith(this.ACL_PREFIX)
      ? permissionName.slice(this.ACL_PREFIX.length)
      : permissionName;

    aclPermissionInfo.permissionDisplayName = displayName;

    const sinceVersion = getIntValue(permissionObject, this.ACL_SINCE_KEY);
    aclPermissionInfo.minSupportApiLevel = String(sinceVersion);

    this.handleInsteadName(aclPermissionInfo, displayName);

    aclPermissionInfos.add(aclPermissionInfo);
  }

  private static parsePermissionDefinitionFile(
    toolProvider: ToolProvider
  ): unknown[] | undefined {
    const configPath = path.join(
      toolProvider.sdkPath, 'default', 'openharmony', 'toolchains',
      this.PERMISSION_DEFINITIONS_RELATIVE_PATH
    );

    if (!fs.existsSync(configPath)) {
      return undefined;
    }

    let text: string;

    try {
      text = fs.readFileSync(configPath, 'utf-8');
    } catch (exception) {
      debuglog(`failed to load permissionDefinitions.json: ${exception}`);
      return undefined;
    }

    let fileObject: JsonObject;

    try {
      const parsed: unknown = JSON.parse(text);

      if (!isJsonObject(parsed)) {
        debuglog('json object is null');
        return undefined;
      }

      fileObject = parsed;
    } catch (exception) {
      debuglog(`failed to parse permissionDefinitions.json: ${exception}`);
      return undefined;
    }

    const definePermissions = fileObject[this.ACL_DEFINE_PERMISSION_KEY];

    if (!Array.isArray(definePermissions)) {
      debuglog('definePermissions is not an array');
      return undefined;
    }

    return definePermissions;
  }

  private static handleInsteadName(
    aclPermissionInfo: AclPermissionInfo,
    displayName: string
  ): void {
    if (!this.ACL_HAVE_INSTEAD_NAME.has(aclPermissionInfo.permissionName)) {
      return;
    }

    aclPermissionInfo.permissionInsteadName = getAclPermissionInsteadName(
      `${this.ACL_CONFIG_PREFIX}${displayName}${this.ACL_INSTEAD_NAME_SUFFIX}`
    );

    aclPermissionInfo.permissionHelpUrlKey = getAclPermissionInsteadName(
      `${this.ACL_CONFIG_PREFIX}${displayName}${this.ACL_HELP_URL_KEY_SUFFIX}`
    );
  }
}
