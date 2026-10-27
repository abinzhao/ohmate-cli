/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isBuildLocked,
  tryWithBuildLock,
  withBuildLock,
} from './build-lock.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'build-lock-ut-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

describe('isBuildLocked', () => {
  it('reports false for a fresh project root', async () => {
    const root = makeRoot();
    expect(await isBuildLocked(root)).toBe(false);
  });
});

describe('withBuildLock', () => {
  it('runs the action under the lock and releases it on success', async () => {
    const root = makeRoot();
    let signal: AbortSignal | undefined;
    const result = await withBuildLock(root, async (actionSignal) => {
      signal = actionSignal;
      expect(await isBuildLocked(root)).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(signal?.aborted).toBe(false);
    expect(await isBuildLocked(root)).toBe(false);
  });

  it('releases the lock when the action throws', async () => {
    const root = makeRoot();
    await expect(
      withBuildLock(root, async () => {
        throw new Error('build failed');
      })
    ).rejects.toThrow('build failed');
    expect(await isBuildLocked(root)).toBe(false);
  });

  it('notifies onWait once while contended and takes over after release', async () => {
    const root = makeRoot();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDone = withBuildLock(root, () => firstGate);

    await waitFor(() => isBuildLocked(root));

    let waitCalls = 0;
    const secondDone = withBuildLock(
      root,
      async () => 'second',
      () => {
        waitCalls += 1;
      }
    );

    await waitFor(async () => waitCalls > 0);
    releaseFirst();
    await firstDone;
    expect(await secondDone).toBe('second');
    expect(waitCalls).toBe(1);
    expect(await isBuildLocked(root)).toBe(false);
  }, 15_000);
});

describe('tryWithBuildLock', () => {
  it('acquires when the lock is free and returns the action result', async () => {
    const root = makeRoot();
    const outcome = await tryWithBuildLock(root, async () => 42);
    expect(outcome).toEqual({ acquired: true, result: 42 });
    expect(await isBuildLocked(root)).toBe(false);
  });

  it('reports acquired false and skips the action when the lock is held', async () => {
    const root = makeRoot();
    const outcome = await withBuildLock(root, async () => {
      let actionRan = false;
      const inner = await tryWithBuildLock(root, async () => {
        actionRan = true;
        return 'inner';
      });
      expect(inner).toEqual({ acquired: false });
      expect(actionRan).toBe(false);
      return 'outer';
    });
    expect(outcome).toBe('outer');
  });
});
