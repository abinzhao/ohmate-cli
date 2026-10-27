/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Code Linter 报告输出格式。 */
export type CodelinterReportFormat = 'default' | 'json';

/** 单次 Code Linter 检查的输入参数。 */
export interface CodelinterCheckRequest {
  lintPath?: string;
  configPath?: string;
  product: string;
  fix?: boolean;
  incremental?: boolean;
}

/** 单次 Code Linter 检查的执行结果。 */
export interface CodelinterCheckResult {
  exitCode: number;
  diagnostics: string;
  report?: CodelinterReport;
  reportError?: Error;
}

/** 标准化后的 Code Linter 问题。 */
export interface CodelinterIssueRow {
  file: string;
  line?: number;
  column?: number;
  severity: string;
  rule?: string;
  message: string;
}

/** Code Linter 报告统计信息。 */
export interface CodelinterSummary {
  filesChecked: number;
  issues: number;
  errors: number;
  warnings: number;
  suggestions: number;
}

/** 标准化后的 Code Linter 报告。 */
export interface CodelinterReport {
  issues: CodelinterIssueRow[];
  summary: CodelinterSummary;
}

/** 从原生标准输出中提取 JSON 后的结果。 */
export interface JsonExtractionResult {
  jsonText: string | undefined;
  diagnostics: string;
}
