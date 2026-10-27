/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * binder 区段解析与故障传播链构建（freeze/binder.py 的移植）。
 *
 * 把每条同步 binder 通信看作有向边 (src_pid:src_tid) -> (dst_pid:dst_tid)；
 * buildPropagation 从故障线程出发双向遍历（下游：在等谁；上游：谁在等它），
 * 取出故障线程所在连通分量形成传播链，并检测死锁环。
 */
import { findSection } from './log-text.js';

/** '20020:20020 to 1234:5678 code 5f475352 wait:6.5 s frz_state:3,' */
const TRANS_RE =
  /(?<src_pid>\d+):(?<src_tid>\d+) to (?<dst_pid>\d+):(?<dst_tid>\d+) code (?<code>\S+) wait:(?<wait>[\d.]+) s(?: frz_state:(?<frz_state>\d+))?/;
/** 对端堆栈起始：'PeerBinder catcher stacktrace for pid : 1234' */
const PEER_STACK_RE = /(?:catcher stacktrace for |Binder catcher stacktrace, type is \w+, )pid : (?<pid>\d+)/;

export interface BinderNode {
  pid: string;
  tid: string;
}

export interface BinderTrans {
  srcPid: string;
  srcTid: string;
  dstPid: string;
  dstTid: string;
  code: string;
  waitSeconds: number;
  frzState: string;
  isAsync: boolean;
  /** 去重用原始行（等价 Python dataclass 值相等）。 */
  raw: string;
}

export interface PeerProcess {
  pid: string;
  processName: string;
}

export interface BinderInfo {
  trans: BinderTrans[];
  peers: Map<string, PeerProcess>;
}

export interface PropagationChain {
  edges: BinderTrans[];
  cycles: BinderNode[][];
}

export interface Propagation {
  faultNode: BinderNode;
  anchor: BinderNode[];
  chain: PropagationChain | null;
  notes: string[];
}

export function srcNode(trans: BinderTrans): BinderNode {
  return { pid: trans.srcPid, tid: trans.srcTid };
}

export function dstNode(trans: BinderTrans): BinderNode {
  return { pid: trans.dstPid, tid: trans.dstTid };
}

function nodeKey(node: BinderNode): string {
  return `${node.pid}:${node.tid}`;
}

function sameNode(a: BinderNode, b: BinderNode): boolean {
  return a.pid === b.pid && a.tid === b.tid;
}

/** 把 (pid, tid) 渲染成 'pid:tid(进程名/线程名)'；tid 为 0 表示 binder 线程耗尽。 */
export function nodeLabel(
  node: BinderNode,
  processNames: Map<string, string>,
  threadNames?: Map<string, string>
): string {
  const processName = processNames.get(node.pid) ?? '';
  const threadName = threadNames?.get(nodeKey(node)) ?? '';
  // 主线程名常等于进程名，相同时只显示一个
  const parts: string[] = [];
  for (const part of [processName, threadName]) {
    if (part !== '' && !parts.includes(part)) {
      parts.push(part);
    }
  }
  let base = `${node.pid}:${node.tid}`;
  if (parts.length > 0) {
    base += `(${parts.join('/')})`;
  }
  if (node.tid === '0') {
    base += '(binder线程耗尽,IPC FULL)';
  }
  return base;
}

function appendTrans(info: BinderInfo, line: string, match: RegExpExecArray): void {
  info.trans.push({
    srcPid: match.groups?.src_pid ?? '',
    srcTid: match.groups?.src_tid ?? '',
    dstPid: match.groups?.dst_pid ?? '',
    dstTid: match.groups?.dst_tid ?? '',
    code: match.groups?.code ?? '',
    waitSeconds: Number.parseFloat(match.groups?.wait ?? '0'),
    frzState: match.groups?.frz_state ?? '',
    isAsync: line.trimStart().startsWith('async'),
    raw: line.trim(),
  });
}

/** 解析 binder 区段（BinderCatcher 起，对端堆栈 end time 止）。 */
export function parseBinder(lines: string[]): BinderInfo {
  const info: BinderInfo = {
    trans: [],
    peers: new Map(),
  };
  // 用 (?<!Peer) 避免被 'PeerBinderCatcher --' 行抢先匹配
  const [section] = findSection(lines, /(?<!Peer)BinderCatcher --/, /end time:|^-{5,}\s*$/, true);
  if (section.length === 0) {
    return info;
  }
  let peerStart = section.length;
  for (let index = 0; index < section.length; index++) {
    const line = section[index];
    if (line.includes('PeerBinder Stacktrace') || PEER_STACK_RE.test(line)) {
      peerStart = index;
      break;
    }
    const transMatch = TRANS_RE.exec(line);
    if (transMatch !== null) {
      appendTrans(info, line, transMatch);
    }
  }
  parsePeerStacks(section.slice(peerStart), info);
  return info;
}

