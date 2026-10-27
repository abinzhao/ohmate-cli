/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { redactTaskValue } from '../tasks/task-redaction.js';
import { EventEnvelopeSchema } from '../debug-protocol/envelopes.js';
import { COOKIE_METADATA_SUMMARY } from '../debug-protocol/domain-schemas.js';
import type { EventEnvelope } from '../debug-protocol/index.js';

function summary(value: string): string {
  return String(redactTaskValue(value))
    .replace(/\b(?:cookie|set-cookie)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
        return parsed.toString();
      } catch { return '[REDACTED]'; }
    })
    .replace(/\b1[3-9]\d{9}\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/\b\d{17}[\dX]\b/gi, '[REDACTED]');
}
function consoleSourceMetadata(channel: string, value: string): boolean {
  // Only bounded native category/role/line metadata survives. The source URL,
  // message text, frame claims and arbitrary additions still become memory-only.
  return channel === 'arkweb.console' && !value.includes('\n') &&
    /^source-(?:[0-9]|1[0-2]);(?:page|script);line-(?:[0-9]|[1-9][0-9]{1,5}|1000000);frame-column-unverified;\[MEMORY_ONLY\]$/.test(value);
}
export function redactDebugEvent(input: EventEnvelope): EventEnvelope {
  const event = structuredClone(input);
  if ('summary' in event.payload) {
    const original = event.payload.summary;
    event.payload.summary = ['arkweb.console', 'arkweb.dom', 'arkweb.storage', 'ui'].includes(event.channel) &&
      !consoleSourceMetadata(event.channel, original) &&
      !(event.channel === 'arkweb.storage' && original === COOKIE_METADATA_SUMMARY)
      ? '[MEMORY_ONLY]' : summary(original);
    if (event.payload.summary !== original) { event.redaction.fieldsRemoved++; }
  }
  return EventEnvelopeSchema.parse(event);
}
