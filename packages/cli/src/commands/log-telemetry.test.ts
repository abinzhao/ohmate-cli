/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { telemetry, TraceError } from '../trace/index.js';
import type { LogTraceEvent, TrackMeasurement } from '../trace/index.js';
import {
  analyzeCrashLog,
  FaultLogError,
  type CrashAnalysisResult,
  type FaultLogVerdict,
  type SampleStackAnalysisResult,
} from '../faultlog/index.js';

interface TestLogOptions {
  crash?: boolean;
  stack?: boolean;
  path?: string;
  format?: string;
  level?: string;
  bundleName?: string;
}

interface PrivateExports {
  buildLogEvent: (options: TestLogOptions) => LogTraceEvent;
  deriveClassification: (
    identify: FaultLogVerdict
  ) => 'identified' | 'unknown' | 'out_of_scope' | 'ambiguous';
  applyIdentifyMeta: <T extends LogTraceEvent>(
    event: T,
    result?: CrashAnalysisResult | SampleStackAnalysisResult,
    faultError?: FaultLogError
  ) => T;
  resolvePrimaryLogPath: (
    result: CrashAnalysisResult | SampleStackAnalysisResult
  ) => string;
  readModuleNameFromLog: (logPath: string) => string | undefined;
  maskPathsInMessage: (message: string) => string;
  withLogTrace: (event: LogTraceEvent, action: () => unknown) => Promise<void>;
}

// The command module keeps its telemetry helpers module-private, so expose
// them for tests through a throwaway sibling module that re-exports them.
async function loadPrivateExports(): Promise<PrivateExports> {
  const sourcePath = fileURLToPath(new URL('./log.ts', import.meta.url));
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const reexports = [
    'export {',
    '  buildLogEvent,',
    '  deriveClassification,',
    '  applyIdentifyMeta,',
    '  resolvePrimaryLogPath,',
    '  readModuleNameFromLog,',
    '  maskPathsInMessage,',
    '  withLogTrace,',
    '};',
    '',
  ].join('\n');
  const helperPath = path.join(
    path.dirname(sourcePath),
    `.log-private-exports-${process.pid}.ts`
  );
  fs.writeFileSync(helperPath, source + reexports);
  try {
    const helperUrl = `${pathToFileURL(helperPath).href}?v=${Date.now()}`;
    return (await import(helperUrl)) as unknown as PrivateExports;
  } finally {
    fs.rmSync(helperPath, { force: true });
  }
}

const {
  buildLogEvent,
  deriveClassification,
  applyIdentifyMeta,
  resolvePrimaryLogPath,
  readModuleNameFromLog,
  maskPathsInMessage,
  withLogTrace,
} = await loadPrivateExports();

const tempFiles: string[] = [];

afterAll(() => {
  for (const filePath of tempFiles) {
    fs.rmSync(filePath, { force: true });
  }
});

function makeTempLog(content: string, fileName: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `log-telemetry-${process.pid}-${tempFiles.length}-${fileName}`
  );
  fs.writeFileSync(filePath, content, 'utf-8');
  tempFiles.push(filePath);
  return filePath;
}

function makeVerdict(
  overrides: Partial<FaultLogVerdict> = {}
): FaultLogVerdict {
  return {
    type: 'app_freeze',
    subtype: 'THREAD_BLOCK_6S',
    confidence: 'high',
    completeness: 'full',
    evidence: ['#01 pc 0x1234 Thread'],
    excluded: [],
    candidates: [],
    filename_hint: 'appfreeze-sample',
    ...overrides,
  };
}

function makeCrashResult(
  identify: FaultLogVerdict,
  sourcePath = '/tmp/appfreeze-sample'
): CrashAnalysisResult {
  return {
    schemaVersion: '1.0.0',
    logType: 'app_freeze',
    source: { kind: 'file', path: sourcePath },
    identify,
    'key-report': { 'basic-info': {}, threads: [], binders: [] },
  };
}

function makeDirectoryCrashResult(
  identify: FaultLogVerdict,
  dirPath: string,
  candidatePath: string
): CrashAnalysisResult {
  return {
    schemaVersion: '1.0.0',
    logType: 'app_freeze',
    source: {
      kind: 'directory',
      path: dirPath,
      candidates: [
        {
          path: candidatePath,
          type: 'app_freeze',
          confidence: 'high',
          completeness: 'full',
        },
      ],
    },
    identify,
    'key-report': { 'basic-info': {}, threads: [], binders: [] },
  };
}

function makeStackResult(
  identify: FaultLogVerdict,
  sourcePath = '/tmp/sample-stack'
): SampleStackAnalysisResult {
  return {
    schemaVersion: '1.0.0',
    logType: 'sample_stack',
    source: { kind: 'file', path: sourcePath },
    identify,
    summary: {
      'statics-duration-ms': 1,
      'cpu-time-ms': 1,
      'cpu-usage': {},
      'snapshot-count': 1,
    },
    hotspots: [],
  };
}

