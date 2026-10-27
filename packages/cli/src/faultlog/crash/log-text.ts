/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * 日志文本通用工具（freeze/common.py + cppcrash/common.py 的合并移植）：
 * 行读取、区段定位、字段提取、按标记行分段、时间解析与格式化。
 */
import * as fs from 'fs';

/** faultlog 中出现过的时间格式（与 freeze/common.py _TIME_RES 一致）。 */
const TIME_RES: readonly RegExp[] = [
  /^(\d{4})[-/](\d{2})[-/](\d{2})[ \-T](\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,6}))?$/,
  /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,6}))?$/,
  /^(\d{4})(\d{2})(\d{2})-?(\d{2})(\d{2})(\d{2})(\d{0,6})$/,
];

const ENGLISH_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** 统一换行为 \n、去 BOM、按行拆分（行内不含换行符）。 */
export function splitLogLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const stripped = normalized.startsWith('\ufeff') ? normalized.slice(1) : normalized;
  return stripped.split('\n');
}

/** 读取文件并拆行；文件不存在或不可读时抛错。 */
export function readFileLines(filePath: string): string[] {
  return splitLogLines(fs.readFileSync(filePath, 'utf8'));
}

/** 取路径最后一段（等价 Python split('/')[-1]）。 */
export function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

/**
 * 定位一个日志区段：从 lines 中找到第一个匹配 startRe 的行，再从它之后找第一个
 * 匹配 endRe 的行。返回 [区段行列表, 区段起始下标]；找不到起始行返回 [[], -1]；
 * 找不到结束行则截取到末尾。
 */
export function findSection(
  lines: string[],
  startRe: RegExp,
  endRe: RegExp,
  includeStart = true
): [string[], number] {
  let startIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (startRe.test(lines[index])) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) {
    return [[], -1];
  }
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index++) {
    if (endRe.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const begin = includeStart ? startIndex : startIndex + 1;
  return [lines.slice(begin, endIndex), startIndex];
}

/** 用 {字段名: 正则} 在多行文本中提取首个命中的捕获组 1，返回 {字段名: 值}。 */
export function searchFields(
  lines: string[],
  fieldRes: Record<string, RegExp>
): Record<string, string> {
  const remaining = new Map(Object.entries(fieldRes));
  const result: Record<string, string> = {};
  for (const line of lines) {
    if (remaining.size === 0) {
      break;
    }
    for (const key of [...remaining.keys()]) {
      const pattern = remaining.get(key);
      if (pattern === undefined) {
        continue;
      }
      const match = pattern.exec(line);
      if (match !== null && match[1] !== undefined && match[1].trim() !== '') {
        result[key] = match[1].trim();
        remaining.delete(key);
      }
    }
  }
  return result;
}

/**
 * 按一组顺序出现的标记行把日志切段（cppcrash/common.py split_by_markers）。
 * 返回 Map：'' 键为第一个标记之前的行；缺失的标记对应空数组。
 */
export function splitByMarkers(lines: string[], markers: string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>([['', []]]);
  for (const marker of markers) {
    sections.set(marker, []);
  }
  let current = '';
  let remaining = [...markers];
  for (const line of lines) {
    for (let index = 0; index < remaining.length; index++) {
      if (line.trimStart().startsWith(remaining[index])) {
        current = remaining[index];
        remaining = remaining.slice(index + 1);
        break;
      }
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

/** 构造本地时间并校验组件未回卷（Python datetime 抛 ValueError 的等价物）。 */
function makeDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number
): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, second, ms);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second ||
    date.getMilliseconds() !== ms
  ) {
    return null;
  }
  return date;
}

/** 解析 'Thu May 21 07:55:59 2025' 这种英文时间（SERVICE_BLOCK 的 MSG 中出现）。 */
function parseEnglishTime(timeStr: string): Date | null {
  const match = /\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})/.exec(timeStr);
  if (match === null) {
    return null;
  }
  const month = ENGLISH_MONTHS[match[1].toLowerCase()] ?? 0;
  if (month === 0) {
    return null;
  }
  return makeDate(
    Number.parseInt(match[6], 10),
    month,
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    Number.parseInt(match[4], 10),
    Number.parseInt(match[5], 10),
    0
  );
}

/** 把日志中的时间字符串解析为 Date（毫秒精度），无法识别时返回 null。 */
export function parseTime(timeStr: string): Date | null {
  if (!timeStr) {
    return null;
  }
  const trimmed = timeStr.trim();
  for (const regex of TIME_RES) {
    const match = regex.exec(trimmed);
    if (match === null) {
      continue;
    }
    const frac = (match[7] ?? '').padEnd(6, '0').slice(0, 6);
    const ms = Math.floor(Number.parseInt(frac, 10) / 1000);
    const date = makeDate(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
      Number.parseInt(match[4], 10),
      Number.parseInt(match[5], 10),
      Number.parseInt(match[6], 10),
      ms
    );
    if (date !== null) {
      return date;
    }
  }
  return parseEnglishTime(trimmed);
}

/** Date 转字符串 'YYYY-MM-DD HH:MM:SS.mmm'，null 安全。 */
export function fmtTime(date: Date | null): string {
  if (date === null) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}
