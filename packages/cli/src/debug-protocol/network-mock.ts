/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { IdentifierSchema } from './domain-schemas.js';
import { canonicalJson, hashContract } from './canonical-hash.js';
import { WriteCommandSchema } from './write-schemas.js';
import type { WriteOperation } from './write-session.js';

const MAX_BYTES = 256 * 1024;
const origin = z.string().max(512).refine((value) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}, 'MOCK_ORIGIN_INVALID');
const sensitivePath = /(?:^|[/._-])(?:auth|authentication|login|logout|oauth|token|password|payments?|checkout|purchase|upload|delete)(?:$|[/._-])/i;
const path = z.string().min(1).max(1024).refine((value) => value.startsWith('/') &&
  !/[%\\?#]/.test(value) && ![...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) && !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..'), 'MOCK_PATH_INVALID');
function headers(names: string[]) {
  return z.record(z.string(), z.string().max(256).refine((value) =>
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))
    .refine((value) => Object.keys(value).every((key) => names.includes(key)), 'MOCK_HEADER_FORBIDDEN');
}
const matchHeaders = headers(['accept', 'content-type', 'x-ohmate-scenario']);
const responseHeaders = headers(['content-type', 'content-language', 'cache-control', 'x-ohmate-scenario']);
const delayMs = z.number().int().min(0).max(3000);
function templateBody(template: string, variables: Record<string, string>): string {
  const names = Object.keys(variables);
  if (names.length > 16 || names.some((name) => !/^test\.[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name))) {
    throw new Error('MOCK_TEMPLATE_INVALID');
  }
  const validText = (text: string, max: number) => typeof text === 'string' &&
    Buffer.byteLength(text) <= max && Buffer.from(text, 'utf8').toString('utf8') === text;
  if (!validText(template, 16384) || names.some((name) => !validText(variables[name], 2048))) {
    throw new Error('MOCK_TEMPLATE_INVALID');
  }
  const used = new Set<string>(), parts: string[] = [];
  let cursor = 0, references = 0, bytes = 0;
  const append = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > 65536) { throw new Error('MOCK_BODY_QUOTA'); }
    parts.push(value);
  };
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    const literal = template.slice(cursor, start < 0 ? template.length : start);
    if (literal.includes('}}')) { throw new Error('MOCK_TEMPLATE_INVALID'); }
    append(literal);
    if (start < 0) { break; }
    const end = template.indexOf('}}', start + 2);
    const name = template.slice(start + 2, end < 0 ? template.length : end);
    if (end < 0 || !names.includes(name) || ++references > 64) { throw new Error('MOCK_TEMPLATE_INVALID'); }
    used.add(name); append(variables[name]); cursor = end + 2;
  }
  if (used.size !== names.length) { throw new Error('MOCK_TEMPLATE_INVALID'); }
  return parts.join('');
}
const templateResponse = z.strictObject({
  kind: z.literal('template'), status: z.number().int().min(200).max(599), headers: responseHeaders,
  template: z.string(), variables: z.record(z.string(), z.string()), delayMs,
}).refine((value) => {
  try { templateBody(value.template, value.variables); return true; } catch { return false; }
}, 'MOCK_TEMPLATE_INVALID');
export const MockResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed'), status: z.number().int().min(200).max(599),
    headers: responseHeaders, body: z.string().refine((value) => Buffer.byteLength(value) <= 65536, 'MOCK_BODY_QUOTA'), delayMs }),
  templateResponse,
  z.strictObject({ kind: z.literal('timeout'), delayMs }),
  z.strictObject({ kind: z.literal('network-error'), delayMs }),
]);
export function renderMockResponse(input: unknown) {
  const response = MockResponseSchema.parse(input);
  if (response.kind !== 'template') { return response; }
  return { kind: 'fixed' as const, status: response.status, headers: response.headers,
    body: templateBody(response.template, response.variables), delayMs: response.delayMs };
}
export function mockResponseSummary(ruleId: string, input: unknown) {
  const original = MockResponseSchema.parse(input), rendered = renderMockResponse(original);
  return { ruleId, kind: original.kind, responseHash: hashContract(original),
    bodyHash: rendered.kind === 'fixed' ? hashContract(rendered.body) : null };
}
export const MockRulesSchema = z.strictObject({
  version: z.literal('1'), targetId: IdentifierSchema,
  rules: z.array(z.strictObject({
    ruleId: IdentifierSchema, priority: z.number().int().min(-1000).max(1000), origin,
    method: z.enum(['GET', 'HEAD', 'OPTIONS']),
    path: path.refine((value) => !sensitivePath.test(value), 'SENSITIVE_REQUEST'),
    headers: matchHeaders, resourceType: z.enum(['fetch', 'xhr']), response: MockResponseSchema,
  })).min(1).max(32),
}).refine((input) => new Set(input.rules.map((rule) => rule.ruleId)).size === input.rules.length, 'MOCK_DUPLICATE_RULE')
  .refine((input) => Buffer.byteLength(canonicalJson(input)) <= MAX_BYTES, 'MOCK_RULES_QUOTA')
  .refine((input) => {
    try {
      return input.rules.reduce((total, rule) => {
        const response = renderMockResponse(rule.response);
        return total + (response.kind === 'fixed' ? Buffer.byteLength(response.body) : 0);
      }, 0) <= MAX_BYTES;
    } catch { return false; }
  }, 'MOCK_RENDERED_TABLE_QUOTA')
  .refine((input) => {
    try {
      return input.rules.every((rule) => {
        const response = renderMockResponse(rule.response);
        return rule.method !== 'HEAD' || response.kind !== 'fixed' || response.body === '';
      });
    } catch { return false; }
  }, 'MOCK_HEAD_BODY_FORBIDDEN');
