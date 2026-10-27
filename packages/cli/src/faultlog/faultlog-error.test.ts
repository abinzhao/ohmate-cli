/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeCrashLog,
  analyzeFaultLogDirectory,
  analyzeSampleStack,
  collectFaultLogs,
  FaultLogError,
  identifyFaultLogContent,
  identifyFaultLogFile,
  MAX_LOG_BYTES,
} from './index.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-code-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function catchError(action: () => unknown): FaultLogError {
  try {
    action();
  } catch (error) {
    return error as FaultLogError;
  }
  throw new Error('expected action to throw');
}

describe('FaultLogError stable codes', () => {
  it('is a normal Error carrying a stable code', () => {
    const error = new FaultLogError('FILE_NOT_FOUND', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.message).toBe('missing');
  });

  it('maps missing file to FILE_NOT_FOUND', () => {
    const missing = path.join(makeTempDir(), 'missing.log');
    const error = catchError(() => identifyFaultLogFile(missing));
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.message).toContain('Fault log not found or not a regular file');
  });

  it('maps oversized content to INPUT_OVERSIZED', () => {
    const error = catchError(() => identifyFaultLogContent('x'.repeat(MAX_LOG_BYTES + 1)));
    expect(error.code).toBe('INPUT_OVERSIZED');
    expect(error.message).toContain('exceeds 20MB limit');
  });

  it('maps unrecognized log to UNRECOGNIZED_LOG', () => {
    const error = catchError(() => analyzeCrashLog({ content: 'plain text without faultlog structure' }));
    expect(error.code).toBe('UNRECOGNIZED_LOG');
    expect(error.message).toContain('无法解析该日志');
  });

  it('carries the classify verdict on unrecognized logs', () => {
    const error = catchError(() => analyzeCrashLog({ content: 'plain text without faultlog structure' }));
    expect(error.code).toBe('UNRECOGNIZED_LOG');
    expect(error.verdict?.type).toBe('unknown');
    expect(error.verdict?.candidates).toEqual([]);
  });

  it('carries the out-of-scope verdict on hilog stream input', () => {
    const content = [
      '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
      '09-01 10:00:00.124  1234  5678 I A0d00/EntryPoint com.example: world',
      'plain line without timestamp',
      '',
    ].join('\n');
    const error = catchError(() => analyzeCrashLog({ content }));
    expect(error.code).toBe('UNRECOGNIZED_LOG');
    expect(error.verdict?.type).toBe('unknown');
    expect(error.verdict?.out_of_scope?.reason).toBe('hilog_stream');
  });

  it('maps missing input to INVALID_INPUT', () => {
    const error = catchError(() => analyzeCrashLog({}));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('必须提供日志文件路径或日志内容');
  });

  it('maps non sample-stack input to INVALID_INPUT', () => {
    const error = catchError(() => analyzeSampleStack({ content: 'plain text without faultlog structure' }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('该日志不是采样栈文件');
  });

  it('maps empty directory to UNRECOGNIZED_LOG', () => {
    const error = catchError(() => analyzeFaultLogDirectory(makeTempDir()));
    expect(error.code).toBe('UNRECOGNIZED_LOG');
    expect(error.message).toContain('中找到可分析的故障日志');
  });

  it('maps missing directory to FILE_NOT_FOUND', () => {
    const error = catchError(() => collectFaultLogs(path.join(makeTempDir(), 'missing-dir')));
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.message).toContain('路径不存在');
  });
});
