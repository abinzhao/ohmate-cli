/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { appendFileSync } from 'node:fs';

export const LogLevel = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  SILENT: 100,
} as const;

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  100: 'SILENT',
};

export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

export function parseLevel(level: string | number): number {
  if (typeof level === 'number') {
    return level;
  }
  const key = String(level || '').toUpperCase();
  if (key in LogLevel) {
    return LogLevel[key as keyof typeof LogLevel];
  }
  return LogLevel.INFO;
}

export interface LogRecord {
  level: number;
  name: string;
  message: string;
  fields: Record<string, unknown>;
  ts: number;
}

export interface Transport {
  write: (record: LogRecord, formatted: string) => void;
}

export interface MemoryTransport extends Transport {
  records: Array<LogRecord & { formatted: string }>;
  clear: () => void;
  find: (predicate: (r: LogRecord) => boolean) => Array<LogRecord & { formatted: string }>;
}

function transport(fn: (record: LogRecord, formatted: string) => void): Transport {
  return { write: fn };
}

export function createConsoleTransport({ useStderr }: { useStderr?: boolean } = {}): Transport {
  return transport((record, formatted) => {
    const line = `${LEVEL_TAG[LEVEL_NAMES[record.level]] || ''}${formatted}`;
    if (useStderr || record.level >= LogLevel.ERROR) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  });
}

const LEVEL_TAG: Record<string, string> = {
  TRACE: '',
  DEBUG: '',
  INFO: '',
  WARN: '',
  ERROR: '',
};

export function createMemoryTransport(): MemoryTransport {
  const records: Array<LogRecord & { formatted: string }> = [];
  const t = transport((record, formatted) => {
    records.push({ ...record, formatted });
  }) as MemoryTransport;
  t.records = records;
  t.clear = () => {
    records.length = 0;
  };
  t.find = (predicate) => records.filter(predicate);
  return t;
}

export function createFileTransport(filePath: string): Transport {
  return transport((_record, formatted) => {
    try {
      appendFileSync(filePath, formatted + '\n');
    } catch {
      /* Ignore file write failures */
    }
  });
}

export interface LoggerOptions {
  name?: string;
  level?: string | number;
  transports?: Transport[];
  fields?: Record<string, unknown>;
  timestamp?: boolean;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class Logger {
  name: string;
  level: number;
  transports: Transport[];
  fields: Record<string, unknown>;
  timestamp: boolean;
  constructor(options: LoggerOptions = {}) {
    this.name = options.name || 'hm';
    this.level = parseLevel(options.level ?? 'info');
    this.transports = options.transports || [createConsoleTransport()];
    this.fields = { ...(options.fields || {}) };
    this.timestamp = options.timestamp !== false;
  }

  /** Derive a child logger: name joined with ':', fields merged */
  child(name: string, fields?: Record<string, unknown>): Logger {
    return new Logger({
      name: name ? `${this.name}:${name}` : this.name,
      level: this.level,
      transports: this.transports,
      fields: { ...this.fields, ...(fields || {}) },
      timestamp: this.timestamp,
    });
  }

  /** Append fixed fields */
  withFields(fields: Record<string, unknown>): Logger {
    return this.child('', fields);
  }

  setLevel(level: string | number): this {
    this.level = parseLevel(level);
    return this;
  }

  addTransport(t: Transport): this {
    this.transports.push(t);
    return this;
  }

  isLevelEnabled(level: string | number): boolean {
    return parseLevel(level) >= this.level;
  }

  trace(message: unknown, ...args: unknown[]): void {
    this._log(LogLevel.TRACE, message, args);
  }
  debug(message: unknown, ...args: unknown[]): void {
    this._log(LogLevel.DEBUG, message, args);
  }
  info(message: unknown, ...args: unknown[]): void {
    this._log(LogLevel.INFO, message, args);
  }
  warn(message: unknown, ...args: unknown[]): void {
    this._log(LogLevel.WARN, message, args);
  }
  error(message: unknown, ...args: unknown[]): void {
    this._log(LogLevel.ERROR, message, args);
  }

  /** Timing log: const end = logger.timeStart('init'); ...; end(); */
  timeStart(label: string, level: number = LogLevel.DEBUG): (extra?: string) => number {
    const t0 = Date.now();
    return (extra?: string) => {
      const cost = Date.now() - t0;
      this._log(level, `${label} cost ${cost}ms${extra ? ' ' + extra : ''}`, []);
      return cost;
    };
  }

  _log(level: number, message: unknown, args: unknown[]): void {
    if (level < this.level) {
      return;
    }
    let text: string;
    try {
      text = typeof message === 'string' ? message : safeStringify(message);
      if (args && args.length) {
        text +=
          ' ' +
          args
            .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeStringify(a)))
            .join(' ');
      }
    } catch {
      text = String(message);
    }
    const fieldsText = formatFields(this.fields);
    const tsText = this.timestamp ? `[${formatTimestamp(Date.now())}] ` : '';
    const formatted = `${tsText}[${LEVEL_NAMES[level]}] [${this.name}]${fieldsText} ${text}`;
    const record: LogRecord = { level, name: this.name, message: text, fields: { ...this.fields }, ts: Date.now() };
    for (const t of this.transports) {
      try {
        t.write(record, formatted);
      } catch {
        /* Logging must not affect the main flow */
      }
    }
  }
}

function formatFields(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields || {});
  if (!keys.length) {
    return '';
  }
  return ' ' + keys.map((k) => `${k}=${fields[k]}`).join(' ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Root logger (module-level shared, for direct getLogger('X') anywhere) */
let root = new Logger({ name: 'hm', level: 'info' });

export function configureRootLogger(options: LoggerOptions = {}): Logger {
  root = new Logger({ name: 'hm', ...options });
  return root;
}

export function getRootLogger(): Logger {
  return root;
}

/** Get/cache a child logger by name */
export function getLogger(name: string): Logger {
  return root.child(name, {});
}

export { Logger as default };