describe('deriveClassification', () => {
  it('returns out_of_scope when out_of_scope is present', () => {
    const verdict = makeVerdict({
      type: 'unknown',
      confidence: 'low',
      completeness: 'fragment',
      out_of_scope: { reason: 'hilog_stream', detail: 'hilog only' },
    });
    expect(deriveClassification(verdict)).toBe('out_of_scope');
  });

  it('returns ambiguous for unknown with candidates', () => {
    const verdict = makeVerdict({
      type: 'unknown',
      confidence: 'low',
      candidates: [
        {
          type: 'cpp_crash',
          confidence: 'medium',
          evidence: [],
          arbitrable: false,
        },
      ],
    });
    expect(deriveClassification(verdict)).toBe('ambiguous');
  });

  it('returns unknown for unknown without candidates', () => {
    const verdict = makeVerdict({ type: 'unknown', confidence: 'low' });
    expect(deriveClassification(verdict)).toBe('unknown');
  });

  it('returns identified for a supported family hit', () => {
    expect(deriveClassification(makeVerdict())).toBe('identified');
  });
});

describe('applyIdentifyMeta', () => {
  it('extracts fault type and backfills bundle name from the log Module name', () => {
    const logPath = makeTempLog(
      'Generated by HiviewDFX@OpenHarmony\nModule name:com.example.freezetest\n',
      'appfreeze.log'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(
      event,
      makeCrashResult(makeVerdict(), logPath)
    );
    expect(applied.faultType).toBe('app_freeze');
    expect(applied.bundleName).toBe('com.example.freezetest');
    const record = applied as unknown as Record<string, unknown>;
    expect(record.schemaVersion).toBeUndefined();
    expect(record.classificationResult).toBeUndefined();
    expect(record.completeness).toBeUndefined();
    expect(record.confidence).toBeUndefined();
    expect(record.identifiedBundleName).toBeUndefined();
  });

  it('maps out_of_scope verdicts to faultType', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const verdict = makeVerdict({
      type: 'unknown',
      confidence: 'low',
      completeness: 'fragment',
      out_of_scope: { reason: 'hilog_stream', detail: 'hilog only' },
    });
    const applied = applyIdentifyMeta(event, makeCrashResult(verdict));
    expect(applied.faultType).toBe('out_of_scope');
  });

  it('maps multi-candidate conflicts to ambiguous', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const verdict = makeVerdict({
      type: 'unknown',
      confidence: 'low',
      candidates: [
        {
          type: 'cpp_crash',
          confidence: 'medium',
          evidence: [],
          arbitrable: false,
        },
        {
          type: 'js_error',
          confidence: 'medium',
          evidence: [],
          arbitrable: false,
        },
      ],
    });
    const applied = applyIdentifyMeta(event, makeCrashResult(verdict));
    expect(applied.faultType).toBe('ambiguous');
  });

  it('keeps faultType unset for sample_stack results and backfills bundle name', () => {
    const logPath = makeTempLog(
      'Module name: com.example.freezetest\r\n',
      'sample-stack'
    );
    const event = buildLogEvent({ stack: true, path: 's.txt', format: 'json' });
    const verdict = makeVerdict({
      type: 'sample_stack',
      confidence: 'high',
      completeness: 'full',
    });
    const applied = applyIdentifyMeta(event, makeStackResult(verdict, logPath));
    expect(applied.faultType).toBeUndefined();
    expect(applied.bundleName).toBe('com.example.freezetest');
  });

  it('maps the verdict carried by a FaultLogError when analysis failed', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const verdict = makeVerdict({
      type: 'unknown',
      confidence: 'low',
      completeness: 'fragment',
      out_of_scope: { reason: 'hilog_stream', detail: 'hilog only' },
    });
    const applied = applyIdentifyMeta(
      event,
      undefined,
      new FaultLogError('UNRECOGNIZED_LOG', '无法解析该日志', verdict)
    );
    expect(applied.faultType).toBe('out_of_scope');
    expect(applied.bundleName).toBe('ALL');
  });

  it('keeps faultType unset when the FaultLogError carries no verdict', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(
      event,
      undefined,
      new FaultLogError('FILE_NOT_FOUND', 'missing')
    );
    expect(applied).toBe(event);
    expect(applied.faultType).toBeUndefined();
  });

  it('returns the event unchanged when result is undefined', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(event, undefined);
    expect(applied).toBe(event);
    expect(applied.faultType).toBeUndefined();
    expect(applied.bundleName).toBe('ALL');
  });

  it('backfills bundle name from the selected candidate file in directory mode', () => {
    const candidatePath = makeTempLog(
      'Module name:com.example.frozen\n',
      'appfreeze-candidate.log'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(
      event,
      makeDirectoryCrashResult(
        makeVerdict(),
        path.dirname(candidatePath),
        candidatePath
      )
    );
    expect(applied.bundleName).toBe('com.example.frozen');
  });

  it('keeps the default bundle name when the log has no Module name header', () => {
    const logPath = makeTempLog(
      'Generated by HiviewDFX@OpenHarmony\nDeviceDebuggable:No\n',
      'no-module.log'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(
      event,
      makeCrashResult(makeVerdict(), logPath)
    );
    expect(applied.bundleName).toBe('ALL');
  });

  it('keeps the default bundle name when the log file cannot be read', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const applied = applyIdentifyMeta(
      event,
      makeCrashResult(
        makeVerdict(),
        path.join(os.tmpdir(), 'log-telemetry-no-such-file.log')
      )
    );
    expect(applied.bundleName).toBe('ALL');
  });
});

