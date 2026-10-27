/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { ModuleNode, Project } from '../utils/project';
import { getApiVersionFromFile } from './sdk-config';
import { ToolProvider } from '../toolchain';
import { AclPermissionConfig } from './acl-permission-config';
import { ACL_PERMISSIONS_MSG } from './acl-permission-message';

interface JsonObject {
  [key: string]: unknown;
}

/**
 * acl permission获取
 *
 * @param project 工程信息
 * @param toolProvider ide工具
 */
export function getAutoSignProjectReqPermissions(
  project: Project,
  toolProvider: ToolProvider,
): Set<string> {
  const allPermissions = new Set<string>();
  const duplicatePermissionModules = new Set<string>();

  AclPermissionConfig.handleSpecificAclPermissions();
  AclPermissionConfig.initAclPermission(project, toolProvider);

  for (const module of project.profile.modules) {
    const reqPermissionsFromMain = getReqPermissions(
      module,
      project,
      toolProvider,
      duplicatePermissionModules,
      path.join('src', 'main')
    );
    for (const p of reqPermissionsFromMain) {
      allPermissions.add(p);
    }

    const reqPermissionsFromTest = getReqPermissions(
      module,
      project,
      toolProvider,
      duplicatePermissionModules,
      path.join('src', 'ohosTest')
    );
    for (const p of reqPermissionsFromTest) {
      allPermissions.add(p);
    }
  }
  checkWrongPermissions(duplicatePermissionModules);
  return allPermissions;
}

function checkWrongPermissions(duplicatePermissionModules: Set<string>) {
  if (duplicatePermissionModules.size > 0) {
    throw new Error(ACL_PERMISSIONS_MSG.DUPLICATE_PERMISSION);
  }
}

function getReqPermissions(module: ModuleNode, project: Project, toolProvider: ToolProvider,
  duplicatePermissionModules: Set<string>, configFileRelativePath: string
): Set<string> {
  const reqPermissionArray = findReqPermissionsFromFile(
    project.rootDir,
    module,
    configFileRelativePath
  );
  if (reqPermissionArray == null) {
    return new Set<string>();
  }

  const permissionList: string[] = [];
  for (const jsonValue of reqPermissionArray) {
    if (typeof jsonValue !== 'object' || jsonValue === null) {
      continue;
    }
    const permissionStr = getJsonString(jsonValue as JsonObject, 'name');
    if (permissionStr) {
      permissionList.push(permissionStr);
    }
  }

  const distinctPermissionList = new Set(permissionList);
  if (distinctPermissionList.size !== permissionList.length) {
    duplicatePermissionModules.add(module.name);
  }
  const sdkPath = path.join(toolProvider.sdkPath, 'default', 'sdk-pkg.json');
  const fullCompileSdkVersion: number = getApiVersionFromFile(sdkPath);
  const permissionInfos = AclPermissionConfig.getAclPermissionInfos(project);

  const permissionWhitelist = new Set(
    Array.from(permissionInfos)
      .filter((info) => {
        const minSupportApiLevel = Number(info.minSupportApiLevel);
        return (
          Number.isFinite(minSupportApiLevel) &&
          minSupportApiLevel <= fullCompileSdkVersion
        );
      })
      .map((info) => info.permissionName)
  );

  for (const permission of Array.from(distinctPermissionList)) {
    if (!permissionWhitelist.has(permission)) {
      distinctPermissionList.delete(permission);
    }
  }
  return distinctPermissionList;
}

function getJsonString(jsonObject: JsonObject, key: string): string {
  const value = jsonObject[key];
  return typeof value === 'string' ? value : '';
}

function findReqPermissionsFromFile(
  projectPath: string,
  module: ModuleNode,
  configFileRelativePath: string
): unknown[] | null {
  const configFilePath = path.join(
    projectPath,
    module.srcPath,
    configFileRelativePath,
    'module.json5'
  );

  const rootJsonObject = findJsonObjectFromFile(configFilePath);
  if (rootJsonObject == null) {
    return null;
  }

  const moduleJsonObject = getJsonObject(rootJsonObject, 'module');
  if (moduleJsonObject == null) {
    return null;
  }

  return getJsonObjectArray(moduleJsonObject, 'requestPermissions');
}

function findJsonObjectFromFile(filePath: string): JsonObject | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON5.parse(content) as JsonObject;
  } catch {
    return null;
  }
}

function getJsonObject(
  jsonObject: JsonObject | null,
  key: string
): JsonObject | null {
  if (jsonObject == null || typeof jsonObject !== 'object') {
    return null;
  }
  const value = jsonObject[key];
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function getJsonObjectArray(
  jsonObject: JsonObject | null,
  key: string
): unknown[] | null {
  if (jsonObject == null || typeof jsonObject !== 'object') {
    return null;
  }
  const value = jsonObject[key];
  return Array.isArray(value) ? value : null;
}
