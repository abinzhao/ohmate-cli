/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { digest } from '../quality/evidence.js';
const diagnostic = z.object({
  line: z.number().int().positive(), column: z.number().int().positive(),
  severity: z.enum(['error', 'warn', 'warning', 'info']),
  message: z.string().min(1).max(64 * 1024), rule: z.string().min(1).max(512),
}).passthrough();
const schema = z.array(z.object({ filePath: z.string().min(1), messages: z.array(diagnostic).max(10_000) }).passthrough()).max(10_000);

export interface ScanFinding {
  ruleId: string; source: 'official-codelinter'; severity: 'error' | 'warning' | 'info';
  confidence: 'producer'; file: string; line: number; column: number; message: string;
  symbol: null; evidence: { reportHash: string; diagnostic: unknown }; suggestion: null; applicableApi: null; fixable: false;
}
export function normalizeLintReport(text: string, root: string, files: string[]): ScanFinding[] {
  const report = schema.parse(JSON.parse(text)), findings = new Map<string, ScanFinding>();
  for (const entry of report) {
    const path = relative(root, isAbsolute(entry.filePath) ? entry.filePath : resolve(root, entry.filePath)).split(sep).join('/');
    if (!files.includes(path)) { throw new Error('Official diagnostic is outside the requested file scope'); }
    for (const item of entry.messages) {
      const severity = item.severity === 'warn' || item.severity === 'warning' ? 'warning' : item.severity;
      const finding: ScanFinding = { ruleId: item.rule, source: 'official-codelinter', severity, confidence: 'producer',
        file: path, line: item.line, column: item.column, message: item.message, symbol: null,
        evidence: { reportHash: digest(text), diagnostic: item }, suggestion: null, applicableApi: null, fixable: false };
      findings.set(JSON.stringify([path, item.line, item.column, item.rule, severity, item.message]), finding);
    }
  }
  return [...findings.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
}
