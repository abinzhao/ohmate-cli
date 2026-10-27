/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyFaultLog } from './classify.js';
import { identifyFaultLogContent, identifyFaultLogFile, sampleBytes } from './identify-faultlog.js';

const CPP_CRASH_FULL = [
  'Timestamp: 2026-09-01 10:00:00.000',
  'Pid: 1234',
  'Uid: 10234',
  'Process name: com.example.app',
  'Process life time: 10s',
  'Reason:Signal 11(SIGSEGV) 0x0000000000000010',
  'Fault thread info:',
  'Tid: 1235, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)(BuildId:abc)',
  '#01 pc 0000000000abcdef0 /system/lib/ld-musl-aarch64.so.1(malloc+20)(BuildId:abc)',
  '#02 pc 0000000000009876 /data/storage/el1/bundle/libs/arm64/libentry.so(fun+8)(BuildId:abc)',
  'Registers:',
  'r0: 0x10 r1: 0x0',
  '',
].join('\n');

const JS_ERROR_FULL = [
  'Device info:HW spp',
  'Module name:entry',
  'Pid: 2345',
  'Process name: com.example.demo',
  'Package name: com.example.demo',
  'Fault time: 2026-09-01 11:00:00.000',
  'Timestamp: 1725169200000',
  'Reason: TypeError',
  'Error name: TypeError',
  'Error message: Cannot read properties of undefined (reading foo)',
  'Stacktrace:',
  'at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)',
  'at bar (/data/storage/el1/bundle/ets/pages/Index.ets:20:5)',
  'at baz (/data/storage/el1/bundle/ets/pages/Index.ets:30:1)',
  '',
].join('\n');

const APP_FREEZE_FULL = [
  'Reason: THREAD_BLOCK_6S',
  'start time: 2026-09-01 12:00:00.000',
  'end time: 2026-09-01 12:00:06.000',
  'EventName: THREAD_BLOCK_6S',
  'PID: 3456',
  'UID: 10234',
  'PACKAGE_NAME: com.example.frozen',
  'PROCESS_NAME: com.example.frozen',
  'MSG =',
  'dispatch timeout',
  'Timestamp: 2026-09-01 12:00:06.000',
  'Tid: 3457, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(futex+32)',
  'Tid: 3458, Name:xxx',
  '#00 pc 0000000000abcdef0 /system/lib/ld-musl-aarch64.so.1(futex+32)',
  '',
].join('\n');

const SAMPLE_STACK = [
  '#Basic Statistical',
  'StaticsDuration: 10000 ms',
  'CpuTime: 5000 ms',
  'cpu0 Usage 12.34%',
  '#CpuFreq Usage',
  'cpu0 online 1000000',
  '#ThreadInfos Tid: 100',
  'SnapshotTime: 2026-09-01 12:00:02.000',
  '#00 pc 0000000000001234 /system/lib/libxxx.so(func+8)',
  'SubmitterStacktrace:',
  '#00 pc 0000000000005678 /system/lib/libyyy.so(func+4)',
  '',
].join('\n');

const FRAGMENT_DUAL_STACK = [
  '#00 pc 0000000000123456 /system/lib/libxxx.so(func+8)',
  'at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)',
  'at bar (/data/storage/el1/bundle/ets/pages/Index.ets:20:5)',
  '',
].join('\n');

const HILOG_STREAM = [
  '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
  '09-01 10:00:00.124  1234  5678 I A0d00/EntryPoint com.example: world',
  'plain line without timestamp',
  '',
].join('\n');

const OTHER_PLATFORM_LOG = [
  '--------- beginning of system ---------',
  '09-01 10:00:00.123  1234  5678 I ActivityManager: start',
  '',
].join('\n');

const tempDirs: string[] = [];

function writeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-identify-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('classifyFaultLog', () => {
  it('identifies full cpp_crash with memory corruption suspect', () => {
    const verdict = classifyFaultLog(CPP_CRASH_FULL);
    expect(verdict.type).toBe('cpp_crash');
    expect(verdict.confidence).toBe('high');
    expect(verdict.completeness).toBe('full');
    expect(verdict.memory_corruption_suspect).toBeDefined();
    expect(verdict.memory_corruption_suspect?.suspected).toBe(true);
    expect(verdict.evidence.some((e) => e.includes('Reason 字段为 Signal 形态'))).toBe(true);
    expect(verdict.excluded.map((e) => e.type)).toEqual(['js_error', 'app_freeze']);
  });

  it('identifies full js_error', () => {
    const verdict = classifyFaultLog(JS_ERROR_FULL);
    expect(verdict.type).toBe('js_error');
    expect(verdict.confidence).toBe('high');
    expect(verdict.completeness).toBe('full');
    expect(verdict.memory_corruption_suspect).toBeUndefined();
    expect(verdict.excluded.map((e) => e.type)).toEqual(['cpp_crash', 'app_freeze']);
  });

  it('identifies full app_freeze with subtype', () => {
    const verdict = classifyFaultLog(APP_FREEZE_FULL);
    expect(verdict.type).toBe('app_freeze');
    expect(verdict.subtype).toBe('THREAD_BLOCK_6S');
    expect(verdict.confidence).toBe('high');
    expect(verdict.completeness).toBe('full');
  });

  it('sample_stack markers win over fragment fault detections', () => {
    const verdict = classifyFaultLog(SAMPLE_STACK);
    expect(verdict.type).toBe('sample_stack');
    expect(verdict.confidence).toBe('high');
    expect(verdict.completeness).toBe('full');
    expect(verdict.evidence[0]).toContain('采样栈(增强日志)结构标记');
    expect(verdict.excluded).toHaveLength(3);
  });

  it('a single sample marker does not classify as sample_stack', () => {
    const verdict = classifyFaultLog(
      '#Basic Statistical\nTimestamp: 2026-09-01 12:00:00.000\n'
    );
    expect(verdict.type).toBe('unknown');
    expect(verdict.out_of_scope).toBeUndefined();
  });

  it('full cpp_crash with a large embedded HiLog section stays analyzable', () => {
    const hilogLines: string[] = [];
    for (let index = 0; index < 30; index++) {
      hilogLines.push(
        `09-01 10:00:00.${String(100 + index).padStart(3, '0')}  1234  5678 I A0d00/EntryPoint com.example: line${index}`
      );
    }
    const verdict = classifyFaultLog(`${CPP_CRASH_FULL}HiLog:\n${hilogLines.join('\n')}\n`);
    expect(verdict.type).toBe('cpp_crash');
    expect(verdict.completeness).toBe('full');
    expect(verdict.out_of_scope).toBeUndefined();
  });

  it('full faultlog wins over coexisting sample_stack markers', () => {
    const verdict = classifyFaultLog(
      APP_FREEZE_FULL + '\n#Basic Statistical\nStaticsDuration: 10000 ms\n' +
        'SnapshotTime: 2026-09-01 12:00:02.000\nSubmitterStacktrace:\n'
    );
    expect(verdict.type).toBe('app_freeze');
    expect(verdict.evidence.some((e) => e.includes('同时检出采样栈(增强日志)结构标记（4 项）'))).toBe(true);
  });

  it('fragment dual-stack arbitrates to cpp_crash with js_error candidate', () => {
    const verdict = classifyFaultLog(FRAGMENT_DUAL_STACK);
    expect(verdict.type).toBe('cpp_crash');
    expect(verdict.confidence).toBe('medium');
    expect(verdict.completeness).toBe('fragment');
    expect(verdict.candidates).toHaveLength(1);
    expect(verdict.candidates[0]?.type).toBe('js_error');
    expect(verdict.candidates[0]?.arbitrable).toBe(true);
  });

  it('rejects hilog stream as out of scope', () => {
    const verdict = classifyFaultLog(HILOG_STREAM);
    expect(verdict.type).toBe('unknown');
    expect(verdict.out_of_scope?.reason).toBe('hilog_stream');
  });

  it('rejects other-platform log as out of scope', () => {
    const verdict = classifyFaultLog(OTHER_PLATFORM_LOG);
    expect(verdict.type).toBe('unknown');
    expect(verdict.out_of_scope?.reason).toBe('other_platform');
  });

  it('empty input is out of scope', () => {
    for (const content of ['', '   \n  \n']) {
      const verdict = classifyFaultLog(content);
      expect(verdict.type).toBe('unknown');
      expect(verdict.out_of_scope?.reason).toBe('empty');
    }
  });

  it('no positive signals yields unknown with fragment-mode exclusion reasons', () => {
    const verdict = classifyFaultLog('hello world\nsome random text\n');
    expect(verdict.type).toBe('unknown');
    expect(verdict.completeness).toBe('fragment');
    expect(verdict.excluded).toHaveLength(3);
    expect(verdict.excluded[0]?.reason).toBe('未命中 Native 栈帧正向特征');
    expect(verdict.excluded[1]?.reason).toBe('未命中 JS 栈帧正向特征');
    expect(verdict.excluded[2]?.reason).toBe('未命中多线程分节或冻屏事件名正向特征');
  });

  it('full header without signal reason excludes cpp_crash with missing-field reasons', () => {
    const verdict = classifyFaultLog(
      ['Timestamp: 2026-09-01 10:00:00.000', 'Pid: 1234', 'Reason:CppRuntime', 'random text', ''].join('\n')
    );
    expect(verdict.type).toBe('unknown');
    expect(verdict.completeness).toBe('full');
    const cpp = verdict.excluded.find((e) => e.type === 'cpp_crash');
    expect(cpp?.reason).toContain('缺少：Signal 形态的 Reason');
    expect(cpp?.reason).toContain('Registers 段');
    expect(cpp?.reason).toContain('Native 栈帧');
  });
});

