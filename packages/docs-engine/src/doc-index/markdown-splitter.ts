/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';
import type { Root, Content, Heading, Code } from 'mdast';
import {
  DOC_API_SECTION_BATCH_SIZE,
  DOC_API_SYMBOLS_MAX_COUNT,
  DOC_BODY_HEAD_CHARS,
  DOC_BODY_TAIL_CHARS,
  DOC_CHUNK_API_PATH_RE,
  DOC_CHUNK_MIN_H4_SECTIONS,
  DOC_CHUNK_MIN_H4_SECTIONS_RELAXED,
  DOC_CHUNK_MIN_LINES,
  DOC_CHUNK_MIN_LINES_RELAXED,
  DOC_HEADINGS_MAX_CHARS,
  DOC_LEAD_TEXT_CHARS,
  DOC_MAX_INDEX_SECTIONS_PER_DOC,
} from './constants.js';
import {
  buildSectionHeadingsText,
  extractFirstDefinitionLine,
  normalizeApiHeading,
  stripApiVersionSuffix,
} from './heading-normalize.js';
import type { DocumentIndexSource } from './segment-types.js';
import {
  appendSymbolVariants,
  extractCamelCaseIdentifiers,
  extractOhosModules,
  filterSubsumedTokens,
  ohosModuleLastSegment,
} from './api-identifiers.js';
import { truncateAtWordBoundary } from './sqlite-snippet.js';

const API_SYMBOL_RE = /[A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]+)*/g;
const DECORATOR_RE = /@[A-Z][a-zA-Z]+/g;
const API_METHOD_HEADING_RE = /^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]+/;
/** Standalone PascalCase type/interface headings (FocusDirection, Rect, …). */
const STANDALONE_API_TYPE_HEADING_RE = /^[A-Z][A-Za-z0-9]+(?:\([^)]*\))?$/;
/** Kebab/snake slug file names (is-inner-application-…). */
const FILENAME_LIKE_TITLE_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const GENERIC_STANDALONE_SYMBOLS = new Set([
  'API',
  'Action',
  'Code',
  'Connect',
  'Connection',
  'Context',
  'Direction',
  'Element',
  'Elements',
  'Entry',
  'Focused',
  'Module',
  'Modules',
  'Name',
  'Names',
  'Stage',
  'Type',
  'Types',
  'Value',
  'Values',
  'Rect',
  'Error',
]);
const ALLOWED_ACRONYMS = new Set([
  'HAP',
  'HSP',
  'HAR',
  'NAPI',
  'CAPI',
  'NDK',
  'ArkTS',
  'ArkUI',
  'OHPM',
]);
const GENERIC_QUALIFIED_ROOTS = new Set([
  'JSON',
  'Object',
  'Array',
  'Promise',
  'console',
  'Math',
  'Date',
  'String',
  'Number',
  'Boolean',
  'Error',
  'Function',
  'Map',
  'Set',
  'RegExp',
]);

interface ParsedDocument {
  headings: string[];
  bodyParts: string[];
  codeBlocks: string[];
}

interface MarkdownSection {
  sectionTitle: string;
  bodyParts: string[];
  codeBlocks: string[];
}

function extractApiSymbols(text: string, codeBlocks: string[]): string[] {
  const symbols = new Set<string>();
  const sources = [text, ...codeBlocks];

  for (const source of sources) {
    for (const modulePath of extractOhosModules(source)) {
      appendSymbolVariants(symbols, modulePath);
      const last = ohosModuleLastSegment(modulePath);
      if (last) {
        appendSymbolVariants(symbols, last);
      }
    }
    for (const camel of extractCamelCaseIdentifiers(source)) {
      appendSymbolVariants(symbols, camel);
    }
    for (const match of source.matchAll(API_SYMBOL_RE)) {
      const symbol = match[0];
      if (isValuableApiSymbol(symbol)) {
        symbols.add(symbol);
      }
    }
    for (const match of source.matchAll(DECORATOR_RE)) {
      symbols.add(match[0]);
    }
  }

  return filterSubsumedTokens([...symbols]);
}

