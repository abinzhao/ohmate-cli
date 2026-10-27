/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyDebugRender({ browse, click, sendBatch, makeEvent, output }) {
  const evaluate = (code) => JSON.parse(browse(['eval', code]));
  const checks = [];
  let through = 104;
  evaluate(`(() => {
    const qa = window.__OHMATE_RENDER_QA = { pending: new Map(), cancelled: [], writes: 0,
      seen: new Set(), maxRows: 0, last: null, source: null, closes: 0, id: 0 };
    const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    const replace = Element.prototype.replaceChildren, NativeSource = window.EventSource;
    qa.restore = () => {
      window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel;
      Element.prototype.replaceChildren = replace; window.EventSource = NativeSource;
    };
    window.requestAnimationFrame = (callback) => { const id = ++qa.id; qa.pending.set(id, callback); return id; };
    window.cancelAnimationFrame = (id) => {
      const callback = qa.pending.get(id);
      if (callback) { qa.cancelled.push(callback); qa.pending.delete(id); }
    };
    Element.prototype.replaceChildren = function(...children) {
      const result = replace.apply(this, children);
      if (this.matches(".debug-workbench > section .debug-event-list")) {
        qa.writes++;
        const headings = [...this.querySelectorAll(".debug-event-heading strong")];
        qa.maxRows = Math.max(qa.maxRows, headings.length);
        for (const heading of headings) { qa.seen.add(Number(/^#(\\d+) ·/.exec(heading.textContent)[1])); }
      }
      return result;
    };
    window.EventSource = class extends NativeSource {
      constructor(...args) {
        super(...args); qa.source = this;
        this.addEventListener("message", (message) => { qa.last = JSON.parse(message.data); });
      }
      close() { qa.closes++; super.close(); }
    };
    qa.flush = () => {
      const pending = [...qa.pending.values()]; qa.pending.clear();
      for (const callback of pending) { callback(performance.now()); }
    };
    qa.replayCancelled = () => {
      const cancelled = qa.cancelled.splice(0);
      for (const callback of cancelled) { callback(performance.now()); }
    };
    qa.snapshot = () => ({
      writes: qa.writes, pending: qa.pending.size, closes: qa.closes,
      headings: [...document.querySelectorAll(".debug-event-heading strong")].map(item => item.textContent),
      counter: document.querySelector(".debug-summary > p")?.textContent,
      status: document.querySelector(".debug-stream-status")?.textContent,
      choice: document.getElementById("debug-stream")?.selectedOptions[0]?.textContent
    });
    return true;
  })()`);
  const snapshot = () => evaluate('window.__OHMATE_RENDER_QA.snapshot()');
  const resetWrites = () => evaluate('window.__OHMATE_RENDER_QA.writes = 0');
  const flush = () => evaluate('(window.__OHMATE_RENDER_QA.flush(), true)');
  function noLateRender(expected) {
    evaluate('(window.__OHMATE_RENDER_QA.replayCancelled(), true)');
    assert.deepEqual(snapshot(), expected, 'Cancelled frame changed a later view or status');
  }
  function renderedAt(cursor) {
    const state = snapshot();
    assert(state.headings.at(-1).startsWith(`#${cursor} ·`), 'Latest committed event was not rendered');
    assert(state.headings.length <= 100, 'Live view exceeded its 100-record limit');
    assert(state.counter.includes(`已提交事件 ${cursor} 条`), 'Visible committed count is stale');
    assert(state.choice.includes(`${cursor} 条`), 'Visible stream count is stale');
    return state;
  }
  async function batch() {
    const events = Array.from({ length: 64 }, (_, offset) => makeEvent(through + offset + 1));
    await sendBatch(events); through += events.length;
    browse(['wait', '--fn', `window.__OHMATE_RENDER_QA.last?.index === ${through}`]);
  }
  function latestPage() {
    let cursor = Number(/游标 (\d+) \/ /.exec(snapshot().status)?.[1]);
    assert(Number.isSafeInteger(cursor), 'Expected a loaded event page');
    while (cursor < through) {
      click('下一页'); cursor = Math.min(through, cursor + 100);
      browse(['wait', '--text', `游标 ${cursor} / ${through}`]);
    }
  }
  function follow() { click('跟随新事件'); resetWrites(); }
  try {
    click('暂停跟随');
    follow();
    await batch();
    const waiting = snapshot();
    await writeFile(join(output, 'render-before-frame.json'), JSON.stringify(waiting, null, 2) + '\n', { flag: 'wx' });
    assert.equal(waiting.writes, 0, '64 committed SSE events rebuilt the list before an animation frame');
    assert.equal(waiting.pending, 1, 'A burst must retain only one pending animation frame');
    flush();
    assert.equal(renderedAt(through).writes, 1, 'A burst was not rendered in one frame');
    checks.push('64 real encrypted/SSE events render in one frame');

    resetWrites();
    evaluate(`(() => {
      const qa = window.__OHMATE_RENDER_QA;
      qa.source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(qa.last) }));
      return true;
    })()`);
    assert.equal(snapshot().pending, 0, 'Duplicate SSE cursor scheduled a frame');
    assert.equal(snapshot().writes, 0);
    checks.push('Duplicate cursor ignored before scheduling');

    resetWrites();
    evaluate('(window.__OHMATE_RENDER_QA.seen.clear(), true)');
    const burstFrom = through + 1;
    await batch(); await batch();
    const overflow = snapshot();
    await writeFile(join(output, 'render-overflow-before-frame.json'), JSON.stringify({
      ...overflow, seen: evaluate('[...window.__OHMATE_RENDER_QA.seen]'),
    }, null, 2) + '\n', { flag: 'wx' });
    assert.equal(overflow.writes, 1, 'Unrendered rows must flush once before bounded eviction');
    assert.equal(overflow.pending, 1, 'Overflow scheduled multiple animation frames');
    noLateRender(overflow);
    flush();
    assert.equal(renderedAt(through).writes, 2, '128 events must use a bounded flush and one frame');
    assert.deepEqual(evaluate(`[...window.__OHMATE_RENDER_QA.seen].filter(index => index >= ${burstFrom}).sort((a, b) => a - b)`),
      Array.from({ length: 128 }, (_, offset) => burstFrom + offset), 'Accepted SSE events never reached the actual DOM');
    assert(evaluate('window.__OHMATE_RENDER_QA.maxRows <= 100'), 'Overflow exceeded the DOM limit');
    checks.push('Two real 64-event batches reach bounded DOM before eviction; cancelled frame stays inert');

    resetWrites();
    await batch();
    click('暂停跟随');
    const paused = renderedAt(through);
    assert.equal(paused.pending, 0, 'Pause retained a pending frame');
    assert.equal(paused.writes, 1, 'Pause did not flush the accepted final batch');
    assert(paused.status.includes('已暂停'));
    noLateRender(paused);
    checks.push('Pause flushes accepted records and cancels late rendering');

    follow(); await batch();
    evaluate(`(() => {
      const select = document.getElementById("debug-stream");
      select.dispatchEvent(new Event("change", { bubbles: true })); return true;
    })()`);
    browse(['wait', '--text', `游标 100 / ${through}`]);
    const selected = snapshot();
    assert.equal(selected.pending, 0, 'Stream selection retained its old pending frame');
    noLateRender(selected);
    assert.equal(selected.headings.length, 100);
    assert(selected.headings.at(-1).startsWith('#100 ·'));
    checks.push('Stream selection discards old frames without overwriting its page');

    latestPage(); follow(); await batch();
    click('刷新调试状态'); browse(['wait', '--text', `游标 100 / ${through}`]);
    const refreshed = snapshot();
    assert.equal(refreshed.pending, 0, 'Refresh retained an old frame');
    noLateRender(refreshed);
    checks.push('Refresh discards old frames');

    latestPage(); follow(); await batch();
    evaluate(`(() => {
      const qa = window.__OHMATE_RENDER_QA, record = { ...qa.last, index: qa.last.index + 2 };
      qa.source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) }));
      return true;
    })()`);
    const fault = renderedAt(through);
    assert.equal(fault.pending, 0, 'Cursor fault retained a frame');
    assert(fault.status.includes('事件序列不连续'), 'Sequence gap was not rejected immediately');
    assert(!fault.headings.at(-1).startsWith(`#${through + 2} ·`));
    noLateRender(fault);
    checks.push('Cursor gap rejected immediately; accepted records flushed');

    follow(); await batch();
    evaluate('(window.__OHMATE_RENDER_QA.source.onerror(), true)');
    const disconnected = renderedAt(through);
    assert.equal(disconnected.pending, 0, 'Disconnect retained a frame');
    assert(disconnected.status.includes('连接中断'));
    noLateRender(disconnected);
    checks.push('Transport error flushes accepted records and preserves fault status');

    follow(); await batch();
    evaluate('(window.__OHMATE_RENDER_QA.source.dispatchEvent(new Event("end")), true)');
    const ended = renderedAt(through);
    assert.equal(ended.pending, 0, 'End retained a frame');
    assert(ended.status.includes('事件流已结束'));
    noLateRender(ended);
    checks.push('Terminal event flushes accepted records and preserves terminal status');

    click('刷新调试状态'); browse(['wait', '--text', `游标 100 / ${through}`]);
    latestPage(); follow(); await batch();
    browse(['set', 'viewport', '1280', '900']);
    click('新任务', 'link');
    browse(['wait', '--fn', '!document.querySelector(".debug-workbench")']);
    const hidden = snapshot();
    assert.equal(hidden.pending, 0, 'Leaving the debug view retained a frame');
    noLateRender(hidden);
    checks.push('Leaving the debug view cancels its pending frame');
    click('调试', 'link'); browse(['wait', '--text', `游标 100 / ${through}`]);

    const result = { status: 'passed', checks, events: through - 104, realEncryptedBatches: 10,
      realSseDelivery: true, controlledAnimationFrames: true, injectedLifecycleSignals: ['gap', 'error', 'end'],
      devicesProbed: false, producer: 'Node fixture', buildVerification: 'unverified' };
    await writeFile(join(output, 'render-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result.events;
  } finally { evaluate('(window.__OHMATE_RENDER_QA.restore(), true)'); }
}
