/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 已定义的错误，错误信息可直接显示给用户
 */
export class DefinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinedError';
  }
}