function isValuableApiSymbol(symbol: string): boolean {
  const trimmed = symbol.trim();
  if (!trimmed || DECORATOR_RE.test(trimmed)) {
    return Boolean(trimmed);
  }

  if (trimmed.includes('.')) {
    const root = trimmed.split('.')[0] ?? '';
    if (GENERIC_QUALIFIED_ROOTS.has(root)) {
      return false;
    }
    return /^[A-Z]/.test(root);
  }

  if (GENERIC_STANDALONE_SYMBOLS.has(trimmed)) {
    return false;
  }
  if (ALLOWED_ACRONYMS.has(trimmed)) {
    return true;
  }
  if (trimmed.length <= 3) {
    return false;
  }
  if (/^[A-Z][a-z]+[A-Z]/.test(trimmed)) {
    return true;
  }
  return trimmed.length >= 6 && /^[A-Z][A-Za-z0-9]+$/.test(trimmed);
}

export function isFilenameLikeTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) {
    return true;
  }
  if (FILENAME_LIKE_TITLE_RE.test(trimmed)) {
    return true;
  }
  if (
    trimmed.length > 28 &&
    !/[A-Z\u4e00-\u9fff]/.test(trimmed) &&
    /^[a-z0-9_-]+$/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export function resolveDocTitle(
  markdown: string,
  options: { jsonTitle?: string; fileName: string }
): string {
  const fromJson = options.jsonTitle?.trim();
  const fromMarkdown = extractDocTitle(markdown, '').trim();
  const fileName = options.fileName.trim();

  if (fromJson && !isFilenameLikeTitle(fromJson)) {
    return fromJson;
  }
  if (fromMarkdown && !isFilenameLikeTitle(fromMarkdown)) {
    return fromMarkdown;
  }
  if (fromJson) {
    return fromJson;
  }
  if (fromMarkdown) {
    return fromMarkdown;
  }
  return fileName;
}

function isApiMethodHeading(title: string): boolean {
  return API_METHOD_HEADING_RE.test(title.trim());
}

function isStandaloneApiTypeHeading(title: string): boolean {
  const trimmed = title.trim().replace(/\([^)]*\)$/, '');
  const base = stripApiVersionSuffix(trimmed);
  return STANDALONE_API_TYPE_HEADING_RE.test(base);
}

function isApiSectionHeading(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) {
    return false;
  }
  if (DECORATOR_RE.test(trimmed)) {
    return true;
  }
  if (isApiMethodHeading(trimmed)) {
    return true;
  }
  if (isStandaloneApiTypeHeading(trimmed)) {
    return true;
  }
  return Boolean(normalizeApiHeading(trimmed).symbolName);
}

function isSectionHeading(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) {
    return false;
  }
  if (isApiMethodHeading(trimmed)) {
    return false;
  }
  if (isStandaloneApiTypeHeading(trimmed)) {
    return false;
  }
  return true;
}

function filterSectionHeadings(headings: string[]): string[] {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const title of headings) {
    const trimmed = title.trim();
    if (!isSectionHeading(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    sections.push(trimmed);
  }
  return sections;
}

function apiSymbolKind(symbol: string): number {
  if (!symbol.includes('.')) {
    return 0;
  }
  const methodPart = symbol.split('.').pop() ?? '';
  if (/^[a-z]/.test(methodPart)) {
    return 1;
  }
  return 2;
}

function compareApiSymbols(a: string, b: string): number {
  const kindDiff = apiSymbolKind(a) - apiSymbolKind(b);
  if (kindDiff !== 0) {
    return kindDiff;
  }
  return a.localeCompare(b);
}

function prepareApiSymbols(
  symbols: string[],
  priority: string[] = []
): string[] {
  const priorityUnique = [
    ...new Set(priority.map((symbol) => symbol.trim()).filter(Boolean)),
  ];
  const prioritySet = new Set(priorityUnique);
  const rest = [
    ...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)),
  ].filter((symbol) => !prioritySet.has(symbol));
  rest.sort(compareApiSymbols);
  return [...priorityUnique, ...rest].slice(0, DOC_API_SYMBOLS_MAX_COUNT);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unescapeMarkdownInline(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+.!-])/g, '$1');
}

