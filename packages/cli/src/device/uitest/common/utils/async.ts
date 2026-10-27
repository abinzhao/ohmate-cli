/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add a timeout to a Promise; rejects on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string = `operation timeout after ${ms}ms`,
  wrap?: (err: Error) => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'TimeoutError';
      reject(wrap ? wrap(err) : err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retry executor
 */
export async function retry<T>(
  fn: () => Promise<T>,
  {
    times = 1,
    delayMs = 0,
    shouldRetry = () => true,
    onRetry = () => {},
  }: {
    times?: number;
    delayMs?: number;
    shouldRetry?: (err: Error, attempt: number) => boolean;
    onRetry?: (err: Error, attempt: number) => void;
  } = {},
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < Math.max(1, times); attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt + 1 >= Math.max(1, times) || !shouldRetry(err as Error, attempt)) {
        throw err;
      }
      onRetry(err as Error, attempt);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

/**
 * Poll until the condition is met or timeout
 * @param fn Return a truthy value to finish
 */
export async function waitUntil<T>(
  fn: () => Promise<T | false | null | undefined>,
  {
    timeoutMs,
    intervalMs = 200,
    firstDelayMs = 0,
    description = 'condition',
  }: {
    timeoutMs: number;
    intervalMs?: number;
    firstDelayMs?: number;
    description?: string;
  },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  if (firstDelayMs > 0) {
    await sleep(firstDelayMs);
  }
  let last: T | false | null | undefined;
  for (;;) {
    last = await fn();
    if (last) {
      return last;
    }
    if (Date.now() >= deadline) {
      const err = new Error(`wait for ${description} timeout after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      throw err;
    }
    await sleep(intervalMs);
  }
}

/**
 * Serial mutex: Ensures only one critical section executes at a time.
 * Used for RPC lifecycle (avoiding concurrent calls that redundantly start processes)
 * and transport layer (avoiding concurrent writes to the same socket).
 */
export class Mutex {
  _tail: Promise<unknown>;
  locked: boolean;
  constructor() {
    this._tail = Promise.resolve();
    this.locked = false;
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this._tail;
    this._tail = prev.then(() => next);
    await prev.catch(() => {});
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

interface IdleWaiter {
  resolve: () => void;
}

/**
 * Counting semaphore: controls the number of "in-flight" concurrent operations.
 */
export class Semaphore {
  limit: number;
  used: number;
  _waiters: Waiter[];
  _idleWaiters: IdleWaiter[];
  /**
   * @param limit Maximum concurrency
   */
  constructor(limit: number = 1) {
    this.limit = Math.max(1, limit | 0);
    this.used = 0;
    this._waiters = [];
    this._idleWaiters = [];
  }

  get available(): number {
    return Math.max(0, this.limit - this.used);
  }

  get waiting(): number {
    return this._waiters.length;
  }

  get isIdle(): boolean {
    return this.used === 0;
  }

  /**
   * Acquire a permit, returns a release function (idempotent)
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      this._dispatch();
    });
  }

  /**
   * Adjust the limit and re-dispatch
   */
  resize(limit: number): void {
    const next = Math.max(1, limit | 0);
    if (next === this.limit) {
      return;
    }
    this.limit = next;
    this._dispatch();
  }

  /** Wake up all queued waiters and reject (e.g., connection closed scenario) */
  abortAll(err: Error): void {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      try {
        w.reject(err);
      } catch {
        /* noop */
      }
    }
  }

  /** Wait for all permits to be returned */
  drain(): Promise<void> {
    if (this.used === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._idleWaiters.push({ resolve });
    });
  }

  _dispatch(): void {
    while (this._waiters.length > 0 && this.used < this.limit) {
      const waiter = this._waiters.shift() as Waiter;
      this.used += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.used -= 1;
        this._dispatch();
        if (this.used === 0 && this._idleWaiters.length) {
          this._resolveIdleWaiters();
        }
      });
    }
  }

  private _resolveIdleWaiters(): void {
    const idle = this._idleWaiters.splice(0);
    for (const w of idle) {
      w.resolve();
    }
  }
}

/**
 * Single flight: concurrent calls with the same key share a single real execution.
 */
export class SingleFlight {
  _map: Map<string, Promise<unknown>>;
  constructor() {
    this._map = new Map();
  }

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const running = this._map.get(key);
    if (running) {return running as Promise<T>}
    const task = (async () => fn())();
    const tracked = task.finally(() => {
      if (this._map.get(key) === tracked) {
        this._map.delete(key);
      }
    });
    this._map.set(key, tracked);
    return tracked;
  }

  /**
   * Currently in-flight task (or null if none).
   */
  pending(key: string): Promise<unknown> | null {
    return this._map.get(key) || null;
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  keys(): string[] {
    return [...this._map.keys()];
  }
}

/** Controlled Promise */
export class Deferred<T = unknown> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (err: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
