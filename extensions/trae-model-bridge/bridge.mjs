/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function textContent(content) {
  if (content === null || content === undefined) { return ''; }
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content) && content.every((part) => object(part) && part.type === 'text' && typeof part.text === 'string')) {
    return content.map((part) => part.text).join('\n');
  }
  fail('BRIDGE_TEXT_ONLY');
}
export function validateInput(body) {
  if (!object(body) || typeof body.model !== 'string' || !Array.isArray(body.messages) ||
      !body.messages.length || body.messages.length > 256 || (body.stream !== true && body.stream !== false)) { fail('BRIDGE_INPUT_INVALID'); }
  if (body.n !== undefined && body.n !== 1) { fail('BRIDGE_INPUT_INVALID'); }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 32)) { fail('BRIDGE_INPUT_INVALID'); }
  const names = new Set(), calls = new Set();
  for (const tool of body.tools ?? []) {
    if (tool?.type !== 'function' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function?.name) ||
        !object(tool.function.parameters) || names.has(tool.function.name)) { fail('BRIDGE_INPUT_INVALID'); }
    names.add(tool.function.name);
  }
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) { fail('BRIDGE_INPUT_INVALID'); }
  for (const message of body.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) { fail('BRIDGE_INPUT_INVALID'); }
    textContent(message.content);
    if (message.role === 'tool') {
      if (!calls.delete(message.tool_call_id)) { fail('BRIDGE_INPUT_INVALID'); }
    }
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 32) { fail('BRIDGE_INPUT_INVALID'); }
      for (const call of message.tool_calls) {
        if (typeof call.id !== 'string' || call.id.length > 200 || calls.has(call.id) ||
            call.type !== 'function' || !names.has(call.function?.name) || typeof call.function.arguments !== 'string') { fail('BRIDGE_INPUT_INVALID'); }
        if (!object(JSON.parse(call.function.arguments))) { fail('BRIDGE_INPUT_INVALID'); }
        calls.add(call.id);
      }
    }
  }
  if (calls.size) { fail('BRIDGE_INPUT_INVALID'); }
  return body;
}
export { textContent };

function publicModels(models) {
  if (!Array.isArray(models) || models.length > 512) { fail('BRIDGE_MODEL_LIST_INVALID'); }
  const ids = new Set();
  return models.map((model) => {
    if (typeof model.id !== 'string' || !model.id.length || model.id.length > 200 || ids.has(model.id) ||
        !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 1024 || model.maxInputTokens > 2_000_000) { fail('BRIDGE_MODEL_LIST_INVALID'); }
    ids.add(model.id);
    return { id: model.id, object: 'model', owned_by: String(model.vendor ?? 'vscode-lm').slice(0, 200),
      name: String(model.name ?? model.id).slice(0, 200), context_window: model.maxInputTokens };
  });
}
export async function startBridge(host, { timeoutMs = 60_000 } = {}) {
  const key = randomBytes(32).toString('base64url'), active = new Set();
  let authority, closing = false;
  const server = createServer(async (request, response) => {
    const json = (status, data) => {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
          'x-ohmate-model-bridge': 'vscode-lm-v1' });
        response.end(JSON.stringify(data));
      }
    };
    const error = (status, code) => json(status, { error: { code, message: code, type: 'bridge_error' } });
    const expected = Buffer.from(`Bearer ${key}`), provided = Buffer.from(String(request.headers.authorization ?? ''));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { error(401, 'BRIDGE_AUTH_REQUIRED'); return; }
    if (request.headers.host !== authority || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      error(403, 'BRIDGE_SOURCE_REJECTED'); return;
    }
    if (closing) { error(503, 'BRIDGE_STOPPED'); return; }
    if (request.method === 'GET' && request.url === '/v1/models') {
      try { json(200, { object: 'list', data: publicModels(await host.list()) }); }
      catch { error(502, 'BRIDGE_MODEL_LIST_UNAVAILABLE'); }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { error(404, 'BRIDGE_ROUTE_UNKNOWN'); return; }
    if (active.size) { error(429, 'BRIDGE_BUSY'); return; }
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('BRIDGE_TIMEOUT')), timeoutMs);
    const disconnect = () => controller.abort();
    response.once('close', disconnect);
    try {
      const parts = []; let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 1024 * 1024) { error(413, 'BRIDGE_BODY_TOO_LARGE'); return; }
        parts.push(part); controller.signal.throwIfAborted();
      }
      let body;
      try { body = validateInput(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { error(400, 'BRIDGE_INPUT_INVALID'); return; }
      if (!publicModels(await host.list()).some((model) => model.id === body.model)) { error(400, 'BRIDGE_MODEL_UNKNOWN'); return; }
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
      let toolIndex = 0, outputBytes = 0, text = ''; const toolCalls = [], callIds = new Set();
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }] });
      const send = async (value) => {
        controller.signal.throwIfAborted();
        if (!response.headersSent) { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
          'x-ohmate-model-bridge': 'vscode-lm-v1' }); }
        if (!response.write(`data: ${JSON.stringify(value)}\n\n`)) {
          await once(response, 'drain', { signal: controller.signal });
        }
      };
      for await (const part of host.complete(body, controller.signal)) {
        controller.signal.throwIfAborted();
        outputBytes += Buffer.byteLength(JSON.stringify(part));
        if (outputBytes > 512 * 1024) { fail('BRIDGE_OUTPUT_LIMIT'); }
        if (typeof part.text === 'string') {
          if (body.stream) { await send(chunk({ content: part.text })); } else { text += part.text; }
        } else if (object(part.toolCall)) {
          const call = part.toolCall;
          if (typeof call.id !== 'string' || call.id.length > 200 || callIds.has(call.id) || toolIndex >= 32 ||
              body.tool_choice === 'none' || !(body.tools ?? []).some((tool) => tool.function.name === call.name) ||
              !object(call.input)) { fail('BRIDGE_RESPONSE_INVALID'); }
          callIds.add(call.id);
          const value = { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } };
          toolCalls.push(value);
          if (body.stream) { await send(chunk({ tool_calls: [{ index: toolIndex, ...value }] })); }
          toolIndex++;
        } else { fail('BRIDGE_RESPONSE_INVALID'); }
      }
      controller.signal.throwIfAborted();
      const finish = toolIndex ? 'tool_calls' : 'stop';
      if (body.stream) { await send(chunk({}, finish)); response.end('data: [DONE]\n\n'); }
      else { json(200, { id, object: 'chat.completion', created, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text, ...(toolIndex ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }] }); }
    } catch (cause) {
      const code = ['BRIDGE_USER_DECLINED', 'BRIDGE_RESPONSE_INVALID', 'BRIDGE_OUTPUT_LIMIT', 'BRIDGE_CONTEXT_LIMIT',
        'BRIDGE_API_UNAVAILABLE'].includes(cause?.message) ? cause.message : controller.signal.aborted ? 'BRIDGE_CANCELLED' : 'BRIDGE_HOST_FAILED';
      if (response.headersSent && !response.destroyed) { response.end(`data: ${JSON.stringify({ error: { code, message: code } })}\n\ndata: [DONE]\n\n`); }
      else { error(code === 'BRIDGE_USER_DECLINED' ? 403 : 502, code); }
    } finally { clearTimeout(timer); response.off('close', disconnect); active.delete(controller); }
  });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 10_000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`;
  return { endpoint: `http://${authority}/v1`, key,
    close: async () => {
      closing = true; for (const controller of active) { controller.abort(); }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    } };
}
