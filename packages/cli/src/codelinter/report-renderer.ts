/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as path from 'path';
import { renderTable } from '../utils/text-table.js';
import type {
  CodelinterIssueRow,
  CodelinterReport,
  CodelinterSummary,
} from './types.js';

const EMPTY_CELL = 'n/a';
const BACKSLASH_PATTERN = /\\/g;
const MARKDOWN_PIPE_PATTERN = /\|/g;
const LINE_BREAK_PATTERN = /\r?\n/g;

/** 渲染终端中的 Code Linter 问题预览。 */
export function formatTerminalPreview(
  report: CodelinterReport,
  limit?: number
): string {
  if (report.issues.length === 0) {
    return `No defects found.\n${formatCodelinterSummaryLine(report.summary)}\n`;
  }

  const previewRows =
    limit === undefined ? report.issues : report.issues.slice(0, limit);
  const lines = [
    formatFlatRows(previewRows),
    formatCodelinterSummaryLine(report.summary),
  ];
  if (limit !== undefined && previewRows.length < report.issues.length) {
    lines.push(formatLimitHint(report.issues.length, previewRows.length));
  }
  return `${lines.join('\n')}\n`;
}

/** 渲染已保存完整报告时的终端摘要。 */
export function formatTerminalSavedReport(
  report: CodelinterReport,
  outputPath: string
): string {
  return [
    formatCodelinterSummaryLine(report.summary),
    `Full report: ${normalizePath(outputPath)}`,
    '',
  ].join('\n');
}

/** 将 Code Linter 报告渲染为 Markdown 文本。 */
export function formatMarkdownReport(report: CodelinterReport): string {
  const lines = ['# CodeLinter report', ''];
  if (report.issues.length === 0) {
    lines.push('No defects found.', '');
  } else {
    lines.push(...formatMarkdownRows(report.issues), '');
  }
  lines.push('## Summary', '', ...formatMarkdownSummary(report.summary), '');
  return lines.join('\n');
}

/** 将 Code Linter 报告渲染为 JSON 文本。 */
export function formatJsonReport(report: CodelinterReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatCodelinterSummaryLine(summary: CodelinterSummary): string {
  return (
    `Summary: Issues: ${formatCount(summary.issues)} | ` +
    `Errors: ${formatCount(summary.errors)} | ` +
    `Warnings: ${formatCount(summary.warnings)} | ` +
    `Suggestions: ${formatCount(summary.suggestions)} | ` +
    `Files checked: ${formatCount(summary.filesChecked)}`
  );
}

function formatLimitHint(total: number, shown: number): string {
  return (
    `Showing ${formatCount(shown)} of ${formatCount(total)} issues. ` +
    'Use --output-path <path> to write all results.'
  );
}

function formatFlatRows(rows: CodelinterIssueRow[]): string {
  const headers = [
    'No',
    'File',
    'Line',
    'Column',
    'Severity',
    'Rule',
    'Message',
  ];
  const tableRows = rows.map((row, index) => ({
    cells: formatTerminalRow(row, index + 1),
  }));
  return ['CodeLinter report', '', renderTable(headers, tableRows)].join('\n');
}

function formatMarkdownRows(rows: CodelinterIssueRow[]): string[] {
  const lines = [
    '| No | File | Line | Column | Severity | Rule | Message |',
    '| ---: | --- | ---: | ---: | --- | --- | --- |',
  ];
  for (const [index, row] of rows.entries()) {
    lines.push(formatMarkdownRow(row, index + 1));
  }
  return lines;
}

function formatMarkdownRow(row: CodelinterIssueRow, index: number): string {
  const cells = [
    String(index),
    normalizePath(formatCell(row.file)),
    formatNumberCell(row.line),
    formatNumberCell(row.column),
    formatCell(row.severity),
    formatCell(row.rule),
    formatCell(row.message),
  ];
  return `| ${cells.map(escapeMarkdownCell).join(' | ')} |`;
}

function formatMarkdownSummary(summary: CodelinterSummary): string[] {
  return [
    `- Issues: ${formatCount(summary.issues)}`,
    `- Errors: ${formatCount(summary.errors)}`,
    `- Warnings: ${formatCount(summary.warnings)}`,
    `- Suggestions: ${formatCount(summary.suggestions)}`,
    `- Files checked: ${formatCount(summary.filesChecked)}`,
  ];
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(BACKSLASH_PATTERN, '\\\\')
    .replace(MARKDOWN_PIPE_PATTERN, '\\|')
    .replace(LINE_BREAK_PATTERN, '<br>');
}

function formatTerminalRow(row: CodelinterIssueRow, index: number): string[] {
  return [
    String(index),
    normalizePath(formatCell(shortenFilePath(row.file))),
    formatNumberCell(row.line),
    formatNumberCell(row.column),
    formatCell(row.severity),
    formatCell(row.rule),
    formatCell(row.message),
  ];
}

function shortenFilePath(file: string): string {
  if (!path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(process.cwd(), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return file;
  }
  return relative;
}

function normalizePath(value: string): string {
  return value.replace(BACKSLASH_PATTERN, '/');
}

function formatCell(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : EMPTY_CELL;
}

function formatNumberCell(value: number | undefined): string {
  return value === undefined ? EMPTY_CELL : String(value);
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
