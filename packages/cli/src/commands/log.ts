/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import { Command, InvalidArgumentError } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { CommonUtils } from '../utils/common-utils.js';
import { cyan, red } from 'colorette';
import ora from 'ora';
import { debugLog } from '../utils/logger.js';
import {
  analyzeCrashLog,
  analyzeFaultLogDirectory,
  analyzeSampleStack,
  extractCrashHilog,
  FaultLogError,
  isFaultLogFamily,
  renderCrashReport,
  renderSampleStackReport,
  type CrashAnalysisResult,
  type SampleStackAnalysisResult,
} from '../faultlog/index.js';
import {
  telemetry,
  EventType,
  type LogTraceEvent,
  type TrackMeasurement,
  TraceError,
} from '../trace/index.js';

interface LogOptions {
  device?: string;
  crash?: boolean;
  stack?: boolean;
  path?: string;
  format?: string;
  limit?: number;
  level?: string;
  bundleName?: string;
  keyword?: string;
  follow?: boolean;
  tail?: number;
  from?: number;
  to?: number;
}

const STACK_FORMATS: ReadonlySet<string> = new Set(['default', 'json', 'report']);
const CRASH_FORMATS: ReadonlySet<string> = new Set(['default', 'json', 'report', 'hilog']);
const DEFAULT_STACK_LIMIT = 20;

function buildLogArgs(options: LogOptions): string[] {
  return [
    'log',
    ...(options.device ? ['--device'] : []),
    ...(options.crash ? ['--crash'] : []),
    ...(options.stack ? ['--stack'] : []),
    ...(options.path ? ['--path'] : []),
    ...(options.format ? ['--format'] : []),
    ...(options.limit !== undefined ? ['--limit'] : []),
    ...(options.level ? ['--level'] : []),
    ...(options.bundleName ? ['--bundle-name'] : []),
    ...(options.keyword ? ['--keyword'] : []),
    ...(options.tail !== undefined ? ['--tail'] : []),
    ...(options.from !== undefined ? ['--from'] : []),
    ...(options.to !== undefined ? ['--to'] : []),
    ...(options.follow ? ['--follow'] : []),
  ];
}

function buildLogEvent(options: LogOptions): LogTraceEvent {
  return {
    event: EventType.CommandExecuted,
    args: buildLogArgs(options),
    operation: options.path !== undefined ? 'local_identify' : options.crash ? 'faultlogger_report' : 'hilog',
    logType: options.stack ? 'stack' : options.crash ? 'crash' : 'common',
    bundleName: options.bundleName ?? 'ALL',
  };
}

function resolveLogErrorCode(error: unknown): string {
  if (error instanceof TraceError) {
    return error.traceMessage;
  }
  if (error instanceof Error) {
    return (error as NodeJS.ErrnoException).code ?? error.name;
  }
  return 'UnknownError';
}

type LogHandlerResult = CrashAnalysisResult | SampleStackAnalysisResult | undefined;

/** 分类漏斗推导（依据 classify.ts 裁决语义：out_of_scope 非空 / unknown+候选非空 / unknown 无候选 / 三族命中）。 */
function deriveClassification(
  identify: CrashAnalysisResult['identify']
): 'identified' | 'unknown' | 'out_of_scope' | 'ambiguous' {
  if (identify.out_of_scope !== undefined) {
    return 'out_of_scope';
  }
  if (identify.type === 'unknown') {
    return identify.candidates.length > 0 ? 'ambiguous' : 'unknown';
  }
  return 'identified';
}

/** 目录模式优先取选中候选日志文件，文件模式取 source.path，供读取日志内容。 */
function resolvePrimaryLogPath(result: CrashAnalysisResult | SampleStackAnalysisResult): string {
  const source = result.source;
  const candidatePath = 'candidates' in source ? source.candidates?.[0]?.path : undefined;
  return candidatePath ?? source.path;
}

