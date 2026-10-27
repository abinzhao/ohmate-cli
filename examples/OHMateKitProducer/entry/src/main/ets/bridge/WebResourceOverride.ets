/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { url } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { CryptoPort, canonical, keysOf, requireWire, hex } from './Wire';

export interface ResourceEntry { url: string; mimeType: string; body: string; sensitivity: string; }
export interface ResourceMetadata { resourceId: string; url: string; bodyHash: string; bytes: number; mimeType: string; }
interface RegisteredResource { metadata: ResourceMetadata; body: string; }
export interface ResourceRule { version: string; targetId: string; resourceId: string; url: string; method: string; }
export interface ResourceSample { requestId: string; url: string; method: string; mainFrame: boolean; redirect: boolean; }
export interface ResourceReview {
  scope: string; targetId: string; resourceId: string; url: string; planHash: string;
  payloadHash: string; samplesHash: string; bodyHash: string; bytes: number;
  expectedHits: number; expiresAt: number; coverage: string;
}
export interface ResourceStatus { phase: string; hits: number; bytes: number; authentication: string; }
export interface ResourceDispatch { resourceId: string; url: string; mimeType: string; body: string; }
const COVERAGE: string = 'registered-allowlist;request-intercepted;frame-type-unverified';
const STREAM_COVERAGE: string = 'registered-allowlist;scheme-handler;frame-type-checked;redirect-unverified';
const HEADERS: string[] = ['accept', 'accept-language', 'accept-encoding', 'user-agent', 'cache-control',
  'pragma', 'host', 'connection', 'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];

export function safeUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 1536 ||
    new RegExp('[%\\\\?#\\x00-\\x20\\x7f]').test(value)) { return false; }
  const parsed = url.URL.parseURL(value);
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password &&
    value === parsed.origin + parsed.pathname && !parsed.pathname.includes('//') &&
    !parsed.pathname.split('/').some((part: string): boolean => part === '.' || part === '..') &&
    !new RegExp('(?:^|[/._-])(?:auth|login|logout|oauth|token|password|payments?|checkout|purchase|upload|delete)(?:$|[/._-])',
      'i').test(parsed.pathname);
}

// The host registers response bytes, never filesystem paths. Registration is
// not frame attestation; only the public basic request fields can be checked.
export class WebResourceOverride {
  private crypto: CryptoPort;
  private activeSource: () => boolean;
  private resources: RegisteredResource[] = [];
  private rule: ResourceRule | undefined = undefined;
  private reviewValue: ResourceReview | undefined = undefined;
  private enabled: boolean = false;
  private revision: number = 0;
  private attempts: number = 0;
  private hits: number = 0;
  private responseBytes: number = 0;
  private lastTime: number = Date.now();
  private clockInvalid: boolean = false;
  private pageUrl: string;
  private streaming: boolean;

