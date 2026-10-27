/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { isDeepStrictEqual } from 'node:util';
import JSON5 from 'json5';
import { z } from 'zod';
import { assertPublicValue } from '../tasks/task-state.js';
import { findSpan, parseSpans, type ValueSpan } from './json5-spans.js';

const fieldSchema = z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1).max(32);
export const fieldEditSchema = z.union([
  z.strictObject({ operation: z.literal('replace').optional(), field: fieldSchema, value: z.json() }),
  z.strictObject({ operation: z.literal('add'), field: fieldSchema, value: z.json() }),
  z.strictObject({ operation: z.literal('remove'), field: fieldSchema }),
]);
type FieldEdit = z.infer<typeof fieldEditSchema>;
interface Edit {
  field: (string | number)[]; operation: 'add' | 'replace' | 'remove'; parent: ValueSpan;
  span?: ValueSpan; key: string | number; before: unknown; after: unknown;
}
interface Replacement { start: number; end: number; text: string }

function prepare(text: string, tree: ValueSpan, input: FieldEdit[]): Edit[] {
  return input.map((edit) => {
    if (edit.field.some((key) => ['__proto__', 'prototype', 'constructor'].includes(String(key)))) { throw new Error('Unsafe field'); }
    const operation = edit.operation ?? 'replace', key = edit.field.at(-1)!;
    const parent = findSpan(tree, edit.field.slice(0, -1)), span = parent.children?.get(key);
    if (!parent.children || (parent.kind === 'array' ? typeof key !== 'number' : typeof key !== 'string')) { throw new Error('Invalid container or index type'); }
    if (operation === 'add' && (parent.kind === 'object' ? span !== undefined : Number(key) > parent.children.size)) { throw new Error('Add requires a missing key or an existing array insertion index'); }
    if (operation !== 'add' && !span) { throw new Error('JSON5 field does not exist'); }
    if (operation === 'replace' && span?.children) { throw new Error('Edit individual leaf fields to preserve nested comments and formatting'); }
    const before = operation === 'add' ? undefined : JSON5.parse(text.slice(span!.start, span!.end)) as unknown;
    const after = 'value' in edit ? edit.value : undefined;
    assertPublicValue(after);
    if (operation === 'replace' && isDeepStrictEqual(before, after)) { throw new Error('Configuration edit has no change'); }
    return { field: edit.field, operation, parent, span, key, before, after };
  });
}
function assertDisjoint(edits: Edit[]) {
  for (let index = 0; index < edits.length; index++) {
    const field = edits[index].field;
    for (const other of edits.slice(index + 1)) {
      if (field.slice(0, Math.min(field.length, other.field.length)).every((key, i) => key === other.field[i])) {
        throw new Error('Overlapping JSON5 fields');
      }
    }
  }
}
function removeRange(span: { start: number; end: number }): Replacement { return { ...span, text: '' }; }
function insertion(text: string, parent: ValueSpan, entries: string[]): Replacement {
  const closing = parent.closeStart!, lineStart = text.lastIndexOf('\n', closing - 1) + 1;
  const closingIndent = text.slice(lineStart, closing), child = parent.children?.values().next().value as ValueSpan | undefined;
  const trailing = [...parent.children!.values()].at(-1)?.comma ? ',' : '';
  if (!/^[\t ]*$/.test(closingIndent) || !text.slice(parent.start, closing).includes('\n')) {
    return { start: closing, end: closing, text: `${entries.join(', ')}${trailing}` };
  }
  const memberStart = child?.memberStart ?? parent.start, memberLine = text.lastIndexOf('\n', memberStart - 1) + 1;
  const existingIndent = text.slice(memberLine, memberStart);
  const indent = /^[\t ]+$/.test(existingIndent) && existingIndent.length > closingIndent.length ? existingIndent : `${closingIndent}  `;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return { start: lineStart, end: lineStart, text: `${entries.map((entry) => `${indent}${entry}`).join(`,${newline}`)}${trailing}${newline}` };
}
function structuralReplacements(text: string, parent: ValueSpan, edits: Edit[]): Replacement[] {
  const children = [...parent.children!.values()], removed = new Set(edits.filter((e) => e.operation === 'remove').map((e) => e.span));
  const output: Replacement[] = [], appended: string[] = [];
  for (const edit of edits) {
    if (edit.operation === 'remove') {
      output.push(removeRange({ start: edit.span!.memberStart!, end: edit.span!.end }));
      if (edit.span!.comma) { output.push(removeRange(edit.span!.comma)); }
    }
    if (edit.operation !== 'add') { continue; }
    const value = JSON.stringify(edit.after);
    if (parent.kind === 'array' && edit.span) { output.push({ start: edit.span.memberStart!, end: edit.span.memberStart!, text: `${value}, ` }); }
    else { appended.push(parent.kind === 'array' ? value : `${JSON.stringify(edit.key)}: ${value}`); }
  }
  const last = children.filter((child) => !removed.has(child)).at(-1);
  if (last?.comma && !appended.length && !children.at(-1)?.comma) { output.push(removeRange(last.comma)); }
  if (appended.length) {
    if (last && !last.comma) { output.push({ start: last.end, end: last.end, text: ',' }); }
    output.push(insertion(text, parent, appended));
  }
  return output;
}
function verifySemantics(original: unknown, next: unknown, edits: Edit[]) {
  const expected = JSON5.parse(JSON5.stringify(original)) as unknown;
  // Coordinates refer to the reviewed snapshot, so array changes apply from the end.
  const ordered = [...edits].sort((a, b) => a.parent === b.parent && a.parent.kind === 'array' ? Number(b.key) - Number(a.key) : b.parent.start - a.parent.start);
  for (const edit of ordered) {
    let node = expected as Record<string | number, unknown>;
    for (const key of edit.field.slice(0, -1)) { node = node[key] as Record<string | number, unknown>; }
    if (Array.isArray(node) && edit.operation !== 'replace') { node.splice(Number(edit.key), edit.operation === 'remove' ? 1 : 0, ...edit.operation === 'add' ? [edit.after] : []); }
    else if (edit.operation === 'remove') { delete node[edit.key]; }
    else { node[edit.key] = edit.after; }
  }
  if (!isDeepStrictEqual(expected, next)) { throw new Error('JSON5 semantic verification failed'); }
}
export function editJson5(text: string, input: FieldEdit[]) {
  const original: unknown = JSON5.parse(text), tree = parseSpans(text), edits = prepare(text, tree, input);
  assertPublicValue(original); assertDisjoint(edits);
  const groups = new Map<ValueSpan, Edit[]>();
  for (const edit of edits) { groups.set(edit.parent, [...groups.get(edit.parent) ?? [], edit]); }
  const replacements = edits.filter((edit) => edit.operation === 'replace').map((edit) => ({ start: edit.span!.start, end: edit.span!.end, text: JSON.stringify(edit.after) }));
  for (const [parent, group] of groups) { replacements.push(...structuralReplacements(text, parent, group)); }
  const merged = new Map<string, Replacement>();
  for (const change of replacements) {
    const key = `${change.start}:${change.end}`, previous = merged.get(key);
    merged.set(key, previous && change.start === change.end ? { ...change, text: previous.text + change.text } : change);
  }
  const unique = [...merged.values()].sort((a, b) => b.start - a.start);
  let next = text;
  for (const change of unique) { next = next.slice(0, change.start) + change.text + next.slice(change.end); }
  const parsed: unknown = JSON5.parse(next);
  assertPublicValue(parsed); verifySemantics(original, parsed, edits);
  return { text: next, fields: edits.map(({ field, operation, before, after }) => ({
    field, operation, beforeExists: operation !== 'add', afterExists: operation !== 'remove',
    ...operation !== 'add' ? { before } : {}, ...operation !== 'remove' ? { after } : {},
  })) };
}