/** 从故障日志头部读取 Module name（日志中标注的应用模块名）；文件不可读或未命中返回 undefined。 */
function readModuleNameFromLog(logPath: string): string | undefined {
  const HEADER_BYTES = 2048;
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
      const match = /(?:^|\n)\s*Module name:\s*([^\r\n]+)/.exec(buffer.toString('utf-8', 0, bytesRead));
      const moduleName = match !== null ? match[1].trim() : '';
      return moduleName !== '' ? moduleName : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** 失败消息中的路径类内容掩码：仅保留扩展名（如 E:\a\b\c.log → ***.log），避免泄漏用户路径；前后为空白的独立 / 或 \ 是文本分隔符而非路径，不掩码。 */
function maskPathsInMessage(message: string): string {
  return message.replace(/[^\s：，,]*[\\/][^\s]*/g, (token) => {
    if (token === '/' || token === '\\') {
      return token;
    }
    const ext = token.slice(token.lastIndexOf('.') + 1);
    return /^[A-Za-z0-9]{1,10}$/.test(ext) ? `***.${ext}` : '***';
  });
}

/** 从解析结果提取识别元数据写入打点事件（成功取解析结果、失败取 FaultLogError 携带的判定推导 faultType；bundleName 回填为日志中的 Module name；错误 message 由 withLogTrace 记录并掩码）。 */
function applyIdentifyMeta<T extends LogTraceEvent>(
  event: T,
  result?: CrashAnalysisResult | SampleStackAnalysisResult,
  faultError?: FaultLogError
): T {
  const identify = faultError?.verdict ?? result?.identify;
  if (identify === undefined) {
    return event;
  }
  const classification = deriveClassification(identify);
  if (isFaultLogFamily(identify.type)) {
    event.faultType = identify.type;
  } else if (classification !== 'identified') {
    event.faultType = classification;
  }
  if (result !== undefined) {
    const moduleName = readModuleNameFromLog(resolvePrimaryLogPath(result));
    if (moduleName !== undefined) {
      event.bundleName = moduleName;
    }
  }
  return event;
}

async function withLogTrace(
  event: LogTraceEvent,
  action: () => Promise<LogHandlerResult> | LogHandlerResult
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  let errorMessage: string | undefined;
  let result: LogHandlerResult = undefined;
  let faultError: FaultLogError | undefined;
  try {
    result = await action();
  } catch (error) {
    success = false;
    errorCode = resolveLogErrorCode(error);
    errorMessage = (error as Error).message;
    if (error instanceof FaultLogError) {
      faultError = error;
    }
    console.error(red((error as Error).message));
    process.exitCode = 1;
  } finally {
    applyIdentifyMeta(event, result, faultError);
    event.errorMessage = errorMessage === undefined ? undefined : maskPathsInMessage(errorMessage);
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement).catch(() => {});
  }
}

function parsePositiveInt(value: string): number {
  try {
    return CommonUtils.parsePositiveInteger(value, 'tail');
  } catch {
    throw new InvalidArgumentError('`tail` must be a positive integer.');
  }
}

function parseLimit(value: string): number {
  try {
    return CommonUtils.parsePositiveInteger(value, 'limit');
  } catch {
    throw new InvalidArgumentError('`limit` must be a positive integer.');
  }
}

function parseFormat(value: string): string {
  if (!CRASH_FORMATS.has(value)) {
    throw new InvalidArgumentError(
      '`--format` must be one of: default, json, report, hilog.'
    );
  }
  return value;
}

function parseDuration(value: string, fieldName: string): number {
  try {
    return CommonUtils.parseDurationToSeconds(value, fieldName);
  } catch {
    throw new InvalidArgumentError(
      `${fieldName} must be a valid duration string (e.g.,30s, 5m or 2.5m).Supported units: s and m.when specified in seconds(with \`s\` or as a raw number), the value must be an integer.`
    );
  }
}

function parseHilogLevel(value: string): string {
  try {
    CommonUtils.assertHilogLevel(value);
    return value;
  } catch {
    throw new InvalidArgumentError('`level` must be one of: D, I, W, E, F.');
  }
}

