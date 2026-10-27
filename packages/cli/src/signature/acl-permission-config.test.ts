/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { AclPermissionInfo } from './acl-permission-config.js';

describe('AclPermissionInfo', () => {
  it('defaults all string fields to empty strings', () => {
    const info = new AclPermissionInfo();
    expect(info.permissionName).toBe('');
    expect(info.permissionDisplayName).toBe('');
    expect(info.minSupportApiLevel).toBe('');
    expect(info.permissionInsteadName).toBeUndefined();
    expect(info.permissionHelpUrlKey).toBeUndefined();
  });

  it('copies all provided fields on full init', () => {
    const info = new AclPermissionInfo({
      permissionName: 'perm.read_contacts',
      permissionDisplayName: 'READ_CONTACTS',
      minSupportApiLevel: '10',
      permissionInsteadName: 'contact.selectContacts',
      permissionHelpUrlKey: 'https://example.com',
    });
    expect(info.permissionName).toBe('perm.read_contacts');
    expect(info.permissionDisplayName).toBe('READ_CONTACTS');
    expect(info.minSupportApiLevel).toBe('10');
    expect(info.permissionInsteadName).toBe('contact.selectContacts');
    expect(info.permissionHelpUrlKey).toBe('https://example.com');
  });

  it('fills defaults for omitted fields on partial init', () => {
    const info = new AclPermissionInfo({ permissionName: 'perm.x' });
    expect(info.permissionName).toBe('perm.x');
    expect(info.permissionDisplayName).toBe('');
    expect(info.minSupportApiLevel).toBe('');
    expect(info.permissionInsteadName).toBeUndefined();
    expect(info.permissionHelpUrlKey).toBeUndefined();
  });
});
