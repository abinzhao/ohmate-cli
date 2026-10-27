/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeCrashLog,
  analyzeFaultLogDirectory,
  extractCrashHilog,
  renderCrashReport,
} from './crash-analyzer.js';

const FREEZE_LOG = [
  'Device info:HW spp',
  'Module name:com.example.frozen',
  'Version:1.0.0',
  'Foreground:Yes',
  'Reason: THREAD_BLOCK_6S',
  'Pid: 3456',
  'Process name:com.example.frozen',
  'NOTE:watchdog',
  '***',
  'start time: 2026-09-01 12:00:06.000',
  'end time: 2026-09-01 12:00:12.000',
  'EVENTNAME = THREAD_BLOCK_6S',
  'PID = 3456',
  'TID = 3457',
  'UID = 10234',
  'PROCESS_NAME = com.example.frozen',
  'Fault time: 2026-09-01 12:00:00.000',
  'MSG =',
  'dispatch timeout',
  'Timestamp: 2026-09-01 12:00:06.000',
  'Tid:3457, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(futex+32)',
  '#01 pc 0000000000abcdef0 /system/lib/libipc_common.z.so(OHOS::IPC::WaitForResponse+100)',
  'Tid:3458, Name:xxx',
  '#00 pc 0000000000fedcba0 /system/lib/ld-musl-aarch64.so.1(futex+8)',
  'BinderCatcher -- start time: 2026-09-01 12:00:06.500',
  '3456:3457 to 1000:2000 code 5f475352 wait:6.5 s frz_state:3,',
  '1000:2000 to 1001:3000 code 1234abcd wait:2.5 s',
  'async 3456:3458 to 1002:2001 code abcd1234 wait:0.1 s',
  'pid  context  request  started  max  ready  free_async_space',
  '3456   bnd      2        2       32    0          1200KB',
  '1000   bnd      1        1       32    0          1200KB',
  'PeerBinder catcher stacktrace for pid : 1000',
  'Process name: com.example.peerservice',
  'Tid:2000, Name:binder_thread',
  '#00 pc 0000000000001111 /system/lib/libbinder.z.so(OHOS::BinderProxy::transact+8)',
  'end time: 2026-09-01 12:00:07.000',
  '--[cpuusage]--',
  'Total: 5.02%; User Space: 2.31%',
  ' 3456  10.00% 5.00% 1.00% 120  300 com.example.frozen',
  ' 1000  5.00% 2.00% 0.00% 80  200 com.example.peerservice',
  'cpuusage end time: 2026-09-01 12:00:06',
  '***',
  'start time: 2026-09-01 12:00:12.000',
  'EVENTNAME = THREAD_BLOCK_6S',
  'PID = 3456',
  'TID = 3457',
  'PROCESS_NAME = com.example.frozen',
  'MSG =',
  'dispatch timeout again',
  'Timestamp: 2026-09-01 12:00:12.000',
  'Tid:3457, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(futex+64)',
  '#01 pc 0000000000abcdef0 /system/lib/libipc_common.z.so(OHOS::IPC::WaitForResponse+200)',
  '',
].join('\n');

const CPP_LOG = [
  'Timestamp: 2026-09-01 10:00:00.000',
  'Pid: 1234',
  'Uid: 10234',
  'Process name: com.example.app',
  'Process life time: 10s',
  'Reason:Signal 11(SIGSEGV) 0x0000000000000010',
  'LastFatalMessage: fatal error before crash',
  'Fault thread info:',
  'Tid:1235, Name:AppDispatchThrea',
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)(7cb22b17eb24ea49c72d5b56cbb5ab075216a830)',
  '#01 pc 0000000000abcdef0 /system/lib/ld-musl-aarch64.so.1(malloc+20)',
  '#02 pc 0000000000009876 /data/storage/el1/bundle/libs/arm64/libentry.so(fun+8)',
  'Registers:',
  'r0: 0x10 r1: 0x0',
  'HiLog:',
  '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
  '',
].join('\n');

