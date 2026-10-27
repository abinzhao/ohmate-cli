/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { buildPropagation, nodeLabel, parseBinder } from './binder-chain.js';

const BINDER_SECTION = [
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
];

describe('parseBinder', () => {
  it('解析同步/异步调用与对端进程', () => {
    const binder = parseBinder(BINDER_SECTION);
    expect(binder.trans).toHaveLength(3);
    expect(binder.trans[0]).toMatchObject({
      srcPid: '3456',
      srcTid: '3457',
      dstPid: '1000',
      dstTid: '2000',
      code: '5f475352',
      waitSeconds: 6.5,
      frzState: '3',
      isAsync: false,
    });
    expect(binder.trans[2].isAsync).toBe(true);
    expect(binder.peers.get('1000')?.processName).toBe('com.example.peerservice');
  });

  it('无 binder 区段时返回空结构', () => {
    const binder = parseBinder(['no binder here']);
    expect(binder.trans).toEqual([]);
    expect(binder.peers.size).toBe(0);
  });
});

describe('buildPropagation', () => {
  it('沿下游方向构建传播链，异步调用不参与', () => {
    const binder = parseBinder(BINDER_SECTION);
    const prop = buildPropagation(binder, '3456', '3457');
    expect(prop.chain?.edges).toHaveLength(2);
    // 按等待时长降序
    expect(prop.chain?.edges[0].waitSeconds).toBe(6.5);
    expect(prop.chain?.edges[1].waitSeconds).toBe(2.5);
  });

  it('故障进程未参与同步通信时给出说明', () => {
    const prop = buildPropagation(parseBinder(BINDER_SECTION), '9999', '8888');
    expect(prop.chain).toBeNull();
    expect(prop.notes[0]).toContain('未参与binder同步通信');
  });

  it('检测双向等待形成的死锁环', () => {
    const lines = [
      'BinderCatcher -- start time: 2026-09-01 12:00:00.000',
      '1:1 to 2:2 code c1 wait:1.0 s',
      '2:2 to 1:1 code c2 wait:1.0 s',
      'end time: 2026-09-01 12:00:01.000',
    ];
    const prop = buildPropagation(parseBinder(lines), '1', '1');
    expect(prop.chain?.cycles).toHaveLength(1);
    expect(prop.chain?.cycles[0]).toHaveLength(2);
  });

  it('互相独立的死锁各取一个代表环', () => {
    const lines = [
      'BinderCatcher -- start time: 2026-09-01 12:00:00.000',
      '1:1 to 1:2 code c1 wait:1.0 s',
      '1:2 to 1:1 code c2 wait:1.0 s',
      '1:1 to 2:3 code c0 wait:1.0 s',
      '2:3 to 2:4 code c3 wait:1.0 s',
      '2:4 to 2:3 code c4 wait:1.0 s',
      'end time: 2026-09-01 12:00:01.000',
    ];
    const prop = buildPropagation(parseBinder(lines), '1', '1');
    expect(prop.chain?.cycles).toHaveLength(2);
    expect(prop.chain?.cycles[0]).toHaveLength(2);
    expect(prop.chain?.cycles[1]).toHaveLength(2);
  });

  it('稠密互相等待图每组只取一个代表环，不长时间阻塞', () => {
    const tids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    const lines = ['BinderCatcher -- start time: 2026-09-01 12:00:00.000'];
    for (const from of tids) {
      for (const to of tids) {
        if (from !== to) {
          lines.push(`1:${from} to 1:${to} code c${from}${to} wait:1.0 s`);
        }
      }
    }
    lines.push('end time: 2026-09-01 12:00:01.000');
    const prop = buildPropagation(parseBinder(lines), '1', '1');
    expect(prop.chain?.edges).toHaveLength(90);
    expect(prop.chain?.cycles).toHaveLength(1);
    expect(prop.chain?.cycles[0]).toHaveLength(2);
  });
});

describe('nodeLabel', () => {
  it('合并进程名/线程名并去重，tid=0 标注 IPC FULL', () => {
    const processNames = new Map([['100', 'com.example.app']]);
    expect(nodeLabel({ pid: '100', tid: '200' }, processNames)).toBe(
      '100:200(com.example.app)'
    );
    expect(
      nodeLabel({ pid: '100', tid: '200' }, processNames, new Map([['100:200', 'com.example.app']]))
    ).toBe('100:200(com.example.app)');
    expect(
      nodeLabel({ pid: '100', tid: '200' }, processNames, new Map([['100:200', 'main']]))
    ).toBe('100:200(com.example.app/main)');
    expect(nodeLabel({ pid: '100', tid: '0' }, processNames)).toBe(
      '100:0(com.example.app)(binder线程耗尽,IPC FULL)'
    );
    expect(nodeLabel({ pid: '100', tid: '200' }, new Map())).toBe('100:200');
  });
});
