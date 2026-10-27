#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const mode = JSON.parse(readFileSync(join(root, 'mode.json'), 'utf8'));
const trace = (value) => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify(value) + '\n');
trace({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
process.on('exit', () => trace({ closed: process.pid }));
process.on('SIGTERM', () => process.exit(0));
if (!['models', 'app-server'].includes(process.argv[2])) { process.exit(64); }
if (process.argv.includes('models')) {
  console.log(JSON.stringify(mode.models ?? [
    { name: 'Display Name', config_name: 'actual-model', context_window: 200000 },
    { name: 'Fallback Name', context_window: 32768 },
  ]));
  process.exit(0);
}
const send = (value) => console.log(JSON.stringify(value));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); trace(request);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-fixture' } } });
  if (request.method !== 'turn/start') return;
  send({ id: request.id, result: { turn: { id: 'turn-fixture' } } });
  const text = request.params.input[0].text;
  if (mode.hang) {
    writeFileSync(join(root, 'ready'), 'ready'); setInterval(() => {}, 1000); return;
  }
  if (mode.error) {
    console.error('EXAMPLE_PRIVATE_STDERR');
    send({ method: 'turn/completed', params: { threadId: 'thread-fixture',
      turn: { id: 'turn-fixture', status: 'failed', error: { message: 'EXAMPLE_PRIVATE_ERROR' } } } }); return;
  }
  if (mode.malformed) { console.log('{invalid'); return; }
  if (mode.tool && !text.includes('"role":"toolResult"')) {
    send({ id: 100, method: 'item/tool/call', params: { threadId: 'thread-fixture', turnId: 'turn-fixture',
      callId: 'fixture-call', namespace: null, tool: mode.tool, arguments: mode.arguments ?? {} } }); return;
  }
  const reply = mode.oversized ? 'a'.repeat(300000) : 'OHMATE_OK';
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'message', delta: reply } });
  send({ method: 'item/completed', params: { threadId: 'thread-fixture', turnId: 'turn-fixture',
    item: { type: 'agentMessage', id: 'message', text: reply } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } });
});
