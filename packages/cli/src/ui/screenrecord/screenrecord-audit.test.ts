/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { lock as guardLock } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLock } from './file-lock.js';
import { RecordingStore } from './recording-store.js';
import { encodeSerial } from './recording-paths.js';
import { parseRecorderRecords } from './ability-records.js';
import {
  publishWithoutOverwrite,
  resolveDestination,
} from './recording-files.js';

const root = path.resolve('.audit-screenrecord');
const serial = 'audit-device';

describe('录屏状态异常输入审计', () => {
  it('目标能力 URI 被截断时应报告查询失败', () => {
    const truncated =
      'ExtensionRecords:\n' +
      '  uri [/com.huawei.hmos.screenrecorder/phone/com.huawei.hmos.screenrecorder.ServiceExtAbility';
    expect(() => parseRecorderRecords(truncated)).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });
});

describe('录屏真实文件系统审计', () => {
  let dir: string;
  let lock: FileLock;
  let store: RecordingStore;

  beforeEach(async () => {
    await fs.mkdir(root, { recursive: true });
    dir = await fs.mkdtemp(path.join(root, 'ut-'));
    lock = new FileLock(dir);
    store = new RecordingStore(dir);
  });

  afterEach(async () => {
    if (path.dirname(path.resolve(dir)) !== root) {
      throw new Error('审计目录超出工作区');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('真实 lease 保护登记创建、冲突检查和删除', async () => {
    const session = {
      fileName: 'devecocli-audit-a123.mp4',
      abilityRecordId: 123,
      startTime: Date.now(),
      localPath: path.join(dir, 'capture.mp4'),
    };
    await lock.withDeviceLock(serial, async (lease) => {
      await store.createAtomic(serial, session, lease);
      expect(await store.read(serial)).toEqual(session);
      await expect(
        store.createAtomic(serial, session, lease)
      ).rejects.toMatchObject({
        code: 'SESSION_CHANGED',
      });
      await expect(
        store.deleteIfSame(serial, { ...session, startTime: 1 }, lease)
      ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
      expect(await store.read(serial)).toEqual(session);
      await store.deleteIfSame(serial, session, lease);
      expect(await store.read(serial)).toBeUndefined();
    });
  });

  it('已释放的真实 lease 无法创建登记', async () => {
    const lease = await lock.withDeviceLock(serial, async (owned) => owned);
    await expect(
      store.createAtomic(
        serial,
        {
          fileName: 'devecocli-audit-a123.mp4',
          abilityRecordId: 123,
          startTime: Date.now(),
          localPath: path.join(dir, 'capture.mp4'),
        },
        lease
      )
    ).rejects.toMatchObject({ code: 'LOCK_LOST' });
    expect(await store.read(serial)).toBeUndefined();
    expect(
      (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('实际相对路径被解析为绝对路径', async () => {
    const relative = path.relative(
      process.cwd(),
      path.join(dir, 'capture.mp4')
    );
    expect(path.isAbsolute(relative)).toBe(false);
    expect(
      await resolveDestination(relative, 'device', new Date(), 'a123')
    ).toBe(path.join(dir, 'capture.mp4'));
  });

  it('两个并发发布保留不同来源的全部字节', async () => {
    const sourceA = path.join(dir, 'source-a');
    const sourceB = path.join(dir, 'source-b');
    await fs.copyFile(new URL('./file-lock.ts', import.meta.url), sourceA);
    await fs.copyFile(
      new URL('./recording-store.ts', import.meta.url),
      sourceB
    );
    const target = path.join(dir, 'capture.mp4');
    const published = await Promise.all([
      publishWithoutOverwrite(sourceA, target),
      publishWithoutOverwrite(sourceB, target),
    ]);
    expect(new Set(published).size).toBe(2);
    expect(await fs.readFile(published[0])).toEqual(await fs.readFile(sourceA));
    expect(await fs.readFile(published[1])).toEqual(await fs.readFile(sourceB));
  });

  it('异常退出临界区后另一实例能够获取同设备锁', async () => {
    await expect(
      lock.withDeviceLock(serial, async () => {
        await fs.readFile(path.join(dir, 'absent'));
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const other = new FileLock(dir);
    await other.withDeviceLock(serial, async (lease) => lease.assertOwned());
  });

  it('guard 竞争结束后仍应释放原 lease 并允许后续获取', async () => {
    let guardReleased: Promise<void> | undefined;
    await lock.withDeviceLock(serial, async () => {
      const release = await guardLock(
        path.join(dir, `${encodeSerial(serial)}.guard`),
        {
          realpath: false,
        }
      );
      // guard 已真实获取；计时器限制其持有时间，保证用例能够结束。
      guardReleased = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          release().then(resolve, reject);
        }, 250);
      });
    });
    await guardReleased;
    await expect(
      new FileLock(dir).withDeviceLock(
        serial,
        async (lease) => {
          await lease.assertOwned();
        },
        500
      )
    ).resolves.toBeUndefined();
  });
});
