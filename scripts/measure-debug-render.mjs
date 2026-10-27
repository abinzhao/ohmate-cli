/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export async function measureDebugRender({ browse, click, sendBatch, makeEvent, output, after, count = 2048 }) {
  assert(Number.isSafeInteger(count) && count > 0 && after + count <= 4096);
  const evaluate = (code) => JSON.parse(browse(['eval', code]));
  browse(['set', 'viewport', '1280', '900']);
  let cursor = Number(/游标 (\d+) \/ /.exec(evaluate('document.querySelector(".debug-stream-status").textContent'))?.[1]);
  assert(Number.isSafeInteger(cursor), 'Measurement requires a loaded event page');
  while (cursor < after) {
    click('下一页'); cursor = Math.min(after, cursor + 100);
    browse(['wait', '--text', `游标 ${cursor} / ${after}`]);
  }
  evaluate(`(() => {
    const after = ${after}, count = ${count}, NativeSource = window.EventSource;
    const qa = window.__OHMATE_RENDER_MEASUREMENT = { arrivals: new Map(), samples: new Map(),
      frames: 0, maxRows: 0, end: 0, error: null, callbacks: new Set() };
    const now = () => performance.timeOrigin + performance.now();
    window.EventSource = class extends NativeSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (message) => {
          const record = JSON.parse(message.data);
          if (record.index > after && record.index <= after + count) { qa.arrivals.set(record.index, now()); }
        });
      }
    };
    const list = document.querySelector(".debug-workbench > section .debug-event-list");
    qa.observer = new MutationObserver(() => {
      try {
        const domAt = now(), records = [...list.querySelectorAll(".debug-event > details > pre")]
          .map(item => JSON.parse(item.textContent));
        qa.maxRows = Math.max(qa.maxRows, records.length); qa.frames++;
        const added = [];
        for (const record of records) {
          if (record.index <= after || record.index > after + count || qa.samples.has(record.index)) { continue; }
          if (record.event.payload.value !== record.index || !qa.arrivals.has(record.index)) {
            throw new Error("Rendered record does not match its actual SSE arrival");
          }
          const sample = { index: record.index, producedAt: Date.parse(record.event.wallTimeUtc),
            arrivalAt: qa.arrivals.get(record.index), domAt };
          qa.samples.set(record.index, sample); added.push(sample);
        }
        if (!added.length) { return; }
        const frame = requestAnimationFrame(() => {
          qa.callbacks.delete(frame); const observedAt = now();
          for (const sample of added) { sample.nextFrameAt = observedAt; }
          if (qa.samples.size === count && [...qa.samples.values()].every(item => item.nextFrameAt)) {
            qa.end = observedAt;
          }
        });
        qa.callbacks.add(frame);
      } catch (error) { qa.error = error.message; }
    });
    qa.observer.observe(list, { childList: true });
    qa.restore = () => {
      qa.observer.disconnect(); window.EventSource = NativeSource;
      for (const frame of qa.callbacks) { cancelAnimationFrame(frame); }
      qa.callbacks.clear();
    };
    return true;
  })()`);
  try {
    click('跟随新事件');
    const started = performance.now();
    for (let first = after + 1; first <= after + count; first += 32) {
      const events = Array.from({ length: Math.min(32, after + count - first + 1) }, (_, offset) => {
        const sequence = first + offset;
        return makeEvent(sequence, { channel: 'hidebug', capability: 'hidebug.read',
          wallTimeUtc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
          offsetUncertaintyMs: Number.MAX_SAFE_INTEGER, payload: { metric: 'pssBytes', value: sequence } });
      });
      await sendBatch(events);
    }
    const producerAckElapsedMs = performance.now() - started;
    browse(['wait', '--fn', `window.__OHMATE_RENDER_MEASUREMENT.end || window.__OHMATE_RENDER_MEASUREMENT.error`]);
    const observationElapsedMs = performance.now() - started;
    const observed = evaluate(`(() => {
      const qa = window.__OHMATE_RENDER_MEASUREMENT;
      return { samples: [...qa.samples.values()], frames: qa.frames, maxRows: qa.maxRows, error: qa.error };
    })()`);
    const samples = observed.samples.sort((a, b) => a.index - b.index);
    const evidence = { observed, observationElapsedMs, producerAckElapsedMs, count, after };
    await writeFile(join(output, 'render-measurement-samples.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    assert.equal(observed.error, null);
    assert.equal(samples.length, count, 'Not all produced events were observed in the DOM');
    assert(observed.maxRows <= 100, 'DOM row bound exceeded');
    assert(samples.every((sample, n) => sample.index === after + n + 1 && sample.nextFrameAt >= sample.domAt &&
      sample.domAt >= sample.arrivalAt && sample.domAt - sample.producedAt >= -2), 'Measurement clock or cursor mismatch');
    const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
    const dom = samples.map(item => item.domAt - item.producedAt), nextFrame = samples.map(item => item.nextFrameAt - item.producedAt);
    const dispatch = samples.map(item => item.domAt - item.arrivalAt);
    const elapsedMs = Math.max(...samples.map(item => item.nextFrameAt)) - Math.min(...samples.map(item => item.producedAt));
    assert(Number.isFinite(elapsedMs) && elapsedMs > 0, 'Invalid render measurement duration');
    const result = { status: 'passed', node: process.version, platform: process.platform, producer: 'Node encrypted loopback fixture',
      count, batchSize: 32, elapsedMs, observationElapsedMs, producerAckElapsedMs, eventsPerSecond: count * 1000 / elapsedMs,
      renderedSamples: samples.length, missingRenderedSamples: 0, listReplacements: observed.frames, maxRows: observed.maxRows,
      domP50Ms: quantile(dom, 0.5), domP95Ms: quantile(dom, 0.95), domMaxMs: Math.max(...dom),
      nextFrameP95Ms: quantile(nextFrame, 0.95), nextFrameMaxMs: Math.max(...nextFrame),
      sseDispatchToDomP95Ms: quantile(dispatch, 0.95),
      clock: 'same-host-wall-clock / browser performance.timeOrigin + performance.now; production quantized to 1 ms',
      latencyEndpoints: { start: 'event creation before encryption', dom: 'MutationObserver after list replacement',
        nextFrame: 'requestAnimationFrame following DOM replacement; does not prove physical display paint',
        duration: 'first production to last observed next frame; excludes browser automation polling' },
      devicesProbed: false, actualKit: false, buildVerification: 'unverified',
      gaLoad: { requiredEventsPerSecond: 1000, requiredDurationSeconds: 600, verified: false } };
    await writeFile(join(output, 'render-measurement.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    click('暂停跟随');
    browse(['screenshot', join(output, 'render-measurement-desktop.png')]);
    browse(['set', 'viewport', '390', '844']);
    assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    browse(['screenshot', join(output, 'render-measurement-mobile.png')]);
    return count;
  } finally { evaluate('(window.__OHMATE_RENDER_MEASUREMENT.restore(), true)'); }
}
