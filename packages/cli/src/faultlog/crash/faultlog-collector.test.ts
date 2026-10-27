/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectFaultLogs, type CollectedFaultLog } from './faultlog-collector.js';

const FREEZE_LOG = [
  'Reason: THREAD_BLOCK_6S',
  'start time: 2026-09-01 12:00:06.000',
  'EVENTNAME = THREAD_BLOCK_6S',
  'PID = 3456',
  'MSG =',
  'dispatch timeout',
  'Tid:3457, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(futex+32)',
  'Tid:3458, Name:xxx',
  '#00 pc 0000000000fedcba0 /system/lib/ld-musl-aarch64.so.1(futex+8)',
  '',
].join('\n');

const CPP_LOG = [
  'Timestamp: 2026-09-01 10:00:00.000',
  'Pid: 1234',
  'Reason:Signal 11(SIGSEGV) 0x0000000000000010',
  'Fault thread info:',
  'Tid:1235, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)',
  '',
].join('\n');

const HILOG_STREAM = [
  '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
  '',
].join('\n');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-collector-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function typesOf(candidates: CollectedFaultLog[]): string[] {
  return candidates.map((candidate) => candidate.type);
}

describe('collectFaultLogs', () => {
  it('递归收集三族日志，非故障文件不参选', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(
      path.join(dir, 'appfreeze-com.example.frozen-3456-20260901120000'),
      FREEZE_LOG,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'nested', 'cppcrash-com.example.app-1234-20260901100000'),
      CPP_LOG,
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'hilog.txt'), HILOG_STREAM, 'utf8');

    const { candidates, typeCounts } = collectFaultLogs(dir);
    expect(typesOf(candidates).sort()).toEqual(['app_freeze', 'cpp_crash']);
    expect(candidates.find((entry) => entry.type === 'cpp_crash')?.path).toContain('nested');
    expect(typeCounts.unknown).toBe(1);
  });

  it('高置信度优先，同级按故障时间倒序', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'cppcrash-com.example.app-1234-20260901100000'),
      CPP_LOG,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'appfreeze-com.example.frozen-3456-20260901120000'),
      FREEZE_LOG,
      'utf8'
    );
    const { candidates } = collectFaultLogs(dir);
    expect(candidates[0].type).toBe('app_freeze');
    expect(candidates[1].type).toBe('cpp_crash');
  });

  it('不可读/超限文件跳过并计入 unreadable', () => {
    const dir = makeTempDir();
    const bigFile = path.join(dir, 'cppcrash-com.example.app-1234-20260901100000');
    fs.writeFileSync(bigFile, Buffer.alloc(21 * 1024 * 1024, 0x61));
    const { candidates, typeCounts } = collectFaultLogs(dir);
    expect(candidates).toHaveLength(0);
    expect(typeCounts.unreadable).toBe(1);
  });

  it('temp 命名（13 位 epoch）也能解析时间', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'cppcrash-1234-1749528000000'), CPP_LOG, 'utf8');
    const { candidates } = collectFaultLogs(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].timeMs).toBeGreaterThan(0);
  });

  it('目录不存在抛错', () => {
    expect(() => collectFaultLogs(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toThrow(
      '路径不存在'
    );
  });
});
