/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolProvider } from '../../toolchain/index.js';
import { DeviceManager } from '../../service/device-manager.js';
import * as deviceSelector from '../../utils/device-selector.js';
import { FileLock } from './file-lock.js';
import { RecorderDevice } from './recorder-device.js';
import { RecordingStore } from './recording-store.js';
import { ScreenRecordAdapter } from './screen-record-adapter.js';
import { createTestDirectory, removeTestDirectory } from './test-directory.js';
import {
  RECORDER_ABILITY,
  RECORDER_BUNDLE,
  type RecordingSession,
} from './types.js';

const serial = 'start-test-device';
const active = {
  abilityRecordId: 42,
  bundleName: RECORDER_BUNDLE,
  abilityName: RECORDER_ABILITY,
};

describe('starting with an interrupted registration', () => {
  let directory: string;
  let store: RecordingStore;
  let lock: FileLock;
  let device: RecorderDevice;
  let adapter: ScreenRecordAdapter;
  let previous: RecordingSession;

  beforeEach(async () => {
    directory = await createTestDirectory('restart-');
    store = new RecordingStore(path.join(directory, 'record'));
    lock = new FileLock(path.join(directory, 'record'));
    device = new RecorderDevice('unused-hdc');
    vi.spyOn(deviceSelector, 'resolveDeviceSerial').mockResolvedValue(serial);
    vi.spyOn(DeviceManager.prototype, 'getConnectedEntries').mockResolvedValue([
      { serial, name: serial, isEmulator: false },
    ]);
    vi.spyOn(device, 'observeOnce').mockResolvedValue([]);
    vi.spyOn(device, 'toggleOnce').mockImplementation(async () => {
      expect(await store.read(serial)).toBeUndefined();
      vi.mocked(device.observeOnce).mockResolvedValue([active]);
      return { transport: 'returned' };
    });
    // Any accidental recovery fails immediately instead of reaching a real device.
    for (const method of [
      'queryMediaUri',
      'exportToStaging',
      'receiveFile',
      'removeStaging',
    ] as const) {
      vi.spyOn(device, method).mockRejectedValue(
        new Error('Unexpected media access')
      );
    }
    previous = {
      fileName: 'previous.mp4',
      abilityRecordId: 27,
      startTime: 1,
      localPath: path.join(directory, 'previous.mp4'),
    };
    await lock.withDeviceLock(serial, (lease) =>
      store.createAtomic(serial, previous, lease)
    );
    adapter = new ScreenRecordAdapter(ToolProvider.fromIDE(directory), {
      store,
      lock,
      device,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTestDirectory(directory);
  });

  function expectNoMediaAccess(): void {
    expect(device.queryMediaUri).not.toHaveBeenCalled();
    expect(device.exportToStaging).not.toHaveBeenCalled();
    expect(device.receiveFile).not.toHaveBeenCalled();
    expect(device.removeStaging).not.toHaveBeenCalled();
  }

  it('still retrieves the interrupted video when stop is requested', async () => {
    vi.mocked(device.queryMediaUri).mockResolvedValue('file://media/previous');
    vi.mocked(device.exportToStaging).mockResolvedValue(undefined);
    vi.mocked(device.receiveFile).mockImplementation(
      async (_serial, _remote, local) => {
        await fs.copyFile(
          new URL('./fixtures/sample.mp4', import.meta.url),
          local
        );
      }
    );
    vi.mocked(device.removeStaging).mockResolvedValue(true);
    const result = await adapter.stopRecording(serial, false);
    expect(result).toMatchObject({
      kind: 'saved',
      localPath: previous.localPath,
    });
    expect(await fs.readFile(previous.localPath)).toEqual(
      await fs.readFile(new URL('./fixtures/sample.mp4', import.meta.url))
    );
    expect(await store.read(serial)).toBeUndefined();
    expect(device.toggleOnce).not.toHaveBeenCalled();
  });

  it.each(['same', 'different'])(
    'starts using a %s destination without retrieving the old video',
    async (destination) => {
      const target =
        destination === 'same'
          ? previous.localPath
          : path.join(directory, 'next.mp4');
      const started = await adapter.startDetached(serial, target);
      const current = await store.read(serial);
      expect(current).toEqual(started.session);
      expect(current).toMatchObject({ abilityRecordId: 42, localPath: target });
      expect(current!.fileName).not.toBe(previous.fileName);
      expect(device.toggleOnce).toHaveBeenCalledTimes(1);
      expectNoMediaAccess();
      await expect(fs.access(previous.localPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('uses the same discard rule for interactive recording', async () => {
    const finished = new Error('End test at the interactive wait boundary');
    const onStarted = vi.fn(() => {
      throw finished;
    });
    await expect(
      adapter.recordInteractively(serial, previous.localPath, { onStarted })
    ).rejects.toBe(finished);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(await store.read(serial)).toMatchObject({
      abilityRecordId: 42,
      localPath: previous.localPath,
    });
    expectNoMediaAccess();
  });

  it('does not start or erase the registration when deletion fails', async () => {
    const error = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    vi.spyOn(store, 'deleteIfSame').mockRejectedValue(error);
    await expect(
      adapter.startDetached(serial, previous.localPath)
    ).rejects.toBe(error);
    expect(await store.read(serial)).toEqual(previous);
    expect(device.toggleOnce).not.toHaveBeenCalled();
    expectNoMediaAccess();
    await lock.withDeviceLock(serial, async (lease) => {
      await lease.assertOwned();
    });
  });

  it.each([
    { id: 27, code: 'CLI_RECORDING_ACTIVE' },
    { id: 99, code: 'EXTERNAL_RECORDING' },
  ])(
    'preserves the registration when a recording is active ($code)',
    async ({ id, code }) => {
      vi.mocked(device.observeOnce).mockResolvedValue([
        { ...active, abilityRecordId: id },
      ]);
      await expect(
        adapter.startDetached(serial, previous.localPath)
      ).rejects.toMatchObject({ code });
      expect(await store.read(serial)).toEqual(previous);
      expect(device.toggleOnce).not.toHaveBeenCalled();
      expectNoMediaAccess();
    }
  );

  it('rejects a device state change after discarding the registration', async () => {
    vi.mocked(device.observeOnce)
      .mockResolvedValueOnce([])
      .mockResolvedValue([active]);
    await expect(
      adapter.startDetached(serial, previous.localPath)
    ).rejects.toMatchObject({ code: 'STATE_CHANGED' });
    expect(await store.read(serial)).toBeUndefined();
    expect(device.toggleOnce).not.toHaveBeenCalled();
    expectNoMediaAccess();
  });

  it('does not restore the discarded registration when starting fails', async () => {
    const error = new Error('Start failed');
    vi.mocked(device.toggleOnce).mockRejectedValue(error);
    await expect(
      adapter.startDetached(serial, previous.localPath)
    ).rejects.toBe(error);
    expect(await store.read(serial)).toBeUndefined();
    expectNoMediaAccess();
  });

  it('retains the old registration when the new path is invalid', async () => {
    await expect(
      adapter.startDetached(serial, path.join(directory, 'missing', 'new.mp4'))
    ).rejects.toMatchObject({ code: 'INVALID_RECORDING_PATH' });
    expect(await store.read(serial)).toEqual(previous);
    expect(device.toggleOnce).not.toHaveBeenCalled();
    expectNoMediaAccess();
  });
});

describe('resolving the target with no connected devices', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTestDirectory('no-device-');
    vi.spyOn(deviceSelector, 'resolveDeviceSerial').mockResolvedValue(serial);
    vi.spyOn(DeviceManager.prototype, 'getConnectedEntries').mockResolvedValue(
      []
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTestDirectory(directory);
  });

  function makeAdapter(): ScreenRecordAdapter {
    const store = new RecordingStore(path.join(directory, 'record'));
    const lock = new FileLock(path.join(directory, 'record'));
    const device = new RecorderDevice('unused-hdc');
    return new ScreenRecordAdapter(ToolProvider.fromIDE(directory), {
      store,
      lock,
      device,
    });
  }

  it('reports a no-device error that asks for a physical device', async () => {
    const error = await makeAdapter()
      .startDetached(undefined, path.join(directory, 'a.mp4'))
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      code: 'NO_ACTIVE_DEVICES',
      message:
        'No active devices found. Connect a physical device; screen recording does not support emulators.',
    });
    expect(deviceSelector.resolveDeviceSerial).not.toHaveBeenCalled();
  });

  it('stops and status share the same no-device error', async () => {
    await expect(
      makeAdapter().stopRecording(undefined, false)
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_DEVICES' });
    await expect(
      makeAdapter().getRecordingStatus(undefined)
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_DEVICES' });
  });
});

describe('interactive stop feedback', () => {
  let directory: string;
  let store: RecordingStore;
  let lock: FileLock;
  let device: RecorderDevice;
  let adapter: ScreenRecordAdapter;

  beforeEach(async () => {
    directory = await createTestDirectory('stop-feedback-');
    store = new RecordingStore(path.join(directory, 'record'));
    lock = new FileLock(path.join(directory, 'record'));
    device = new RecorderDevice('unused-hdc');
    vi.spyOn(deviceSelector, 'resolveDeviceSerial').mockResolvedValue(serial);
    vi.spyOn(DeviceManager.prototype, 'getConnectedEntries').mockResolvedValue([
      { serial, name: serial, isEmulator: false },
    ]);
    vi.spyOn(device, 'observeOnce').mockResolvedValue([]);
    let toggles = 0;
    vi.spyOn(device, 'toggleOnce').mockImplementation(async () => {
      toggles += 1;
      // First toggle starts the recording; the second (stop) toggle ends it.
      vi.mocked(device.observeOnce).mockResolvedValue(
        toggles === 1 ? [active] : []
      );
      return { transport: 'returned' };
    });
    for (const method of [
      'queryMediaUri',
      'exportToStaging',
      'receiveFile',
      'removeStaging',
    ] as const) {
      vi.spyOn(device, method).mockRejectedValue(
        new Error('Unexpected media access')
      );
    }
    adapter = new ScreenRecordAdapter(ToolProvider.fromIDE(directory), {
      store,
      lock,
      device,
      timing: { stopReadyMs: 10, observeIntervalMs: 5, foregroundPollMs: 5 },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTestDirectory(directory);
  });

  it('notifies once, before any finalize IO, when a stop signal arrives', async () => {
    const sentinel = new Error('End test at the media wait');
    vi.mocked(device.queryMediaUri).mockRejectedValue(sentinel);
    const onStopRequested = vi.fn();
    const error = await adapter
      .recordInteractively(undefined, path.join(directory, 'a.mp4'), {
        onStarted: () => {
          // A repeat signal must not fire the notification twice.
          process.emit('SIGHUP', 'SIGHUP');
          process.emit('SIGHUP', 'SIGHUP');
        },
        onStopRequested,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBe(sentinel);
    expect(onStopRequested).toHaveBeenCalledTimes(1);
    expect(onStopRequested.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(device.queryMediaUri).mock.invocationCallOrder[0]
    );
  });

  it('proceeds without the optional hook', async () => {
    const sentinel = new Error('End test at the media wait');
    vi.mocked(device.queryMediaUri).mockRejectedValue(sentinel);
    const error = await adapter
      .recordInteractively(undefined, path.join(directory, 'b.mp4'), {
        onStarted: () => {
          process.emit('SIGHUP', 'SIGHUP');
        },
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBe(sentinel);
  });
});