function parseBundleName(value: string): string {
  try {
    CommonUtils.assertBundleNameStrict(value);
    return value;
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

function validateLogTimeRange(options: LogOptions): void {
  if (options.to && options.follow) {
    throw new FaultLogError('INVALID_ARGUMENTS', '`--to` cannot be used with `--follow`.');
  }
}

/** 本地故障日志分析（--path 模式）的旗标组合校验，错误信息为英文。 */
function validateLocalModeOptions(options: LogOptions): void {
  if (options.stack === true && options.crash === true) {
    throw new FaultLogError('INVALID_ARGUMENTS', '`--stack` cannot be used with `--crash`.');
  }
  if (options.stack === true && options.path === undefined) {
    throw new FaultLogError('INVALID_ARGUMENTS', '`--stack` requires a local sample stack file (use --path).');
  }
  if (options.path !== undefined && options.crash !== true && options.stack !== true) {
    throw new FaultLogError('INVALID_ARGUMENTS', '`--path` requires `--crash` or `--stack`.');
  }
  if (options.limit !== undefined && options.stack !== true) {
    throw new FaultLogError('INVALID_ARGUMENTS', '`--limit` is only valid with `--stack`.');
  }
  if (options.format !== undefined) {
    if (options.crash !== true && options.stack !== true) {
      throw new FaultLogError('INVALID_ARGUMENTS', '`--format` is only valid with `--crash` or `--stack`.');
    }
    if (options.path === undefined) {
      throw new FaultLogError('INVALID_ARGUMENTS', '`--format` requires a local fault log (use --path).');
    }
    if (options.stack === true && !STACK_FORMATS.has(options.format)) {
      throw new FaultLogError('INVALID_ARGUMENTS', '`--format` must be one of: default, json, report.');
    }
  }
}

function rejectDeviceStreamOptions(options: LogOptions): void {
  const conflicts: string[] = [];
  if (options.device !== undefined) {
    conflicts.push('--device');
  }
  if (options.level !== undefined) {
    conflicts.push('--level');
  }
  if (options.bundleName !== undefined) {
    conflicts.push('--bundle-name');
  }
  if (options.keyword !== undefined) {
    conflicts.push('--keyword');
  }
  if (options.follow === true) {
    conflicts.push('--follow');
  }
  if (options.tail !== undefined) {
    conflicts.push('--tail');
  }
  if (options.from !== undefined) {
    conflicts.push('--from');
  }
  if (options.to !== undefined) {
    conflicts.push('--to');
  }
  if (conflicts.length > 0) {
    throw new FaultLogError(
      'INVALID_ARGUMENTS',
      `\`--path\` cannot be combined with device log options: ${conflicts.join(', ')}.`
    );
  }
}

function resolvePathKind(targetPath: string): 'file' | 'directory' {
  if (!fs.existsSync(targetPath)) {
    throw new FaultLogError('FILE_NOT_FOUND', `路径不存在：${targetPath}`);
  }
  return fs.statSync(targetPath).isDirectory() ? 'directory' : 'file';
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function handleStackAnalysis(targetPath: string, format: string, limit: number): SampleStackAnalysisResult {
  const kind = resolvePathKind(targetPath);
  if (kind !== 'file') {
    throw new FaultLogError('INVALID_INPUT', `采样栈分析仅支持文件路径，收到目录：${targetPath}`);
  }
  const result = analyzeSampleStack({ path: targetPath }, limit);
  if (format === 'json') {
    printJson(result);
    return result;
  }
  const report = renderSampleStackReport(result);
  if (format === 'report') {
    console.log(report);
    return result;
  }
  console.log(`分析文件：${targetPath}`);
  console.log(report);
  return result;
}

function handleCrashAnalysis(targetPath: string, format: string): CrashAnalysisResult {
  const kind = resolvePathKind(targetPath);
  const result =
    kind === 'directory'
      ? analyzeFaultLogDirectory(targetPath)
      : analyzeCrashLog({ path: targetPath });
  const bestPath =
    kind === 'directory'
      ? result.source.candidates?.[0]?.path ?? targetPath
      : targetPath;
  if (format === 'hilog') {
    console.log(extractCrashHilog({ path: bestPath }));
    return result;
  }
  if (format === 'json') {
    printJson(result);
    return result;
  }
  const report = renderCrashReport(result);
  if (format === 'report') {
    console.log(report);
    return result;
  }
  if (kind === 'directory') {
    console.log(`分析目录：${targetPath}`);
    console.log(`选中日志：${bestPath}`);
  } else {
    console.log(`分析文件：${targetPath}`);
  }
  console.log(report);
  return result;
}

/** --path 模式入口：--stack 走采样栈分析，--crash 走故障日志分析。 */
function handleLocalFaultLog(options: LogOptions): CrashAnalysisResult | SampleStackAnalysisResult {
  rejectDeviceStreamOptions(options);
  const targetPath = options.path ?? '';
  const format = options.format ?? 'default';
  if (options.stack === true) {
    return handleStackAnalysis(targetPath, format, options.limit ?? DEFAULT_STACK_LIMIT);
  }
  return handleCrashAnalysis(targetPath, format);
}

async function fetchLogsByOptions(
  service: HilogAdapter,
  deviceId: string,
  options: LogOptions,
  fromSeconds?: number,
  toSeconds?: number
): Promise<string> {
  return options.crash
    ? await service.getCrashLog(deviceId, options.bundleName)
    : await service.getHilog(deviceId, {
        level: options.level,
        bundleName: options.bundleName,
        keyword: options.keyword,
        isFollow: options.follow ? true : false,
        tail: options.tail,
        fromSeconds,
        toSeconds,
      });
}

function postProcessCrashLogs(
  logs: string,
  options: LogOptions,
  fromSeconds?: number,
  toSeconds?: number
): string {
  const windowFiltered = CommonUtils.filterLogsByRelativeWindow(
    logs,
    fromSeconds,
    toSeconds
  );
  if (!options.tail) {
    return windowFiltered;
  }
  return CommonUtils.getLastLines(windowFiltered, options.tail);
}

const logCommand = new Command('log')
  .description('Obtain device application logs')
  .configureOutput({
    outputError: (str, write) => write(red(str)),
  })
  .option('--device <device>', 'Target device (name or serial)')
  .option('--crash', 'Only obtain crash logs')
  .option('--stack', 'Analyze a local sample stack file (requires --path)')
  .option(
    '--path <path>',
    'Local fault log file or directory to analyze (requires --crash or --stack)'
  )
  .option(
    '--format <format>',
    'Output format: default, json, report (plus hilog with --crash)',
    parseFormat
  )
  .option('--limit <num>', 'Max hotspots shown by --stack', parseLimit)
  .option('--level <level>', 'Log level filter: D, I, W, E, F', parseHilogLevel)
  .option(
    '--bundle-name <bundle-name>',
    'Filter by application bundle name',
    parseBundleName
  )
  .option('--keyword <keyword>', 'Keyword filter')
  .option('--tail <num>', 'Show only the latest N log lines', parsePositiveInt)
  .option(
    '--from <start>',
    'Start offset from now, e.g. 30s, 5m, 2.5m, or 120',
    (value: string) => parseDuration(value, 'from')
  )
  .option(
    '--to <end>',
    'End offset from now, e.g. 30s, 5m, 2.5m, or 120',
    (value: string) => parseDuration(value, 'to')
  )
  .option('--follow', 'Follow the log stream in real-time.')
  .action(async (options: LogOptions) => {
    await withLogTrace(buildLogEvent(options), () => handleLogCommand(options));
  });

async function handleLogCommand(options: LogOptions): Promise<LogHandlerResult> {
  validateLocalModeOptions(options);
  if (options.stack === true || options.path !== undefined) {
    return handleLocalFaultLog(options);
  }
  await handleDeviceLog(options);
  return undefined;
}

async function handleDeviceLog(options: LogOptions): Promise<void> {
  const spinner = ora({
    text: 'Preparing log request…',
    color: 'cyan',
  });
  const stopAndClearSpinner = () => {
    spinner.stop();
    spinner.clear();
  };
  spinner.start();
  try {
    validateLogTimeRange(options);
    const fromSeconds = options.from;
    const toSeconds = options.to;

    const toolProvider = await ToolProvider.new();
    const service = new HilogAdapter(toolProvider);

    const deviceId = await service.selectDevice(options.device);
    if (!deviceId) {
      throw new TraceError(
        'No active devices found.',
        'No active devices found.'
      );
    }

    debugLog(cyan(`deviceId: ${deviceId}`));
    debugLog(cyan(`type: ${options.crash ? 'Crash logs' : 'Common logs'}`));
    debugLog(cyan('Obtaining logs ...'));

    spinner.text = 'Fetching logs…';
    if (options.follow) {
      stopAndClearSpinner();
    }

    let logs = await fetchLogsByOptions(
      service,
      deviceId,
      options,
      fromSeconds,
      toSeconds
    );
    stopAndClearSpinner();

    if (options.crash && logs) {
      logs = postProcessCrashLogs(logs, options, fromSeconds, toSeconds);
    }

    if (logs) {
      console.log(logs);
    }
  } finally {
    stopAndClearSpinner();
  }
}

export default logCommand;
