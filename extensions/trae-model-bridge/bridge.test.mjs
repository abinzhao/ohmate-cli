/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startBridge } from './bridge.mjs';
import { createVSCodeHost } from './vscode-host.mjs';

const model = { id: 'host-model', name: 'Host model', vendor: 'trae', family: 'example',
  version: '1', maxInputTokens: 32768 };
async function setup(t, complete = async function* () { yield { text: 'Hello' }; }) {
  const bridge = await startBridge({ list: async () => [model], complete });
  t.after(() => bridge.close());
  const request = (path, body, extra = {}) => fetch(`${bridge.endpoint}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${bridge.key}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { bridge, request };
}
const input = { model: model.id, stream: true, messages: [{ role: 'user', content: 'Hello' }] };

test('requires bearer auth, exact host, and rejects browser origins', async (t) => {
  const { bridge, request } = await setup(t);
  assert.equal((await fetch(`${bridge.endpoint}/models`)).status, 401);
  assert.equal((await request('/models', undefined, { origin: 'http://localhost' })).status, 403);
  // Fetch rewrites Host; use a real HTTP request to exercise the server's authority check.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${bridge.endpoint}/models`, { headers: {
      authorization: `Bearer ${bridge.key}`, host: 'remote.example',
    } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const response = await request('/models');
  assert.equal(response.headers.get('x-ohmate-model-bridge'), 'vscode-lm-v1');
  assert.equal((await response.json()).data[0].id, model.id);
});
test('streams text and native tool calls without executing tools', async (t) => {
  const { request } = await setup(t, async function* () {
    yield { text: 'Reading' };
    yield { toolCall: { id: 'call-1', name: 'workspace__read', input: { path: 'main.ts' } } };
  });
  const response = await request('/chat/completions', { ...input,
    tools: [{ type: 'function', function: { name: 'workspace__read', parameters: { type: 'object' } } }] });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Reading/); assert.match(text, /workspace__read/);
  assert.match(text, /"finish_reason":"tool_calls"/); assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /"usage"/);
});
test('rejects unsupported input and unknown models before invoking host', async (t) => {
  let calls = 0;
  const { request } = await setup(t, async function* () { calls++; });
  for (const body of [{ ...input, model: 'missing' }, { ...input, messages: [{ role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.test' } }] }] },
  { ...input, messages: [] }, { ...input, tools: Array(33).fill({}) }]) {
    assert.equal((await request('/chat/completions', body)).status, 400);
  }
  assert.equal(calls, 0);
});
test('cancels host when client disconnects and releases request slot', async (t) => {
  let cancelled;
  const observed = new Promise((resolve) => { cancelled = resolve; });
  const { request, bridge } = await setup(t, async function* (_, signal) {
    yield { text: 'Waiting' };
    await new Promise((resolve) => { signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }); });
  });
  const controller = new AbortController();
  const response = await fetch(`${bridge.endpoint}/chat/completions`, { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${bridge.key}` }, body: JSON.stringify(input) });
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await observed;
  assert.equal((await request('/models')).status, 200);
});
test('does not echo host exceptions or request content', async (t) => {
  const { request } = await setup(t, async function* () { throw new Error('EXAMPLE_PRIVATE_HOST_DATA'); });
  const response = await request('/chat/completions', input);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /EXAMPLE_PRIVATE/);
});
test('rejects unauthorized tools and overlapping requests', async (t) => {
  let release;
  const { request } = await setup(t, async function* () {
    yield { text: 'Waiting' }; await new Promise((resolve) => { release = resolve; });
    yield { toolCall: { id: 'x', name: 'unknown', input: {} } };
  });
  const first = await request('/chat/completions', input);
  assert.equal((await request('/chat/completions', input)).status, 429);
  release();
  const text = await first.text(); assert.match(text, /BRIDGE_RESPONSE_INVALID/);
  assert.doesNotMatch(text, /"name":"unknown"/);
});

function fakeVSCode(accept = true) {
  class Text { constructor(value) { this.value = value; } }
  class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class Source { token = {}; cancel() { this.cancelled = true; } dispose() {} }
  const requests = [], notices = [];
  const api = { LanguageModelTextPart: Text, LanguageModelToolCallPart: Call,
    LanguageModelToolResultPart: Result, CancellationTokenSource: Source,
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    LanguageModelChatMessage: { User: (content) => ({ role: 'user', content }),
      Assistant: (content) => ({ role: 'assistant', content }) },
    window: { showInformationMessage: async (...args) => { notices.push(args); return accept ? '允许本次请求' : undefined; } },
    lm: { selectChatModels: async () => [{ ...model, countTokens: async () => 10,
      sendRequest: async (messages, options) => { requests.push({ messages, options }); return {
        stream: (async function* () { yield new Text('Hello'); yield new Call('call-2', 'read', { path: 'a' }); })(),
      }; } }] } };
  return { api, requests, notices };
}
test('uses public API with user consent and preserves tool-call/result history', async () => {
  const { api, requests, notices } = fakeVSCode();
  const host = createVSCodeHost(api);
  const payload = { ...input, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    messages: [{ role: 'system', content: 'Context' }, { role: 'user', content: 'Read' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'File' }] };
  const chunks = [];
  for await (const chunk of host.complete(payload, new AbortController().signal)) { chunks.push(chunk); }
  assert.equal(notices.length, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[2].content[0].callId, 'call-1');
  assert.equal(requests[0].messages[3].content[0].callId, 'call-1');
  assert.deepEqual(requests[0].options.tools[0], { name: 'read', description: 'read', inputSchema: { type: 'object' } });
  assert.equal(chunks[1].toolCall.id, 'call-2');
});
test('decline and cancellation never send model requests', async () => {
  const { api, requests } = fakeVSCode(false);
  const controller = new AbortController();
  await assert.rejects(async () => { for await (const _ of createVSCodeHost(api).complete(input, controller.signal)) {} }, /BRIDGE_USER_DECLINED/);
  controller.abort();
  await assert.rejects(async () => { for await (const _ of createVSCodeHost(api).complete(input, controller.signal)) {} });
  assert.equal(requests.length, 0);
});
test('cancellation releases a request waiting for editor confirmation', { timeout: 1000 }, async () => {
  const { api, requests } = fakeVSCode();
  api.window.showInformationMessage = () => new Promise(() => {});
  const controller = new AbortController();
  const iterator = createVSCodeHost(api).complete(input, controller.signal);
  const pending = iterator.next();
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(pending); assert.equal(requests.length, 0); }
  finally { clearTimeout(timer); }
});

test('non-streaming responses preserve text and native tool calls without invented usage', async (t) => {
  const { request } = await setup(t, async function* () {
    yield { text: 'Read ' }; yield { text: 'complete' };
    yield { toolCall: { id: 'non-stream-call', name: 'read', input: { path: 'a' } } };
  });
  const response = await request('/chat/completions', { ...input, stream: false,
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  const result = await response.json();
  assert.equal(result.choices[0].message.content, 'Read complete');
  assert.deepEqual(result.choices[0].message.tool_calls[0].function, { name: 'read', arguments: '{"path":"a"}' });
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.usage, undefined);
});
test('oversized bodies are rejected before host invocation', async (t) => {
  let calls = 0;
  const { request } = await setup(t, async function* () { calls++; });
  const response = await request('/chat/completions', { ...input,
    messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] });
  assert.equal(response.status, 413); assert.equal(calls, 0);
});
test('closing the bridge cancels its active request and a new bridge rejects the old key', async (t) => {
  let observed;
  const cancelled = new Promise((resolve) => { observed = resolve; });
  const { bridge, request } = await setup(t, async function* (_, signal) {
    yield { text: 'Waiting' };
    await new Promise((resolve) => signal.addEventListener('abort', () => { observed(); resolve(); }, { once: true }));
  });
  const response = await request('/chat/completions', input);
  await response.body.getReader().read();
  await bridge.close(); await cancelled;
  const next = await startBridge({ list: async () => [model], complete: async function* () {} });
  t.after(() => next.close());
  assert.notEqual(next.key, bridge.key);
  assert.equal((await fetch(`${next.endpoint}/models`, { headers: { authorization: `Bearer ${bridge.key}` } })).status, 401);
});
test('context limit blocks the public API sendRequest', async () => {
  const { api, requests } = fakeVSCode(), select = api.lm.selectChatModels;
  api.lm.selectChatModels = async () => (await select()).map(item => ({ ...item, countTokens: async () => model.maxInputTokens }));
  await assert.rejects(async () => {
    for await (const _ of createVSCodeHost(api).complete(input, new AbortController().signal)) {}
  }, /BRIDGE_CONTEXT_LIMIT/);
  assert.equal(requests.length, 0);
});
test('request timeout cancels editor confirmation without calling a model', { timeout: 1000 }, async (t) => {
  const { api, requests } = fakeVSCode();
  api.window.showInformationMessage = () => new Promise(() => {});
  const bridge = await startBridge(createVSCodeHost(api), { timeoutMs: 50 });
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.endpoint}/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${bridge.key}` }, body: JSON.stringify(input) });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'BRIDGE_CANCELLED'); assert.equal(requests.length, 0);
});
