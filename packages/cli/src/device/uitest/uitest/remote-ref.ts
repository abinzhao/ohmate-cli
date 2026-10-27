/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Minimal RPC call interface (decoupled from UiTestRpc to avoid circular deps) */
export interface RpcLike {
  call(api: string, thisRef?: string, args?: unknown[], options?: unknown): Promise<unknown>;
}

// === Tunable protocol constants (verified against hypium-driver on real device) ===
/** API to create persistent Driver remote object */
export const DRIVER_REF_API = 'Driver.create';
/** Unified API to release remote objects (device-side BackendObjectsCleaner, max 10 refs per call) */
export const CLEAR_API = 'BackendObjectsCleaner';
/** Max refs per single cleanup call (matches device-side MAX_OBJECT_CLEAN_PER_CALL) */
export const CLEAR_BATCH = 10;
/** Seed thisRef for creating On objects (matches hypium daemon convention) */
export const ON_SEED = 'On#seed';
// ==========================================================================================

/** Release a set of remote refs (batched, CLEAR_BATCH per batch; best-effort, no throw) */
export async function clearRefs(rpc: RpcLike, refs: string[]): Promise<void> {
  const live = refs.filter((r) => r && r !== ON_SEED);
  if (live.length === 0) {
    return;
  }
  try {
    for (let i = 0; i < live.length; i += CLEAR_BATCH) {
      await rpc.call(CLEAR_API, '', [live.slice(i, i + CLEAR_BATCH)]);
    }
  } catch {
    /* Cleanup failure does not block main flow */
  }
}

export class RemoteRefSession {
  private readonly refs: string[] = [];

  constructor(private readonly rpc: RpcLike) {}

  /** Create a new remote object (using ON_SEED as seed), track ref and return */
  async create(api: string, args: unknown[] = [], seed: string = ON_SEED): Promise<string> {
    const ref = String(await this.rpc.call(api, seed, args));
    this.refs.push(ref);
    return ref;
  }

  /** Call a method on an existing remote object (does not track new ref unless return value is a ref) */
  async call(api: string, thisRef: string, args: unknown[] = []): Promise<unknown> {
    return this.rpc.call(api, thisRef, args);
  }

  /** Track an externally obtained ref (e.g. from findComponent) for cleanup on dispose */
  track(ref: string): string {
    if (ref && ref !== ON_SEED) {
      this.refs.push(ref);
    }
    return ref;
  }

  /** Track multiple refs (e.g. array from findComponents) */
  trackAll(refs: string[]): string[] {
    for (const r of refs) {
      this.track(r);
    }
    return refs;
  }

  /** Release all refs tracked by this session */
  async dispose(): Promise<void> {
    await clearRefs(this.rpc, this.refs);
    this.refs.length = 0;
  }

  /** Run a controlled closure: refs are released on exit (normal or error) */
  async run<T>(fn: (s: this) => Promise<T>): Promise<T> {
    try {
      return await fn(this);
    } finally {
      await this.dispose();
    }
  }
}