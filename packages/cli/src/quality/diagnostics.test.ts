/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { buildDiagnostics } from './build-service.js';
import type { ProcessOutput } from '../runtime/process-runner.js';

const invocation = (stdout: string, stderr = '', toolExitCode = 0): ProcessOutput => ({
  executable: '/tool/node', argv: ['hvigor', 'assembleHap'], cwd: '/project',
  startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z', stdout, stderr, toolExitCode, signal: null, truncated: false,
});
it('includes official warnings and notes even when the build succeeds without flagging progress logs', () => {
  expect(buildDiagnostics([invocation('> hvigor INFO: Task finished\n> hvigor WARN: compiler warning\nNOTE: preview only\n')]))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ priority: 'P1', original: '> hvigor WARN: compiler warning', normalized: 'warning' }),
      expect.objectContaining({ priority: 'P2', original: 'NOTE: preview only', normalized: 'note' }),
    ]));
  expect(buildDiagnostics([invocation('> hvigor INFO: BUILD SUCCESSFUL\n')])).toEqual([]);
  const colored = '\u001b[33m> hvigor WARN:\u001b[0m official warning';
  expect(buildDiagnostics([invocation(colored)])).toEqual(expect.arrayContaining([
    expect.objectContaining({ priority: 'P1', original: colored }),
  ]));
});
it('keeps blocking diagnostics and output truncation explicit with the original exit code', () => {
  const output = invocation('', 'original error\n', 7);
  expect(buildDiagnostics([output])[0]).toMatchObject({ priority: 'P0', toolExitCode: 7, original: 'original error\n' });
  expect(buildDiagnostics([{ ...invocation('partial log'), truncated: true }])).toEqual(expect.arrayContaining([
    expect.objectContaining({ priority: 'P0', code: 'OFFICIAL_OUTPUT_TRUNCATED', original: 'partial log' }),
  ]));
});
