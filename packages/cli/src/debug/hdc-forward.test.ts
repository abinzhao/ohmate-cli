/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ForwardDependencies } from './hdc-forward.js';

let root: string;
let forwardModule: typeof import('./hdc-forward.js');
let rules: string, calls: string[][];
const serial = 'owned-fixture-device';
const controller = new AbortController();
let dependencies: ForwardDependencies;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-hdc-forward-'));
  const loaded = await import('./hdc-forward.js').catch(() => ({}));
  expect(loaded).toHaveProperty('HdcReadonlyForward');
  forwardModule = loaded as typeof import('./hdc-forward.js');
  rules = ''; calls = [];
  dependencies = {
    select: async () => serial,
    run: async (args) => {
      calls.push(args);
      if (args.join(' ') === 'fport ls') { return rules || '[Empty]'; }
      if (args.includes('rport')) {
        rules = `${serial} tcp:43210 tcp:43210 [Reverse]`;
        return 'Forward port result:OK';
      }
      if (args.includes('rm')) { rules = ''; return 'Remove forward ruler success'; }
      throw new Error('Unexpected command');
    },
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function acquire() {
  return forwardModule.HdcReadonlyForward.acquire({ dataDir: root, selector: serial, port: 43210, signal: controller.signal }, dependencies);
}

it('owns only a newly observed reverse rule and releases the exact selected device and endpoints', async () => {
  const forward = await acquire();
  expect(forward.binding).toMatchObject({ state: 'active', direction: 'device-to-host', port: 43210 });
  expect(JSON.stringify(forward.binding)).not.toContain(serial);
  expect(calls).toContainEqual(['-t', serial, 'rport', 'tcp:43210', 'tcp:43210']);
  await forward.close();
  expect(calls).toContainEqual(['-t', serial, 'fport', 'rm', 'tcp:43210', 'tcp:43210']);
  expect(rules).toBe('');
  await forward.close();
  expect(calls.filter((args) => args.includes('rm'))).toHaveLength(1);
});

it('refuses an existing matching rule instead of claiming someone else’s mapping', async () => {
  rules = `${serial} tcp:43210 tcp:43210 [Reverse]`;
  await expect(acquire()).rejects.toThrow('HDC_FORWARD_CONFLICT');
  expect(calls.filter((args) => args.includes('rport') || args.includes('rm'))).toHaveLength(0);
});

it('does not remove another device’s reverse rule on the same port', async () => {
  rules = `other-fixture tcp:43210 tcp:43210 [Reverse]`;
  const forward = await acquire();
  rules += '\nother-fixture tcp:43210 tcp:43210 [Reverse]';
  await forward.close();
  expect(calls.filter((args) => args.includes('rm'))).toEqual([
    ['-t', serial, 'fport', 'rm', 'tcp:43210', 'tcp:43210'],
  ]);
});

it('retains a changed mapping and reports cleanup conflict', async () => {
  const forward = await acquire();
  rules = `${serial} tcp:43210 tcp:55555 [Reverse]`;
  await expect(forward.close()).rejects.toThrow('HDC_FORWARD_CHANGED');
  expect(calls.some((args) => args.includes('rm'))).toBe(false);
  rules = `${serial} tcp:43210 tcp:43210 [Reverse]`;
  await forward.close();
});

it('never treats a forward-direction row as evidence of the reverse mapping', async () => {
  dependencies.run = async (args) => {
    calls.push(args);
    if (args.includes('rport')) { rules = `${serial} tcp:43210 tcp:43210 [Forward]`; return 'OK'; }
    return rules || '[Empty]';
  };
  await expect(acquire()).rejects.toThrow('HDC_FORWARD_NOT_OBSERVED');
  expect(calls.some((args) => args.includes('rm'))).toBe(false);
});

it('refuses malformed or anonymous table rows before creating a rule', async () => {
  for (const output of ['tcp:43210 tcp:43210 [Reverse]', 'unexpected response', `${serial} tcp:0 tcp:1 [Reverse]`]) {
    rules = output;
    await expect(acquire()).rejects.toThrow('HDC_FORWARD_TABLE_INVALID');
  }
  expect(calls.some((args) => args.includes('rport'))).toBe(false);
});

it('does not expose device command output in acquisition errors', async () => {
  dependencies.run = async () => { throw new Error('fixture-secret-device-identifier'); };
  await expect(acquire()).rejects.toThrow('HDC_FORWARD_COMMAND_FAILED');
});

it('serializes acquisitions within the same data directory', async () => {
  const forward = await acquire();
  await expect(acquire()).rejects.toThrow('Resource is busy');
  await forward.close();
  const next = await acquire();
  await next.close();
});

it('releases the lock after creation fails so the next acquisition can proceed', async () => {
  const run = dependencies.run;
  dependencies.run = async (args, signal) => {
    if (args.includes('rport')) { throw new Error('fixture creation failed'); }
    return run(args, signal);
  };
  await expect(acquire()).rejects.toThrow('HDC_FORWARD_COMMAND_FAILED');
  dependencies.run = run;
  const next = await acquire();
  await next.close();
});

it('keeps failed cleanup visible and permits a bounded retry', async () => {
  const forward = await acquire();
  const run = dependencies.run;
  dependencies.run = async (args, signal) => {
    if (args.includes('rm')) { throw new Error('fixture disconnection'); }
    return run(args, signal);
  };
  await expect(forward.close()).rejects.toThrow('HDC_FORWARD_COMMAND_FAILED');
  expect(forward.binding.state).toBe('cleanup-failed');
  dependencies.run = run;
  await forward.close();
  expect(forward.binding.state).toBe('released');
});

it('checks removal by reading the table rather than trusting an exit code', async () => {
  const forward = await acquire();
  const run = dependencies.run;
  dependencies.run = async (args, signal) => args.includes('rm') ? 'Remove forward ruler success' : run(args, signal);
  await expect(forward.close()).rejects.toThrow('HDC_FORWARD_REMOVE_NOT_OBSERVED');
  dependencies.run = run;
  await forward.close();
});

it('parses mixed-direction and non-TCP rows without losing table identities', () => {
  expect(forwardModule.parseForwardRules(`${serial} tcp:43210 tcp:43210 [Reverse]\nother localabstract:fixture tcp:9 [Forward]`))
    .toEqual([
      { serial, local: 'tcp:43210', remote: 'tcp:43210', direction: 'Reverse' },
      { serial: 'other', local: 'localabstract:fixture', remote: 'tcp:9', direction: 'Forward' },
    ]);
});

it('cleans a successfully created mapping if cancellation arrives before verification', async () => {
  const cancellation = new AbortController(), run = dependencies.run;
  dependencies.run = async (args, signal) => {
    if (signal.aborted) { throw new Error('fixture cancelled query'); }
    const result = await run(args, signal);
    if (args.includes('rport')) { cancellation.abort(); }
    return result;
  };
  await expect(forwardModule.HdcReadonlyForward.acquire({ dataDir: root, selector: serial, port: 43210,
    signal: cancellation.signal }, dependencies)).rejects.toThrow('CANCELLED');
  expect(rules).toBe('');
});

it('retains an owner for retry when observation fails after a successful create', async () => {
  const run = dependencies.run;
  let created = false;
  dependencies.run = async (args, signal) => {
    if (created && args.join(' ') === 'fport ls') { throw new Error('fixture lost device connection'); }
    const result = await run(args, signal);
    if (args.includes('rport')) { created = true; }
    return result;
  };
  const failure = await acquire().catch((error: Error) => error);
  expect(failure).toHaveProperty('owner');
  expect(rules).not.toBe('');
  dependencies.run = run;
  const owner = (failure as InstanceType<typeof forwardModule.ForwardAcquisitionError>).owner;
  await owner.close();
  expect(rules).toBe('');
});