export function extractDocTitle(markdown: string, fallback = ''): string {
  const lines = markdown.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  if (index >= lines.length) {
    return fallback;
  }

  const firstLine = unescapeMarkdownInline(lines[index].trim());
  const atxMatch = firstLine.match(/^#+\s+(.+)$/);
  if (atxMatch) {
    return unescapeMarkdownInline(atxMatch[1].trim());
  }

  if (index + 1 < lines.length) {
    const underline = lines[index + 1].trim();
    if (/^=+$/.test(underline) || /^-+$/.test(underline)) {
      return firstLine;
    }
  }

  return firstLine || fallback;
}

export function extractMarkdownHeadings(markdown: string): string[] {
  return parseMarkdownDocument(markdown).headings;
}

function sampleBodyText(bodyParts: string[]): string {
  const body = normalizeWhitespace(bodyParts.join(' '));
  if (body.length <= DOC_BODY_HEAD_CHARS) {
    return body;
  }

  const head = body.slice(0, DOC_BODY_HEAD_CHARS);
  if (body.length <= DOC_BODY_HEAD_CHARS + DOC_BODY_TAIL_CHARS) {
    return head;
  }

  return `${head} ${body.slice(-DOC_BODY_TAIL_CHARS)}`;
}

function capHeadings(headings: string[]): string {
  const joined = filterSectionHeadings(headings).join(' ');
  if (joined.length <= DOC_HEADINGS_MAX_CHARS) {
    return joined;
  }
  return joined.slice(0, DOC_HEADINGS_MAX_CHARS);
}

function buildLeadText(bodySample: string): {
  leadText: string;
  excerptTruncated: boolean;
} {
  const text = normalizeWhitespace(bodySample);
  const { text: leadText, excerptTruncated } = truncateAtWordBoundary(
    text,
    DOC_LEAD_TEXT_CHARS
  );
  return { leadText, excerptTruncated };
}

function resolveSectionExcerptTruncated(
  bodySample: string,
  sectionTitle: string
): { leadText: string; excerptTruncated: boolean } {
  const { leadText, excerptTruncated } = buildLeadText(bodySample);
  return {
    leadText,
    excerptTruncated: excerptTruncated || Boolean(sectionTitle.trim()),
  };
}

function appendNodeToSection(node: Content, section: MarkdownSection): void {
  if (node.type === 'code') {
    section.codeBlocks.push((node as Code).value ?? '');
    return;
  }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children as Content[]) {
      appendNodeToSection(child, section);
    }
    return;
  }
  const text = normalizeWhitespace(toString(node));
  if (text) {
    section.bodyParts.push(text);
  }
}

function splitMarkdownIntoSections(markdown: string): MarkdownSection[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown) as Root;
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  const flush = (): void => {
    if (!current) {
      return;
    }
    if (
      current.sectionTitle ||
      current.bodyParts.length ||
      current.codeBlocks.length
    ) {
      sections.push(current);
    }
    current = null;
  };

  const ensureCurrent = (): MarkdownSection => {
    if (!current) {
      current = { sectionTitle: '', bodyParts: [], codeBlocks: [] };
    }
    return current;
  };

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const heading = node as Heading;
      const title = toString(heading).trim();
      if (heading.depth >= 4 && title && isApiSectionHeading(title)) {
        flush();
        current = { sectionTitle: title, bodyParts: [], codeBlocks: [] };
        continue;
      }
      const section = ensureCurrent();
      if (title) {
        section.bodyParts.push(title);
      }
      continue;
    }
    appendNodeToSection(node, ensureCurrent());
  }
  flush();

  if (sections.length === 0) {
    return [{ sectionTitle: '', bodyParts: [], codeBlocks: [] }];
  }
  return sections;
}

function isApiReferenceDocument(documentId: string): boolean {
  return DOC_CHUNK_API_PATH_RE.test(documentId);
}

function countApiIndexSections(sections: MarkdownSection[]): number {
  return sections.filter(
    (section) =>
      section.sectionTitle && isApiSectionHeading(section.sectionTitle)
  ).length;
}

