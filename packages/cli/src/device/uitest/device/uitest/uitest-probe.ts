/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { compareVersions } from '../../common/utils/version.js';

export const DEFAULT_NEW_UITEST_MIN_VERSION = '6.0.2.2';

/** probeUitest only depends on the device's shellArgs capability; uses a structured type for stub device injection */
export interface ProbeDevice {
  shellArgs(argv: (string | number)[]): Promise<string>;
}

export interface UitestInfo {
  version: string;
  arch: 'arm64' | 'x86_64';
  isNewUiTest: boolean;
  endpointStyle: 'unix' | 'tcp';
  fileOutput?: string;
}

export interface ProbeUitestOptions {
  minVersion?: string;
}

export async function probeUitest(device: ProbeDevice, options: ProbeUitestOptions = {}): Promise<UitestInfo> {
  const minVersion = options.minVersion || DEFAULT_NEW_UITEST_MIN_VERSION;

  const fileOutput = (await device.shellArgs(['file', '/system/bin/uitest'])).trim();
  const arch = /x86[ _-]64/.test(fileOutput) ? 'x86_64' : 'arm64';

  const rawVersion = (await device.shellArgs(['/system/bin/uitest', '--version'])).trim();
  const version = extractFirstVersion(rawVersion) || rawVersion;

  const isNewUiTest = compareVersions(version, minVersion) >= 0;
  const endpointStyle = isNewUiTest && arch !== 'x86_64' ? 'unix' : 'tcp';

  return { version, arch, isNewUiTest, endpointStyle, fileOutput };
}

function extractFirstVersion(text: string): string | null {
  const m = /(\d+(?:\.\d+)+)/.exec(String(text || ''));
  return m ? m[1] : null;
}
