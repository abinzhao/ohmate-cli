/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  parseAvailableImageEntriesFromImageList,
  parseDownloadedImageEntriesFromImageList,
  parseDownloadedOsVersionsFromImageList,
} from './emulator-image-list-parse.js';

const ROWS = JSON.stringify([
  {
    osVersion: ' 5.0.1 ',
    SoftWareVersion: '5.0.1.100',
    deviceType: 'Phone',
    downloaded: true,
  },
  {
    OsVersion: '5.0.0',
    softwareVersion: 'v2',
    DeviceType: 'Tablet',
    downloaded: false,
  },
  {
    OSVersion: '6.0.0',
    SoftwareVersion: 'beta',
    deviceType: 'PC',
    Downloaded: 'TRUE',
  },
]);

describe('parseAvailableImageEntriesFromImageList', () => {
  it('parses all rows with any field-name casing and trims values', () => {
    expect(parseAvailableImageEntriesFromImageList(ROWS)).toEqual([
      { osVersion: '5.0.1', softwareVersion: '5.0.1.100', deviceType: 'Phone' },
      { osVersion: '5.0.0', softwareVersion: 'v2', deviceType: 'Tablet' },
      { osVersion: '6.0.0', softwareVersion: 'beta', deviceType: 'PC' },
    ]);
  });

  it('returns [] for empty or whitespace-only output', () => {
    expect(parseAvailableImageEntriesFromImageList('')).toEqual([]);
    expect(parseAvailableImageEntriesFromImageList('   \n ')).toEqual([]);
  });

  it('returns [] for non-JSON output or a non-array JSON document', () => {
    expect(parseAvailableImageEntriesFromImageList('not json')).toEqual([]);
    expect(
      parseAvailableImageEntriesFromImageList('{"osVersion":"5"}')
    ).toEqual([]);
  });

  it('skips null and non-object rows', () => {
    expect(parseAvailableImageEntriesFromImageList('[null, 42, "x"]')).toEqual(
      []
    );
  });

  it('drops rows without both osVersion and softwareVersion', () => {
    const rows = JSON.stringify([
      { deviceType: 'Phone' },
      { osVersion: '5.0.0' },
      { softwareVersion: '1.0' },
    ]);
    expect(parseAvailableImageEntriesFromImageList(rows)).toEqual([
      { osVersion: '5.0.0', softwareVersion: '', deviceType: '' },
      { osVersion: '', softwareVersion: '1.0', deviceType: '' },
    ]);
  });
});

describe('parseDownloadedImageEntriesFromImageList', () => {
  it('keeps only rows marked downloaded (bool true or string "true", any key/casing)', () => {
    expect(parseDownloadedImageEntriesFromImageList(ROWS)).toEqual([
      { osVersion: '5.0.1', softwareVersion: '5.0.1.100', deviceType: 'Phone' },
      { osVersion: '6.0.0', softwareVersion: 'beta', deviceType: 'PC' },
    ]);
  });

  it('excludes rows without a downloaded flag', () => {
    const rows = JSON.stringify([{ osVersion: '5.0.0' }]);
    expect(parseDownloadedImageEntriesFromImageList(rows)).toEqual([]);
  });

  it('falls back to the Downloaded key when downloaded is null', () => {
    const rows = JSON.stringify([
      { osVersion: '5.0.0', downloaded: null, Downloaded: 'true' },
    ]);
    expect(parseDownloadedImageEntriesFromImageList(rows)).toEqual([
      { osVersion: '5.0.0', softwareVersion: '', deviceType: '' },
    ]);
  });
});

describe('parseDownloadedOsVersionsFromImageList', () => {
  it('returns unique non-empty os versions of downloaded rows in order', () => {
    const rows = JSON.stringify([
      { osVersion: '5.0.0', downloaded: true },
      { osVersion: '5.0.0', softwareVersion: 'x', downloaded: 'true' },
      { softwareVersion: 'only', downloaded: true },
      { osVersion: '6.0.0', downloaded: false },
    ]);
    expect(parseDownloadedOsVersionsFromImageList(rows)).toEqual(['5.0.0']);
  });

  it('returns [] when nothing is downloaded', () => {
    expect(parseDownloadedOsVersionsFromImageList('[]')).toEqual([]);
  });
});
