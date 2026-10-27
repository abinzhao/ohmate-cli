/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listDevicesMock = vi.hoisted(() => vi.fn());
const listDevicesWithNameMock = vi.hoisted(() => vi.fn());
vi.mock('../service/device-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../service/device-manager.js')>();
  return {
    ...actual,
    DeviceManager: {
      from: () => ({
        listDevices: listDevicesMock,
        listDevicesWithName: listDevicesWithNameMock,
      }),
    },
  };
});

import { resolveDeviceSerial } from './device-selector.js';
import { HilogAdapter } from './hilog-adapter.js';
import type { ToolProvider } from '../toolchain/index.js';

const toolProvider = { hdcPath: '/hdc' } as ToolProvider;

describe('resolveDeviceSerial', () => {
  beforeEach(() => {
    listDevicesMock.mockReset();
    listDevicesWithNameMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an exact serial without querying device names', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    await expect(resolveDeviceSerial(toolProvider, 'emu-2')).resolves.toBe(
      'emu-2'
    );
    expect(listDevicesWithNameMock).not.toHaveBeenCalled();
  });

  it('resolves a device by its display name', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
      { serial: 'emu-2', name: 'Emu Two' },
    ]);
    await expect(resolveDeviceSerial(toolProvider, 'Emu One')).resolves.toBe(
      'emu-1'
    );
  });

  it('auto-selects the single connected device', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: '127.0.0.1:5555', status: 'device' },
    ]);
    await expect(resolveDeviceSerial(toolProvider)).resolves.toBe(
      '127.0.0.1:5555'
    );
  });

  it('refuses to guess between multiple devices', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
      { serial: 'emu-2', name: 'Emu Two' },
    ]);
    await expect(resolveDeviceSerial(toolProvider)).rejects.toThrow(
      /Multiple devices found/
    );
  });

  it('propagates the not-found error for unknown device names', async () => {
    listDevicesMock.mockResolvedValue([{ serial: 'emu-1', status: 'device' }]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
    ]);
    await expect(resolveDeviceSerial(toolProvider, 'nope')).rejects.toThrow(
      /Device 'nope' not found/
    );
  });

  it('errors when nothing is connected', async () => {
    listDevicesMock.mockResolvedValue([]);
    await expect(resolveDeviceSerial(toolProvider)).rejects.toThrow(
      /No active devices found/
    );
  });

  it('forwards the selection argument to the underlying adapter', async () => {
    const selectDeviceSpy = vi
      .spyOn(HilogAdapter.prototype, 'selectDevice')
      .mockResolvedValue('emu-9');
    await expect(resolveDeviceSerial(toolProvider, 'Emu Nine')).resolves.toBe(
      'emu-9'
    );
    expect(selectDeviceSpy).toHaveBeenCalledWith('Emu Nine');
    await expect(resolveDeviceSerial(toolProvider)).resolves.toBe('emu-9');
    expect(selectDeviceSpy).toHaveBeenLastCalledWith(undefined);
  });

  it('throws the guidance error when selection resolves to an empty serial', async () => {
    vi.spyOn(HilogAdapter.prototype, 'selectDevice').mockResolvedValue('');
    await expect(resolveDeviceSerial(toolProvider)).rejects.toThrow(
      'No device selected. Use `devecocli device list` to see targets.'
    );
  });
});
