/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { AUTO_LIMITS, type AutoCandidate, type AutoFamily } from './types.js';

const markers: [AutoFamily, RegExp][] = [
  ['ui', /C03900\/Ace:.*\]: window\b/],
  ['gc', /ArkCompiler:[ \t]*\[gc\][ \t]*\[/],
  ['api', /^[^\r\n]+[ \t]+[EF][ \t]+C[0-9a-fA-F]{5}\/[^:\r\n]+:.*(?:^|[\s,;])(?:error[ \t]+)?code[ \t]*[:=]/i],
  ['jscrash', /^Reason:(?:Error|TypeError|SyntaxError|ReferenceError|RangeError|BusinessError|OutOfMemoryError|OOMError|URIError|TerminationError|AggregateError|EvalError)[ \t]*$/],
  ['cppcrash', /^Reason:Signal:/],
  ['freeze', /^Reason:(?:APP_INPUT_BLOCK|LIFECYCLE_TIMEOUT|THREAD_BLOCK_3S|THREAD_BLOCK_6S|BUSSINESS_THREAD_BLOCK_3S|BUSSINESS_THREAD_BLOCK_6S|BUSINESS_THREAD_BLOCK_6S)[ \t]*$/],
  ['fdleak', /^[ \t]*leaked fd nums[ \t]*:/],
  ['nativeleak', /^[ \t]*time\(s\)[ \t]+PssMemory\(KB\)[ \t]+realtime[ \t]*$/],
];
function decode(bytes: Buffer) {
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > AUTO_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) || text.includes('\0') ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { throw new Error('AUTO_TEXT_UNSUPPORTED'); }
}
export async function classifyLog(bytes: Buffer, signal: AbortSignal): Promise<AutoCandidate[]> {
  signal.throwIfAborted(); decode(bytes);
  const candidates = new Map<AutoFamily, AutoCandidate>();
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > AUTO_LIMITS.lines || raw.length > AUTO_LIMITS.lineBytes) { throw new Error('AUTO_LINE_LIMIT'); }
    const text = raw.toString('utf8').replace(/\r?\n$/, '');
    if (/^\s*(?:\.{3}|\[truncated\])/i.test(text)) { throw new Error('AUTO_TRUNCATION_UNSUPPORTED'); }
    for (const [family, pattern] of markers) {
      if (!pattern.test(text)) { continue; }
      const candidate = candidates.get(family) ?? { analyzer: family, basis: 'raw-log-markers', markerCount: 0, markers: [] };
      candidate.markerCount++;
      if (candidate.markers.length < AUTO_LIMITS.markersPerFamily) {
        candidate.markers.push({ line: lines, offset, bytes: raw.length, sha256: digest(raw) });
      }
      candidates.set(family, candidate);
    }
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted();
  if (!candidates.size) { throw new Error('AUTO_INPUT_TYPE_UNSUPPORTED'); }
  return [...candidates.values()];
}
