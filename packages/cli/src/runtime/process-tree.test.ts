/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { processIdentityProbe, processStopPlan, usesProcessGroups } from './process-tree.js';

it('selects native process identity probes for Linux, Windows and macOS', () => {
  expect(processIdentityProbe('linux', 42)).toEqual({ kind: 'proc', path: '/proc/42/stat' });
  expect(processIdentityProbe('win32', 42)).toMatchObject({
    kind: 'exec',
    executable: 'powershell.exe',
    args: expect.arrayContaining(['(Get-Process -Id 42).StartTime.ToUniversalTime().Ticks']),
    windowsHide: true,
  });
  expect(processIdentityProbe('darwin', 42)).toEqual({
    kind: 'exec',
    executable: 'ps',
    args: ['-p', '42', '-o', 'stat=', '-o', 'lstart=', '-o', 'comm='],
    windowsHide: false,
  });
});

it('uses taskkill on Windows and signed process-group ids on POSIX', () => {
  expect(processStopPlan('win32', 42, false, true)).toEqual({
    kind: 'taskkill', executable: 'taskkill', args: ['/pid', '42', '/T'],
  });
  expect(processStopPlan('win32', 42, true, true)).toEqual({
    kind: 'taskkill', executable: 'taskkill', args: ['/pid', '42', '/T', '/F'],
  });
  expect(processStopPlan('linux', 42, false, true)).toEqual({
    kind: 'signal', pid: -42, signal: 'SIGTERM',
  });
  expect(processStopPlan('darwin', 42, true, false)).toEqual({
    kind: 'signal', pid: 42, signal: 'SIGKILL',
  });
  expect(usesProcessGroups('win32')).toBe(false);
  expect(usesProcessGroups('linux')).toBe(true);
  expect(usesProcessGroups('darwin')).toBe(true);
});
