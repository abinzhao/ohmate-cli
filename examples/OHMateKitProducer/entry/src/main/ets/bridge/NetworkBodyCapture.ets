/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { http } from '@kit.NetworkKit';
import { url } from '@kit.ArkTS';
import { CryptoPort, canonical, keysOf, requireWire } from './Wire';

export interface BodyRule {
  version: string;
  targetId: string;
  origin: string;
  path: string;
  contentTypes: string[];
  maxBytes: number;
  maxTotalBytes: number;
  ttlMs: number;
}
export interface BodyReview {
  scope: string;
  targetId: string;
  planHash: string;
  payloadHash: string;
  expiresAt: number;
}
export interface BodyPreview {
  targetId: string;
  requestId: string;
  contentType: string;
  body: string;
  capturedBytes: number;
  mode: string;
  authentication: string;
}
export interface BodyTicket { revision: number; requestId: string; }

function validPath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && value.startsWith('/') &&
    !new RegExp('[%\\\\?#\\s\\x00-\\x1f\\x7f]').test(value) && !value.includes('//') &&
    !value.split('/').some((part: string) => part === '.' || part === '..') &&
    !new RegExp('(?:^|[/._-])(?:auth|authentication|login|logout|oauth|token|password|payments?|checkout|purchase|upload|delete)(?:$|[/._-])', 'i').test(value);
}
function readRule(text: string, targetId: string): BodyRule {
  requireWire(text.length <= 4096, 'BODY_RULE_INVALID');
  const value = keysOf(JSON.parse(text) as Object,
    ['version', 'targetId', 'origin', 'path', 'contentTypes', 'maxBytes', 'maxTotalBytes', 'ttlMs']);
  const rule = value as Object as BodyRule;
  requireWire(rule.version === '1' && rule.targetId === targetId && typeof rule.origin === 'string' &&
    typeof rule.path === 'string' && validPath(rule.path), 'BODY_RULE_INVALID');
  const parsed = url.URL.parseURL(rule.origin);
  requireWire(['http:', 'https:'].includes(parsed.protocol) && parsed.origin === rule.origin &&
    !parsed.username && !parsed.password, 'BODY_RULE_INVALID');
  requireWire(Array.isArray(rule.contentTypes) && rule.contentTypes.length > 0 && rule.contentTypes.length <= 2 &&
    rule.contentTypes.every((type: string) => type === 'application/json' || type === 'text/plain') &&
    new Set(rule.contentTypes).size === rule.contentTypes.length &&
    Number.isInteger(rule.maxBytes) && rule.maxBytes > 0 && rule.maxBytes <= 65536 &&
    Number.isInteger(rule.maxTotalBytes) && rule.maxTotalBytes >= rule.maxBytes && rule.maxTotalBytes <= 262144 &&
    Number.isInteger(rule.ttlMs) && rule.ttlMs > 0 && rule.ttlMs <= 30000, 'BODY_RULE_INVALID');
  return rule;
}

// This owner is local consent, never device/build authentication. It sees
// response data only through the explicitly registered, host-owned adapter.
export class NetworkBodyCapture {
  private crypto: CryptoPort;
  private targetId: string;
  private activeSource: () => boolean;
  private rule: BodyRule | undefined = undefined;
  private reviewValue: BodyReview | undefined = undefined;
  private enabled: boolean = false;
  private revision: number = 0;
  private reviews: number = 0;
  private capturedBytes: number = 0;
  private captures: number = 0;
  private sample: string = '';
  private lastTime: number = Date.now();

