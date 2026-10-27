/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLock } from './file-lock.js';
import {
  createTestDirectory,
  removeTestDirectory,
} from './test-directory.js';
import { encodeSerial } from './recording-paths.js';
import { RecordingStore } from './recording-store.js';
import { sameSession } from './session-identity.js';
import type { RecordingSession } from './types.js';

const SERIAL = '0177832457001024';

function makeSession(
  overrides: Partial<RecordingSession> = {}
): RecordingSession {
  return {
    fileName: 'devecocli-20260916-115530123-a3f2.mp4',
    abilityRecordId: 14945,
    startTime: 1789530530123,
    localPath: path.resolve('out', 'demo.mp4'),
    ...overrides,
  };
}

describe('RecordingStore', () => {
  let dir: string;
  let store: RecordingStore;
  let lock: FileLock;

  beforeEach(async () => {
    dir = await createTestDirectory('record-store-');
    store = new RecordingStore(dir);
    lock = new FileLock(dir);
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  it('reads a missing session as undefined', async () => {
    await expect(store.read(SERIAL)).resolves.toBeUndefined();
  });

  it('creates a session atomically and reads it back', async () => {
    const session = makeSession();
    await lock.withDeviceLock(SERIAL, (lease) =>
      store.createAtomic(SERIAL, session, lease)
    );
    await expect(store.read(SERIAL)).resolves.toEqual(session);
  });

  it('leaves no temp files behind after createAtomic', async () => {
    await lock.withDeviceLock(SERIAL, (lease) =>
      store.createAtomic(SERIAL, makeSession(), lease)
    );
    const leftovers = (await fs.promises.readdir(dir)).filter((name) =>
      name.endsWith('.tmp')
    );
    expect(leftovers).toEqual([]);
  });

  it('refuses to overwrite an existing session', async () => {
    await lock.withDeviceLock(SERIAL, async (lease) => {
      await store.createAtomic(SERIAL, makeSession(), lease);
      await expect(
        store.createAtomic(SERIAL, makeSession({ abilityRecordId: 9 }), lease)
      ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    });
    // The original record survives the conflict.
    await expect(store.read(SERIAL)).resolves.toEqual(makeSession());
  });

  it('throws SESSION_CORRUPT for invalid JSON', async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, `${encodeSerial(SERIAL)}.json`),
      '{ not json'
    );
    await expect(store.read(SERIAL)).rejects.toMatchObject({
      code: 'SESSION_CORRUPT',
    });
  });

  it.each([
    ['fileName with traversal', { fileName: '../evil.mp4' }],
    ['fileName that is not a basename', { fileName: 'a/b.mp4' }],
    ['non-positive abilityRecordId', { abilityRecordId: 0 }],
    [
      'unsafe abilityRecordId',
      { abilityRecordId: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['non-finite startTime', { startTime: Number.NaN }],
    ['relative localPath', { localPath: 'out/demo.mp4' }],
  ])('throws SESSION_CORRUPT for %s', async (_label, patch) => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, `${encodeSerial(SERIAL)}.json`),
      JSON.stringify({ ...makeSession(), ...patch })
    );
    await expect(store.read(SERIAL)).rejects.toMatchObject({
      code: 'SESSION_CORRUPT',
    });
  });

  it('deletes only the matching session', async () => {
    const session = makeSession();
    await lock.withDeviceLock(SERIAL, async (lease) => {
      await store.createAtomic(SERIAL, session, lease);
      await expect(
        store.deleteIfSame(SERIAL, makeSession({ abilityRecordId: 9 }), lease)
      ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
      await expect(store.read(SERIAL)).resolves.toEqual(session);
      await store.deleteIfSame(SERIAL, session, lease);
    });
    await expect(store.read(SERIAL)).resolves.toBeUndefined();
  });

  it('treats deleting a missing session as a no-op', async () => {
    await expect(
      lock.withDeviceLock(SERIAL, (lease) =>
        store.deleteIfSame(SERIAL, makeSession(), lease)
      )
    ).resolves.toBeUndefined();
  });

  it('checks lock ownership before creating', async () => {
    const lostLease = await lock.withDeviceLock(SERIAL, async (lease) => lease);
    await expect(
      store.createAtomic(SERIAL, makeSession(), lostLease)
    ).rejects.toMatchObject({ code: 'LOCK_LOST' });
    await expect(store.read(SERIAL)).resolves.toBeUndefined();
    expect(
      (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('preserves the session when deletion uses a released lease', async () => {
    const session = makeSession();
    const released = await lock.withDeviceLock(SERIAL, async (lease) => {
      await store.createAtomic(SERIAL, session, lease);
      return lease;
    });
    await expect(
      store.deleteIfSame(SERIAL, session, released)
    ).rejects.toMatchObject({ code: 'LOCK_LOST' });
    await expect(store.read(SERIAL)).resolves.toEqual(session);
    await lock.withDeviceLock(SERIAL, (lease) =>
      store.deleteIfSame(SERIAL, session, lease)
    );
  });
});

describe('sameSession', () => {
  it('compares all four fields', () => {
    const a = makeSession();
    expect(sameSession(a, { ...a })).toBe(true);
    expect(
      sameSession(a, { ...a, abilityRecordId: a.abilityRecordId + 1 })
    ).toBe(false);
    expect(sameSession(a, { ...a, fileName: 'other.mp4' })).toBe(false);
    expect(sameSession(a, { ...a, startTime: a.startTime + 1 })).toBe(false);
    expect(sameSession(a, { ...a, localPath: '/other.mp4' })).toBe(false);
  });

  it('treats undefined pairs as equal only when both missing', () => {
    expect(sameSession(undefined, undefined)).toBe(true);
    expect(sameSession(makeSession(), undefined)).toBe(false);
    expect(sameSession(undefined, makeSession())).toBe(false);
  });
});
