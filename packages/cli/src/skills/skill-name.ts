/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** 校验 Skill 名称，拒绝路径分隔符、特殊目录名称和非法字符。 */
export function assertSafeSkillName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
}
