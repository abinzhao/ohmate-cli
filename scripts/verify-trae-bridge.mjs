/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startBridge } from '../extensions/trae-model-bridge/bridge.mjs';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-cli-'));
let count = 0, toolResults = 0, cancelled = false;
const bridge = await startBridge({ list: async () => [{ id: 'fixture-host', name: 'Fixture host',
  vendor: 'test-only', maxInputTokens: 32768 }], complete: async function* (input, signal) {
    count++;
    if (JSON.stringify(input.messages).includes('CANCEL_CHECK')) {
      yield { text: 'Waiting' };
      await new Promise((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    } else if (JSON.stringify(input.messages).includes('ERROR_CHECK')) {
      yield { text: 'Partial' }; throw new Error('EXAMPLE_PRIVATE_PROVIDER_ERROR');
    } else if (input.messages.some((message) => message.role === 'tool')) {
      toolResults++; yield { text: 'OHMATE_BRIDGE_OK' };
    } else {
      yield { toolCall: { id: 'fixture-call', name: 'workspace__read', input: { path: 'main.ts' } } };
    }
  } });
const env = { ...process.env, OHMATE_DATA_DIR: join(root, 'data'), OHMATE_TRAE_BRIDGE_KEY: bridge.key };
async function cli(args, expected = 0) {
  const child = spawn(process.execPath, [bin, ...args, '--format', 'json'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(20_000),
  });
  let stdout = ''; child.stdout.on('data', (part) => { stdout += part; }); child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, expected, `Unexpected CLI exit for ${args[0]} ${args[1]}`);
  const result = JSON.parse(stdout);
  assert(!stdout.includes(bridge.key), 'Bridge credential entered CLI receipt');
  return result;
}
let taskId;
try {
  await writeFile(join(root, 'main.ts'), 'export const value = 1;\n');
  const discovered = (await cli(['model', 'trae', '--endpoint', bridge.endpoint])).data;
  assert.equal(discovered.models.length, 1); assert.equal(discovered.selectedAutomatically, false);
  assert.equal((await cli(['model', 'list'])).data.selected, null);
  await cli(['model', 'select', discovered.models[0].id]);
  const selected = ['--files', 'main.ts', '--allowed-tools', 'workspace.read', '--project', root];
  const preview = (await cli(['context', 'preview', '--prompt', 'Read file', ...selected])).data;
  const result = await cli(['agent', 'run', 'Read file', ...selected, '--preview-hash', preview.hash, '--max-turns', '3']);
  assert.equal(result.data.text, 'OHMATE_BRIDGE_OK'); assert.equal(toolResults, 1);
  const errorPreview = (await cli(['context', 'preview', '--prompt', 'ERROR_CHECK', ...selected])).data;
  await cli(['agent', 'run', 'ERROR_CHECK', ...selected, '--preview-hash', errorPreview.hash], 6);
  const cancelPreview = (await cli(['context', 'preview', '--prompt', 'CANCEL_CHECK', ...selected])).data;
  const input = { prompt: 'CANCEL_CHECK', files: ['main.ts'], allowedTools: ['workspace.read'], previewHash: cancelPreview.hash };
  const before = count;
  taskId = (await cli(['task', 'submit', 'agent.run', '--payload', JSON.stringify(input), '--project', root])).data.id;
  const deadline = Date.now() + 15_000;
  while (count === before && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert(count > before); await cli(['task', 'cancel', taskId]);
  while (Date.now() < deadline) {
    const task = (await cli(['task', 'show', taskId])).data;
    if (task.state === 'cancelled' && !task.processes.length) { break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await cli(['task', 'show', taskId])).data.state, 'cancelled'); assert(cancelled);
  taskId = undefined;
  const saved = await readFile(join(root, 'data/state/models.json'), 'utf8'); assert(!saved.includes(bridge.key));
  const report = { status: 'passed', node: process.version, binary: bin, producer: 'test-host',
    realCli: true, realHttp: true, realPiSdk: true, toolLoop: true, partialErrorPropagated: true,
    backgroundCancellation: true, credentialsNotPersisted: true, actualTraeHost: false, actualCloudModels: false };
  if (process.env.OHMATE_TRAE_VERIFY_OUTPUT) { await writeFile(process.env.OHMATE_TRAE_VERIFY_OUTPUT, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report));
} finally {
  if (taskId) { await cli(['task', 'cancel', taskId, '--force']).catch(() => {}); }
  await bridge.close();
  // Only delete this fixture after the task worker has been observed stopped.
  if (!taskId) { await rm(root, { recursive: true, force: true }); }
}
