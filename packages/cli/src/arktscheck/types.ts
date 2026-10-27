/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** 单次 ArkTS 检查的输入参数。 */
export interface ArktsCheckRequest {
  files: string[];
  fix: boolean;
  projectRoot?: string;
}

/** ArkTS 检查输出的单条诊断。 */
export interface ArktsDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  rule: string;
}

/** ArkTS 检查的统计信息。 */
export interface ArktsCheckSummary {
  errorCount: number;
  warnCount: number;
  fixedCount: number;
  checkerDiagCount?: number;
  fileCount: number;
}

/** 单次 ArkTS 检查的执行结果。 */
export interface ArktsCheckResult {
  success: boolean;
  error?: string;
  errors: ArktsDiagnostic[];
  fixed: ArktsDiagnostic[];
  alsoModified: string[];
  summary: ArktsCheckSummary;
}
