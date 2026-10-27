/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';

class Element {
  textContent = '';
  disabled = false;
  value = '';
  children: Element[] = [];
  constructor(readonly tag: string, attributes: Record<string, unknown> = {}, children: Element[] = []) {
    Object.assign(this, attributes); this.children = children;
  }
  replaceChildren(...children: Element[]) { this.children = children; }
  append(...children: Element[]) { this.children.push(...children); }
  get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
}
class Source {
  static current: Source;
  handlers = new Map<string, (message: { data: string; lastEventId: string }) => void>();
  closed = false;
  onmessage?: (message: { data: string; lastEventId: string }) => void;
  constructor() { Source.current = this; }
  addEventListener(name: string, handler: (message: { data: string; lastEventId: string }) => void) { this.handlers.set(name, handler); }
  close() { this.closed = true; }
  send(name: string, value: unknown, id = '') {
    const message = { data: JSON.stringify(value), lastEventId: id };
    if (name === 'message') { this.onmessage?.(message); } else { this.handlers.get(name)?.(message); }
  }
}
interface View {
  cursor: number;
  rows: { index: number }[];
  stream: { streamId: string; integrity: string; through: number; active: boolean };
  session: { id: string };
  streamSelect: Element;
  events: Element;
  counter: Element;
  message: Element;
  retentionNotice: Element;
  renderFrame: number | null;
  toggleStream(): void;
  page(after: number): Promise<void>;
  close(): void;
}
let view: View, frames: Map<number, () => void>;
const request = vi.fn();
const range = { retainedFrom: 3, retainedCount: 4, through: 6 };
const gap = { missingFrom: 1, missingThrough: 2, reason: 'retention-quota', ...range };
const event = (index: number) => ({ index, event: { sequence: index, channel: 'hilog', payload: { summary: `event ${index}` } },
  clock: { segment: 1 } });
beforeEach(async () => {
  request.mockReset(); frames = new Map();
  let frame = 0;
  const source = await readFile(new URL('../../../../apps/web/debug.js', import.meta.url), 'utf8');
  const node = (tag: string, attributes = {}, children = []) => new Element(tag, attributes, children);
  class Subview { view = node('div'); close() {} choose() {} }
  const Constructor = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nDebugView;', {
    request, node, button: (text: string) => node('button', { textContent: text }), empty: () => node('div'),
    details: () => node('details'), clockText: () => 'clock', ProblemView: Subview, InspectorView: Subview,
    EventSource: Source, requestAnimationFrame: (callback: () => void) => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }) as new (bootstrap: object, openTask: () => void) => View;
  view = new Constructor({}, () => {});
  view.session = { id: 'session' }; view.stream = { streamId: 'stream', integrity: 'verified', through: 0, active: true };
  view.streamSelect.value = 'stream'; view.streamSelect.children = [node('option', { value: 'stream' })];
});
function flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) { callback(); } }