/** 把对端堆栈按 'catcher stacktrace for pid : N' 拆分，提取各对端进程名。 */
function parsePeerStacks(lines: string[], info: BinderInfo): void {
  const starts: Array<{ index: number; pid: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = PEER_STACK_RE.exec(lines[index]);
    if (match !== null) {
      starts.push({ index, pid: match.groups?.pid ?? '' });
    }
  }
  for (let order = 0; order < starts.length; order++) {
    const start = starts[order];
    const end = order + 1 < starts.length ? starts[order + 1].index : lines.length;
    const chunk = lines.slice(start.index, end);
    // Python read_lines 保留行尾换行，''.join 后 '(.*)' 停在换行前；这里用 '\n' 还原该语义
    const nameMatch = /Process name:(.*)/.exec(chunk.join('\n'));
    info.peers.set(start.pid, {
      pid: start.pid,
      processName: nameMatch !== null ? nameMatch[1].trim() : '',
    });
  }
}

/** 匹配调用方；tid 为 0 的节点表示该进程全部 binder 工作线程。 */
function matchesSrc(trans: BinderTrans, node: BinderNode): boolean {
  if (trans.srcPid !== node.pid) {
    return false;
  }
  return trans.srcTid === node.tid || node.tid === '0';
}

/** trans 的对端是否落在 node 上；dst_tid 为 0（IPC FULL）时按进程匹配。 */
function matchesDst(trans: BinderTrans, node: BinderNode): boolean {
  if (trans.dstPid !== node.pid) {
    return false;
  }
  return trans.dstTid === node.tid || trans.dstTid === '0';
}

function nextNode(trans: BinderTrans, current: BinderNode, forward: boolean): BinderNode | null {
  if (forward) {
    if (matchesSrc(trans, current)) {
      return dstNode(trans);
    }
    return null;
  }
  if (matchesDst(trans, current)) {
    return srcNode(trans);
  }
  return null;
}

/**
 * 以故障线程及故障进程为锚点，构建故障传播链（上游 + 下游 + 传递闭包）。
 * 锚点 = 故障线程 + 故障进程在 binder 中出现的所有线程；只保留与锚点连通的调用链。
 */
export function buildPropagation(
  binder: BinderInfo,
  faultPid: string,
  faultTid: string
): Propagation {
  const faultNode: BinderNode = { pid: faultPid, tid: faultTid };
  const sync = binder.trans.filter((trans) => !trans.isAsync);
  const anchor: BinderNode[] = [faultNode];
  for (const trans of sync) {
    for (const node of [srcNode(trans), dstNode(trans)]) {
      if (node.pid === faultPid && !anchor.some((entry) => sameNode(entry, node))) {
        anchor.push(node);
      }
    }
  }

  const downstreamEdges = walk(sync, anchor, true);
  const upstreamEdges = walk(sync, anchor, false);
  const chainEdges = dedupEdges([...downstreamEdges, ...upstreamEdges]);

  const prop: Propagation = {
    faultNode,
    anchor,
    chain: null,
    notes: [],
  };
  if (chainEdges.length > 0) {
    prop.chain = {
      edges: sortEdges(chainEdges),
      cycles: findCycles(chainEdges),
    };
    if (chainEdges.some((edge) => edge.dstTid === '0')) {
      prop.notes.push('传播链中存在对端tid为0的调用，对应进程binder线程耗尽（IPC FULL）');
    }
  } else {
    prop.notes.push('故障进程未参与binder同步通信，故障线程未阻塞在IPC上');
  }
  return prop;
}

/** 从 starts 单向遍历收集可达调用边；tid=0 作为进程 binder 工作线程通配节点。 */
function walk(
  sync: BinderTrans[],
  starts: BinderNode[],
  forward: boolean
): BinderTrans[] {
  const visited = new Set<string>(starts.map(nodeKey));
  const stack = [...starts];
  const edges: BinderTrans[] = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    for (const trans of sync) {
      const next = nextNode(trans, node, forward);
      if (next === null) {
        continue;
      }
      if (!edges.includes(trans)) {
        edges.push(trans);
      }
      if (!visited.has(nodeKey(next))) {
        visited.add(nodeKey(next));
        stack.push(next);
      }
    }
  }
  return edges;
}

/** binder 有向图：正向/反向邻接表与 key 到节点的映射。 */
interface BinderGraph {
  outgoing: Map<string, BinderNode[]>;
  incoming: Map<string, BinderNode[]>;
  nodeOfKey: Map<string, BinderNode>;
}

function buildGraph(edges: BinderTrans[]): BinderGraph {
  const graph: BinderGraph = { outgoing: new Map(), incoming: new Map(), nodeOfKey: new Map() };
  for (const edge of edges) {
    const from = srcNode(edge);
    const to = dstNode(edge);
    const fromKey = nodeKey(from);
    const toKey = nodeKey(to);
    graph.nodeOfKey.set(fromKey, from);
    graph.nodeOfKey.set(toKey, to);
    graph.outgoing.set(fromKey, [...(graph.outgoing.get(fromKey) ?? []), to]);
    graph.incoming.set(toKey, [...(graph.incoming.get(toKey) ?? []), from]);
  }
  return graph;
}