export const MockRequestSchema = z.strictObject({
  requestId: IdentifierSchema, targetId: IdentifierSchema, origin, path,
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']),
  headers: matchHeaders, resourceType: z.enum(['fetch', 'xhr', 'websocket', 'drm', 'upload']),
  sensitivity: z.enum(['ordinary', 'authentication', 'payment', 'upload', 'delete', 'unknown']),
});
export const MockSamplesSchema = z.array(MockRequestSchema).max(128)
  .refine((input) => new Set(input.map((item) => item.requestId)).size === input.length, 'MOCK_DUPLICATE_SAMPLE')
  .refine((input) => Buffer.byteLength(canonicalJson(input)) <= MAX_BYTES, 'MOCK_SAMPLES_QUOTA');
export type MockRules = z.infer<typeof MockRulesSchema>;
export type MockRequest = z.infer<typeof MockRequestSchema>;
export interface MockMatch {
  requestId: string; ruleId: string | null; decision: 'mock' | 'passthrough' | 'blocked'; reason: string | null;
}
export interface MockPlan {
  targetId: string; payloadHash: string; planHash: string; baselineHash: string; samplesHash: string;
  matches: MockMatch[]; coverage: 'provided-request-samples-only'; ruleCount: number;
  responses: ReturnType<typeof mockResponseSummary>[];
}
interface TableState {
  rules: MockRules | null; hits: number; owner: object | null;
  signal?: AbortSignal; expiresAt: number; invalidated: boolean; clockEpoch: number;
}

export function validateMockRules(input: unknown): MockRules {
  return MockRulesSchema.parse(input);
}
function match(input: MockRules | null, sample: MockRequest): MockMatch {
  const result: MockMatch = { requestId: sample.requestId, ruleId: null, decision: 'passthrough', reason: null };
  if (sample.sensitivity !== 'ordinary' || sensitivePath.test(sample.path) ||
    !['GET', 'HEAD', 'OPTIONS'].includes(sample.method) || !['fetch', 'xhr'].includes(sample.resourceType)) {
    return { ...result, decision: 'blocked', reason: 'SENSITIVE_REQUEST' };
  }
  const found = input?.targetId === sample.targetId ? [...input.rules].sort((a, b) => b.priority - a.priority).find((rule) =>
    rule.origin === sample.origin && rule.method === sample.method && rule.path === sample.path &&
    rule.resourceType === sample.resourceType &&
    Object.entries(rule.headers).every(([key, value]) => sample.headers[key] === value)) : undefined;
  return found ? { ...result, ruleId: found.ruleId, decision: 'mock' } : result;
}

