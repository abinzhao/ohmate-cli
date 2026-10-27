/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type {
  CodelinterIssueRow,
  CodelinterReport,
  CodelinterSummary,
  JsonExtractionResult,
} from './types.js';

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const CARRIAGE_RETURN_PATTERN = /\r/g;
const PROGRESS_LINE_PATTERN = /^(Working|Finished)\.\.\.\[[^\]]*\]\d+%$/;
const RULE_PREFIX_PATTERN = /^<+\s*/;
const RULE_SUFFIX_PATTERN = /\s*>+$/;
const INFORMATION_LINE_PATTERNS = [
  /^The configuration file .+ is in use\.$/,
  /^The configuration file .+ in the project is in use\.$/,
  /^Currently active product: ?.+$/,
  /^Writing the result to .+\.$/,
  /^Write finished\.$/,
  /^CodeLinter found some defects in your code\.$/,
] as const;
/** Studio 6.0 时过滤Code Linter 原生输出中状态信息和进度消息。 */
const HIDDEN_NATIVE_MESSAGE_TYPES = new Set([1]);

/** 过滤 Code Linter 原生输出中的 ANSI、进度和状态信息。 */
export function filterCodelinterNativeText(text: string | undefined): string {
  if (!text) {
    return '';
  }
  const lines = text
    .replace(ANSI_PATTERN, '')
    .replace(CARRIAGE_RETURN_PATTERN, '\n')
    .split('\n')
    .map(normalizeNativeMessage)
    .map((line) => line.trimEnd())
    .filter((line) => shouldKeepLine(line));

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** 将旧版消息协议转换为可展示诊断文本。 */
function normalizeNativeMessage(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return line;
  }
  try {
    const message = JSON.parse(trimmed) as {
      content?: unknown;
      messageType?: unknown;
    };
    if (
      typeof message.content !== 'string' ||
      typeof message.messageType !== 'number'
    ) {
      return line;
    }
    return HIDDEN_NATIVE_MESSAGE_TYPES.has(message.messageType)
      ? ''
      : message.content;
  } catch {
    return line;
  }
}

const MAX_CODELINTER_OUTPUT_LENGTH = 50 * 1024 * 1024;

/** 从 Code Linter 标准输出中分离 JSON 报告和诊断文本。 */
export function extractJsonFromNativeStdout(
  stdout: string | undefined
): JsonExtractionResult {
  const filtered = filterCodelinterNativeText(stdout).trim();
  if (!filtered) {
    return { jsonText: undefined, diagnostics: '' };
  }

  if (filtered.length > MAX_CODELINTER_OUTPUT_LENGTH) {
    return { jsonText: undefined, diagnostics: `${filtered.slice(0, 1024)}\n[output truncated: exceeded ${MAX_CODELINTER_OUTPUT_LENGTH} bytes]\n` };
  }

  if (isJsonText(filtered)) {
    return { jsonText: filtered, diagnostics: '' };
  }

  // Studio 6.0 为每个已检查文件输出一行独立 JSON。
  const jsonLines = filtered.split('\n');
  if (jsonLines.length > 1 && jsonLines.every(isJsonText)) {
    return {
      jsonText: JSON.stringify(jsonLines.map((line) => JSON.parse(line))),
      diagnostics: '',
    };
  }

  const jsonRange = findJsonRange(filtered);
  if (!jsonRange) {
    return { jsonText: undefined, diagnostics: `${filtered}\n` };
  }

  const diagnostics = [
    filtered.slice(0, jsonRange.start).trim(),
    filtered.slice(jsonRange.end).trim(),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    jsonText: filtered.slice(jsonRange.start, jsonRange.end),
    diagnostics: diagnostics ? `${diagnostics}\n` : '',
  };
}

function isProgressLine(line: string): boolean {
  return PROGRESS_LINE_PATTERN.test(line.trim());
}

function shouldKeepLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    !!trimmed &&
    !isProgressLine(trimmed) &&
    !INFORMATION_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 从混合文本中定位第一个可完整解析的 JSON 数组或对象。 */
function findJsonRange(
  text: string
): { start: number; end: number } | undefined {
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== '[' && ch !== '{') {
      continue;
    }
    const close = ch === '[' ? ']' : '}';
    const end = findMatchingClose(text, start, ch, close);
    if (end !== -1 && isJsonText(text.slice(start, end + 1))) {
      return { start, end: end + 1 };
    }
  }
  return undefined;
}