function mergeApiSectionBatch(group: MarkdownSection[]): MarkdownSection {
  return {
    sectionTitle: group
      .map((section) => section.sectionTitle.trim())
      .join(' | '),
    bodyParts: group.flatMap((section) => section.bodyParts).slice(0, 40),
    codeBlocks: group.flatMap((section) => section.codeBlocks).slice(0, 8),
  };
}

function isTypeOrObjectApiSection(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed || DECORATOR_RE.test(trimmed)) {
    return DECORATOR_RE.test(trimmed);
  }
  if (/对象说明$|枚举说明$/.test(trimmed)) {
    return true;
  }
  return isStandaloneApiTypeHeading(trimmed);
}

function limitApiSections(sections: MarkdownSection[]): MarkdownSection[] {
  const preamble = sections.filter(
    (section) =>
      !section.sectionTitle || !isApiSectionHeading(section.sectionTitle)
  );
  const apiSections = sections.filter(
    (section) =>
      section.sectionTitle && isApiSectionHeading(section.sectionTitle)
  );
  const typeSections = apiSections.filter((section) =>
    isTypeOrObjectApiSection(section.sectionTitle)
  );
  const methodSections = apiSections.filter(
    (section) => !isTypeOrObjectApiSection(section.sectionTitle)
  );

  const methodBudget = Math.max(
    0,
    DOC_MAX_INDEX_SECTIONS_PER_DOC - typeSections.length
  );
  const keptMethods = methodSections.slice(0, methodBudget);
  const overflowMethods = methodSections.slice(methodBudget);
  const overflowH2 = overflowMethods.filter((section) =>
    isH2MethodSection(section.sectionTitle)
  );
  const overflowBatchable = overflowMethods.filter(
    (section) => !isH2MethodSection(section.sectionTitle)
  );
  const batched: MarkdownSection[] = [];
  for (
    let i = 0;
    i < overflowBatchable.length;
    i += DOC_API_SECTION_BATCH_SIZE
  ) {
    batched.push(
      mergeApiSectionBatch(
        overflowBatchable.slice(i, i + DOC_API_SECTION_BATCH_SIZE)
      )
    );
  }
  return [
    ...preamble,
    ...typeSections,
    ...keptMethods,
    ...overflowH2,
    ...batched,
  ];
}

function shouldChunkIntoSections(
  markdown: string,
  sections: MarkdownSection[],
  documentId: string
): boolean {
  const lineCount = markdown.split(/\r?\n/).length;
  const apiSectionCount = countApiIndexSections(sections);
  if (apiSectionCount === 0) {
    return false;
  }
  if (isApiReferenceDocument(documentId)) {
    return (
      lineCount >= DOC_CHUNK_MIN_LINES_RELAXED &&
      apiSectionCount >= DOC_CHUNK_MIN_H4_SECTIONS_RELAXED
    );
  }
  return (
    lineCount >= DOC_CHUNK_MIN_LINES &&
    apiSectionCount >= DOC_CHUNK_MIN_H4_SECTIONS
  );
}

const H2_METHOD_SECTION_RE = /^\[h2\][A-Za-z]/;

function isH2MethodSection(title: string): boolean {
  return H2_METHOD_SECTION_RE.test(title.trim());
}

function symbolsFromSectionTitle(sectionTitle: string): string[] {
  if (!sectionTitle.includes(' | ')) {
    const normalized = normalizeApiHeading(sectionTitle);
    return normalized.symbolName ? [normalized.symbolName] : [];
  }

  const symbols: string[] = [];
  for (const part of sectionTitle.split(' | ')) {
    const symbolName = normalizeApiHeading(part.trim()).symbolName;
    if (symbolName) {
      symbols.push(symbolName);
    }
  }
  return symbols;
}

function buildSectionApiSymbols(
  sectionTitle: string,
  normalized: ReturnType<typeof normalizeApiHeading>,
  allText: string,
  codeBlocks: string[]
): string[] {
  const titleSymbols = symbolsFromSectionTitle(sectionTitle);
  const symbols = extractApiSymbols(allText, codeBlocks);
  if (normalized.symbolName) {
    symbols.push(normalized.symbolName);
  }
  return prepareApiSymbols([...titleSymbols, ...symbols], titleSymbols);
}

