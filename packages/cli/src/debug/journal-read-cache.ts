/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { CommittedHistory } from '../debug-protocol/committed-history.js';
import type { ClockSegment } from '../debug-protocol/clock-segments.js';
import type { JournalEvent } from './journal-schemas.js';

export interface VerifiedJournalPrefix {
  manifestDigest: string;
  epochsHash: string;
  retentionHash?: string;
  files: Array<{ name: string; digest: string }>;
  events: JournalEvent[];
  totalBytes: number;
  previousHash: string;
  clock: ClockSegment | null;
  history?: CommittedHistory;
}

// Limits bound decoded records as well as their serialized footprint, including empty streams.
export class JournalReadCache {
  private readonly entries = new Map<string, VerifiedJournalPrefix>();
  private bytes = 0;
  private events = 0;
  take(root: string): VerifiedJournalPrefix | undefined {
    const value = this.entries.get(root);
    if (value) {
      this.entries.delete(root);
      this.bytes -= value.totalBytes; this.events -= value.events.length;
    }
    return value;
  }
  put(root: string, value: VerifiedJournalPrefix): void {
    this.take(root);
    while (this.entries.size && (this.entries.size >= 16 ||
      this.bytes + value.totalBytes > 5 * 1024 * 1024 || this.events + value.events.length > 4096)) {
      this.take(this.entries.keys().next().value!);
    }
    if (value.totalBytes > 5 * 1024 * 1024 || value.events.length > 4096) { return; }
    this.entries.set(root, value);
    this.bytes += value.totalBytes; this.events += value.events.length;
  }
}
