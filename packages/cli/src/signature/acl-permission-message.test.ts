/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { getAclPermissionInsteadName } from './acl-permission-message.js';

describe('getAclPermissionInsteadName', () => {
  it.each([
    ['acl.SYSTEM_FLOAT_WINDOW.instead.name', 'PiPWindow'],
    ['acl.READ_CONTACTS.instead.name', 'contact.selectContacts'],
    ['acl.READ_IMAGEVIDEO.instead.name', 'PhotoViewPicker'],
    ['acl.WRITE_IMAGEVIDEO.instead.name', 'SaveButton'],
    ['acl.READ_AUDIO.instead.name', 'AudioViewPicker'],
    ['acl.WRITE_AUDIO.instead.name', 'AudioViewPicker'],
    ['acl.READ_PASTEBOARD.instead.name', 'PasteButton'],
  ])('maps known key %s → %s', (key, expected) => {
    expect(getAclPermissionInsteadName(key)).toBe(expected);
  });

  it('returns undefined for unknown key', () => {
    expect(
      getAclPermissionInsteadName('acl.UNKNOWN_PERMISSION.instead.name')
    ).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getAclPermissionInsteadName('')).toBeUndefined();
  });

  it('does not resolve prototype-chain keys', () => {
    expect(getAclPermissionInsteadName('constructor')).toBeUndefined();
    expect(getAclPermissionInsteadName('toString')).toBeUndefined();
    expect(getAclPermissionInsteadName('__proto__')).toBeUndefined();
  });
});