const JS_LOG = [
  'Device info:HW spp',
  'Module name:entry',
  'Name:entry',
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
  '',
  'SubmitterStacktrace:',
  'at qux (/data/storage/el1/bundle/ets/pages/Other.ets:5:1)',
  '',
].join('\n');

const GWP_ASAN_BLOCK = [
  '*** GWP-ASan detected a memory error ***',
  '===use-after-free===',
  '#00 pc 0000000000001234 /data/storage/el1/bundle/libs/arm64/libentry.so(bad+8)',
  '* End GWP-ASan report *',
  '',
].join('\n');

const HILOG_STREAM = [
  '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
  'plain line without timestamp',
  '',
].join('\n');

const tempDirs: string[] = [];

function writeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-analyzer-'));
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

describe('analyzeCrashLog app_freeze', () => {
  const result = analyzeCrashLog({ content: FREEZE_LOG, path: undefined });

  it('判定为 app_freeze 并提取基本信息', () => {
    expect(result.logType).toBe('app_freeze');
    expect(result.identify.type).toBe('app_freeze');
    expect(result['key-report']['basic-info']).toEqual({
      故障时间: '2026-09-01 12:00:00.000',
      PID: '3456',
      进程名: 'com.example.frozen',
      故障类型: 'appfreeze',
      故障原因: 'THREAD_BLOCK_6S',
    });
  });

  it('提取 warning 与 block 两次抓栈', () => {
    const threads = result['key-report'].threads;
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      role: 'fault',
      tid: '3457',
      name: 'AppDispatchThrea',
    });
    expect(threads[0].frames).toHaveLength(2);
    expect(threads[0].frames[0]).toContain('futex+32');
    expect(threads[1]).toMatchObject({ role: 'fault-secondary', tid: '3457' });
    expect(threads[1].frames[0]).toContain('futex+64');
  });

  it('构建 binder 传播链（异步边不参与）', () => {
    const binders = result['key-report'].binders;
    expect(binders).toHaveLength(2);
    expect(binders[0]).toMatchObject({
      from: '3456:3457(com.example.frozen/AppDispatchThrea)',
      to: '1000:2000(com.example.peerservice)',
      relation: '同步等待',
      'wait-seconds': 6.5,
      code: '5f475352',
      'frz-state': '3',
    });
    expect(binders[1].to).toContain('1001:3000');
    expect(result['key-report'].cycles).toBeUndefined();
  });

  it('渲染文本报告', () => {
    const report = renderCrashReport(result);
    expect(report).toContain('【基本信息】');
    expect(report).toContain('PID：3456  进程名：com.example.frozen');
    expect(report).toContain('【故障线程堆栈】');
    expect(report).toContain('【故障线程堆栈（二次抓栈）】');
    expect(report).toContain('#00 /system/lib/ld-musl-aarch64.so.1(futex+32)');
    expect(report).toContain('【binder 传播链】');
    expect(report).toContain(
      '3456:3457(com.example.frozen/AppDispatchThrea) -> 1000:2000(com.example.peerservice) 同步等待 6.50s frz_state:3'
    );
  });
});

describe('analyzeCrashLog cpp_crash', () => {
  const result = analyzeCrashLog({ content: CPP_LOG, path: undefined });

  it('提取头部与崩溃线程', () => {
    expect(result.logType).toBe('cpp_crash');
    expect(result['key-report']['basic-info']).toMatchObject({
      PID: '1234',
      进程名: 'com.example.app',
      故障类型: 'cppcrash',
      LastFatalMessage: 'fatal error before crash',
    });
    expect(result['key-report'].threads[0]).toMatchObject({
      role: 'fault',
      tid: '1235',
      name: 'AppDispatchThrea',
    });
    expect(result['key-report'].threads[0].frames).toHaveLength(3);
  });

  it('提取 GWP-ASan 报告原文', () => {
    const withGwp = analyzeCrashLog({ content: `${CPP_LOG}${GWP_ASAN_BLOCK}`, path: undefined });
    expect(withGwp['key-report']['gwp-asan']).toContain(
      '*** GWP-ASan detected a memory error ***'
    );
    expect(withGwp['key-report']['gwp-asan']).toContain('* End GWP-ASan report *');
    expect(result['key-report']['gwp-asan']).toBeUndefined();
  });

  it('渲染文本报告', () => {
    const report = renderCrashReport(result);
    expect(report).toContain('故障原因：Signal 11(SIGSEGV) 0x0000000000000010');
    expect(report).toContain(
      '#00 /system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)'
    );
  });
});