function buildSegmentIndexSource(
  section: MarkdownSection,
  meta: { documentId: string; catalogId: number; docTitle: string }
): DocumentIndexSource {
  const bodySample = sampleBodyText(section.bodyParts);
  const sectionTitle = section.sectionTitle.trim();
  const normalized = normalizeApiHeading(sectionTitle);
  const definitionLine = extractFirstDefinitionLine(section.bodyParts);
  const headingsText = buildSectionHeadingsText(
    sectionTitle,
    definitionLine,
    normalized
  );
  const titleSymbols = symbolsFromSectionTitle(sectionTitle);
  const titleTokens = sectionTitle
    ? titleSymbols.length > 0
      ? `${meta.docTitle} ${titleSymbols.join(' ')}`
      : `${meta.docTitle} ${normalized.symbolName ?? sectionTitle}`
    : meta.docTitle;
  const allText = [meta.docTitle, headingsText, ...section.bodyParts].join(' ');
  const { leadText, excerptTruncated } = resolveSectionExcerptTruncated(
    bodySample,
    sectionTitle
  );

  return {
    documentId: meta.documentId,
    catalogId: meta.catalogId,
    docTitle: meta.docTitle,
    sectionTitle,
    titleTokens,
    headingsText,
    apiSymbols: buildSectionApiSymbols(
      sectionTitle,
      normalized,
      allText,
      section.codeBlocks
    ),
    bodySample,
    leadText,
    excerptTruncated,
  };
}
function walkDocumentNodes(nodes: Content[], parsed: ParsedDocument): void {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const title = toString(node as Heading).trim();
      if (title) {
        parsed.headings.push(title);
      }
      continue;
    }

    if (node.type === 'code') {
      parsed.codeBlocks.push((node as Code).value ?? '');
      continue;
    }

    if ('children' in node && Array.isArray(node.children)) {
      walkDocumentNodes(node.children as Content[], parsed);
      continue;
    }

    const text = normalizeWhitespace(toString(node));
    if (text) {
      parsed.bodyParts.push(text);
    }
  }
}

function parseMarkdownDocument(markdown: string): ParsedDocument {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown) as Root;
  const parsed: ParsedDocument = {
    headings: [],
    bodyParts: [],
    codeBlocks: [],
  };
  walkDocumentNodes(tree.children, parsed);
  return parsed;
}

export function buildDocumentIndexSource(
  markdown: string,
  meta: { documentId: string; catalogId: number; docTitle: string }
): DocumentIndexSource {
  const parsed = parseMarkdownDocument(markdown);
  const docTitle = meta.docTitle?.trim() || meta.documentId;
  const bodySample = sampleBodyText(parsed.bodyParts);
  const allText = [docTitle, ...parsed.headings, bodySample].join(' ');
  const { leadText, excerptTruncated } = buildLeadText(bodySample);

  return {
    documentId: meta.documentId,
    catalogId: meta.catalogId,
    docTitle,
    sectionTitle: '',
    titleTokens: docTitle,
    headingsText: capHeadings(parsed.headings),
    apiSymbols: prepareApiSymbols(
      extractApiSymbols(allText, parsed.codeBlocks)
    ),
    bodySample,
    leadText,
    excerptTruncated,
  };
}

export function buildDocumentIndexSources(
  markdown: string,
  meta: { documentId: string; catalogId: number; docTitle: string }
): DocumentIndexSource[] {
  const docTitle = meta.docTitle?.trim() || meta.documentId;
  const sections = splitMarkdownIntoSections(markdown);
  if (!shouldChunkIntoSections(markdown, sections, meta.documentId)) {
    return [buildDocumentIndexSource(markdown, { ...meta, docTitle })];
  }
  return limitApiSections(sections)
    .filter(
      (section) =>
        section.sectionTitle ||
        section.bodyParts.length > 0 ||
        section.codeBlocks.length > 0
    )
    .map((section) => buildSegmentIndexSource(section, { ...meta, docTitle }));
}
