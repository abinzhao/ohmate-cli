/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../quality/evidence.js';
import type { PublicSymbol } from './compiler-exports.js';
const text = z.string().max(64 * 1024);
export const apiEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/), file: text, kind: text, name: text,
  signature: text, description: text, tags: z.array(z.unknown()).max(512),
});
export type ApiEntry = z.infer<typeof apiEntrySchema>;
export const apiModelSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), producer: z.literal('official-arktsdoc'),
  scope: z.strictObject({ modules: z.array(text), files: z.array(text) }),
  entries: z.array(apiEntrySchema).max(10_000),
});
export function extractArkDocJson(html: string): unknown {
  const marker = /window\.getArkDocInfo\s*=\s*function\s*\(\s*\)\s*\{\s*return\s+/g;
  const matches = [...html.matchAll(marker)];
  if (matches.length !== 1) { throw new Error('Expected one official ArkTSDoc JSON model'); }
  const begin = matches[0].index! + matches[0][0].length;
  const suffix = /;\s*}\s*;\s*<\/script\s*>/i.exec(html.slice(begin));
  if (!suffix) { throw new Error('Unrecognized ArkTSDoc model wrapper'); }
  return JSON.parse(html.slice(begin, begin + suffix.index));
}
const object = z.object({
  name: text, kind: text, signature: z.object({ label: text }), description: text.optional(),
  tags: z.array(z.unknown()).optional(), modifiers: z.array(text).optional(),
  classLikeInfo: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
function stableDocumentation(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(stableDocumentation); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'allIdMap', 'createTime'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableDocumentation(child)]));
  }
  return value;
}
function apiEntry(value: unknown, file: string, parent?: string): ApiEntry[] {
  const entry = object.parse(value);
  if (entry.modifiers?.some((modifier) => /^(private|protected)$/i.test(modifier))) { return []; }
  const name = parent ? `${parent}.${entry.name}` : entry.name, kind = entry.kind;
  const id = digest(JSON.stringify([file, kind, name]));
  const normalized = { id, file, kind, name, signature: entry.signature.label, description: entry.description ?? '',
    tags: (entry.tags ?? []).map(stableDocumentation) };
  const children = ['methods', 'properties', 'accessors'].flatMap((key) => {
    const items = entry.classLikeInfo?.[key] ?? [];
    if (!Array.isArray(items) || items.length > 1000) { throw new Error('Invalid ArkTSDoc member list'); }
    return items.flatMap((child) => apiEntry(child, file, name));
  });
  return [normalized, ...children];
}
export function normalizeArkDoc(model: unknown, file: string, names: Set<string>): ApiEntry[] {
  const queue: unknown[] = [model], entries: ApiEntry[] = [];
  let count = 0, seenFile = false;
  while (queue.length) {
    if (++count > 10_000) { throw new Error('ArkTSDoc model exceeds the node budget'); }
    const node = z.object({ fileKind: text.optional(), filePath: text.optional(), children: z.array(z.unknown()).optional(),
      jsDoc: z.array(z.unknown()).optional() }).passthrough().parse(queue.shift());
    if (node.fileKind === 'file') {
      const path = node.filePath?.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!path || isAbsolute(path) || /(?:^|\/)\.\.(?:\/|$)/.test(path) || path !== file && !file.endsWith(`/${path}`)) {
        throw new Error('ArkTSDoc file is outside the selected source scope');
      }
      seenFile = true;
      for (const declaration of node.jsDoc ?? []) {
        const entry = object.parse(declaration);
        if (names.has(entry.name)) { entries.push(...apiEntry(entry, file)); }
      }
    }
    queue.push(...node.children ?? []);
  }
  if (!seenFile || [...names].some((name) => !entries.some((entry) => entry.name === name))) { throw new Error('ArkTSDoc omitted a selected file or exported declaration'); }
  const grouped = new Map<string, ApiEntry>();
  for (const entry of entries) {
    const prior = grouped.get(entry.id);
    if (!prior) { grouped.set(entry.id, entry); continue; }
    if (!/^(Function|Method|Constructor)$/i.test(entry.kind)) { throw new Error('Ambiguous ArkTSDoc public API identity'); }
    prior.signature = [...new Set([prior.signature, entry.signature])].join('\n');
    prior.description = [...new Set([prior.description, entry.description].filter(Boolean))].join('\n');
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}
function anonymousNames(model: unknown, symbols: PublicSymbol[]) {
  const copy: unknown = structuredClone(model), queue = [copy];
  let count = 0;
  while (queue.length) {
    if (++count > 10_000) { throw new Error('ArkTSDoc model exceeds the node budget'); }
    const node = z.object({ jsDoc: z.array(z.unknown()).optional(), children: z.array(z.unknown()).optional() }).passthrough().parse(queue.shift());
    for (const raw of node.jsDoc ?? []) {
      const entry = object.parse(raw), symbol = symbols.find((symbol) => symbol.anonymousText === entry.name);
      if (symbol) { (raw as { name: string }).name = symbol.declarationName; }
    }
    queue.push(...node.children ?? []);
  }
  return copy;
}
export function exposeArkDoc(model: unknown, origin: string, symbols: PublicSymbol[]) {
  const entries = normalizeArkDoc(anonymousNames(model, symbols), origin, new Set(symbols.map((symbol) => symbol.declarationName)));
  return symbols.flatMap((symbol) => {
    const selected = entries.filter((entry) => entry.name === symbol.declarationName || entry.name.startsWith(`${symbol.declarationName}.`));
    const result = selected.flatMap((entry) => {
      const suffix = entry.name.slice(symbol.declarationName.length), member = symbol.members.find((member) => `.${member.name}` === suffix);
      if (suffix && !member) { return []; }
      const name = symbol.name + suffix, signatures = suffix ? member!.signatures : symbol.signatures;
      return [{ ...entry, file: symbol.file, name, id: digest(JSON.stringify([symbol.file, entry.kind, name])),
        signature: signatures.length ? signatures.join('\n') : !suffix && symbol.anonymousSignature ? symbol.anonymousSignature : entry.signature }];
    });
    if (symbol.members.some((member) => !result.some((entry) => entry.name === `${symbol.name}.${member.name}`))) {
      throw new Error('ArkTSDoc omitted a compiler-confirmed public member');
    }
    return result;
  });
}
export function diffApi(before: ApiEntry[], after: ApiEntry[]) {
  const previous = new Map(before.map((item) => [item.id, item])), current = new Map(after.map((item) => [item.id, item]));
  return { added: after.filter((item) => !previous.has(item.id)), removed: before.filter((item) => !current.has(item.id)),
    changed: after.filter((item) => previous.has(item.id) && digest(JSON.stringify(previous.get(item.id))) !== digest(JSON.stringify(item))) };
}