function findMatchingClose(
  text: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

type JsonObject = Record<string, unknown>;

const SEVERITY_ORDER = [
  'Error',
  'Warning',
  'Suggestion',
  'Info',
  'Off',
  'Unknown',
] as const;

type NormalizedSeverity = (typeof SEVERITY_ORDER)[number];

/** 将 Code Linter 原生 JSON 转换为统一报告模型。 */
export function createCodelinterReport(rawJson: unknown): CodelinterReport {
  const rows = collectRows(rawJson);
  return {
    issues: sortRowsBySeverity(rows),
    summary: summarizeRows(rawJson, rows),
  };
}

function summarizeRows(
  rawJson: unknown,
  rows: CodelinterIssueRow[]
): CodelinterSummary {
  const severityCounts = countRowsBySeverity(rows);
  return {
    filesChecked: collectFileNames(rawJson).size,
    issues: rows.length,
    errors: severityCounts.get('Error') ?? 0,
    warnings: severityCounts.get('Warning') ?? 0,
    suggestions: severityCounts.get('Suggestion') ?? 0,
  };
}

/** 递归兼容不同原生报告层级并收集标准化问题。 */
function collectRows(value: unknown, parentFile = ''): CodelinterIssueRow[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRows(item, parentFile));
  }
  if (!isObject(value)) {
    return [];
  }

  const file = pickString(value, ['filePath', 'file', 'path']) ?? parentFile;
  const nestedRows = collectNestedRows(value, file);
  if (nestedRows.length > 0) {
    return nestedRows;
  }

  const row = toIssueRow(value, file);
  return row ? [row] : [];
}

function collectNestedRows(
  value: JsonObject,
  file: string
): CodelinterIssueRow[] {
  const keys = ['messages', 'defects', 'issues', 'results', 'files'];
  for (const key of keys) {
    const child = value[key];
    if (Array.isArray(child)) {
      const rows = child.flatMap((item) => collectRows(item, file));
      if (rows.length > 0) {
        return rows;
      }
    }
  }
  return [];
}

function toIssueRow(
  value: JsonObject,
  parentFile: string
): CodelinterIssueRow | undefined {
  const message =
    pickString(value, ['message', 'description', 'desc', 'detail']) ?? '';
  const rule = normalizeRuleName(
    pickString(value, ['rule', 'ruleId', 'ruleName'])
  );
  const severity = pickSeverity(value, ['severity', 'level']);
  const file = pickString(value, ['filePath', 'file', 'path']) ?? parentFile;

  if (!message && !rule && severity === 'Unknown') {
    return undefined;
  }

  return {
    file,
    line: pickNumber(value, ['line', 'reportLine']),
    column: pickNumber(value, ['column', 'reportColumn']),
    severity,
    rule,
    message,
  };
}

function sortRowsBySeverity(rows: CodelinterIssueRow[]): CodelinterIssueRow[] {
  return [...rows].sort((a, b) => {
    const severityDiff =
      getSeverityRank(a.severity) - getSeverityRank(b.severity);
    return severityDiff === 0 ? compareLocation(a, b) : severityDiff;
  });
}

function compareLocation(a: CodelinterIssueRow, b: CodelinterIssueRow): number {
  const fileDiff = a.file.localeCompare(b.file);
  if (fileDiff !== 0) {
    return fileDiff;
  }
  const lineDiff =
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
  if (lineDiff !== 0) {
    return lineDiff;
  }
  return (
    (a.column ?? Number.MAX_SAFE_INTEGER) -
    (b.column ?? Number.MAX_SAFE_INTEGER)
  );
}

function countRowsBySeverity(
  rows: CodelinterIssueRow[]
): Map<NormalizedSeverity, number> {
  const counts = new Map<NormalizedSeverity, number>();
  for (const row of rows) {
    const severity = row.severity as NormalizedSeverity;
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return counts;
}

function collectFileNames(value: unknown): Set<string> {
  const files = new Set<string>();
  addFileNames(files, value, '');
  return files;
}

function addFileNames(
  files: Set<string>,
  value: unknown,
  parentFile: string
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addFileNames(files, item, parentFile);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }

  const file = pickString(value, ['filePath', 'file', 'path']) ?? parentFile;
  if (file) {
    files.add(file);
  }
  addNestedFileNames(files, value, file);
}

function addNestedFileNames(
  files: Set<string>,
  value: JsonObject,
  parentFile: string
): void {
  const keys = ['messages', 'defects', 'issues', 'results', 'files'];
  for (const key of keys) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        addFileNames(files, item, parentFile);
      }
    }
  }
}

function pickSeverity(value: JsonObject, keys: string[]): NormalizedSeverity {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number') {
      return normalizeSeverity(item);
    }
  }
  return 'Unknown';
}

function normalizeSeverity(value: string | number): NormalizedSeverity {
  const normalized = String(value).normalize('NFKC').trim().toLowerCase();
  if (normalized === '2' || normalized === 'error' || normalized === 'err') {
    return 'Error';
  }
  if (normalized === '1' || normalized === 'warn' || normalized === 'warning') {
    return 'Warning';
  }
  if (
    normalized === '3' ||
    normalized === 'suggest' ||
    normalized === 'suggestion'
  ) {
    return 'Suggestion';
  }
  if (normalized === 'info' || normalized === 'information') {
    return 'Info';
  }
  if (normalized === '0' || normalized === 'off') {
    return 'Off';
  }
  return 'Unknown';
}

function normalizeRuleName(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized
    .replace(RULE_PREFIX_PATTERN, '')
    .replace(RULE_SUFFIX_PATTERN, '')
    .toLowerCase();
}

function getSeverityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity as NormalizedSeverity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function pickString(value: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string') {
      return item;
    }
  }
  return undefined;
}

function pickNumber(value: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'number') {
      return item;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}
