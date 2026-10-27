/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { green } from 'colorette';

export interface TableRow {
  cells: string[];
  highlight?: boolean;
}

/**
 * Ranges of wide East Asian characters that occupy 2 columns in a terminal.
 * Covers CJK Unified Ideographs, Extension A/B, Compatibility Ideographs,
 * Fullwidth Forms, Hangul Syllables, and other wide pictographic blocks.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebe0],
] as const;

/** Ranges of zero-width characters (combining marks, control, etc.). */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x300, 0x36f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0x200d, 0x200d],
] as const;

/** Regex to strip ANSI escape sequences (colorette color codes). */
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[([0-9;]*)[a-zA-Z]`,
  'g'
);

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate the visual display width of a string in a terminal,
 * accounting for East Asian wide characters (width 2) and zero-width characters.
 * Also strips ANSI escape sequences before computing width.
 */
function getDisplayWidth(str: string): number {
  // Strip ANSI escape sequences (colorette color codes) first
  const stripped = str.replace(ANSI_ESCAPE_REGEX, '');

  let width = 0;
  let i = 0;
  while (i < stripped.length) {
    const codePoint = stripped.codePointAt(i);
    if (codePoint === undefined) {
      break;
    }

    if (inRanges(codePoint, ZERO_WIDTH_RANGES)) {
      // Zero-width character: don't add to width
    } else if (inRanges(codePoint, WIDE_RANGES)) {
      width += 2;
    } else {
      width += 1;
    }

    // Advance by code point length (1 for BMP, 2 for surrogate pairs)
    i += codePoint > 0xffff ? 2 : 1;
  }

  return width;
}

function padCell(value: string, width: number): string {
  const displayWidth = getDisplayWidth(value);
  return value + ' '.repeat(Math.max(0, width - displayWidth));
}

function computeColumnWidths(
  headers: readonly string[],
  rows: TableRow[]
): number[] {
  return headers.map((header, index) => {
    let width = getDisplayWidth(header);
    for (const row of rows) {
      const cell = row.cells[index] ?? '';
      width = Math.max(width, getDisplayWidth(cell));
    }
    return width;
  });
}

export function renderTable(
  headers: readonly string[],
  rows: TableRow[]
): string {
  const widths = computeColumnWidths(headers, rows);
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padCell(h, widths[i])).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    const line = row.cells
      .map((c, i) => padCell(c ?? '', widths[i]))
      .join('  ')
      .trimEnd();
    lines.push(row.highlight ? green(line) : line);
  }
  return lines.join('\n');
}