it('accepts an explicit gap immediately and renders retained count separately from the absolute tail in one frame', () => {
  view.toggleStream();
  Source.current.send('gap', gap, '2');
  expect(view.cursor).toBe(2);
  Source.current.send('message', event(3), '3'); Source.current.send('message', event(4), '4');
  expect(view.cursor).toBe(4);
  expect(frames.size).toBe(1);
  expect(view.events.children).toHaveLength(0);
  flush();
  expect(view.events.children).toHaveLength(2);
  expect(view.counter.textContent).toContain('保留事件 4 条');
  expect(view.counter.textContent).toContain('已提交尾序号 6');
  expect(view.retentionNotice.textContent).toContain('1–2');
  Source.current.send('end', {});
  expect(view.message.textContent).toContain('已结束');
  expect(view.retentionNotice.textContent).toContain('1–2');
});
it('updates and prunes a caught-up retained window without authorizing an event jump', () => {
  view.cursor = 6; view.rows = [event(3), event(4), event(5), event(6)];
  view.toggleStream();
  Source.current.send('retention', { retainedFrom: 5, retainedCount: 4, through: 8 });
  expect(view.cursor).toBe(6);
  expect(view.rows.map((row) => row.index)).toEqual([5, 6]);
  Source.current.send('message', event(8), '8');
  expect(Source.current.closed).toBe(true);
  expect(view.cursor).toBe(6);
  expect(view.message.textContent).toContain('事件序列不连续');
  expect(frames.size).toBe(0);
});
it.each([
  { missingFrom: 2 }, { missingThrough: 3 }, { missingThrough: 1.5 }, { reason: 'other' },
  { retainedFrom: 4 }, { retainedCount: 4097 }, { through: Number.MAX_SAFE_INTEGER + 1 },
])('rejects a malformed gap without advancing the cursor: %j', (change) => {
  view.toggleStream(); Source.current.send('gap', { ...gap, ...change }, '2');
  expect(Source.current.closed).toBe(true); expect(view.cursor).toBe(0); expect(frames.size).toBe(0);
  expect(view.message.textContent).toContain('读取未完成');
});
it('rejects a gap whose SSE id disagrees with its acknowledged boundary', () => {
  view.toggleStream(); Source.current.send('gap', gap, '3');
  expect(Source.current.closed).toBe(true); expect(view.cursor).toBe(0);
});
it('reads a retained HTTP page with the exact missing range and original event positions', async () => {
  request.mockResolvedValue({ ...range, gap, events: [event(3), event(4)], nextCursor: 4, hasMore: true });
  await view.page(0);
  expect(view.cursor).toBe(4); expect(view.rows.map((row) => row.index)).toEqual([3, 4]);
  expect(view.counter.textContent).toContain('保留事件 4 条');
  expect(view.retentionNotice.textContent).toContain('1–2');
  expect(frames.size).toBe(0);
});
it.each([
  { gap: null }, { events: [event(4)] }, { nextCursor: 5 },
])('rejects a retained page that silently skips or mislabels its cursor: %j', async (change) => {
  request.mockResolvedValue({ ...range, gap, events: [event(3), event(4)], nextCursor: 4, hasMore: true, ...change });
  await view.page(0);
  expect(view.cursor).toBe(0); expect(view.rows).toHaveLength(0);
  expect(view.message.textContent).toContain('读取未完成');
});
it('ignores a repeated valid gap without clearing accepted records or scheduling another frame', () => {
  view.toggleStream(); Source.current.send('gap', gap, '2'); Source.current.send('message', event(3), '3');
  flush();
  Source.current.send('gap', gap, '2');
  expect(view.cursor).toBe(3); expect(view.rows.map((row) => row.index)).toEqual([3]); expect(frames.size).toBe(0);
});
it('cancels a gap frame on closure and does not let late events change the cursor', () => {
  view.toggleStream(); Source.current.send('gap', gap, '2');
  expect(frames.size).toBe(1);
  const callback = [...frames.values()][0];
  view.close(); callback(); Source.current.send('message', event(3), '3');
  expect(frames.size).toBe(0); expect(view.cursor).toBe(2);
  expect(view.events.children).toHaveLength(0);
});

it('puts every accepted event into the bounded DOM before a burst evicts unrendered rows', () => {
  const seen = new Set<number>(), replace = view.events.replaceChildren.bind(view.events);
  const writes = vi.spyOn(view.events, 'replaceChildren').mockImplementation((...children) => {
    replace(...children);
    expect(children.length).toBeLessThanOrEqual(100);
    for (const article of children) {
      const heading = String(article.children[0].children[0].children[0]);
      seen.add(Number(/^#(\d+) ·/.exec(heading)![1]));
    }
  });
  let cancelled: (() => void) | undefined;
  view.toggleStream();
  // Two 64-event encrypted batches can arrive before the browser's next frame.
  for (let index = 1; index <= 128; index++) {
    Source.current.send('message', event(index), String(index));
    expect(view.rows.length).toBeLessThanOrEqual(100);
    expect(frames.size).toBeLessThanOrEqual(1);
    if (index === 100) { cancelled = [...frames.values()][0]; }
  }
  expect(writes).toHaveBeenCalledTimes(1);
  cancelled!();
  expect(writes).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(1);
  flush();
  expect(writes).toHaveBeenCalledTimes(2);
  expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
  expect(view.cursor).toBe(128);
  expect(frames.size).toBe(0);
});

it.each(['retention', 'gap'])('renders accepted rows before %s removes them from the live window', (signal) => {
  view.toggleStream();
  Source.current.send('gap', gap, '2');
  Source.current.send('message', event(3), '3'); Source.current.send('message', event(4), '4');
  const replace = vi.spyOn(view.events, 'replaceChildren');
  const nextRange = { retainedFrom: 6, retainedCount: 3, through: 8 };
  Source.current.send(signal, signal === 'gap' ?
    { ...nextRange, missingFrom: 5, missingThrough: 5, reason: 'retention-quota' } : nextRange, '5');
  expect(replace).toHaveBeenCalledTimes(1);
  expect(view.events.children).toHaveLength(2);
  expect(view.rows).toHaveLength(0);
  expect(view.cursor).toBe(signal === 'gap' ? 5 : 4);
  expect(frames.size).toBe(1);
  flush();
  expect(replace).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
});