describe('sampleBytes', () => {
  it('normalizes CRLF and strips BOM for small inputs', () => {
    const data = Buffer.from('\ufeffa\r\nb\r\nc', 'utf8');
    expect(sampleBytes(data, 1024)).toBe('a\nb\nc');
  });

  it('samples head and tail with fixed marker for large inputs', () => {
    const size = 600 * 1024;
    const data = Buffer.alloc(size, 0x61);
    data.write('HEAD', 0, 'utf8');
    data.write('TAIL', size - 4, 'utf8');
    const sampled = sampleBytes(data, 512 * 1024);
    expect(sampled.startsWith('HEAD')).toBe(true);
    expect(sampled.endsWith('TAIL')).toBe(true);
    expect(sampled.includes('…（中段省略）…')).toBe(true);
    const half = 256 * 1024;
    expect(sampled.length).toBe(half + '…（中段省略）…'.length + 2 + half);
  });
});

describe('identifyFaultLogFile', () => {
  it('sets filename_hint from basename', () => {
    const file = writeTempFile('appfreeze-com.example.frozen-3456-1725169200001', APP_FREEZE_FULL);
    const verdict = identifyFaultLogFile(file);
    expect(verdict.type).toBe('app_freeze');
    expect(verdict.filename_hint).toBe('appfreeze-com.example.frozen-3456-1725169200001');
  });

  it('throws for missing file', () => {
    expect(() => identifyFaultLogFile(path.join(os.tmpdir(), 'faultlog-not-exist-xyz.log'))).toThrow(
      /not a regular file/
    );
  });
});

describe('identifyFaultLogContent', () => {
  it('classifies content and applies custom filename hint', () => {
    const verdict = identifyFaultLogContent(CPP_CRASH_FULL, 'device-pull.log');
    expect(verdict.type).toBe('cpp_crash');
    expect(verdict.filename_hint).toBe('device-pull.log');
  });
});
