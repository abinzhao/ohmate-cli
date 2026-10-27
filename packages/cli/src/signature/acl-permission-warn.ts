/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { AclPermissionConfig, AclPermissionInfo } from './acl-permission-config.js';
import { Project } from '../utils/project.js';

const HELP_URL_BASE = 'https://developer.huawei.com';

const AclHelpUrls: Record<string, string> = {
  'ohos.permission.SYSTEM_FLOAT_WINDOW':
    '/consumer/cn/doc/harmonyos-guides/window-pipwindow',
  'ohos.permission.READ_CONTACTS':
    '/consumer/cn/doc/harmonyos-references/js-apis-contact#contactselectcontacts10',
  'ohos.permission.READ_IMAGEVIDEO':
    '/consumer/cn/doc/harmonyos-guides/select-user-file#%E9%80%89%E6%8B%A9%E5%9B%BE%E7%89%87%E6%88%96%E8%A7%86%E9%A2%91%E7%B1%BB%E6%96%87%E4%BB%B6',
  'ohos.permission.WRITE_IMAGEVIDEO':
    '/consumer/cn/doc/harmonyos-guides/savebutton',
  'ohos.permission.READ_AUDIO':
    '/consumer/cn/doc/harmonyos-guides/select-user-file#%E9%80%89%E6%8B%A9%E9%9F%B3%E9%A2%91%E7%B1%BB%E6%96%87%E4%BB%B6',
  'ohos.permission.WRITE_AUDIO':
    '/consumer/cn/doc/harmonyos-guides/save-user-file#%E4%BF%9D%E5%AD%98%E9%9F%B3%E9%A2%91%E7%B1%BB%E6%96%87%E4%BB%B6',
  'ohos.permission.READ_PASTEBOARD':
    '/consumer/cn/doc/harmonyos-guides/pastebutton',
};

const ACL_CAN_APPLY_URL =
  '/consumer/cn/doc/harmonyos-guides/restricted-permissions';

function resolveHelpUrl(permissionName: string): string | undefined {
  const path = AclHelpUrls[permissionName];
  return path ? `${HELP_URL_BASE}${path}` : undefined;
}

function resolveCanApplyUrl(): string {
  return `${HELP_URL_BASE}${ACL_CAN_APPLY_URL}`;
}

const AclMessages: Record<string, string> = {
  'acl.can.apply.text': 'Permission Application Scenarios',
  'acl.permissions.warn':
    'Note: You are applying for restricted ACL permissions: {0} These permissions are subject to review together with your app release. For a faster review process, apply for the following permissions instead, if they are sufficient for your purposes: {1} {2}',
};

function getMessage(key: string, args: unknown[]): string {
  const template = AclMessages[key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

function getContentWithSeparator(items: Set<string>): string {
  return Array.from(items).join(', ');
}

/**
 * 打印受限制的acl permission提示
 *
 * @param allPermissions acl权限
 * @param project 工程信息
 */
export function aclPermissionsUsingWarn(
  allPermissions: Set<string>,
  project: Project,
): void {
  if (allPermissions.size === 0) {
    return;
  }

  const allAclPermissionInfos = AclPermissionConfig.getAclPermissionInfos(project);
  const usedAclPermissionsInfo = new Set<AclPermissionInfo>();

  for (const info of allAclPermissionInfos) {
    if (allPermissions.has(info.permissionName)) {
      usedAclPermissionsInfo.add(info);
    }
  }

  for (const aclPermissionInfo of usedAclPermissionsInfo) {
    const url = resolveHelpUrl(aclPermissionInfo.permissionName);
    if (url != null) {
      aclPermissionInfo.permissionHelpUrlKey = url;
    }
  }

  const displayAclPermissions = new Set<string>();
  for (const info of usedAclPermissionsInfo) {
    displayAclPermissions.add(info.permissionDisplayName);
  }

  const aclPermissionsHelpUrl = new Set<string>();
  for (const info of usedAclPermissionsInfo) {
    if (info.permissionHelpUrlKey != null) {
      const insteadName =
        info.permissionInsteadName ?? info.permissionDisplayName;
      aclPermissionsHelpUrl.add(
        `${insteadName} (${info.permissionHelpUrlKey})`
      );
    }
  }

  const canApplyUrl = resolveCanApplyUrl();
  const canApplyText = getMessage('acl.can.apply.text', []);
  const aclPermissionsCanApplyHelpUrl = canApplyUrl
    ? `${canApplyText} (${canApplyUrl})` : canApplyText;

  const helpUrlPart = aclPermissionsHelpUrl.size > 0
    ? Array.from(aclPermissionsHelpUrl).join(', ') + '.' : '';

  const noticeContent = getMessage('acl.permissions.warn', [
    getContentWithSeparator(displayAclPermissions),
    helpUrlPart,
    aclPermissionsCanApplyHelpUrl,
  ]);

  console.log(noticeContent);
}