// Application-local rule owner only. It does not admit remote peers or perform HTTP.
export class NetworkMockTable {
  private state: TableState = { rules: null, hits: 0, owner: null, expiresAt: 0, invalidated: false, clockEpoch: 0 };
  private revision = 0;
  private lastTime = Date.now();
  private clockEpoch = 0;
  constructor(private readonly targetId: string) { IdentifierSchema.parse(targetId); }
  status() {
    return { targetId: this.targetId, active: this.active(), hits: this.state.hits,
      rulesHash: this.state.rules ? hashContract(this.state.rules) : null,
      authentication: 'not-authenticated', mode: 'application-local-memory-only' };
  }
  plan(input: unknown, samples: unknown): MockPlan {
    const rules = validateMockRules(input), requests = MockSamplesSchema.parse(samples);
    if (rules.targetId !== this.targetId) { throw new Error('MOCK_TARGET_MISMATCH'); }
    const baselineHash = hashContract({ revision: this.revision, rules: this.state.rules });
    const description = { targetId: this.targetId, payloadHash: hashContract(rules), baselineHash,
      samplesHash: hashContract(requests), matches: requests.map((sample) => match(rules, sample)),
      responses: rules.rules.map((rule) => mockResponseSummary(rule.ruleId, rule.response)),
      coverage: 'provided-request-samples-only' as const, ruleCount: rules.rules.length };
    return { ...description, planHash: hashContract(description) };
  }
  operation(input: unknown, payload: unknown, samples: unknown): WriteOperation {
    const command = WriteCommandSchema.parse(input), rules = validateMockRules(payload);
    const plan = this.plan(rules, samples);
    if (command.scope !== 'network.mock' || command.targetId !== this.targetId ||
      command.payloadHash !== plan.payloadHash || command.planHash !== plan.planHash) { throw new Error('MOCK_PLAN_MISMATCH'); }
    const before = this.state, revision = this.revision, owner = {};
    let applied = false;
    return {
      execute: async (signal) => {
        const now = Date.now();
        if (signal.aborted || now >= command.deadline) { throw new Error('MOCK_EXPIRED'); }
        if (now < this.lastTime) { throw new Error('MOCK_CLOCK_ROLLBACK'); }
        if (this.revision !== revision) { throw new Error('MOCK_TABLE_CHANGED'); }
        this.state = { rules, hits: 0, owner, signal, expiresAt: Math.min(command.deadline, now + command.ttlMs),
          invalidated: false, clockEpoch: this.clockEpoch };
        this.revision++; applied = true; this.lastTime = now;
      },
      rollback: async () => {
        if (!applied) { return; }
        if (this.state.owner !== owner) { throw new Error('MOCK_TABLE_CHANGED'); }
        this.state = before; this.revision++; applied = false;
      },
    };
  }
  evaluate(input: unknown): { ruleId: string; response: ReturnType<typeof renderMockResponse> } | null {
    const request = MockRequestSchema.parse(input);
    if (!this.active()) { return null; }
    const found = match(this.state.rules, request);
    if (found.decision !== 'mock') { return null; }
    if (this.state.hits >= Number.MAX_SAFE_INTEGER) { this.state.invalidated = true; return null; }
    const rule = this.state.rules!.rules.find((rule) => rule.ruleId === found.ruleId)!;
    this.state.hits++;
    return { ruleId: rule.ruleId, response: renderMockResponse(rule.response) };
  }
  private active(): boolean {
    const now = Date.now();
    if (now < this.lastTime) { this.clockEpoch++; }
    if (this.state.signal?.aborted || now >= this.state.expiresAt || this.state.clockEpoch !== this.clockEpoch) {
      this.state.invalidated = true;
    }
    this.lastTime = Math.max(now, this.lastTime);
    return !!this.state.rules && !this.state.invalidated;
  }
}
