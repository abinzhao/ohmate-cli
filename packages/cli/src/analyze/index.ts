/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { analyzeJSLeak, jsleakSchema } from './jsleak/adapter.js';
import { analyzeGC, gcSchema } from './gc/adapter.js';
import { analyzeFDLeak, fdSchema } from './fdleak/adapter.js';
import { analyzeJSCrash, jsCrashSchema } from './jscrash/adapter.js';
import { analyzeCppCrash, cppCrashSchema } from './cppcrash/adapter.js';
import { analyzeFreeze, freezeSchema } from './freeze/adapter.js';
import { analyzeAPI, apiSchema } from './api/adapter.js';
import { analyzeNativeLeak, nativeLeakSchema } from './nativeleak/adapter.js';
import { analyzeUI, uiAnalysisSchema } from './ui/adapter.js';
import { analyzeAuto, autoSchema } from './auto/adapter.js';
export function getAnalysisSpecs(): ToolSpec[] {
  return [{ ...serviceSpec('analyze.jsleak', 'Analyze a bounded V8 JSON layout subset offline; Ark capture, rawheap, retained size and leak diagnosis remain unverified',
    jsleakSchema, analyzeJSLeak, [valueOption('snapshots', 'One snapshot, or before/after in explicit order; .heapsnapshot files only', true)]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['snapshot-raw-hash', 'declared-strong-paths', 'aggregate-deltas', 'jsleak-report'] },
  { ...serviceSpec('analyze.gc', 'Analyze the bounded Ark GC summary log subset offline; capture identity, verbose association and root cause remain unverified',
    gcSchema, analyzeGC, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; only known Ark GC summary fields')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'gc-summary-fields', 'gc-report'] },
  { ...serviceSpec('analyze.fdleak', 'Analyze the bounded FD snapshot/allocation log subset offline; symbols, detail association and leak diagnosis remain unverified',
    fdSchema, analyzeFDLeak, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; declared FD stock and allocation fields only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'fd-stock-fields', 'fd-allocation-fields', 'fdleak-report'] },
  { ...serviceSpec('analyze.jscrash', 'Analyze the bounded JS faultlog/JS primary stack subset offline; SourceMap, build identity and root cause remain unverified',
    jsCrashSchema, analyzeJSCrash, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; declared JS error and primary JS frames only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'js-error-fields', 'js-raw-frames', 'jscrash-report'] },
  { ...serviceSpec('analyze.cppcrash', 'Analyze the bounded Native faultlog/signal and primary frame subset offline; symbols, build identity and root cause remain unverified',
    cppCrashSchema, analyzeCppCrash, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; declared Native signal and fault-thread frames only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'native-signal-fields', 'native-raw-frames', 'cppcrash-report'] },
  { ...serviceSpec('analyze.freeze', 'Analyze the bounded AppFreeze event and thread-stack subset offline; system factors, sample association and root cause remain unverified',
    freezeSchema, analyzeFreeze, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; declared Freeze events and thread frames only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'freeze-event-fields', 'freeze-thread-frames', 'freeze-report'] },
  { ...serviceSpec('analyze.api', 'Analyze the bounded HiLog explicit error-code subset offline; API association, capture and root cause remain unverified',
    apiSchema, analyzeAPI, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; E/F lines with explicit error code fields'),
      valueOption('sdk-module', 'Optional exact @ohos module in the current toolchain SDK; declaration candidates only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'api-error-code-fields', 'sdk-declaration-hash', 'api-report'] },
  { ...serviceSpec('analyze.nativeleak', 'Analyze the bounded Native memory sample and smaps table subset offline; capture, allocation lifetime and leak diagnosis remain unverified',
    nativeLeakSchema, analyzeNativeLeak, [valueOption('sample', 'Explicit public UTF-8 .log/.txt sample; OpenHarmony 5.0.3 fields only'),
      valueOption('smaps', 'Optional explicit public UTF-8 .log/.txt hidumper smaps table; no companion discovery or input association')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['sample-raw-hash', 'smaps-raw-hash', 'native-memory-fields', 'nativeleak-report'] },
  { ...serviceSpec('analyze.ui', 'Analyze the bounded Ace window lifecycle log subset offline; layout, rendering, capture and root cause remain unverified',
    uiAnalysisSchema, analyzeUI, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; known Ace window notifications and context fields only')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'ui-window-notifications', 'ui-analysis-report'] },
  { ...serviceSpec('analyze.auto', 'Triage a bounded public log subset offline; validate a sole candidate, leave ambiguous domains manual and capture or root cause unverified',
    autoSchema, analyzeAuto, [valueOption('log', 'Explicit public UTF-8 .log/.txt input; no snapshot, SDK, attachment or device discovery')]),
  idempotency: 'read', recovery: 'verify-and-retry', evidence: ['log-raw-hash', 'auto-classification-markers', 'selected-analyzer-validation', 'auto-report'] }];
}
