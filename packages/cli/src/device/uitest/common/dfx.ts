/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { Logger } from './logger.js';

export interface DfxRecord {
  type: 'counter' | 'timer' | 'event';
  name: string;
  value?: number;
  durationMs?: number;
  fields: Record<string, unknown>;
  ts: number;
}

export interface DfxSink {
  write: (record: DfxRecord) => void;
  reset?: () => void;
}

export interface DfxOptions {
  enabled?: boolean;
  tags?: Record<string, unknown>;
  sinks?: DfxSink[];
  slowThresholdMs?: number;
  logger?: Logger | null;
}

interface AggregatedMetric {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

interface AggregatedSnapshot {
  counters: Record<string, AggregatedMetric>;
  timers: Record<string, AggregatedMetric>;
  events: Array<{ name: string; fields: Record<string, unknown>; ts: number }>;
}

export class MemorySink implements DfxSink {
  records: DfxRecord[];
  constructor() {
    this.records = [];
  }

  write(record: DfxRecord): void {
    this.records.push(record);
  }

  /** Filter by name */
  select(name: string | ((n: string) => boolean)): DfxRecord[] {
    return this.records.filter((r) =>
      typeof name === 'function' ? name(r.name) : r.name === name || r.name.startsWith(name + '.'),
    );
  }

  /** Sum counter-type metrics */
  sum(name: string | ((n: string) => boolean)): number {
    return this.select(name).reduce((acc, r) => acc + (r.value || 0), 0);
  }

  count(name: string | ((n: string) => boolean)): number {
    return this.select(name).length;
  }

  snapshot(): AggregatedSnapshot {
    return {
      counters: aggregate(this.records, 'counter'),
      timers: aggregate(this.records, 'timer'),
      events: this.records.filter((r) => r.type === 'event').map((r) => ({ name: r.name, fields: r.fields, ts: r.ts })),
    };
  }

  reset(): void {
    this.records.length = 0;
  }
}

function aggregate(records: DfxRecord[], type: 'counter' | 'timer'): Record<string, AggregatedMetric> {
  const out: Record<string, AggregatedMetric> = {};
  for (const r of records) {
    if (r.type !== type) {
      continue;
    }
    if (!out[r.name]) {
      out[r.name] = { count: 0, sum: 0, min: Infinity, max: 0, avg: 0 };
    }
    const v = type === 'counter' ? r.value || 0 : r.durationMs || 0;
    out[r.name].count += 1;
    out[r.name].sum += v;
    out[r.name].min = Math.min(out[r.name].min, v);
    out[r.name].max = Math.max(out[r.name].max, v);
  }
  for (const key of Object.keys(out)) {
    out[key].avg = out[key].sum / out[key].count;
    if (out[key].min === Infinity) {
      out[key].min = 0;
    }
  }
  return out;
}

export class LogSink implements DfxSink {
  logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger;
  }

  write(record: DfxRecord): void {
    const fields = Object.entries(record.fields || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    if (record.type === 'timer') {
      this.logger.info(`[dfx] ${record.name} ${record.durationMs}ms ${fields}`.trim());
    } else if (record.type === 'counter') {
      this.logger.info(`[dfx] ${record.name} +${record.value} ${fields}`.trim());
    } else {
      this.logger.info(`[dfx] ${record.name} ${fields}`.trim());
    }
  }
}

export class Dfx {
  enabled: boolean;
  tags: Record<string, unknown>;
  sinks: DfxSink[];
  slowThresholdMs: number;
  logger: Logger | null;
  constructor(options: DfxOptions = {}) {
    this.enabled = options.enabled !== false;
    this.tags = { ...(options.tags || {}) };
    this.sinks = options.sinks || [new MemorySink()];
    this.slowThresholdMs = options.slowThresholdMs ?? 1000;
    this.logger = options.logger ?? null;
  }

  /** Derive a sub-logger (appending default tags) */
  child(tags: Record<string, unknown>): Dfx {
    return new Dfx({
      enabled: this.enabled,
      sinks: this.sinks,
      tags: { ...this.tags, ...(tags || {}) },
      slowThresholdMs: this.slowThresholdMs,
      logger: this.logger,
    });
  }

  /** Counter */
  counter(name: string, value: number = 1, fields: Record<string, unknown> = {}): void {
    this._emit({ type: 'counter', name, value, fields });
  }

  /** Event */
  event(name: string, fields: Record<string, unknown> = {}): void {
    this._emit({ type: 'event', name, fields });
  }

  /** Duration timer: const end = dfx.timer('rpc.request'); ...; end({ok:1}); */
  timer(name: string, fields: Record<string, unknown> = {}): (extraFields?: Record<string, unknown>) => number {
    const t0 = Date.now();
    return (extraFields: Record<string, unknown> = {}) => {
      const durationMs = Date.now() - t0;
      this._emit({ type: 'timer', name, fields: { ...fields, ...extraFields }, durationMs });
      if (this.slowThresholdMs > 0 && durationMs > this.slowThresholdMs) {
        this._emit({
          type: 'event',
          name: 'slow',
          fields: { ...fields, ...extraFields, metric: name, durationMs },
        });
      }
      return durationMs;
    };
  }

  /** Wrap an async function with automatic timing + success/failure tags + error counting */
  async span<T>(name: string, fn: () => Promise<T> | T, fields: Record<string, unknown> = {}): Promise<T> {
    const end = this.timer(name, fields);
    try {
      const result = await fn();
      end({ ok: 1 });
      this.counter(`${name}.ok`, 1, fields);
      return result;
    } catch (err) {
      end({ ok: 0 });
      this.counter(`${name}.error`, 1, { ...fields, code: (err as Error & { code?: string })?.code || (err as Error)?.name });
      throw err;
    }
  }

  /** Internal: write to all sinks */
  _emit(record: Omit<DfxRecord, 'fields' | 'ts'> & { fields?: Record<string, unknown> }): void {
    if (!this.enabled) {
      return;
    }
    const full: DfxRecord = {
      type: record.type,
      name: record.name,
      value: record.value,
      durationMs: record.durationMs,
      fields: { ...this.tags, ...(record.fields || {}) },
      ts: Date.now(),
    };
    for (const sink of this.sinks) {
      try {
        sink.write(full);
      } catch {
        /* Metrics must not affect the main flow */
      }
    }
  }

  /** Convenience: get snapshot from the first MemorySink */
  snapshot(): AggregatedSnapshot | null {
    const sink = this.sinks.find((s) => s instanceof MemorySink) as MemorySink | undefined;
    return sink ? sink.snapshot() : null;
  }

  reset(): void {
    for (const sink of this.sinks) {
      if (typeof sink.reset === 'function') {
        sink.reset();
      }
    }
  }
}

/** Create a metrics collector */
export function createDfx(options: DfxOptions = {}): Dfx {
  return new Dfx(options);
}