  constructor(crypto: CryptoPort, pageUrl: string, entries: ResourceEntry[], active: () => boolean,
    streaming: boolean = false) {
    this.crypto = crypto; this.activeSource = active;
    this.pageUrl = pageUrl; this.streaming = streaming;
    requireWire(Array.isArray(entries) && entries.length <= 32, 'RESOURCE_ALLOWLIST_INVALID');
    const origin = url.URL.parseURL(pageUrl).origin;
    let total = 0;
    for (const entry of entries) {
      keysOf(entry, ['url', 'mimeType', 'body', 'sensitivity']);
      requireWire(safeUrl(entry.url) && url.URL.parseURL(entry.url).origin === origin && entry.url !== pageUrl &&
        entry.sensitivity === 'ordinary' && ['text/plain', 'text/css'].includes(entry.mimeType) &&
        !this.resources.some((value: RegisteredResource): boolean => value.metadata.url === entry.url),
        'RESOURCE_ALLOWLIST_INVALID');
      const bytes = this.utf8(entry.body, 65536);
      total += bytes;
      requireWire(total <= 262144, 'RESOURCE_ALLOWLIST_INVALID');
      const random = crypto.random(16);
      let id = '';
      try { requireWire(random.length === 16, 'RESOURCE_ALLOWLIST_INVALID'); id = hex(random); }
      finally { random.fill(0); }
      requireWire(!this.resources.some((value: RegisteredResource): boolean => value.metadata.resourceId === id),
        'RESOURCE_ALLOWLIST_INVALID');
      const metadata: ResourceMetadata = { resourceId: id, url: entry.url, mimeType: entry.mimeType,
        bytes: bytes, bodyHash: crypto.hash(entry.body) };
      this.resources.push({ metadata: metadata, body: entry.body });
    }
  }
  private utf8(text: string, max: number): number {
    requireWire(typeof text === 'string' && text.length <= max, 'RESOURCE_RULE_INVALID');
    const bytes = this.crypto.encode(text);
    try {
      requireWire(bytes.length <= max && this.crypto.decode(bytes) === text, 'RESOURCE_RULE_INVALID');
      return bytes.length;
    } finally { bytes.fill(0); }
  }
  catalog(): ResourceMetadata[] {
    return this.resources.map((item: RegisteredResource): ResourceMetadata => {
      const metadata = item.metadata;
      return { resourceId: metadata.resourceId, url: metadata.url, mimeType: metadata.mimeType,
        bodyHash: metadata.bodyHash, bytes: metadata.bytes };
    });
  }
  review(text: string, samplesText: string, binding: string, deadline: number, ttlMs: number): ResourceReview {
    this.cancel();
    requireWire(this.timeValid() && this.activeSource() && this.attempts < 256, 'RESOURCE_UNAVAILABLE');
    this.attempts++;
    this.utf8(text, 16384); this.utf8(samplesText, 262144);
    requireWire(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 600000, 'RESOURCE_RULE_INVALID');
    const rule = keysOf(JSON.parse(text) as Object,
      ['version', 'targetId', 'resourceId', 'url', 'method']) as Object as ResourceRule;
    const resource = this.resources.find((entry: RegisteredResource): boolean =>
      entry.metadata.resourceId === rule.resourceId && entry.metadata.url === rule.url);
    requireWire(rule.version === '1' && rule.targetId === 'web-main' && rule.method === 'GET' &&
      resource !== undefined, 'RESOURCE_RULE_INVALID');
    if (resource === undefined) { throw new Error('RESOURCE_RULE_INVALID'); }
    const samples = JSON.parse(samplesText) as ResourceSample[];
    requireWire(Array.isArray(samples) && samples.length <= 128, 'RESOURCE_RULE_INVALID');
    const ids: string[] = [];
    for (const sample of samples) {
      keysOf(sample, ['requestId', 'url', 'method', 'mainFrame', 'redirect']);
      requireWire(typeof sample.requestId === 'string' &&
        new RegExp('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').test(sample.requestId) &&
        !ids.includes(sample.requestId) && safeUrl(sample.url) && typeof sample.method === 'string' &&
        ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(sample.method) &&
        typeof sample.mainFrame === 'boolean' && typeof sample.redirect === 'boolean', 'RESOURCE_RULE_INVALID');
      ids.push(sample.requestId);
    }
    this.utf8(canonical(samples), 262144);
    const expiresAt = Math.min(deadline, Date.now() + ttlMs);
    requireWire(Number.isSafeInteger(expiresAt) && expiresAt > Date.now(), 'RESOURCE_UNAVAILABLE');
    const payloadHash = this.crypto.hash(canonical(rule));
    const samplesHash = this.crypto.hash(canonical(samples));
    const expectedHits = samples.filter((sample: ResourceSample): boolean =>
      sample.url === rule.url && sample.method === rule.method && !sample.mainFrame && !sample.redirect).length;
    const coverage = this.streaming ? STREAM_COVERAGE : COVERAGE;
    const plan: Record<string, Object> = {
      'scope': 'arkweb.resources.override', 'binding': binding, 'revision': this.revision,
      'payloadHash': payloadHash, 'rawPayloadHash': this.crypto.hash(text),
      'samplesHash': samplesHash, 'rawSamplesHash': this.crypto.hash(samplesText),
      'bodyHash': resource.metadata.bodyHash, 'expiresAt': expiresAt, 'ttlMs': ttlMs, 'coverage': coverage
    };
    const review: ResourceReview = { scope: 'arkweb.resources.override', targetId: 'web-main',
      resourceId: rule.resourceId, url: rule.url, payloadHash: payloadHash, samplesHash: samplesHash,
      planHash: this.crypto.hash(canonical(plan)), bodyHash: resource.metadata.bodyHash,
      bytes: resource.metadata.bytes, expectedHits: expectedHits, expiresAt: expiresAt, coverage: coverage };
    this.rule = rule; this.reviewValue = review;
    return JSON.parse(JSON.stringify(review)) as ResourceReview;
  }
  confirm(planHash: string): boolean {
    if (!this.current() || this.reviewValue?.planHash !== planHash) { return false; }
    this.enabled = true; return true;
  }
  cancel(): void {
    this.revision++; this.enabled = false; this.rule = undefined; this.reviewValue = undefined;
    this.hits = 0; this.responseBytes = 0;
  }
  clear(): void { this.cancel(); this.resources = []; }
  status(): ResourceStatus {
    const current = this.current();
    return { phase: current ? (this.enabled ? 'active' : 'review') : 'idle', hits: this.hits,
      bytes: this.responseBytes, authentication: 'not-authenticated' };
  }
  private requestScope(request: WebResourceRequest, rule: ResourceRule): string | undefined {
    try {
      // Reject out-of-scope requests before asking the native API for headers.
      if (request.getRequestUrl() !== rule.url || request.getRequestMethod() !== 'GET' ||
        request.isMainFrame() !== false || request.isRedirect() !== false) { return undefined; }
      const headers = request.getRequestHeader();
      if (!Array.isArray(headers) || headers.length > 32) { return undefined; }
      const names: string[] = [];
      for (const header of headers) {
        if (header === null || header === undefined || typeof header.headerKey !== 'string') { return undefined; }
        const name = header.headerKey.toLowerCase();
        if (!HEADERS.includes(name) || names.includes(name)) { return undefined; }
        names.push(name);
      }
      return canonical(names.sort());
    } catch { return undefined; }
  }
  resolve(request: WebResourceRequest): WebResourceResponse | undefined {
    if (this.streaming) { return undefined; }
    if (!this.current() || !this.enabled || this.rule === undefined) { return undefined; }
    const rule = this.rule;
    const revision = this.revision;
    const scope = this.requestScope(request, rule);
    if (scope === undefined) { return undefined; }
    if (!this.current() || !this.enabled || revision !== this.revision ||
      this.requestScope(request, rule) !== scope) {
      this.cancel(); throw new Error('RESOURCE_CANCELLED');
    }
    const resource = this.resources.find((item: RegisteredResource): boolean => item.metadata.resourceId === rule.resourceId);
    requireWire(resource !== undefined, 'RESOURCE_CANCELLED');
    if (resource === undefined) { throw new Error('RESOURCE_CANCELLED'); }
    requireWire(this.hits < 128 && this.responseBytes + resource.metadata.bytes <= 1048576, 'RESOURCE_RESPONSE_QUOTA');
    this.hits++; this.responseBytes += resource.metadata.bytes;
    try {
      const response = new WebResourceResponse();
      response.setResponseData(resource.body);
      response.setResponseEncoding('UTF-8'); response.setResponseMimeType(resource.metadata.mimeType);
      response.setResponseCode(200); response.setReasonMessage('OK');
      const headers: Header[] = [
        { headerKey: 'Cache-Control', headerValue: 'no-store' },
        { headerKey: 'X-Content-Type-Options', headerValue: 'nosniff' },
        { headerKey: 'X-OHMate-Resource', headerValue: rule.resourceId }
      ];
      response.setResponseHeader(headers); response.setResponseIsReady(true);
      const finalScope = this.requestScope(request, rule);
      requireWire(finalScope === scope && this.current() && this.enabled && revision === this.revision,
        'RESOURCE_CANCELLED');
      return response;
    } catch {
      this.cancel();
      throw new Error('RESOURCE_RESPONSE_FAILED');
    }
  }
  private schemeScope(request: webview.WebSchemeHandlerRequest, rule: ResourceRule): string | undefined {
    try {
      if (request.getRequestUrl() !== rule.url || request.getRequestMethod() !== 'GET' ||
        request.isMainFrame() !== false || request.getFrameUrl() !== this.pageUrl ||
        request.getReferrer() !== '' || request.getHttpBodyStream() !== null ||
        ![webview.WebResourceType.STYLE_SHEET, webview.WebResourceType.XHR]
          .includes(request.getRequestResourceType())) { return undefined; }
      const headers = request.getHeader();
      if (!Array.isArray(headers) || headers.length > 32) { return undefined; }
      const names: string[] = [];
      for (const header of headers) {
        if (header === null || header === undefined || typeof header.headerKey !== 'string') { return undefined; }
        const name = header.headerKey.toLowerCase();
        if (!HEADERS.includes(name) || names.includes(name)) { return undefined; }
        names.push(name);
      }
      return canonical(names.sort()) + ':' + request.getRequestResourceType();
    } catch { return undefined; }
  }
  dispatchScheme(request: webview.WebSchemeHandlerRequest,
    deliver: (resource: ResourceDispatch, current: () => boolean) => void): boolean {
    if (!this.streaming || !this.current() || !this.enabled || this.rule === undefined) { return false; }
    const rule = this.rule;
    const revision = this.revision;
    const scope = this.schemeScope(request, rule);
    if (scope === undefined) { return false; }
    const current = (): boolean => this.current() && this.enabled && revision === this.revision &&
      this.schemeScope(request, rule) === scope;
    requireWire(current(), 'RESOURCE_CANCELLED');
    const resource = this.resources.find((item: RegisteredResource): boolean => item.metadata.resourceId === rule.resourceId);
    requireWire(resource !== undefined, 'RESOURCE_CANCELLED');
    if (resource === undefined) { throw new Error('RESOURCE_CANCELLED'); }
    requireWire(this.hits < 128 && this.responseBytes + resource.metadata.bytes <= 1048576, 'RESOURCE_RESPONSE_QUOTA');
    this.hits++; this.responseBytes += resource.metadata.bytes;
    const entry: ResourceDispatch = { resourceId: resource.metadata.resourceId, url: resource.metadata.url,
      mimeType: resource.metadata.mimeType, body: resource.body };
    deliver(entry, current);
    return true;
  }
  private timeValid(): boolean {
    const now = Date.now();
    if (this.clockInvalid || !Number.isSafeInteger(now) || now < this.lastTime) {
      this.clockInvalid = true; this.cancel(); return false;
    }
    this.lastTime = now; return true;
  }
  private current(): boolean {
    let active = false;
    try { active = this.activeSource(); } catch { active = false; }
    if (!this.timeValid() || !active || this.reviewValue === undefined || Date.now() >= this.reviewValue.expiresAt) {
      this.cancel(); return false;
    }
    return this.rule !== undefined;
  }
}
