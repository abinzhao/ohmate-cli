/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeSampleStack, renderSampleStackReport } from './sample-stack-analyzer.js';

const SAMPLE_STACK = [
  '#Basic Statistical',
  'StaticsDuration: 10000 ms',
  'CpuTime: 5000 ms',
  '#CpuFreq Usage',
  'cpu0 Usage 12.34%',
  'cpu1 Usage 5.00%',
  '#ThreadInfos Tid: 100',
  'SnapshotTime: 2026-09-01 12:00:01.000',
  '#00 pc 0000000000001234 /system/lib/libxxx.so(func+8)',
  '#01 pc 0000000000005678 /data/storage/el1/bundle/libs/arm64/libentry.so(main+16)',
  'Timestamp: 2026-09-01 12:00:02.000',
  '#00 pc 0000000000001234 /system/lib/libxxx.so(func+8)',
  '#01 pc 0000000000005678 /data/storage/el1/bundle/libs/arm64/libentry.so(main+16)',
  'SnapshotTime: 2026-09-01 12:00:03.000',
  '#00 pc 0000000000009999 /data/storage/el1/bundle/libs/arm64/libother.so(worker+4)',
  '#01 pc 0000000000008877 /data/storage/el1/bundle/libs/arm64/libentry.so(runner+8)',
  '',
].join('\n');

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('analyzeSampleStack', () => {
  const result = analyzeSampleStack({ content: SAMPLE_STACK, path: undefined });

  it('解析摘要信息', () => {
    expect(result.logType).toBe('sample_stack');
    expect(result.identify.type).toBe('sample_stack');
    expect(result.summary).toEqual({
      'statics-duration-ms': 10000,
      'cpu-time-ms': 5000,
      'cpu-usage': { '0': 12.34, '1': 5 },
      'snapshot-count': 3,
    });
  });

  it('热点按次数降序，调用链父节点在前', () => {
    expect(result.hotspots).toHaveLength(2);
    const top = result.hotspots[0];
    expect(top['parent-node']).toBe(
      '/data/storage/el1/bundle/libs/arm64/libentry.so(main+16)'
    );
    expect(top.count).toBe(2);
    expect(top['total-snapshots']).toBe(3);
    expect(top.chains).toHaveLength(2);
    expect(top.chains[0].timestamp).toBe('2026-09-01 12:00:01.000');
    expect(top.chains[0].calls).toEqual([
      '/data/storage/el1/bundle/libs/arm64/libentry.so(main+16)',
    ]);

    const second = result.hotspots[1];
    expect(second['parent-node']).toBe(
      '/data/storage/el1/bundle/libs/arm64/libentry.so(runner+8)'
    );
    // 父节点（栈底 runner）在前，子帧 worker 在后
    expect(second.chains[0].calls).toEqual([
      '/data/storage/el1/bundle/libs/arm64/libentry.so(runner+8)',
      '/data/storage/el1/bundle/libs/arm64/libother.so(worker+4)',
    ]);
  });

  it('hotspotLimit 截断热点数量', () => {
    const limited = analyzeSampleStack({ content: SAMPLE_STACK, path: undefined }, 1);
    expect(limited.hotspots).toHaveLength(1);
  });

  it('最后一个快照止于 SubmitterStacktrace，提交者调用帧不参与热点', () => {
    const content = [
      '#Basic Statistical',
      'StaticsDuration: 10000 ms',
      '#ThreadInfos Tid: 100',
      'SnapshotTime: 2026-09-01 12:00:01.000',
      '#00 pc 0000000000001234 /system/lib/libxxx.so(func+8)',
      '#01 pc 0000000000005678 /data/storage/el1/bundle/libs/arm64/libentry.so(mainLoop+16)',
      'SnapshotTime: 2026-09-01 12:00:02.000',
      '#00 pc 0000000000001234 /system/lib/libxxx.so(func+8)',
      '#01 pc 0000000000005678 /data/storage/el1/bundle/libs/arm64/libentry.so(mainLoop+16)',
      'SubmitterStacktrace:',
      '#00 pc 0000000000004321 libcollector.so(capture+8)',
      '',
    ].join('\n');
    const result = analyzeSampleStack({ content, path: undefined });
    expect(result.summary['snapshot-count']).toBe(2);
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0]?.['parent-node']).toBe(
      '/data/storage/el1/bundle/libs/arm64/libentry.so(mainLoop+16)'
    );
    expect(result.hotspots[0]?.count).toBe(2);
    expect(result.hotspots[0]?.['total-snapshots']).toBe(2);
    expect(result.hotspots[0]?.chains).toHaveLength(2);
    for (const chain of result.hotspots[0]?.chains ?? []) {
      expect(chain.calls).toEqual([
        '/data/storage/el1/bundle/libs/arm64/libentry.so(mainLoop+16)',
      ]);
    }
  });

  it('非采样栈日志抛错', () => {
    expect(() =>
      analyzeSampleStack({ content: 'Reason:Signal 11(SIGSEGV)', path: undefined })
    ).toThrow(/不是采样栈文件/);
  });

  it('支持文件路径输入', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-stack-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'sample_stacks.txt');
    fs.writeFileSync(file, SAMPLE_STACK, 'utf8');
    const fromFile = analyzeSampleStack({ path: file });
    expect(fromFile.source.path).toBe(file);
    expect(fromFile.summary['snapshot-count']).toBe(3);
  });
});

describe('renderSampleStackReport', () => {
  it('渲染中文报告', () => {
    const report = renderSampleStackReport(
      analyzeSampleStack({ content: SAMPLE_STACK, path: undefined })
    );
    expect(report).toContain('========================\n采样栈分析报告\n========================');
    expect(report).toContain('【基本信息】');
    expect(report).toContain('StaticsDuration: 10000ms');
    expect(report).toContain('CpuTime: 5000ms');
    expect(report).toContain('CPU使用率:\n  CPU0: 12.34%\n  CPU1: 5%');
    expect(report).toContain('快照总数: 3');
    expect(report).toContain('【父节点统计】');
    // 父节点名按最长名对齐（runner+8 名 57 字符，列宽 59）
    expect(report).toContain(
      '/data/storage/el1/bundle/libs/arm64/libentry.so(main+16)   出现次数: 2/3  占比: 66.7%'
    );
    expect(report).toContain(
      '/data/storage/el1/bundle/libs/arm64/libentry.so(runner+8)  出现次数: 1/3  占比: 33.3%'
    );
    expect(report).toContain('  调用链:');
    expect(report).toContain(
      '    [快照1] /data/storage/el1/bundle/libs/arm64/libentry.so(main+16)'
    );
    expect(report).toContain(
      '    [快照2] /data/storage/el1/bundle/libs/arm64/libentry.so(main+16)'
    );
    expect(report).toContain(
      '    [快照1] /data/storage/el1/bundle/libs/arm64/libentry.so(runner+8) -> /data/storage/el1/bundle/libs/arm64/libother.so(worker+4)'
    );
  });
});
