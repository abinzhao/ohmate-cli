/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { http } from '@kit.NetworkKit';
import { url } from '@kit.ArkTS';
import { CryptoPort, canonical, keysOf, recordOf, requireWire } from './Wire';

export interface MockResponseRule {
  kind: string;
  delayMs: number;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  template?: string;
  variables?: Record<string, string>;
}
export interface MockRule {
  ruleId: string;
  priority: number;
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  resourceType: string;
  response: MockResponseRule;
}
export interface MockRules { version: string; targetId: string; rules: MockRule[]; }
export interface MockSample {
  requestId: string;
  targetId: string;
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  resourceType: string;
  sensitivity: string;
}
export interface MockMatch {
  requestId: string;
  ruleId: string | null;
  decision: string;
  reason: string | null;
}
export interface MockReview {
  scope: string;
  targetId: string;
  payloadHash: string;
  samplesHash: string;
  planHash: string;
  expiresAt: number;
  ruleCount: number;
  coverage: string;
  matches: MockMatch[];
  responses: MockResponseSummary[];
}
export interface MockResponseSummary {
  ruleId: string;
  kind: string;
  responseHash: string;
  bodyHash: string | null;
}
export interface MockStatus {
  phase: string;
  hits: number;
  pending: number;
  authentication: string;
}
export interface MockHttpResponse extends http.HttpResponse {
  mock: boolean;
  source: string;
  ruleId: string;
}
interface MockPending { timer: number; reject: (error: Error) => void; }
interface MockSelection { rule: MockRule; headersHash: string; maxLimit: number | undefined; }

const MATCH_HEADERS: string[] = ['accept', 'content-type', 'x-ohmate-scenario'];
const RESPONSE_HEADERS: string[] = ['content-type', 'content-language', 'cache-control', 'x-ohmate-scenario'];
const METHODS: string[] = ['GET', 'HEAD', 'OPTIONS'];
function identifier(value: string): boolean {
  return typeof value === 'string' && new RegExp('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').test(value);
}
function sensitive(path: string): boolean {
  return new RegExp('(?:^|[/._-])(?:auth|authentication|login|logout|oauth|token|password|payments?|checkout|purchase|upload|delete)(?:$|[/._-])', 'i').test(path);
}
function validPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.startsWith('/') &&
    !new RegExp('[%\\\\?#\\x00-\\x20\\x7f]').test(value) && !value.includes('//') &&
    !value.split('/').some((part: string) => part === '.' || part === '..');
}
function validOrigin(value: string): boolean {
  if (typeof value !== 'string' || value.length > 512 || value.includes('*')) { return false; }
  const parsed = url.URL.parseURL(value);
  return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value &&
    !parsed.username && !parsed.password;
}
function readHeaders(value: Object, names: string[]): Record<string, string> {
  const record = recordOf(value);
  requireWire(Object.keys(record).every((name: string) => names.includes(name) &&
    typeof record[name] === 'string' && (record[name] as string).length <= 256 &&
    !new RegExp('[\\x00-\\x1f\\x7f]').test(record[name] as string)), 'MOCK_RULE_INVALID');
  return record as Object as Record<string, string>;
}
function findRule(rules: MockRules, sample: MockSample): MockRule | undefined {
  if (sample.sensitivity !== 'ordinary' || sensitive(sample.path) || !METHODS.includes(sample.method) ||
    !['fetch', 'xhr'].includes(sample.resourceType) || rules.targetId !== sample.targetId) { return undefined; }
  let found: MockRule | undefined = undefined;
  for (const rule of rules.rules) {
    if (rule.origin === sample.origin && rule.method === sample.method && rule.path === sample.path &&
      rule.resourceType === sample.resourceType &&
      Object.keys(rule.headers).every((key: string) => rule.headers[key] === sample.headers[key]) &&
      (found === undefined || rule.priority > found.priority)) { found = rule; }
  }
  return found;
}
function dryMatch(rules: MockRules, sample: MockSample): MockMatch {
  if (sample.sensitivity !== 'ordinary' || sensitive(sample.path) || !METHODS.includes(sample.method) ||
    !['fetch', 'xhr'].includes(sample.resourceType)) {
    return { requestId: sample.requestId, ruleId: null, decision: 'blocked', reason: 'SENSITIVE_REQUEST' };
  }
  const rule = findRule(rules, sample);
  return { requestId: sample.requestId, ruleId: rule?.ruleId ?? null,
    decision: rule === undefined ? 'passthrough' : 'mock', reason: null };
}