  constructor(crypto: CryptoPort, targetId: string, active: () => boolean) {
    this.crypto = crypto; this.targetId = targetId; this.activeSource = active;
  }
  review(text: string, binding: string, sessionDeadline: number): BodyReview {
    this.cancel();
    requireWire(this.activeSource() && this.timeValid() && this.reviews < 256, 'BODY_CAPTURE_UNAVAILABLE');
    let rule: BodyRule;
    try { rule = readRule(text, this.targetId); } catch { throw new Error('BODY_RULE_INVALID'); }
    const deadline = Math.min(sessionDeadline, Date.now() + rule.ttlMs);
    requireWire(Number.isSafeInteger(deadline) && deadline > Date.now(), 'BODY_CAPTURE_UNAVAILABLE');
    this.reviews++;
    const plan: Record<string, Object> = {
      'scope': 'network.body.capture', 'targetId': this.targetId, 'binding': binding,
      'revision': this.revision, 'payloadHash': this.crypto.hash(canonical(rule)), 'expiresAt': deadline
    };
    const review: BodyReview = {
      scope: 'network.body.capture', targetId: this.targetId, payloadHash: plan['payloadHash'] as string,
      planHash: this.crypto.hash(canonical(plan)), expiresAt: deadline
    };
    this.rule = rule; this.reviewValue = review;
    return {
      scope: review.scope, targetId: review.targetId, payloadHash: review.payloadHash,
      planHash: review.planHash, expiresAt: review.expiresAt
    };
  }
  confirm(planHash: string): boolean {
    if (!this.current() || this.reviewValue?.planHash !== planHash) { return false; }
    this.enabled = true;
    return true;
  }
  cancel(): void {
    this.revision++; this.enabled = false; this.rule = undefined; this.reviewValue = undefined;
    this.sample = ''; this.capturedBytes = 0; this.captures = 0;
  }
  status(): string {
    if (!this.current()) { return 'idle'; }
    return this.enabled ? 'active' : 'review';
  }
  preview(): BodyPreview | undefined {
    return this.current() && this.enabled && this.sample ? JSON.parse(this.sample) as BodyPreview : undefined;
  }
  begin(requestId: string, requestUrl: string, options: http.HttpRequestOptions, classification: string): BodyTicket | undefined {
    if (!this.current() || !this.enabled || classification !== 'ordinary') { return undefined; }
    try {
      const rule = this.rule;
      requireWire(rule !== undefined, 'BODY_CAPTURE_UNAVAILABLE');
      if (rule === undefined) { return undefined; }
      const parsed = url.URL.parseURL(requestUrl);
      requireWire(requestUrl === rule.origin + rule.path && parsed.origin === rule.origin &&
        parsed.pathname === rule.path && !parsed.search && !parsed.hash &&
        (options.method ?? http.RequestMethod.GET) === http.RequestMethod.GET &&
        options.maxRedirects === 0 && options.usingCache === false &&
        options.customMethod === undefined && options.extraData === undefined && options.body === undefined &&
        options.queryParams === undefined && options.multiFormDataList === undefined, 'BODY_REQUEST_FORBIDDEN');
      if (options.header !== undefined) {
        requireWire(Object.keys(options.header).every((name: string) =>
          ['accept', 'content-type', 'x-ohmate-scenario'].includes(name.toLowerCase())), 'BODY_REQUEST_FORBIDDEN');
      }
      return { revision: this.revision, requestId: requestId };
    } catch { return undefined; }
  }
  complete(ticket: BodyTicket, response: http.HttpResponse): void {
    if (!this.current() || !this.enabled || ticket.revision !== this.revision) { return; }
    this.sample = '';
    try {
      const rule = this.rule;
      if (rule === undefined) { return; }
      const status = response.responseCode;
      requireWire(response.connectionExtraInfo?.redirectCount === 0 && response.resultType === http.HttpDataType.STRING &&
        Number.isInteger(status) && status >= 200 && status <= 599 &&
        !(status >= 300 && status < 400) && ![401, 402, 403].includes(status), 'BODY_RESPONSE_FORBIDDEN');
      const headers = response.header as Record<string, Object>;
      // Only the content type is read. Cookies and unrelated response fields
      // stay with the business request and never enter the capture owner.
      const type = headers['content-type'];
      requireWire(typeof type === 'string', 'BODY_RESPONSE_FORBIDDEN');
      const parts = (type as string).toLowerCase().split(';').map((part: string) => part.trim());
      requireWire(rule.contentTypes.includes(parts[0]) && parts.slice(1).every((part: string) =>
        part === 'charset=utf-8' || part === 'charset="utf-8"'), 'BODY_RESPONSE_FORBIDDEN');
      const raw = response.result;
      requireWire(typeof raw === 'string' && (raw as string).length <= rule.maxBytes, 'BODY_QUOTA');
      const bytes = this.crypto.encode(raw as string);
      try {
        requireWire(bytes.length <= rule.maxBytes && this.capturedBytes + bytes.length <= rule.maxTotalBytes &&
          this.captures < 32 && this.crypto.decode(bytes) === raw, 'BODY_QUOTA');
        const redacted = parts[0] === 'application/json' ? this.redact(JSON.parse(raw as string) as Object, 0, [0]) : '[redacted]';
        requireWire(this.crypto.encode(redacted).length <= 65536, 'BODY_QUOTA');
        if (!this.current() || ticket.revision !== this.revision) { return; }
        this.capturedBytes += bytes.length; this.captures++;
        const preview: BodyPreview = {
          targetId: this.targetId, requestId: ticket.requestId, contentType: parts[0], body: redacted,
          capturedBytes: this.capturedBytes, mode: 'application-local-memory-only', authentication: 'not-authenticated'
        };
        this.sample = JSON.stringify(preview);
      } finally { bytes.fill(0); }
    } catch { this.sample = ''; }
  }
  private redact(value: Object | null, depth: number, nodes: number[]): string {
    requireWire(depth <= 32 && ++nodes[0] <= 256, 'BODY_QUOTA');
    if (value === null) { return 'null'; }
    if (typeof value === 'string') {
      const bytes = this.crypto.encode(value);
      try { requireWire(this.crypto.decode(bytes) === value, 'BODY_ENCODING_INVALID'); }
      finally { bytes.fill(0); }
      return '"[redacted]"';
    }
    if (typeof value === 'number' && Math.abs(value) >= 10000000) { return '"[redacted]"'; }
    if (typeof value !== 'object') { return JSON.stringify(value); }
    if (Array.isArray(value)) {
      return '[' + (value as Object[]).map((item: Object) => this.redact(item, depth + 1, nodes)).join(',') + ']';
    }
    const record = value as Record<string, Object>;
    const keys = Object.keys(record);
    requireWire(keys.length <= 256 - nodes[0] &&
      keys.every((key: string) => new RegExp('^[a-zA-Z_][a-zA-Z_0-9]{0,63}$').test(key)), 'BODY_QUOTA');
    return '{' + keys.map((key: string) => {
      const sensitive = new RegExp('cookie|authorization|token|password|secret|credential|phone|email|account|identity', 'i').test(key);
      return JSON.stringify(key) + ':' + (sensitive ? '"[redacted]"' : this.redact(record[key], depth + 1, nodes));
    }).join(',') + '}';
  }
  private timeValid(): boolean {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < this.lastTime) { this.cancel(); return false; }
    this.lastTime = now;
    return true;
  }
  private current(): boolean {
    if (!this.timeValid() || !this.activeSource() || this.reviewValue === undefined ||
      Date.now() >= this.reviewValue.expiresAt) { this.cancel(); return false; }
    return this.rule !== undefined;
  }
}
