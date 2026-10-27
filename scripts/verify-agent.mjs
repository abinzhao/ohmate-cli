/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(process.argv[2] ?? join(root, 'packages/cli-wrapper/cli.js'));
const stage = process.argv[3] ?? 'm1-agent-built';
assert.match(stage, /^[a-z0-9-]+$/);
const temporary = await mkdtemp(join(tmpdir(), 'ohmate-agent-validation-'));
const environment = { ...process.env, OHMATE_DATA_DIR: join(temporary, 'data'), OHMATE_VALIDATION_KEY: 'EXAMPLE_LOCAL_PROTOCOL_ONLY' };
let requestCount = 0, cancelledConnections = 0;
const activeTasks = new Set();
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) { body += chunk; }
  const payload = JSON.parse(body);
  requestCount++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (body.includes('CancelCheck')) {
    response.write('data: {"choices":[{"index":0,"delta":{"content":"waiting"}}]}\n\n');
    response.once('close', () => { cancelledConnections++; });
    return;
  }
  const called = payload.messages.some((message) => message.role === 'tool');
  const delta = called ? { content: 'Local SDK tool loop passed.' } :
    { tool_calls: [{ index: 0, id: 'local-call', type: 'function', function: { name: 'workspace__read', arguments: '{"path":"main.ts"}' } }] };
  for (const chunk of [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: called ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } },
  ]) { response.write(`data: ${JSON.stringify({ id: 'local-validation', model: 'example', ...chunk })}\n\n`); }
  response.end('data: [DONE]\n\n');
});

async function run(args, expected = 0) {
  const child = spawn(process.execPath, [binary, ...args, '--format', 'json'], {
    cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    signal: AbortSignal.timeout(60_000),
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, expected, `CLI check failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function waitTask(id, expected) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const task = (await run(['task', 'show', id])).data;
    if (task.state === expected && task.processes.length === 0) { activeTasks.delete(id); return task; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Background task did not settle');
}

try {
  await writeFile(join(temporary, 'main.ts'), 'export const validation = 1;\n');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  assert.equal((await run(['model', 'list'])).data.selected, null);
  await run(['model', 'add', 'validation', '--api', 'openai-completions', '--model', 'example',
    '--endpoint', endpoint, '--credential-env', 'OHMATE_VALIDATION_KEY', '--max-tokens', '128']);
  await run(['model', 'select', 'validation']);
  const selected = ['--files', 'main.ts', '--allowed-tools', 'workspace.read', '--project', temporary];
  const preview = (await run(['context', 'preview', '--prompt', 'Inspect', ...selected])).data;
  const foreground = await run(['agent', 'run', 'Inspect', ...selected, '--preview-hash', preview.hash, '--max-turns', '3']);
  assert.equal(foreground.data.adapter, 'pi-sdk');
  assert.equal(foreground.data.text, 'Local SDK tool loop passed.');
  const exported = await run(['session', 'export', foreground.data.sessionId]);
  const artifact = exported.artifacts[0];
  assert.equal(createHash('sha256').update(await readFile(artifact.path)).digest('hex'), artifact.sha256);
  const input = { prompt: 'Inspect', files: ['main.ts'], allowedTools: ['workspace.read'], previewHash: preview.hash };
  const submitted = await run(['task', 'submit', 'agent.run', '--payload', JSON.stringify(input), '--project', temporary]);
  activeTasks.add(submitted.data.id);
  const background = await waitTask(submitted.data.id, 'succeeded');
  assert.equal(background.receipt.data.adapter, 'pi-sdk');
  assert.equal(background.sessionId, background.receipt.data.sessionId);
  const cancelPreview = (await run(['context', 'preview', '--prompt', 'CancelCheck', ...selected])).data;
  const cancelInput = { ...input, prompt: 'CancelCheck', previewHash: cancelPreview.hash };
  const deadline = Date.now() + 15_000, requestsBeforeCancel = requestCount;
  const cancellation = await run(['task', 'submit', 'agent.run', '--payload', JSON.stringify(cancelInput), '--project', temporary]);
  activeTasks.add(cancellation.data.id);
  while (requestCount === requestsBeforeCancel && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.ok(requestCount > requestsBeforeCancel, 'Cancellation request must reach the local protocol server');
  await run(['task', 'cancel', cancellation.data.id]);
  const cancelled = await waitTask(cancellation.data.id, 'cancelled');
  assert.equal(cancelled.receipt.exitCode, 130);
  assert.equal(cancelledConnections, 1);
  await run(['model', 'remove', 'validation']);
  await run(['agent', 'run', 'Inspect'], 5);
  await run(['capabilities']);
  const report = { schemaVersion: '1.0', stage, node: process.version, platform: process.platform,
    sdk: '@earendil-works/pi-agent-core@1.4.0', binary, protocol: 'loopback OpenAI-compatible SSE; no paid model',
    foreground: foreground.status, background: background.state, sessionLinked: true, exportHashVerified: true,
    cancellation: cancelled.state, cancelledConnections, requestCount, modelRemovalLeavesDeterministicToolsAvailable: true };
  await mkdir(join(root, 'artifacts/validation'), { recursive: true });
  await writeFile(join(root, 'artifacts/validation', `${stage}-sdk.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const id of activeTasks) {
    await run(['task', 'cancel', id, '--force']);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await run(['task', 'show', id])).data.processes.length) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await run(['task', 'show', id])).data.processes.length, 0, 'Validation worker must stop before directory cleanup');
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
