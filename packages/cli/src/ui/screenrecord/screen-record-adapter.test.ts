/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { lock as guardLock } from 'proper-lockfile';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ToolProvider } from '../../toolchain/index.js';
import { debugLog } from '../../utils/logger.js';
import { FileLock } from './file-lock.js';
import { createTestDirectory } from './test-directory.js';
import { RecorderDevice } from './recorder-device.js';
import { validateReceived } from './recording-files.js';
import { encodeSerial } from './recording-paths.js';
import { RecordingStore } from './recording-store.js';

const serial = process.env.DEVECO_SCREENRECORD_TEST_DEVICE?.trim();
const cliPath = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));

// 真机测试需要空闲设备和构建产物；每个用例保留独立目录中的视频和执行日志。
describe.skipIf(!serial)('ScreenRecordAdapter physical device', () => {
  const deviceSerial = serial!;
  let provider: ToolProvider;
  let device: RecorderDevice;
  let releaseDevice: (() => Promise<void>) | undefined;
  let root: string | undefined;
  let data: string;
  let foreignData: string;
  let store: RecordingStore;
  let commandNumber: number;
  let unregisteredId: number | undefined;

  function launch(args: string[], dataDir = data) {
    const argv = [
      cliPath,
      'ui',
      'screenrecord',
      ...args,
      '--device',
      deviceSerial,
    ];
    const logPath = path.join(root!, `command-${++commandNumber}.json`);
    debugLog(`Executing: ${process.execPath} ${argv.join(' ')}`);
    const child = execa(process.execPath, argv, {
      cwd: root,
      env: {
        DEVECO_CLI_DATA_DIR: dataDir,
        DEVECO_CLI_DISABLE_TELEMETRY: '1',
        DEVECO_CLI_DISABLE_UPDATE: '1',
        NO_COLOR: '1',
      },
      reject: false,
      timeout: 120_000,
    });
    const completion = child.then(async (result) => {
      await fs.writeFile(
        logPath,
        JSON.stringify(
          {
            args,
            dataDir,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2
        )
      );
      return result;
    });
    return { child, completion };
  }

  function cli(args: string[], dataDir = data) {
    return launch(args, dataDir).completion;
  }

  async function expectIdle(): Promise<void> {
    expect(await device.observeOnce(deviceSerial)).toEqual([]);
    expect(await store.read(deviceSerial)).toBeUndefined();
  }

  async function start(file: string, dataDir = data): Promise<void> {
    const result = await cli(['start', '--path', file], dataDir);
    expect(result.exitCode, result.stderr).toBe(0);
  }

  async function interrupt(file: string): Promise<void> {
    await start(file);
    const result = await cli(['stop', '--force'], foreignData);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await device.observeOnce(deviceSerial)).toEqual([]);
    expect(await store.read(deviceSerial)).toBeDefined();
  }

  beforeAll(async () => {
    await fs.access(cliPath);
    const directory = await createTestDirectory('device-suite-');
    releaseDevice = await guardLock(
      path.join(
        path.dirname(directory),
        `device-${encodeSerial(deviceSerial)}`
      ),
      { realpath: false }
    );
    provider = await ToolProvider.new();
    device = new RecorderDevice(provider.hdcPath);
    expect(
      await device.observeOnce(deviceSerial),
      'Device must be idle before testing'
    ).toEqual([]);
  }, 30_000);

  afterAll(async () => {
    await releaseDevice?.();
  });

  beforeEach(async () => {
    root = undefined;
    expect(
      await device.observeOnce(deviceSerial),
      'Device must be idle before testing'
    ).toEqual([]);
    root = await createTestDirectory('device-');
    console.log(`Screenrecord device artifacts: ${root}`);
    data = path.join(root, 'data');
    foreignData = path.join(root, 'foreign-data');
    commandNumber = 0;
    unregisteredId = undefined;
    const recordDir = path.join(data, 'record');
    store = new RecordingStore(recordDir);
  }, 30_000);

  afterEach(async () => {
    if (!root) {
      return;
    }
    if (unregisteredId !== undefined) {
      const records = await device.observeOnce(deviceSerial);
      if (records.length) {
        expect(records.map((record) => record.abilityRecordId)).toEqual([
          unregisteredId,
        ]);
        const stopped = await cli(['stop', '--force']);
        expect(stopped.exitCode, stopped.stderr).toBe(0);
      }
    }
    for (const dataDir of [data, foreignData]) {
      const session = await new RecordingStore(
        path.join(dataDir, 'record')
      ).read(deviceSerial);
      if (!session) {
        continue;
      }
      const records = await device.observeOnce(deviceSerial);
      if (
        records.length &&
        (records.length !== 1 ||
          records[0].abilityRecordId !== session.abilityRecordId)
      ) {
        throw new Error(
          `Device recording changed; retained session at ${dataDir}`
        );
      }
      const result = await cli(['stop'], dataDir);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    await expectIdle();
  }, 150_000);

  it('starts, reports status, rejects duplicate start, and saves', async () => {
    const target = path.join(root!, 'normal.mp4');
    await start(target);
    const status = await cli(['status', '--format', 'json']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'recording' });
    const original = await store.read(deviceSerial);
    const duplicate = await cli([
      'start',
      '--path',
      path.join(root!, 'duplicate.mp4'),
    ]);
    expect(duplicate.exitCode).not.toBe(0);
    expect(await store.read(deviceSerial)).toEqual(original);
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await validateReceived(target)).toBeGreaterThan(0);
    await expectIdle();
    expect((await cli(['stop', '--force'])).exitCode).not.toBe(0);
    await expectIdle();
  }, 180_000);

  it('saves when stop is requested immediately after start returns', async () => {
    const target = path.join(root!, 'immediate.mp4');
    await start(target);
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await validateReceived(target)).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);

  it('serializes competing starts from independent CLI processes', async () => {
    const outcomes = await Promise.allSettled([
      cli(['start', '--path', path.join(root!, 'first.mp4')]),
      cli(['start', '--path', path.join(root!, 'second.mp4')]),
    ]);
    const results = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      return outcome.value;
    });
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    const session = await store.read(deviceSerial);
    expect(session).toBeDefined();
    expect(
      (await device.observeOnce(deviceSerial)).map(
        (record) => record.abilityRecordId
      )
    ).toEqual([session!.abilityRecordId]);
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await validateReceived(session!.localPath)).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);

  it('serializes competing stops and publishes exactly one video', async () => {
    const target = path.join(root!, 'concurrent-stop.mp4');
    await start(target);
    const outcomes = await Promise.allSettled([cli(['stop']), cli(['stop'])]);
    const results = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      return outcome.value;
    });
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    expect(
      (await fs.readdir(root!)).filter((name) => name.endsWith('.mp4'))
    ).toEqual(['concurrent-stop.mp4']);
    expect(await validateReceived(target)).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);

  it.each(['same-data', 'external-data'])(
    'finalizes the foreground process after a stop from %s',
    async (stopMode) => {
      const target = path.join(root!, 'foreground.mp4');
      const { child, completion } = launch(['--path', target]);
      const settled = completion.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      try {
        await expect
          .poll(() => store.read(deviceSerial), {
            timeout: 30_000,
            interval: 200,
          })
          .toBeDefined();
        const stopped =
          stopMode === 'same-data'
            ? await cli(['stop'])
            : await cli(['stop', '--force'], foreignData);
        expect(stopped.exitCode, stopped.stderr).toBe(0);
        const outcome = await settled;
        if ('error' in outcome) {
          throw outcome.error;
        }
        expect(outcome.result.exitCode, outcome.result.stderr).toBe(0);
        expect(outcome.result.stdout).toContain('Recording...');
        const messages = `${stopped.stdout}\n${outcome.result.stdout}`;
        expect(messages.match(/Saved successfully to/g)).toHaveLength(1);
        expect(await validateReceived(target)).toBeGreaterThan(0);
        await expectIdle();
      } finally {
        child.kill();
        await settled;
      }
    },
    180_000
  );

  it('preserves an external recording until force stop and leaves its registration recoverable', async () => {
    const target = path.join(root!, 'external.mp4');
    await start(target, foreignData);
    const before = await device.observeOnce(deviceSerial);
    const status = await cli(['status', '--format', 'json']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'busy' });
    expect(
      (await cli(['start', '--path', path.join(root!, 'blocked.mp4')])).exitCode
    ).not.toBe(0);
    expect((await cli(['stop'])).exitCode).not.toBe(0);
    expect(await device.observeOnce(deviceSerial)).toEqual(before);
    const forced = await cli(['stop', '--force']);
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(forced.stdout).toContain('device gallery');
    await expectIdle();
    const recovered = await cli(['stop'], foreignData);
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(await validateReceived(target)).toBeGreaterThan(0);
  }, 180_000);

  it('protects a device recording started without CLI registration or a customized filename', async () => {
    await new FileLock(path.join(data, 'record')).withDeviceLock(
      deviceSerial,
      async (lease) => {
        await device.toggleOnce(deviceSerial, undefined, lease);
      }
    );
    await expect
      .poll(() => device.observeOnce(deviceSerial), {
        timeout: 15_000,
        interval: 250,
      })
      .toHaveLength(1);
    const records = await device.observeOnce(deviceSerial);
    expect(records).toHaveLength(1);
    unregisteredId = records[0].abilityRecordId;
    expect(await store.read(deviceSerial)).toBeUndefined();
    const status = await cli(['status', '--format', 'json']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'busy' });
    expect(
      (await cli(['start', '--path', path.join(root!, 'blocked.mp4')])).exitCode
    ).not.toBe(0);
    expect((await cli(['stop'])).exitCode).not.toBe(0);
    expect(
      (await device.observeOnce(deviceSerial)).map(
        (record) => record.abilityRecordId
      )
    ).toEqual([unregisteredId]);
    const forced = await cli(['stop', '--force']);
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(forced.stdout).toContain('device gallery');
    expect(
      (await fs.readdir(root!)).filter((name) => name.endsWith('.mp4'))
    ).toEqual([]);
    await expectIdle();
  }, 180_000);

  it('discards the interrupted registration and reuses its destination', async () => {
    const target = path.join(root!, 'restart.mp4');
    await interrupt(target);
    const previous = await store.read(deviceSerial);
    const result = await cli(['start', '--path', target]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Saved successfully');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const current = await store.read(deviceSerial);
    expect(current!.fileName).not.toBe(previous!.fileName);
    expect(current!.localPath).toBe(target);
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await validateReceived(target)).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);

  it('starts without downloading the interrupted recording', async () => {
    const oldTarget = path.join(root!, 'previous.mp4');
    const nextTarget = path.join(root!, 'next.mp4');
    await interrupt(oldTarget);
    const result = await cli(['start', '--path', nextTarget]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Saved successfully');
    await expect(fs.access(oldTarget)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await validateReceived(nextTarget)).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);

  it('preserves an occupied destination and publishes a recovered name', async () => {
    const target = path.join(root!, 'occupied.mp4');
    await start(target);
    await fs.writeFile(target, 'existing file', { flag: 'wx' });
    const stopped = await cli(['stop']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(await fs.readFile(target, 'utf8')).toBe('existing file');
    expect(
      await validateReceived(path.join(root!, 'occupied-recovered.mp4'))
    ).toBeGreaterThan(0);
    await expectIdle();
  }, 180_000);
});
