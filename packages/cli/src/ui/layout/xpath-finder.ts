/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { DOMParser } from '@xmldom/xmldom';

declare module 'xpath' {
  export function select(expression: string, contextNode: unknown): unknown;
}
import { select } from 'xpath';

export interface XpathMatch {
  type?: string;
  id?: string;
  key?: string;
  text?: string;
  originalText?: string;
  description?: string;
  enabled?: string;
  focused?: string;
  checked?: string;
  selected?: string;
  visible?: string;
  clickable?: string;
  longClickable?: string;
  scrollable?: string;
  checkable?: string;
  accessibilityLevel?: string;
  hitTestBehavior?: string;
  bounds?: [number, number, number, number];
  attributes: Record<string, string>;
}

export interface XpathableNode {
  attributes?: Record<string, unknown> | null;
  children?: XpathableNode[] | null;
}

const ATTR_KEYS: readonly string[] = [
  'id',
  'key',
  'originalText',
  'description',
  'enabled',
  'focused',
  'checked',
  'selected',
  'visible',
  'clickable',
  'longClickable',
  'scrollable',
  'checkable',
  'accessibilityLevel',
  'hitTestBehavior',
  'bounds',
];

function sanitizeTag(type: string | undefined): string {
  if (!type) {
    return 'node';
  }
  let t = type.replace(/[^A-Za-z0-9_-]/g, '_');
  if (/^[0-9]/.test(t)) {
    t = '_' + t;
  }
  return t || 'node';
}

/** XML escape regex patterns */
const XML_AMP_RE = /&/g;
const XML_LT_RE = /</g;
const XML_GT_RE = />/g;
const XML_QUOT_RE = /"/g;
const XML_APOS_RE = /'/g;

function escapeXml(s: string): string {
  return s
    .replace(XML_AMP_RE, '&amp;')
    .replace(XML_LT_RE, '&lt;')
    .replace(XML_GT_RE, '&gt;')
    .replace(XML_QUOT_RE, '&quot;')
    .replace(XML_APOS_RE, '&apos;');
}

function buildAttributes(a: Record<string, unknown>): string {
  const parts: string[] = [];
  const typeVal = typeof a.type === 'string' ? a.type : '';
  if (typeVal) {
    parts.push(` type="${escapeXml(typeVal)}"`);
  }
  const textVal = a.originalText ?? a.text;
  if (textVal !== undefined && textVal !== null && textVal !== '') {
    parts.push(` text="${escapeXml(String(textVal))}"`);
  }
  for (const k of ATTR_KEYS) {
    const v = a[k];
    if (v === undefined || v === null || v === '') {
      continue;
    }
    parts.push(` ${k}="${escapeXml(String(v))}"`);
  }
  const desc = a.description;
  if (desc !== undefined && desc !== null && desc !== '') {
    parts.push(` desc="${escapeXml(String(desc))}"`);
  }
  return parts.join('');
}

function buildElement(node: XpathableNode): string {
  const a = node.attributes ?? {};
  const tag = sanitizeTag(typeof a.type === 'string' ? a.type : undefined);
  const attrs = buildAttributes(a);
  const kids = node.children ?? [];
  if (kids.length === 0) {
    return `<${tag}${attrs}/>`;
  }
  return `<${tag}${attrs}>${kids.map(buildElement).join('')}</${tag}>`;
}

export function buildXmlTree(root: XpathableNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${buildElement(root)}`;
}

function parseBounds(raw: string | undefined): [number, number, number, number] | undefined {
  if (!raw) {
    return undefined;
  }
  const nums = raw.match(/-?\d+/g);
  if (!nums || nums.length < 4) {
    return undefined;
  }
  const [x, y, w, h] = nums.map(Number);
  return [x, y, w, h];
}

interface DomElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
  attributes: { length: number; [index: number]: { name: string; value: string } } | null;
}

function isDomElement(node: unknown): node is DomElementLike {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  return (node as { nodeType?: number }).nodeType === 1;
}

function elementToMatch(el: DomElementLike): XpathMatch {
  const get = (k: string): string | undefined => {
    const v = el.getAttribute(k);
    return v === '' || v === null ? undefined : v;
  };
  const attributes: Record<string, string> = {};
  const attrs = el.attributes;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      if (attr) {
        attributes[attr.name] = attr.value;
      }
    }
  }
  return {
    type: get('type') ?? el.tagName,
    id: get('id'),
    key: get('key'),
    text: get('text'),
    originalText: get('originalText'),
    description: get('description') ?? get('desc'),
    enabled: get('enabled'),
    focused: get('focused'),
    checked: get('checked'),
    selected: get('selected'),
    visible: get('visible'),
    clickable: get('clickable'),
    longClickable: get('longClickable'),
    scrollable: get('scrollable'),
    checkable: get('checkable'),
    accessibilityLevel: get('accessibilityLevel'),
    hitTestBehavior: get('hitTestBehavior'),
    bounds: parseBounds(get('bounds')),
    attributes,
  };
}

export function findByXpath(root: XpathableNode, expr: string): XpathMatch[] {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new Error('xpath expression must be a non-empty string');
  }
  const xml = buildXmlTree(root);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const result = select(expr, doc);
  if (!Array.isArray(result)) {
    throw new Error(
      `xpath "${expr}" did not return a node-set; use a path expression like //Button[@text='登录']`
    );
  }
  const matches: XpathMatch[] = [];
  for (const node of result as unknown[]) {
    if (isDomElement(node)) {
      matches.push(elementToMatch(node));
    }
  }
  return matches;
}

export function isXpathSelector(selector: string | undefined): selector is string {
  return typeof selector === 'string' && selector.trimStart().startsWith('xpath=');
}

export function extractXpathExpr(selector: string): string {
  const trimmed = selector.trimStart();
  return trimmed.slice('xpath='.length);
}