describe('resolvePrimaryLogPath', () => {
  it('prefers the first candidate in directory mode', () => {
    const result = makeDirectoryCrashResult(
      makeVerdict(),
      path.join(os.tmpdir(), 'faults'),
      path.join(os.tmpdir(), 'faults', 'best.log')
    );
    expect(resolvePrimaryLogPath(result)).toBe(
      path.join(os.tmpdir(), 'faults', 'best.log')
    );
  });

  it('falls back to the source path without candidates', () => {
    expect(
      resolvePrimaryLogPath(
        makeCrashResult(makeVerdict(), path.join(os.tmpdir(), 'a.log'))
      )
    ).toBe(path.join(os.tmpdir(), 'a.log'));
    expect(
      resolvePrimaryLogPath(
        makeStackResult(makeVerdict(), path.join(os.tmpdir(), 'stack'))
      )
    ).toBe(path.join(os.tmpdir(), 'stack'));
  });
});

describe('readModuleNameFromLog', () => {
  it('parses the Module name header', () => {
    const logPath = makeTempLog(
      'Generated by HiviewDFX@OpenHarmony\nModule name:com.example.dfx_test\nReason:Signal 11\n',
      'cppcrash.log'
    );
    expect(readModuleNameFromLog(logPath)).toBe('com.example.dfx_test');
  });

  it('trims spaces and CRLF line endings', () => {
    const logPath = makeTempLog(
      'Module name: com.example.freezetest\r\nTimeStamp: 2026-09-17\r\n',
      'sample-stack'
    );
    expect(readModuleNameFromLog(logPath)).toBe('com.example.freezetest');
  });

  it('reads Module name after the faultlog preamble', () => {
    const logPath = makeTempLog(
      'Device info:OpenHarmony Device\nBuild info:OpenHarmony 5.0\nModule name:com.example.app\n',
      'jscrash.log'
    );
    expect(readModuleNameFromLog(logPath)).toBe('com.example.app');
  });

  it('returns undefined when the header is missing', () => {
    const logPath = makeTempLog(
      'plain text without faultlog structure\n',
      'fragment.txt'
    );
    expect(readModuleNameFromLog(logPath)).toBeUndefined();
  });

  it('returns undefined for unreadable files', () => {
    expect(
      readModuleNameFromLog(
        path.join(os.tmpdir(), 'log-telemetry-no-such-file.log')
      )
    ).toBeUndefined();
  });
});

describe('maskPathsInMessage', () => {
  it('keeps path-free messages unchanged', () => {
    expect(maskPathsInMessage('boom')).toBe('boom');
    expect(maskPathsInMessage('分析失败：文件不存在')).toBe(
      '分析失败：文件不存在'
    );
  });

  it('masks windows paths keeping only the extension', () => {
    expect(
      maskPathsInMessage('Cannot read file: E:\\tmp\\faults\\cppcrash-x.log')
    ).toBe('Cannot read file: ***.log');
  });

  it('masks extension-less directories as bare stars', () => {
    expect(
      maskPathsInMessage('分析目录：E:\\tmp\\faults 失败：文件不存在')
    ).toBe('分析目录：*** 失败：文件不存在');
  });

  it('masks posix paths as well', () => {
    expect(maskPathsInMessage('no such file: /data/log/jserror.txt')).toBe(
      'no such file: ***.txt'
    );
  });

  it('keeps standalone slash separators in plain text', () => {
    expect(
      maskPathsInMessage('仅支持 cpp_crash / js_error / app_freeze 类型')
    ).toBe('仅支持 cpp_crash / js_error / app_freeze 类型');
  });

  it('masks relative multi-segment paths', () => {
    expect(maskPathsInMessage('读取失败：logs/cppcrash-x.log')).toBe(
      '读取失败：***.log'
    );
  });
});

