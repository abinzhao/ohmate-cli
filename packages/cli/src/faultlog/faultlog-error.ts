/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * faultlog 领域稳定错误码：遥测 error_code 的归因维度。消息面向用户可变，码不可变。
 */
import type { FaultLogVerdict } from './types.js';

export type FaultLogErrorCode =
  | 'FILE_NOT_FOUND'
  | 'INPUT_OVERSIZED'
  | 'UNRECOGNIZED_LOG'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_INPUT'
  | 'INTERNAL_ERROR';

/** 带稳定错误码的领域错误；.code 经 resolveLogErrorCode 进入打点 error_code；verdict 携带失败场景的判定结果供打点分类。 */
export class FaultLogError extends Error {
  readonly code: FaultLogErrorCode;
  readonly verdict?: FaultLogVerdict;

  constructor(code: FaultLogErrorCode, message: string, verdict?: FaultLogVerdict) {
    super(message);
    this.name = 'FaultLogError';
    this.code = code;
    this.verdict = verdict;
  }
}