describe('analyzeCrashLog js_error', () => {
  const result = analyzeCrashLog({ content: JS_LOG, path: undefined });

  it('提取错误信息与 Stacktrace 帧', () => {
    expect(result.logType).toBe('js_error');
    expect(result['key-report']['basic-info']).toMatchObject({
      PID: '2345',
      进程名: 'com.example.demo',
      故障类型: 'jserror',
      错误信息: 'Cannot read properties of undefined (reading foo)',
    });
    const thread = result['key-report'].threads[0];
    expect(thread.frames).toHaveLength(2);
    expect(thread.frames[0]).toBe('at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)');
  });

  it('渲染文本报告（js 帧保留原始 at 行）', () => {
    const report = renderCrashReport(result);
    expect(report).toContain('错误信息：Cannot read properties of undefined (reading foo)');
    expect(report).toContain('at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)');
  });
});

describe('analyzeCrashLog 输入校验', () => {
  it('非故障日志抛错并说明判定结果', () => {
    expect(() => analyzeCrashLog({ content: HILOG_STREAM, path: undefined })).toThrow(
      /无法解析该日志：识别为 unknown/
    );
  });

  it('无输入抛错', () => {
    expect(() => analyzeCrashLog({})).toThrow('必须提供日志文件路径或日志内容');
  });
});

describe('extractCrashHilog', () => {
  it('提取 HiLog 区段原文', () => {
    const text = extractCrashHilog({ content: CPP_LOG, path: undefined });
    expect(text.startsWith('HiLog:')).toBe(true);
    expect(text).toContain('com.example: hello');
  });

  it('无 HiLog 区段时抛错', () => {
    expect(() => extractCrashHilog({ content: FREEZE_LOG, path: undefined })).toThrow(
      '日志中未找到 HiLog 区段'
    );
  });
});

describe('analyzeFaultLogDirectory', () => {
  it('按相关性选择最优候选并返回全部候选', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-dir-'));
    tempDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'cppcrash-com.example.app-1234-20260901100000'),
      CPP_LOG,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'jscrash-com.example.demo-2345-20260901110000'),
      JS_LOG,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'appfreeze-com.example.frozen-3456-20260901120000'),
      FREEZE_LOG,
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'hilog.txt'), HILOG_STREAM, 'utf8');

    const result = analyzeFaultLogDirectory(dir);
    expect(result.logType).toBe('app_freeze');
    expect(result.source.kind).toBe('directory');
    expect(result.source.candidates).toHaveLength(3);
    expect(result.source.candidates?.[0].type).toBe('app_freeze');
    expect(result['key-report']['basic-info'].PID).toBe('3456');
  });

  it('目录无可分析日志时抛错并给出类型分布', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultlog-empty-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'hilog.txt'), HILOG_STREAM, 'utf8');
    expect(() => analyzeFaultLogDirectory(dir)).toThrow(/未在.*中找到可分析的故障日志.*unknown=1/);
  });

  it('文件路径输入报错', () => {
    const file = writeTempFile('appfreeze-com.example.frozen-3456-20260901120000', FREEZE_LOG);
    expect(() => analyzeFaultLogDirectory(file)).toThrow('预期为目录');
  });

  it('路径不存在时报错', () => {
    expect(() => analyzeFaultLogDirectory(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toThrow(
      '路径不存在'
    );
  });
});
