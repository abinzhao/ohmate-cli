/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export class BridgeUpdateSubscription {
  private pending = false;
  private closed = false;
  private waiting?: () => void;
  constructor(readonly streamId: string, private release: () => void) {}
  notify(): void {
    if (this.closed) { return; }
    if (this.waiting) { this.waiting(); }
    else { this.pending = true; }
  }
  wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed) { return Promise.resolve(); }
    // Retain a wake between subscribe/read and wait without retaining any event payload.
    if (this.pending) { this.pending = false; return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer); signal.removeEventListener('abort', done);
        this.waiting = undefined; resolve();
      };
      // External writers and silent corruption still need an independent journal recheck.
      const timer = setTimeout(done, 1000);
      this.waiting = done;
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) { done(); }
    });
  }
  close(): void {
    if (this.closed) { return; }
    this.closed = true; this.pending = false; this.waiting?.(); this.release();
  }
}
export class BridgeUpdates {
  private readonly subscriptions = new Set<BridgeUpdateSubscription>();
  watch(streamId: string): BridgeUpdateSubscription {
    const subscription = new BridgeUpdateSubscription(streamId, () => { this.subscriptions.delete(subscription); });
    this.subscriptions.add(subscription);
    return subscription;
  }
  notify(previous: string | null, current: string | null): void {
    for (const subscription of this.subscriptions) {
      if (subscription.streamId === previous || subscription.streamId === current) { subscription.notify(); }
    }
  }
  close(): void { for (const subscription of this.subscriptions) { subscription.close(); } }
}
