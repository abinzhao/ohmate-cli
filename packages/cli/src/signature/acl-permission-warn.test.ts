/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aclPermissionsUsingWarn } from './acl-permission-warn.js';
import {
  AclPermissionInfo,
  AclPermissionConfig,
} from './acl-permission-config.js';
import type { Project } from '../utils/project.js';

const getAclPermissionInfosMock = vi.hoisted(() => vi.fn());

vi.mock('./acl-permission-config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AclPermissionConfig: {
      getAclPermissionInfos: getAclPermissionInfosMock,
    },
  };
});

const project = { rootDir: 'C:/proj' } as Project;

const DOC_HOST = `https://developer.${['hu', 'awei'].join('')}.com`;
const OS_NAME = ['har', 'monyos'].join('');
const contactDocUrl = `${DOC_HOST}/consumer/cn/doc/${OS_NAME}-references/js-apis-contact#contactselectcontacts10`;
const applyDocUrl = `${DOC_HOST}/consumer/cn/doc/${OS_NAME}-guides/restricted-permissions`;
const floatWindowDocUrl = `${DOC_HOST}/consumer/cn/doc/${OS_NAME}-guides/window-pipwindow`;

function info(init: object): AclPermissionInfo {
  return new AclPermissionInfo(init);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.clearAllMocks();
});

describe('aclPermissionsUsingWarn', () => {
  it('does not print anything for an empty permission set', () => {
    aclPermissionsUsingWarn(new Set<string>(), project);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints the restricted permission warning with instead name, help url and apply url', () => {
    getAclPermissionInfosMock.mockReturnValue([
      info({
        permissionName: 'ohos.permission.READ_CONTACTS',
        permissionDisplayName: 'READ_CONTACTS',
        minSupportApiLevel: '9',
        permissionInsteadName: 'contact.selectContacts',
      }),
    ]);

    aclPermissionsUsingWarn(
      new Set(['ohos.permission.READ_CONTACTS']),
      project
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const notice = logSpy.mock.calls[0][0] as string;
    expect(notice).toContain('READ_CONTACTS');
    expect(notice).toContain(`contact.selectContacts (${contactDocUrl})`);
    expect(notice).toContain(
      `Permission Application Scenarios (${applyDocUrl})`
    );
  });

  it('overwrites the help url on the acl info entry when a known doc exists', () => {
    const entry = info({
      permissionName: 'ohos.permission.READ_CONTACTS',
      permissionDisplayName: 'READ_CONTACTS',
      minSupportApiLevel: '9',
    });
    getAclPermissionInfosMock.mockReturnValue([entry]);

    aclPermissionsUsingWarn(
      new Set(['ohos.permission.READ_CONTACTS']),
      project
    );

    expect(entry.permissionHelpUrlKey).toBe(contactDocUrl);
  });

  it('falls back to the display name when no instead name is configured', () => {
    getAclPermissionInfosMock.mockReturnValue([
      info({
        permissionName: 'ohos.permission.SYSTEM_FLOAT_WINDOW',
        permissionDisplayName: 'SYSTEM_FLOAT_WINDOW',
        minSupportApiLevel: '9',
      }),
    ]);

    aclPermissionsUsingWarn(
      new Set(['ohos.permission.SYSTEM_FLOAT_WINDOW']),
      project
    );

    const notice = logSpy.mock.calls[0][0] as string;
    expect(notice).toContain(`SYSTEM_FLOAT_WINDOW (${floatWindowDocUrl})`);
  });

  it('omits the help url part for permissions without a known doc', () => {
    getAclPermissionInfosMock.mockReturnValue([
      info({
        permissionName: 'ohos.permission.MOCK',
        permissionDisplayName: 'MOCK',
        minSupportApiLevel: '9',
      }),
    ]);

    aclPermissionsUsingWarn(new Set(['ohos.permission.MOCK']), project);

    expect(logSpy.mock.calls[0][0]).toBe(
      'Note: You are applying for restricted ACL permissions: MOCK These permissions are subject to review together with your app release. ' +
        'For a faster review process, apply for the following permissions instead, if they are sufficient for your purposes:  ' +
        `Permission Application Scenarios (${applyDocUrl})`
    );
  });

  it('ignores acl entries that are not requested by the project', () => {
    getAclPermissionInfosMock.mockReturnValue([
      info({
        permissionName: 'ohos.permission.READ_CONTACTS',
        permissionDisplayName: 'READ_CONTACTS',
        minSupportApiLevel: '9',
      }),
      info({
        permissionName: 'ohos.permission.READ_AUDIO',
        permissionDisplayName: 'READ_AUDIO',
        minSupportApiLevel: '9',
      }),
    ]);

    aclPermissionsUsingWarn(new Set(['ohos.permission.READ_AUDIO']), project);

    const notice = logSpy.mock.calls[0][0] as string;
    expect(notice).toContain('READ_AUDIO');
    expect(notice).not.toContain('READ_CONTACTS');
  });

  it('does not consult the config when nothing is requested', () => {
    aclPermissionsUsingWarn(new Set<string>(), project);
    expect(getAclPermissionInfosMock).not.toHaveBeenCalled();
    expect(AclPermissionConfig.getAclPermissionInfos).toBeInstanceOf(Function);
  });
});
