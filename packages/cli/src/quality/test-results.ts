/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
interface CaseRecord { name: string; status: 'Success' | 'Failure' | 'Error' | 'Ignore'; }
const summaryPattern = /^Tests run: (\d+), Failure: (\d+), Error: (\d+), Pass: (\d+), Ignore: (\d+)$/;
const bracketPattern = /^\[(pass|fail)\]\s+([^#\0]+#[^#\0]+)$/i;
function officialRecords(lines: string[]) {
  const records: CaseRecord[] = [], summaries: number[][] = [];
  let suite = '', method = '', valid = true;
  for (const line of lines) {
    if (line.startsWith('class=')) {
      if (method) { valid = false; }
      suite = line.slice(6); method = '';
      if (!suite || /[#\0]/.test(suite)) { valid = false; }
    } else if (line.startsWith('test=')) {
      if (method || summaries.length) { valid = false; }
      method = line.slice(5);
      if (!method || /[#\0]/.test(method)) { valid = false; }
    } else if (line.startsWith('result=')) {
      const status = line.slice(7);
      if (!suite || !method || !['Success', 'Failure', 'Error', 'Ignore'].includes(status)) { valid = false; }
      else { records.push({ name: `${suite}#${method}`, status: status as CaseRecord['status'] }); }
      method = '';
    } else if (line.startsWith('Tests run:')) {
      const summary = line.match(summaryPattern);
      if (!summary) { valid = false; }
      else { summaries.push(summary.slice(1).map(Number)); }
    } else if (/^\[(?:pass|fail)\]/i.test(line)) { valid = false; }
  }
  const statuses = ['Failure', 'Error', 'Success', 'Ignore'];
  const counts = [records.length, ...statuses.map((status) => records.filter((item) => item.status === status).length)];
  return { records, valid: valid && !method && summaries.length === 1 && summaries[0].every((value, index) => value === counts[index]) };
}
export function parseTestResults(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()), official = lines.some((line) => /^(?:class|test|result)=/.test(line));
  const parsed = official ? officialRecords(lines) : {
    records: lines.flatMap((line) => {
      const match = line.match(bracketPattern);
      return match ? [{ name: match[2], status: match[1].toLowerCase() === 'pass' ? 'Success' as const : 'Failure' as const }] : [];
    }), valid: !lines.some((line) => line.startsWith('Tests run:') || /^\[(?:pass|fail)\]/i.test(line) && !bracketPattern.test(line)),
  };
  const cases = parsed.records.map((item) => item.name), passed = parsed.records.filter((item) => item.status === 'Success').length;
  const ignored = parsed.records.filter((item) => item.status === 'Ignore').length, failed = cases.length - passed - ignored;
  return { format: official ? 'official-key-value' : cases.length ? 'bracket-records' : 'unknown',
    complete: parsed.valid && cases.length > 0 && new Set(cases).size === cases.length,
    passed, failed, ignored, cases, records: parsed.records };
}
