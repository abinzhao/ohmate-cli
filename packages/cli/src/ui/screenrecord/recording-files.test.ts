/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDestinationAvailable,
  createReceiveDir,
  publishWithoutOverwrite,
  removeReceiveDir,
  resolveDestination,
  validateReceived,
} from './recording-files.js';
import {
  createTestDirectory,
  removeTestDirectory,
} from './test-directory.js';

const sampleMp4 = await fs.promises.readFile(
  new URL('./fixtures/sample.mp4', import.meta.url)
);

describe('resolveDestination', () => {
  let dir: string;
  const date = new Date(2026, 8, 16, 11, 55, 30, 123);

  beforeEach(async () => {
    dir = await createTestDirectory('record-files-');
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  it('auto-names a directory destination', async () => {
    const resolved = await resolveDestination(dir, 'Mate XT', date, 'a3f2');
    expect(path.dirname(resolved)).toBe(dir);
    expect(path.basename(resolved)).toBe('Mate XT-20260916-115530123-a3f2.mp4');
  });

  it('resolves a relative file target to an absolute path', async () => {
    const cwd = process.cwd();
    const resolved = await resolveDestination(
      path.join(dir, 'demo.mp4'),
      'Mate XT',
      date,
      'a3f2'
    );
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.join(dir, 'demo.mp4'));
    expect(cwd).toBe(process.cwd());
  });

  it('rejects a missing path, a bad extension, an existing file, and a missing parent', async () => {
    await expect(
      resolveDestination(undefined, 'd', date, 'a3f2')
    ).rejects.toMatchObject({ code: 'INVALID_RECORDING_PATH' });
    await expect(
      resolveDestination(path.join(dir, 'demo.png'), 'd', date, 'a3f2')
    ).rejects.toMatchObject({ code: 'INVALID_RECORDING_PATH' });
    const existing = path.join(dir, 'demo.mp4');
    await fs.promises.writeFile(existing, 'x');
    await expect(
      resolveDestination(existing, 'd', date, 'a3f2')
    ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(
      resolveDestination(path.join(dir, 'gone', 'demo.mp4'), 'd', date, 'a3f2')
    ).rejects.toMatchObject({ code: 'INVALID_RECORDING_PATH' });
  });
});

describe('validateReceived', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTestDirectory('record-mp4-');
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  const writeTemp = async (content: Buffer): Promise<string> => {
    const file = path.join(dir, 'clip.mp4');
    await fs.promises.writeFile(file, content);
    return file;
  };

  it('accepts a real complete MP4 with a video track and returns its size', async () => {
    const content = await fs.promises.readFile(
      new URL('./fixtures/sample.mp4', import.meta.url)
    );
    const file = await writeTemp(content);
    await expect(validateReceived(file)).resolves.toBe(content.length);
  });

  it('rejects an empty file', async () => {
    const file = await writeTemp(Buffer.alloc(0));
    await expect(validateReceived(file)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('rejects an unfinished recording without a movie header', async () => {
    const file = await writeTemp(sampleMp4.subarray(0, 24));
    await expect(validateReceived(file)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('rejects a truncated file', async () => {
    const file = await writeTemp(sampleMp4.subarray(0, sampleMp4.length - 10));
    await expect(validateReceived(file)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('rejects garbage', async () => {
    const file = await writeTemp(Buffer.from('not a video at all.........'));
    await expect(validateReceived(file)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('rejects a truncated real MP4 (mdat cut mid-file)', async () => {
    const content = await fs.promises.readFile(
      new URL('./fixtures/sample.mp4', import.meta.url)
    );
    const cut = content.subarray(0, Math.floor(content.length / 2));
    const file = await writeTemp(cut);
    await expect(validateReceived(file)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });
});

describe('publishWithoutOverwrite', () => {
  let dir: string;
  let source: string;

  beforeEach(async () => {
    dir = await createTestDirectory('record-pub-');
    source = path.join(dir, 'received.mp4');
    await fs.promises.copyFile(
      new URL('./fixtures/sample.mp4', import.meta.url),
      source
    );
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  it('publishes to the requested name when free', async () => {
    const target = path.join(dir, 'demo.mp4');
    const published = await publishWithoutOverwrite(source, target);
    expect(published).toBe(target);
    const content = await fs.promises.readFile(target);
    expect(content).toEqual(sampleMp4);
  });

  it('falls back to -recovered names without touching the occupant', async () => {
    const target = path.join(dir, 'demo.mp4');
    await fs.promises.writeFile(target, 'original');
    const published = await publishWithoutOverwrite(source, target);
    expect(published).toBe(path.join(dir, 'demo-recovered.mp4'));
    await expect(fs.promises.readFile(target, 'utf8')).resolves.toBe(
      'original'
    );
  });

  it('walks the numbered recovery sequence', async () => {
    const target = path.join(dir, 'demo.mp4');
    await fs.promises.writeFile(target, 'a');
    await fs.promises.writeFile(path.join(dir, 'demo-recovered.mp4'), 'b');
    const published = await publishWithoutOverwrite(source, target);
    expect(published).toBe(path.join(dir, 'demo-recovered-2.mp4'));
  });

  it('fails when every candidate is taken', async () => {
    const target = path.join(dir, 'demo.mp4');
    await fs.promises.writeFile(target, 'x');
    await fs.promises.writeFile(path.join(dir, 'demo-recovered.mp4'), 'x');
    for (let i = 2; i < 20; i++) {
      await fs.promises.writeFile(
        path.join(dir, `demo-recovered-${i}.mp4`),
        'x'
      );
    }
    await expect(publishWithoutOverwrite(source, target)).rejects.toMatchObject(
      { code: 'DESTINATION_UNAVAILABLE' }
    );
  });

  it('does not overwrite when racing an existing file', async () => {
    const target = path.join(dir, 'demo.mp4');
    await fs.promises.writeFile(target, 'keep-me');
    await publishWithoutOverwrite(source, target);
    await expect(fs.promises.readFile(target, 'utf8')).resolves.toBe('keep-me');
  });
});

describe('receive directory lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTestDirectory('record-recv-');
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  it('creates and removes a private receive dir next to the target', async () => {
    const target = path.join(dir, 'demo.mp4');
    const receiveDir = await createReceiveDir(target);
    expect(path.dirname(receiveDir)).toBe(dir);
    expect(path.basename(receiveDir)).toMatch(/^\.devecocli-record-/);
    await removeReceiveDir(receiveDir, target);
    expect(fs.existsSync(receiveDir)).toBe(false);
  });

  it('refuses to remove a directory that is not ours', async () => {
    const target = path.join(dir, 'demo.mp4');
    const foreign = await fs.promises.mkdtemp(path.join(dir, 'other-'));
    await removeReceiveDir(foreign, target);
    expect(fs.existsSync(foreign)).toBe(true);
    const outside = await createTestDirectory('outside-');
    try {
      await removeReceiveDir(outside, target);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      await removeTestDirectory(outside);
    }
  });
});

describe('assertDestinationAvailable', () => {
  it('passes for a missing path and fails for an existing one', async () => {
    const dir = await createTestDirectory('record-av-');
    try {
      const target = path.join(dir, 'demo.mp4');
      await expect(assertDestinationAvailable(target)).resolves.toBeUndefined();
      await fs.promises.writeFile(target, 'x');
      await expect(assertDestinationAvailable(target)).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS',
      });
    } finally {
      await removeTestDirectory(dir);
    }
  });
});