/** 第一遍 DFS（迭代式）：产出各节点的完成顺序 key。 */
function dfsFinishOrder(graph: BinderGraph): string[] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const startKey of graph.outgoing.keys()) {
    if (visited.has(startKey)) {
      continue;
    }
    visited.add(startKey);
    const stack: Array<{ key: string; next: number }> = [{ key: startKey, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        break;
      }
      const neighbors = graph.outgoing.get(top.key) ?? [];
      const neighbor = neighbors[top.next];
      if (neighbor === undefined) {
        finishOrder.push(top.key);
        stack.pop();
        continue;
      }
      top.next += 1;
      const neighborKey = nodeKey(neighbor);
      if (!visited.has(neighborKey) && graph.outgoing.has(neighborKey)) {
        visited.add(neighborKey);
        stack.push({ key: neighborKey, next: 0 });
      }
    }
  }
  return finishOrder;
}

/** 从 rootKey 出发沿反图收集一个互相可达分组（收集前未分配的节点）。 */
function collectGroup(
  graph: BinderGraph,
  rootKey: string,
  assigned: Set<string>
): BinderNode[] {
  assigned.add(rootKey);
  const groupKeys: string[] = [rootKey];
  for (let head = 0; head < groupKeys.length; head++) {
    const key = groupKeys[head];
    if (key === undefined) {
      continue;
    }
    for (const prev of graph.incoming.get(key) ?? []) {
      const prevKey = nodeKey(prev);
      if (!assigned.has(prevKey) && graph.outgoing.has(prevKey)) {
        assigned.add(prevKey);
        groupKeys.push(prevKey);
      }
    }
  }
  return groupKeys
    .map((key) => graph.nodeOfKey.get(key))
    .filter((node): node is BinderNode => node !== undefined);
}

/** 第二遍：反图上按完成序逆序收集互相可达分组（强连通分量）。 */
function stronglyConnectedGroups(graph: BinderGraph, finishOrder: string[]): BinderNode[][] {
  const assigned = new Set<string>();
  const groups: BinderNode[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index--) {
    const rootKey = finishOrder[index];
    if (rootKey === undefined || assigned.has(rootKey)) {
      continue;
    }
    groups.push(collectGroup(graph, rootKey, assigned));
  }
  return groups;
}

/** 沿 BFS parent 回溯出 [start, ..., node] 的环节点序列。 */
function cyclePath(
  node: BinderNode,
  start: BinderNode,
  parent: Map<string, BinderNode>
): BinderNode[] {
  const reversed: BinderNode[] = [];
  let cursor: BinderNode | undefined = node;
  while (cursor !== undefined && !sameNode(cursor, start)) {
    reversed.push(cursor);
    cursor = parent.get(nodeKey(cursor));
  }
  return cursor === undefined ? [] : [start, ...reversed.reverse()];
}

/** 从 start 出发 BFS，取最先回到 start 的最短路径作为组内代表环；无环返回 null。 */
function representativeCycle(start: BinderNode, graph: BinderGraph): BinderNode[] | null {
  const startKey = nodeKey(start);
  const parent = new Map<string, BinderNode>();
  const seen = new Set<string>([startKey]);
  const queue: BinderNode[] = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    for (const next of graph.outgoing.get(nodeKey(node)) ?? []) {
      if (sameNode(next, start)) {
        return cyclePath(node, start, parent);
      }
      const nextKey = nodeKey(next);
      if (!seen.has(nextKey) && graph.outgoing.has(nextKey)) {
        seen.add(nextKey);
        parent.set(nextKey, node);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * 在有向边集合中找死锁环：按互相可达分组，每组只取一个代表环。
 * 稠密图（多线程互相等待）下不再枚举全部环，避免指数级耗时。
 */
function findCycles(edges: BinderTrans[]): BinderNode[][] {
  const graph = buildGraph(edges);
  const groups = stronglyConnectedGroups(graph, dfsFinishOrder(graph));
  const cycles: BinderNode[][] = [];
  for (const group of groups) {
    const start = group[0];
    if (start === undefined) {
      continue;
    }
    const cycle = representativeCycle(start, graph);
    if (cycle !== null && cycle.length > 0) {
      cycles.push(cycle);
    }
  }
  return cycles;
}

function sortEdges(edges: BinderTrans[]): BinderTrans[] {
  return [...edges].sort((a, b) => b.waitSeconds - a.waitSeconds);
}

function dedupEdges(edges: BinderTrans[]): BinderTrans[] {
  const result: BinderTrans[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!seen.has(edge.raw)) {
      seen.add(edge.raw);
      result.push(edge);
    }
  }
  return result;
}
