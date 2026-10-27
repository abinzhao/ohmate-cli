/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

let seq = 0;

/**
 * Generate a request ID: timestamp + sequence + random, ensuring uniqueness within a connection
 */
export function requestId(prefix: string = 'hm'): string {
  seq = (seq + 1) % 1000000;
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${seq.toString(36)}-${rand}`;
}
