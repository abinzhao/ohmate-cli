/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { assertPublicValue } from '../tasks/task-state.js';

const nameOptions = ['-keep-global-name', '-keep-property-name', '-keep-file-name'] as const;
const switches = ['-disable-obfuscation', '-enable-property-obfuscation', '-enable-string-property-obfuscation',
  '-enable-toplevel-obfuscation', '-enable-export-obfuscation', '-enable-filename-obfuscation',
  '-enable-lib-obfuscation-options', '-enable-bytecode-obfuscation', '-enable-bytecode-obfuscation-debugging',
  '-remove-comments', '-compact', '-remove-log', '-use-keep-in-source'] as const;
const name = z.string().min(1).max(256).regex(/^[^-\s,'"#][^\s,'"#]*$/)
  .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const ruleEditSchema = z.union([
  z.strictObject({ operation: z.enum(['add', 'remove']), option: z.enum(nameOptions), values: z.array(name).min(1).max(100) }),
  z.strictObject({ operation: z.enum(['add', 'remove']), option: z.enum(switches) }),
]);
type RuleEdit = z.infer<typeof ruleEditSchema>;
interface Token { text: string; start: number; end: number; line: number }
interface Rule { option: Token; values: Token[] }
export interface RuleFinding { code: string; line: number }
const supported = new Set<string>([...nameOptions, ...switches]);
const names = new Set<string>(nameOptions);
export function isArkguardPath(path: string) { return /(?:^|\/)(?:obfuscation|consumer)-rules\.txt$/.test(path); }

function parseRules(text: string) {
  const rules: Rule[] = [], findings: RuleFinding[] = [];
  let line = 1, previous = 0, count = 0;
  for (const match of text.matchAll(/#[^\n]*|[^',\t \r\n\ufeff#]+/g)) {
    line += text.slice(previous, match.index).split('\n').length - 1; previous = match.index;
    if (match[0].startsWith('#')) { continue; }
    if (++count > 10_000) { throw new Error('ArkGuard rule input exceeds 10000 tokens'); }
    const token = { text: match[0], start: match.index, end: match.index + match[0].length, line };
    if (token.text.startsWith('-')) { rules.push({ option: token, values: [] }); }
    else if (rules.length) { rules.at(-1)!.values.push(token); }
    else { findings.push({ code: 'ARKGUARD_ORPHAN_VALUE', line: token.line }); }
  }
  return { rules, findings };
}
function findingsFor(rule: Rule, consumer: boolean): RuleFinding[] {
  const option = rule.option.text, findings: RuleFinding[] = [], line = rule.option.line;
  if (!supported.has(option)) { return [{ code: 'ARKGUARD_UNSUPPORTED_OPTION', line }]; }
  if (consumer && option !== '-keep-global-name' && option !== '-keep-property-name') { findings.push({ code: 'ARKGUARD_CONSUMER_OPTION', line }); }
  if (names.has(option) ? !rule.values.length : rule.values.length) { findings.push({ code: 'ARKGUARD_ARGUMENTS_INVALID', line }); }
  if (option === '-keep-file-name' && rule.values.some((value) => /[/\\]|\*\*/.test(value.text))) { findings.push({ code: 'ARKGUARD_FILENAME_INVALID', line }); }
  return findings;
}
export function inspectRules(text: string, consumer: boolean) {
  assertPublicValue(text);
  const parsed = parseRules(text), findings = [...parsed.findings, ...parsed.rules.flatMap((rule) => findingsFor(rule, consumer))];
  const invalid = findings.some((finding) => finding.code !== 'ARKGUARD_UNSUPPORTED_OPTION');
  return { parser: 'arkguard', rules: parsed.rules.map((rule) => ({
    option: rule.option.text, values: rule.values.map((value) => value.text), line: rule.option.line,
  })), findings, valid: invalid ? false : findings.length ? null : true,
  officialValidation: 'not-run', effectiveMerge: 'not-run', requiredBuildMode: 'release',
  grammar: 'ohmate-arkguard-subset-v1', unsupportedOptions: findings.filter((finding) => finding.code === 'ARKGUARD_UNSUPPORTED_OPTION').length };
}
function semanticRules(rules: Rule[]) {
  const options = new Map<string, Set<string>>();
  for (const rule of rules) { options.set(rule.option.text, new Set([...options.get(rule.option.text) ?? [], ...rule.values.map((value) => value.text)])); }
  return options;
}
function canonical(rules: Map<string, Set<string>>) {
  return JSON.stringify([...rules].map(([key, values]) => [key, [...values].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}
function expectedRules(rules: Rule[], edits: RuleEdit[]) {
  const expected = semanticRules(rules), touched = new Set<string>();
  for (const edit of edits) {
    assertPublicValue(edit);
    const keys = 'values' in edit ? edit.values : [''];
    const values = expected.get(edit.option);
    for (const key of keys) {
      const identity = JSON.stringify([edit.option, key]);
      if (touched.has(identity)) { throw new Error('Overlapping ArkGuard rule edits'); }
      touched.add(identity);
      const exists = values !== undefined && (!names.has(edit.option) || values.has(key));
      if (edit.operation === 'add' ? exists : !exists) { throw new Error('ArkGuard rule edit has no change or removes a missing value'); }
    }
    if (edit.operation === 'add') { expected.set(edit.option, new Set([...values ?? [], ...'values' in edit ? edit.values : []])); }
    else if (!names.has(edit.option)) { expected.delete(edit.option); }
    else {
      for (const key of keys) { values!.delete(key); }
      if (!values!.size) { expected.delete(edit.option); }
    }
  }
  return expected;
}
export function editRules(text: string, edits: RuleEdit[], consumer: boolean) {
  const parsed = parseRules(text), before = inspectRules(text, consumer);
  if (before.unsupportedOptions || parsed.findings.length) { throw new Error('Unsupported ArkGuard grammar cannot be edited losslessly'); }
  const expected = expectedRules(parsed.rules, edits), deletions: Token[] = [];
  for (const rule of parsed.rules) {
    const removals = edits.filter((edit) => edit.operation === 'remove' && edit.option === rule.option.text);
    if (!removals.length) { continue; }
    if (!names.has(rule.option.text)) { deletions.push(rule.option); continue; }
    const removed = new Set(removals.flatMap((edit) => 'values' in edit ? edit.values : []));
    const tokens = rule.values.filter((token) => removed.has(token.text));
    deletions.push(...tokens);
    if (tokens.length === rule.values.length) { deletions.push(rule.option); }
  }
  let next = text;
  for (const token of deletions.sort((a, b) => b.start - a.start)) { next = next.slice(0, token.start) + next.slice(token.end); }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const edit of edits.filter((edit) => edit.operation === 'add')) {
    next += `${next && !next.endsWith('\n') ? newline : ''}${edit.option}${'values' in edit ? ` ${edit.values.join(' ')}` : ''}${newline}`;
  }
  if (inspectRules(next, consumer).valid !== true || canonical(expected) !== canonical(semanticRules(parseRules(next).rules))) {
    throw new Error('ArkGuard semantic verification failed or output violates the supported rule policy');
  }
  return { text: next, rules: edits, grammar: before.grammar, officialValidation: 'not-run', effectiveMerge: 'not-run' };
}
