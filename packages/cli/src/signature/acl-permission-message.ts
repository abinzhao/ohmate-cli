/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * ACL permission instead name
 */
export const AclPermissionInsteadNames = {
  'acl.SYSTEM_FLOAT_WINDOW.instead.name': 'PiPWindow',
  'acl.READ_CONTACTS.instead.name': 'contact.selectContacts',
  'acl.READ_IMAGEVIDEO.instead.name': 'PhotoViewPicker',
  'acl.WRITE_IMAGEVIDEO.instead.name': 'SaveButton',
  'acl.READ_AUDIO.instead.name': 'AudioViewPicker',
  'acl.WRITE_AUDIO.instead.name': 'AudioViewPicker',
  'acl.READ_PASTEBOARD.instead.name': 'PasteButton',
} as const;

export type AclPermissionInsteadNameKey = keyof typeof AclPermissionInsteadNames;

function isAclPermissionInsteadNameKey(
  key: string
): key is AclPermissionInsteadNameKey {
  return Object.prototype.hasOwnProperty.call(AclPermissionInsteadNames, key);
}

export function getAclPermissionInsteadName(
  key: string
): string | undefined {
  if (isAclPermissionInsteadNameKey(key)) {
    return AclPermissionInsteadNames[key];
  }

  return undefined;
}

export const ACL_PERMISSIONS_MSG = {
  DUPLICATE_PERMISSION:
    'Duplicate permissions detected. Make sure each permission is unique in the same module and try again.',
};
