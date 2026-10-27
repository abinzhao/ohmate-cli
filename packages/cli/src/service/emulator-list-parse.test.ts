/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEmulatorListOutput } from './emulator-list-parse.js';

describe('parseEmulatorListOutput (JSON mode)', () => {
  it('parses emulator rows from a JSON array', () => {
    const output = JSON.stringify([
      {
        name: 'WideFold',
        isRunning: true,
        instancePath: '/data/deployed/WideFold',
        path: '/images/widefold.hvd',
        imageRoot: '/images',
        uuid: 'uuid-1',
        deviceType: 'WideFold',
        'os.osVersion': '5.0.1(18)',
      },
    ]);
    expect(parseEmulatorListOutput(output)).toEqual([
      {
        name: 'WideFold',
        isRunning: true,
        instancePath: '/data/deployed/WideFold',
        path: '/images/widefold.hvd',
        imageRoot: '/images',
        uuid: 'uuid-1',
        deviceType: 'WideFold',
        osVersion: '5.0.1(18)',
      },
    ]);
  });

  it('accepts isRunning given as a case-insensitive string', () => {
    const output = JSON.stringify([
      { name: 'A', isRunning: 'TRUE' },
      { name: 'B', isRunning: 'false' },
      { name: 'C' },
    ]);
    expect(parseEmulatorListOutput(output).map((e) => e.isRunning)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('parses isHotBoot as the creation-time Quick Boot flag', () => {
    const output = JSON.stringify([
      { name: 'A', isHotBoot: true },
      { name: 'B', isHotBoot: 'false' },
      { name: 'C' },
    ]);
    expect(parseEmulatorListOutput(output).map((e) => e.hotBoot)).toEqual([
      true,
      false,
      undefined,
    ]);
  });

  it('maps snake_case and alternative field names', () => {
    const output = JSON.stringify([
      {
        Name: 'X',
        instance_path: ' /d/X ',
        hvd_path: '/x.hvd',
        image_root: '/img',
        instance_uuid: 'u9',
        devicetype: 'Phone',
        osVersion: ' 5.0.0 ',
      },
    ]);
    expect(parseEmulatorListOutput(output)).toEqual([
      {
        name: 'X',
        isRunning: false,
        instancePath: '/d/X',
        path: '/x.hvd',
        imageRoot: '/img',
        uuid: 'u9',
        deviceType: 'Phone',
        osVersion: '5.0.0',
      },
    ]);
  });

  it('picks up heuristic instance keys such as myInstanceDir', () => {
    const output = JSON.stringify([
      { name: 'X', myInstanceDir: '/deployed/X' },
    ]);
    expect(parseEmulatorListOutput(output)[0]?.instancePath).toBe(
      '/deployed/X'
    );
  });

  it('drops items without a name', () => {
    const output = JSON.stringify([{ instancePath: '/d/X' }, { name: 'ok' }]);
    expect(parseEmulatorListOutput(output).map((e) => e.name)).toEqual(['ok']);
  });

  it('returns [] for a JSON object instead of an array', () => {
    expect(parseEmulatorListOutput('{"name":"X"}')).toEqual([]);
  });
});

describe('parseEmulatorListOutput (text mode)', () => {
  it('parses emulator blocks from case-insensitive key: value lines', () => {
    const output = [
      'NAME: Emu1',
      'IsRunning: true',
      'IsHotBoot: true',
      'InstancePath: /d/Emu1',
      'path: /img/emu1.hvd',
      'imageRoot: /img',
      'deviceType: Phone',
      'os.osVersion: 5.0.1(18)',
      '',
      'name: Emu2',
      'isRunning: False',
      'isHotBoot: false',
      'instancePath: /d/Emu2',
    ].join('\r\n');
    expect(parseEmulatorListOutput(output)).toEqual([
      {
        name: 'Emu1',
        isRunning: true,
        hotBoot: true,
        instancePath: '/d/Emu1',
        path: '/img/emu1.hvd',
        imageRoot: '/img',
        deviceType: 'Phone',
        osVersion: '5.0.1(18)',
      },
      { name: 'Emu2', isRunning: false, hotBoot: false, instancePath: '/d/Emu2' },
    ]);
  });

  it('ignores field lines that appear before the first name', () => {
    expect(parseEmulatorListOutput('isRunning: true\nname: Emu1')).toEqual([
      { name: 'Emu1' },
    ]);
  });

  it('returns [] for output without recognizable fields', () => {
    expect(parseEmulatorListOutput('random output\nno fields')).toEqual([]);
    expect(parseEmulatorListOutput('')).toEqual([]);
  });
});

describe('parseEmulatorListOutput (instance path hydration)', () => {
  let root: string;
  let deployed: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-emu-parse-'));
    deployed = path.join(root, 'deployed');
    await fs.mkdir(deployed);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('hydrates a missing instancePath beside the anchor when the folder exists', async () => {
    await fs.mkdir(path.join(deployed, 'Anchor'));
    await fs.mkdir(path.join(deployed, 'Hydrate'));
    const output = JSON.stringify([
      { name: 'Anchor', instancePath: path.join(deployed, 'Anchor') },
      { name: 'Hydrate' },
      { name: 'MissingFolder' },
    ]);

    const result = parseEmulatorListOutput(output);

    // The anchor keeps its original path untouched.
    expect(result[0]?.instancePath).toBe(path.join(deployed, 'Anchor'));
    // The hydrated path uses forward slashes on every platform.
    expect(result[1]?.instancePath).toBe(
      path.join(deployed, 'Hydrate').replace(/\\/g, '/')
    );
    // A missing deployed folder is not invented (empty string stays empty).
    expect(result[2]?.instancePath).toBe('');
  });

  it('leaves paths alone when no emulator has an instance path anchor', () => {
    const result = parseEmulatorListOutput(
      JSON.stringify([{ name: 'A' }, { name: 'B' }])
    );
    expect(result.map((e) => e.instancePath)).toEqual(['', '']);
  });
});
