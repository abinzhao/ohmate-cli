/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 专为打点上报设计的异常类。
 * 允许开发者传入原始错误信息（message）和用于上报的脱敏信息（traceMessage）。
 */
export class TraceError extends Error {
  /**
   * 用于打点上报的异常信息（通常已脱敏）。
   * 若未提供，则默认使用原始 message。
   */
  public readonly traceMessage: string;

  constructor(message: string, traceMessage?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TraceError';
    this.traceMessage = traceMessage ?? message;
  }
}

/**
 * 从任意异常派生打点上报用的 error_code（脱敏）：
 * TraceError 使用其脱敏信息 traceMessage；
 * 其余 Error 优先取字符串形式的 code（覆盖 errno 码（ENOENT/EACCES 等）及带 code 的校验/业务错误
 * ——如各模块的 ValidationError），无 code 时回退为错误类型名；
 * 不上报原始 message（可能含路径、标识符等敏感内容）。
 */
export function toTraceErrorCode(error: unknown): string {
  if (error instanceof TraceError) {
    return error.traceMessage;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && code !== '' ? code : error.name;
  }
  return 'UnknownError';
}