describe('buildLogEvent', () => {
  it('marks local identify mode for --crash --path', () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    expect(event.operation).toBe('local_identify');
    expect(event.logType).toBe('crash');
    expect(event.bundleName).toBe('ALL');
    expect(event.args).toContain('--crash');
    expect(event.args).toContain('--path');
    expect(event.args).not.toContain('a.log');
  });

  it('marks device faultlogger mode for --crash without --path', () => {
    const event = buildLogEvent({ crash: true });
    expect(event.operation).toBe('faultlogger_report');
    expect(event.logType).toBe('crash');
  });

  it('marks plain hilog mode without crash flags', () => {
    const event = buildLogEvent({ level: 'E' });
    expect(event.operation).toBe('hilog');
    expect(event.logType).toBe('common');
    expect(event.bundleName).toBe('ALL');
  });

  it('records stack mode', () => {
    const event = buildLogEvent({ stack: true, path: 's.txt', format: 'json' });
    expect(event.operation).toBe('local_identify');
    expect(event.logType).toBe('stack');
  });
});

describe('withLogTrace', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: string | number | null | undefined;

  beforeEach(() => {
    trackSpy = vi.spyOn(telemetry, 'track').mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  it('tracks success with identify metadata on the happy path', async () => {
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    const result = makeCrashResult(makeVerdict());
    await withLogTrace(event, () => result);
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(trackedEvent).toBe(event);
    expect(trackedEvent.faultType).toBe('app_freeze');
    expect(trackedEvent.errorMessage).toBeUndefined();
    expect(measurement.success).toBe(true);
    expect(measurement.error_code).toBeNull();
    expect(measurement.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('still tracks with error code when the action throws', async () => {
    const event = buildLogEvent({ crash: true, path: 'missing.log' });
    await withLogTrace(event, () => {
      throw new TraceError('boom', 'PATH_NOT_FOUND');
    });
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(measurement.success).toBe(false);
    expect(measurement.error_code).toBe('PATH_NOT_FOUND');
    expect(trackedEvent.operation).toBe('local_identify');
    expect(trackedEvent.faultType).toBeUndefined();
    expect(trackedEvent.errorMessage).toBe('boom');
  });

  it('records the error message with paths masked on failure', async () => {
    const event = buildLogEvent({ crash: true, path: 'dir/missing.log' });
    await withLogTrace(event, () => {
      throw new Error('分析目录：E:\\tmp\\faults 失败：文件不存在');
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(measurement.success).toBe(false);
    expect(trackedEvent.errorMessage).toBe('分析目录：*** 失败：文件不存在');
  });

  it('classifies hilog stream failures as out_of_scope via the carried verdict', async () => {
    const logPath = makeTempLog(
      [
        '09-01 10:00:00.123  1234  5678 I A0d00/EntryPoint com.example: hello',
        '09-01 10:00:00.124  1234  5678 I A0d00/EntryPoint com.example: world',
        'plain line without timestamp',
        '',
      ].join('\n'),
      'hilog-stream.log'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    await withLogTrace(event, () => analyzeCrashLog({ path: logPath }));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(measurement.success).toBe(false);
    expect(measurement.error_code).toBe('UNRECOGNIZED_LOG');
    expect(trackedEvent.faultType).toBe('out_of_scope');
  });

  it('classifies plain-text failures as unknown via the carried verdict', async () => {
    const logPath = makeTempLog(
      'plain text without faultlog structure\n',
      'plain.txt'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    await withLogTrace(event, () => analyzeCrashLog({ path: logPath }));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(measurement.success).toBe(false);
    expect(measurement.error_code).toBe('UNRECOGNIZED_LOG');
    expect(trackedEvent.faultType).toBe('unknown');
  });

  it('classifies multi-candidate conflicts as ambiguous via the carried verdict', async () => {
    const logPath = makeTempLog(
      [
        '#00 pc 0000000000123456 /system/lib/libxxx.so(func+8)',
        'Tid: 100, Name:thread-a',
        'Tid: 101, Name:thread-b',
        '',
      ].join('\n'),
      'ambiguous.log'
    );
    const event = buildLogEvent({ crash: true, path: 'a.log' });
    await withLogTrace(event, () => analyzeCrashLog({ path: logPath }));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [trackedEvent, measurement] = trackSpy.mock.calls[0] as unknown as [
      LogTraceEvent,
      TrackMeasurement,
    ];
    expect(measurement.success).toBe(false);
    expect(measurement.error_code).toBe('UNRECOGNIZED_LOG');
    expect(trackedEvent.faultType).toBe('ambiguous');
  });
});