// The host opts into this bounded local owner. It never authenticates a peer,
// owns a native HttpRequest, persists a payload, or restores previous consent.
export class NetworkMock {
  private crypto: CryptoPort;
  private targetId: string;
  private activeSource: () => boolean;
  private rules: MockRules | undefined = undefined;
  private reviewValue: MockReview | undefined = undefined;
  private enabled: boolean = false;
  private revision: number = 0;
  private reviews: number = 0;
  private hits: number = 0;
  private pending: MockPending[] = [];
  private lastTime: number = Date.now();
  private clockInvalid: boolean = false;

  constructor(crypto: CryptoPort, targetId: string, active: () => boolean) {
    this.crypto = crypto; this.targetId = targetId; this.activeSource = active;
  }
  private utf8(text: string, max: number): void {
    requireWire(typeof text === 'string' && text.length <= max, 'MOCK_RULE_INVALID');
    const bytes = this.crypto.encode(text);
    try { requireWire(bytes.length <= max && this.crypto.decode(bytes) === text, 'MOCK_RULE_INVALID'); }
    finally { bytes.fill(0); }
  }
  private headers(value: Object, names: string[]): Record<string, string> {
    const headers = readHeaders(value, names);
    for (const key of Object.keys(headers)) { this.utf8(headers[key], 1024); }
    return headers;
  }
  private templateBody(response: MockResponseRule): string {
    const template = response.template;
    const variables = response.variables;
    requireWire(typeof template === 'string' && variables !== undefined && variables !== null, 'MOCK_RULE_INVALID');
    if (template === undefined || variables === undefined) { throw new Error('MOCK_RULE_INVALID'); }
    recordOf(variables);
    const names = Object.keys(variables);
    requireWire(names.length <= 16 && names.every((name: string): boolean =>
      new RegExp('^test\\.[A-Za-z][A-Za-z0-9_]{0,31}$').test(name)), 'MOCK_RULE_INVALID');
    this.utf8(template, 16384);
    for (const name of names) { this.utf8(variables[name], 2048); }
    const used: string[] = [];
    const parts: string[] = [];
    let cursor = 0;
    let references = 0;
    let bytes = 0;
    const append = (text: string): void => {
      const encoded = this.crypto.encode(text);
      try { bytes += encoded.length; requireWire(bytes <= 65536, 'MOCK_RULE_INVALID'); }
      finally { encoded.fill(0); }
      parts.push(text);
    };
    while (cursor < template.length) {
      const start = template.indexOf('{{', cursor);
      const literal = template.slice(cursor, start < 0 ? template.length : start);
      requireWire(!literal.includes('}}'), 'MOCK_RULE_INVALID');
      append(literal);
      if (start < 0) { break; }
      const end = template.indexOf('}}', start + 2);
      const name = template.slice(start + 2, end < 0 ? template.length : end);
      references++;
      requireWire(end >= 0 && names.includes(name) && references <= 64, 'MOCK_RULE_INVALID');
      if (!used.includes(name)) { used.push(name); }
      append(variables[name]); cursor = end + 2;
    }
    requireWire(used.length === names.length, 'MOCK_RULE_INVALID');
    return parts.join('');
  }
  private responseSummaries(rules: MockRules): MockResponseSummary[] {
    return rules.rules.map((rule: MockRule): MockResponseSummary => {
      const response = rule.response;
      const body = response.kind === 'template' ? this.templateBody(response) : response.body;
      return { ruleId: rule.ruleId, kind: response.kind, responseHash: this.crypto.hash(canonical(response)),
        bodyHash: body === undefined ? null : this.crypto.hash(canonical(body)) };
    });
  }
  private readRules(text: string): MockRules {
    this.utf8(text, 262144);
    const rules = keysOf(JSON.parse(text) as Object, ['version', 'targetId', 'rules']) as Object as MockRules;
    requireWire(rules.version === '1' && rules.targetId === this.targetId && identifier(rules.targetId) &&
      Array.isArray(rules.rules) && rules.rules.length > 0 && rules.rules.length <= 32, 'MOCK_RULE_INVALID');
    const ids: string[] = [];
    for (const rule of rules.rules) {
      keysOf(rule, ['ruleId', 'priority', 'origin', 'method', 'path', 'headers', 'resourceType', 'response']);
      requireWire(identifier(rule.ruleId) && !ids.includes(rule.ruleId) &&
        Number.isInteger(rule.priority) && rule.priority >= -1000 && rule.priority <= 1000 &&
        validOrigin(rule.origin) && METHODS.includes(rule.method) && validPath(rule.path) &&
        !sensitive(rule.path) && ['fetch', 'xhr'].includes(rule.resourceType), 'MOCK_RULE_INVALID');
      ids.push(rule.ruleId);
      this.utf8(rule.path, 4096);
      this.headers(rule.headers, MATCH_HEADERS);
      const response = rule.response;
      const fixed = response.kind === 'fixed';
      const template = response.kind === 'template';
      keysOf(response, fixed ? ['kind', 'status', 'headers', 'body', 'delayMs'] :
        template ? ['kind', 'status', 'headers', 'template', 'variables', 'delayMs'] : ['kind', 'delayMs']);
      requireWire(['fixed', 'template', 'timeout', 'network-error'].includes(response.kind) &&
        Number.isInteger(response.delayMs) && response.delayMs >= 0 && response.delayMs <= 3000, 'MOCK_RULE_INVALID');
      if (fixed || template) {
        const status = response.status ?? 0;
        const body = template ? this.templateBody(response) : response.body;
        requireWire(Number.isInteger(status) && status >= 200 && status <= 599 &&
          typeof body === 'string' && (rule.method !== 'HEAD' || body === ''), 'MOCK_RULE_INVALID');
        this.utf8(body ?? '', 65536);
        if (response.headers === undefined || response.headers === null) { throw new Error('MOCK_RULE_INVALID'); }
        this.headers(response.headers, RESPONSE_HEADERS);
      }
    }
    let totalBodyBytes = 0;
    for (const rule of rules.rules) {
      const response = rule.response;
      const body = response.kind === 'template' ? this.templateBody(response) : response.body ?? '';
      const bytes = this.crypto.encode(body);
      try { totalBodyBytes += bytes.length; requireWire(totalBodyBytes <= 262144, 'MOCK_RULE_INVALID'); }
      finally { bytes.fill(0); }
    }
    this.utf8(canonical(rules), 262144);
    return rules;
  }
  private readSamples(text: string): MockSample[] {
    this.utf8(text, 262144);
    const samples = JSON.parse(text) as MockSample[];
    requireWire(Array.isArray(samples) && samples.length <= 128, 'MOCK_RULE_INVALID');
    const ids: string[] = [];
    for (const sample of samples) {
      keysOf(sample, ['requestId', 'targetId', 'origin', 'method', 'path', 'headers', 'resourceType', 'sensitivity']);
      requireWire(identifier(sample.requestId) && !ids.includes(sample.requestId) && identifier(sample.targetId) &&
        validOrigin(sample.origin) && validPath(sample.path) &&
        ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE'].includes(sample.method) &&
        ['fetch', 'xhr', 'websocket', 'drm', 'upload'].includes(sample.resourceType) &&
        ['ordinary', 'authentication', 'payment', 'upload', 'delete', 'unknown'].includes(sample.sensitivity), 'MOCK_RULE_INVALID');
      ids.push(sample.requestId); this.utf8(sample.path, 4096); this.headers(sample.headers, MATCH_HEADERS);
    }
    this.utf8(canonical(samples), 262144);
    return samples;
  }
  review(text: string, samplesText: string, binding: string, sessionDeadline: number, ttlMs: number): MockReview {
    this.cancel();
    requireWire(this.timeValid() && this.activeSource() && this.reviews < 256, 'MOCK_UNAVAILABLE');
    // Attempts consume the connection quota, even if parsing fails.
    this.reviews++;
    let rules: MockRules;
    let samples: MockSample[];
    try {
      requireWire(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 600000, 'MOCK_RULE_INVALID');
      rules = this.readRules(text); samples = this.readSamples(samplesText);
    } catch { throw new Error('MOCK_RULE_INVALID'); }
    const deadline = Math.min(sessionDeadline, Date.now() + ttlMs);
    requireWire(Number.isSafeInteger(deadline) && deadline > Date.now(), 'MOCK_UNAVAILABLE');
    const payloadHash = this.crypto.hash(canonical(rules));
    const samplesHash = this.crypto.hash(canonical(samples));
    const matches = samples.map((sample: MockSample): MockMatch => dryMatch(rules, sample));
    const responses = this.responseSummaries(rules);
    const plan: Record<string, Object> = {
      'scope': 'network.mock', 'targetId': this.targetId, 'binding': binding, 'revision': this.revision,
      'payloadHash': payloadHash, 'samplesHash': samplesHash,
      'rawPayloadHash': this.crypto.hash(text), 'rawSamplesHash': this.crypto.hash(samplesText),
      'expiresAt': deadline, 'ttlMs': ttlMs, 'matches': matches, 'responses': responses,
      'coverage': 'provided-request-samples-only'
    };
    const review: MockReview = { scope: 'network.mock', targetId: this.targetId, payloadHash: payloadHash,
      samplesHash: samplesHash, planHash: this.crypto.hash(canonical(plan)), expiresAt: deadline,
      ruleCount: rules.rules.length, coverage: 'provided-request-samples-only', matches: matches, responses: responses };
    this.rules = rules; this.reviewValue = review;
    return JSON.parse(JSON.stringify(review)) as MockReview;
  }
  confirm(planHash: string): boolean {
    if (!this.current() || this.reviewValue?.planHash !== planHash) { return false; }
    this.enabled = true;
    return true;
  }
  cancel(): void {
    this.revision++; this.enabled = false; this.rules = undefined; this.reviewValue = undefined; this.hits = 0;
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) { clearTimeout(item.timer); item.reject(new Error('MOCK_CANCELLED')); }
  }
  status(): MockStatus {
    const current = this.current();
    return { phase: current ? (this.enabled ? 'active' : 'review') : 'idle', hits: this.hits,
      pending: this.pending.length, authentication: 'not-authenticated' };
  }
  private requestRule(requestUrl: string, options: http.HttpRequestOptions,
    classification: string, resourceType: string): MockSelection | undefined {
    if (classification !== 'ordinary' || !['fetch', 'xhr'].includes(resourceType) || this.rules === undefined) { return undefined; }
    try {
      const parsed = url.URL.parseURL(requestUrl);
      const method = options.method ?? http.RequestMethod.GET;
      requireWire(validOrigin(parsed.origin) && validPath(parsed.pathname) && !sensitive(parsed.pathname) &&
        requestUrl === parsed.origin + parsed.pathname && !parsed.search && !parsed.hash &&
        !parsed.username && !parsed.password && METHODS.includes(method) &&
        options.expectDataType === http.HttpDataType.STRING && options.customMethod === undefined &&
        options.extraData === undefined && options.body === undefined && options.queryParams === undefined &&
        options.multiFormDataList === undefined && options.clientCert === undefined &&
        options.clientEncCert === undefined, 'MOCK_REQUEST_FORBIDDEN');
      const headers: Record<string, string> = {};
      if (options.header !== undefined) {
        const original = recordOf(options.header);
        const names = Object.keys(original);
        // Check names before reading values; credentials never reach the matcher.
        requireWire(names.every((name: string) => MATCH_HEADERS.includes(name.toLowerCase())) &&
          new Set(names.map((name: string): string => name.toLowerCase())).size === names.length, 'MOCK_REQUEST_FORBIDDEN');
        for (const name of names) {
          const value = original[name];
          requireWire(typeof value === 'string', 'MOCK_REQUEST_FORBIDDEN');
          headers[name.toLowerCase()] = value as string;
        }
        this.headers(headers, MATCH_HEADERS);
      }
      const sample: MockSample = { requestId: 'request', targetId: this.targetId, origin: parsed.origin,
        path: parsed.pathname, method: method, headers: headers, sensitivity: classification, resourceType: resourceType };
      const rule = findRule(this.rules, sample);
      return rule === undefined ? undefined :
        { rule: rule, headersHash: this.crypto.hash(canonical(headers)), maxLimit: options.maxLimit };
    } catch { return undefined; }
  }
  resolve(requestUrl: string, options: http.HttpRequestOptions,
    classification: string, resourceType: string): Promise<http.HttpResponse> | undefined {
    if (!this.current() || !this.enabled) { return undefined; }
    const selection = this.requestRule(requestUrl, options, classification, resourceType);
    if (selection === undefined) { return undefined; }
    const rule = selection.rule;
    if (this.hits >= 128) { return Promise.reject(new Error('MOCK_HIT_QUOTA')); }
    if (rule.response.delayMs > 0 && this.pending.length >= 8) {
      return Promise.reject(new Error('MOCK_PENDING_QUOTA'));
    }
    const revision = this.revision;
    this.hits++;
    return new Promise<http.HttpResponse>((resolve, reject): void => {
      const finish = (): void => {
        const current = this.current() && revision === this.revision && this.enabled ?
          this.requestRule(requestUrl, options, classification, resourceType) : undefined;
        if (current === undefined || current.rule !== rule ||
          current.headersHash !== selection.headersHash || current.maxLimit !== selection.maxLimit) {
          reject(new Error('MOCK_CANCELLED')); return;
        }
        try { resolve(this.response(rule, options)); } catch (error) { reject(error as Error); }
      };
      if (rule.response.delayMs === 0) { finish(); return; }
      const item: MockPending = { timer: -1, reject: reject };
      this.pending.push(item);
      item.timer = setTimeout(() => {
        this.pending = this.pending.filter((value: MockPending): boolean => value !== item);
        finish();
      }, rule.response.delayMs);
    });
  }
  private response(rule: MockRule, options: http.HttpRequestOptions): MockHttpResponse {
    const response = rule.response;
    if (response.kind !== 'fixed' && response.kind !== 'template') {
      throw new Error(response.kind === 'timeout' ? 'MOCK_TIMEOUT' : 'MOCK_NETWORK_ERROR');
    }
    const body = response.kind === 'template' ? this.templateBody(response) : response.body ?? '';
    const bytes = this.crypto.encode(body);
    try {
      const max = options.maxLimit ?? 5242880;
      requireWire(Number.isSafeInteger(max) && max > 0 && bytes.length <= max, 'MOCK_RESPONSE_QUOTA');
    } finally { bytes.fill(0); }
    const headers: Record<string, string> = {};
    const configured = response.headers ?? {};
    for (const name of Object.keys(configured)) { headers[name] = configured[name]; }
    const timing: http.PerformanceTiming = {
      dnsTiming: NaN, tcpTiming: NaN, tlsTiming: NaN, firstSendTiming: NaN, firstReceiveTiming: NaN,
      totalFinishTiming: NaN, redirectTiming: NaN, responseHeaderTiming: NaN, responseBodyTiming: NaN, totalTiming: NaN
    };
    return { result: body, resultType: http.HttpDataType.STRING, responseCode: response.status ?? 0,
      header: headers, cookies: '', performanceTiming: timing, mock: true,
      source: 'application-local-mock', ruleId: rule.ruleId };
  }
  private timeValid(): boolean {
    const now = Date.now();
    if (this.clockInvalid || !Number.isSafeInteger(now) || now < this.lastTime) {
      this.clockInvalid = true; this.cancel(); return false;
    }
    this.lastTime = now;
    return true;
  }
  private current(): boolean {
    if (!this.timeValid() || !this.activeSource() || this.reviewValue === undefined ||
      Date.now() >= this.reviewValue.expiresAt) { this.cancel(); return false; }
    return this.rules !== undefined;
  }
}
