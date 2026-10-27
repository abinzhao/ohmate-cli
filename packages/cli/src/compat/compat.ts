/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { InvalidArgumentError } from 'commander';
import * as path from 'path';
import * as os from 'os';
import { Project } from '../utils/project.js';
import { projectSkillChecker } from '../skills/index.js';
import { CommonUtils } from '../utils/common-utils.js';
import {
  readdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
  copyFileSync,
  writeFileSync,
} from 'fs';
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { cyan, yellow } from 'colorette';
import { debugLog } from '../utils/logger.js';
import ora from 'ora';
import { telemetry, EventType } from '../trace/index.js';
import type { CheckCommand, TrackMeasurement } from '../trace/index.js';
import { readProcessRss, formatBytesMb } from '../utils/process-rss.js';

class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function deriveCompatErrorCode(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return error instanceof ValidationError
    ? (error as ValidationError).code
    : (e.code ?? e.name ?? 'UnknownError');
}

async function trackCompat(
  start: number,
  success: boolean,
  errorCode: string | null,
  cmdArgs: string[]
): Promise<void> {
  const rssKb = await readProcessRss(process.pid);
  const mcpMemory =
    rssKb !== null ? formatBytesMb(Number(rssKb) * 1024) : 'unknown';
  const event: CheckCommand = {
    event: EventType.CheckCommand,
    args: cmdArgs,
    mcpMemory,
    lspMemory: 'unknown',
  };
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(event, measurement).catch(() => {});
}

const FORMAT_VALUES = ['default', 'csv', 'json'] as const;
type FormatValue = (typeof FORMAT_VALUES)[number];

const VERSIONS_FORMAT_VALUES = ['default', 'json'] as const;

/**
 * 升序排序 SDK 版本号。版本号形式 `*_X.Y.Z(N)_<suffix>`
 */
function sortVersions(versions: string[]): string[] {
  return [...versions].sort((left, right) => {
    const leftParsed = parseSdkVersion(left);
    const rightParsed = parseSdkVersion(right);
    return (
      leftParsed.apiVersion - rightParsed.apiVersion ||
      leftParsed.suffix.localeCompare(rightParsed.suffix)
    );
  });
}

function parseSdkVersion(version: string): {
  apiVersion: number;
  suffix: string;
} {
  const parenMatch = version.match(/\((\d+)\)/);
  const apiVersion = parenMatch ? Number(parenMatch[1]) : 0;
  const lastUnderscore = version.lastIndexOf('_');
  const suffix =
    lastUnderscore >= 0 ? version.slice(lastUnderscore + 1) : version;
  return { apiVersion, suffix };
}

/**
 * 读取可用 SDK 版本列表。
 */
function listApiChangeVersions(apiChangeDir: string): string[] {
  const entries = readdirSync(apiChangeDir, { withFileTypes: true });
  const versions = entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
    )
    .map((entry) => entry.name.slice(0, -'.json'.length));
  return sortVersions(versions);
}



/**
 * `compat versions` 入口。
 */
async function handleVersionsCommand(format?: string): Promise<void> {
  format = format === undefined ? 'default' : format;
  if (!VERSIONS_FORMAT_VALUES.some((value) => value === format)) {
    throw new Error(`--format must be ${VERSIONS_FORMAT_VALUES.join(' or ')}. got "${format}"`);
  }
  const start = Date.now();
  const cmdArgs = ['check', 'compat', 'versions'];
  try {
    const toolProvider = await ToolProvider.new();
    const { apiChangeDir } = toolProvider.getApiscanPaths();
    debugLog(cyan(`[compat:versions] apiChangeDir: "${apiChangeDir}"`));

    const versions = listApiChangeVersions(apiChangeDir);

    if (format === 'json') {
      console.log(JSON.stringify({ versions, count: versions.length }, null, 2));
    } else {
      if (versions.length === 0) {
        console.log('No SDK versions available.');
        await trackCompat(start, true, null, cmdArgs);
        return;
      }
      console.log(versions.join('\n'));
    }
    await trackCompat(start, true, null, cmdArgs);
  } catch (error) {
    const errorCode = deriveCompatErrorCode(error);
    await trackCompat(start, false, errorCode, cmdArgs);
    throw error;
  }
}

interface CheckOptions {
  sourceVersion?: string;
  targetVersion?: string;
  modules?: string[];
  format: FormatValue;
  outputPath?: string;
  limit: number;
}

/**
 * CSV 报告中的一行变更记录。
 */
interface ApiChangeRecord {
  apiDefinition: string;
  language: string;
  changeId: string;
  changedInSdk: string;
  affectedVersions: string;
  title: string;
  codeLocation: string;
  changeType: string;
}

/**
 * 文件级扫描支持的后缀白名单。
 */
const SUPPORTED_FILE_EXTS = new Set(['.ets', '.c', '.cpp']);

/**
 * 校验模块名是否存在。
 */
function validateModulesExist(project: Project, modules: string[]): void {
  const known = new Set(project.profile.modules.map((m) => m.name));
  const missing = modules.filter((m) => !known.has(m));
  if (missing.length === 0) {
    return;
  }
  const knownList = project.profile.modules.map((m) => m.name).join(', ');
  const verb = missing.length > 1 ? 'are' : 'is';
  throw new ValidationError(
    'errorCode',
    `Module ${missing.map((m) => `"${m}"`).join(', ')} ${verb} not defined in ` +
      `build-profile.json5. Available modules: ${knownList}.`
  );
}

/**
 * 校验文件是否存在且后缀合法。
 */
function validateFiles(files: string[]): void {
  for (const raw of files) {
    const f = path.resolve(raw);
    if (!existsSync(f)) {
      throw new ValidationError('errorCode', `File "${raw}" does not exist.`);
    }
    const ext = path.extname(f).toLowerCase();
    if (!SUPPORTED_FILE_EXTS.has(ext)) {
      const supportedList = Array.from(SUPPORTED_FILE_EXTS).join(', ');
      throw new ValidationError(
        'errorCode',
        `Unsupported file extension "${ext}" for "${raw}". ` +
          `Supported: ${supportedList}.`
      );
    }
  }
}

/**
 * 按后缀拆分文件为 arkTs / cpp 两组。
 */
function splitFilesByKind(files: string[]): {
  arkTs: string[];
  cpp: string[];
} {
  const arkTs: string[] = [];
  const cpp: string[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.ets') {
      arkTs.push(f);
    } else {
      cpp.push(f);
    }
  }
  return { arkTs, cpp };
}

/**
 * 解析 RFC4180 风格 CSV：双引号包裹字段，内部 `""` 表示字面 `"`。
 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      ({ field, inQuotes, i } = stepQuotedChar(text, i, ch, field, inQuotes));
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      current.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

/**
 * 在引号段内推进一个字符。
 */
function stepQuotedChar(
  text: string,
  index: number,
  ch: string,
  field: string,
  inQuotes: boolean
): { field: string; inQuotes: boolean; i: number } {
  if (ch !== '"') {
    return { field: field + ch, inQuotes, i: index + 1 };
  }
  if (text[index + 1] === '"') {
    return { field: field + '"', inQuotes, i: index + 2 };
  }
  return { field, inQuotes: false, i: index + 1 };
}

/**
 * 表头和行转为 ApiChangeRecord 数组。
 */
function rowsToRecords(header: string[], rows: string[][]): ApiChangeRecord[] {
  return rows.map((cols) => {
    const get = (name: string): string => {
      const idx = header.indexOf(name);
      return idx >= 0 && idx < cols.length ? cols[idx] : '';
    };
    return {
      apiDefinition: get('Api Definition'),
      language: get('Language'),
      changeId: get('ChangeId'),
      changedInSdk: get('Changed in SDK'),
      affectedVersions: get('Affected Versions'),
      title: get('Title'),
      codeLocation: get('Code Location'),
      changeType: get('Change Type'),
    };
  });
}

/**
 * 解析 API 变更 CSV 报告。
 */
function parseApiChangeCsv(csvPath: string): ApiChangeRecord[] {
  const raw = readFileSync(csvPath, 'utf8');
  // 去掉 UTF-8 BOM（如果存在）
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;

  const rows = parseCsvText(text);
  if (rows.length < 2) {
    return [];
  }
  const [header, ...dataRows] = rows;
  return rowsToRecords(header, dataRows);
}

/**
 * 从工具输出中按 `CSV saved to:` 关键字解析结果文件路径。
 */
function extractCsvPathFromOutput(
  stdout: string,
  outputDir: string
): string | null {
  const m = stdout.match(/CSV saved to:\s*([^\r\n]+\.csv)/);
  if (!m) {
    return null;
  }
  const raw = m[1].trim();
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const resolved = path.join(outputDir, raw);
  return CommonUtils.ensurePathWithinRoot(outputDir, resolved);
}

/**
 * 打印扫描汇总信息（按 Change Type 分组统计）。
 */
function printSummary(
  records: ApiChangeRecord[],
  csvPath: string | null
): void {
  const counts = new Map<string, number>();
  for (const r of records) {
    const t = r.changeType || '(unknown)';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const groups = Array.from(counts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const labelWidth = Math.max(5, ...groups.map(([t]) => t.length));
  console.log(cyan('API change scan summary:'));
  console.log(`  ${'Total'.padEnd(labelWidth)}  ${records.length}`);
  for (const [type, count] of groups) {
    console.log(`  ${type.padEnd(labelWidth)}  ${count}`);
  }
  if (csvPath) {
    console.log(`  ${'Report'.padEnd(labelWidth)}  ${csvPath}`);
  }
}

/**
 * 打印 text 格式的明细。
 */
function printDetailsText(records: ApiChangeRecord[], limit: number): void {
  console.log();
  if (records.length === 0) {
    console.log('No API changes detected.');
    return;
  }

  const shown = records.slice(0, limit);
  const hidden = records.length - shown.length;
  console.log(
    cyan(
      `Details (showing ${shown.length}${hidden > 0 ? ` of ${records.length}` : ''}):`
    )
  );

  const fields: ReadonlyArray<readonly [string, keyof ApiChangeRecord]> = [
    ['Title', 'title'],
    ['Language', 'language'],
    ['ChangeId', 'changeId'],
    ['Changed in', 'changedInSdk'],
    ['Affected Versions', 'affectedVersions'],
    ['Code Location', 'codeLocation'],
  ];
  const labelWidth = Math.max(...fields.map(([label]) => label.length));
  const display = (raw: string): string => raw || '<unknown>';

  for (const r of shown) {
    console.log(`  [${display(r.changeType)}] ${display(r.apiDefinition)}`);
    for (const [label, key] of fields) {
      console.log(`    ${label.padEnd(labelWidth)}  ${display(r[key])}`);
    }
  }

  if (hidden > 0) {
    console.log(
      yellow(
        `  ... and ${hidden} more. you can re-run with --output-path <dir> to save the full report.`
      )
    );
  }
}

/**
 * 打印 json 格式的明细。
 */
function printDetailsJson(records: ApiChangeRecord[], limit: number): void {
  const shown = records.slice(0, limit);
  const hidden = records.length - shown.length;
  console.log();
  console.log(
    JSON.stringify({ records: shown, count: records.length }, null, 2)
  );
  if (hidden > 0) {
    console.log(
      yellow(
        `... and ${hidden} more. you can re-run with --output-path <dir> to save the full report.`
      )
    );
  }
}

/**
 * 把模块名解析为绝对路径。
 */
function resolveModulePaths(project: Project, moduleNames: string[]): string[] {
  const result: string[] = [];
  for (const name of moduleNames) {
    const mod = project.profile.modules.find((m) => m.name === name);
    if (!mod) {
      // 理论上 `validateModulesExist` 已经拦过，这里再兜底一次
      throw new ValidationError(
        'errorCode',
        `Module "${name}" not found in build-profile.json5.`
      );
    }
    result.push(path.resolve(project.rootDir, mod.srcPath));
  }
  return result;
}

/**
 * 构造扫描工具参数。
 */
function buildToolArgs(
  scriptPath: string,
  files: string[],
  project: Project,
  options: CheckOptions
): string[] {
  if (!options.sourceVersion || !options.targetVersion) {
    throw new ValidationError(
      'errorCode',
      'source-version and target-version are required.'
    );
  }
  const args: string[] = [
    scriptPath,
    '--startVersion',
    options.sourceVersion,
    '--endVersion',
    options.targetVersion,
  ];

  if (files.length > 0) {
    const { arkTs, cpp } = splitFilesByKind(files);
    const toAbs = (f: string) => path.resolve(process.cwd(), f);
    const arkTsAbs = arkTs.map(toAbs);
    const cppAbs = cpp.map(toAbs);
    if (arkTsAbs.length > 0) {
      args.push('--arkTsFiles', arkTsAbs.join(','));
    }
    if (cppAbs.length > 0) {
      args.push('--cppFiles', cppAbs.join(','));
    }
  } else if (options.modules && options.modules.length > 0) {
    const modulePaths = resolveModulePaths(project, options.modules);
    args.push('--modulePaths', modulePaths.join(','));
  } else {
    args.push('--projectPath', project.rootDir);
  }
  args.push('--outputPath', os.tmpdir());
  return args;
}

/**
 * 执行兼容性扫描工具。
 */
async function runScanTool(
  toolProvider: ToolProvider,
  args: string[]
): Promise<string> {
  const cwd = path.dirname(args[0]);
  try {
    const result = await execa(toolProvider.nodePath, args, {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const stdout = result.stdout;
    if (process.env.DEVECO_CLI_DEBUG) {
      console.log(cyan('[compat:check] === scan stdout ==='));
      process.stdout.write(stdout);
      if (!stdout.endsWith('\n')) {
        process.stdout.write('\n');
      }
      console.log(cyan('[compat:check] === end stdout ==='));
    }
    return stdout;
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    if (process.env.DEVECO_CLI_DEBUG && e.stdout) {
      console.log(cyan('[compat:check] === scan stdout (on error) ==='));
      process.stdout.write(e.stdout);
      if (!e.stdout.endsWith('\n')) {
        process.stdout.write('\n');
      }
      console.log(cyan('[compat:check] === end stdout ==='));
    }
    const message = new ValidationError(
      'errorCode',
      `Compatibility scan failed: ${e.message}` +
        (e.stderr ? `\n${e.stderr}` : '')
    );
    if (e.stdout) {
      (message as Error & { stdout?: string }).stdout = e.stdout;
    }
    throw message;
  }
}

/**
 * 校验必需参数和互斥关系。
 */
function validateCheckOptions(files: string[], options: CheckOptions): void {
  if (!FORMAT_VALUES.includes(options.format)) {
    throw new InvalidArgumentError(
      `--format must be default, csv, or json (console: default|json, file: default|csv|json). got "${options.format}"`
    );
  }
  if (files.length > 0 && options.modules && options.modules.length > 0) {
    throw new ValidationError(
      'errorCode',
      'Cannot use `--modules` together with file arguments. ' +
        'Use either file-level scanning (with files) or module-level scanning (with --modules).'
    );
  }
  if (!options.sourceVersion) {
    throw new ValidationError('errorCode', '--source-version is required.');
  }
  if (!options.targetVersion) {
    throw new ValidationError('errorCode', '--target-version is required.');
  }
  if (!options.outputPath && options.format === 'csv') {
    throw new ValidationError(
      'errorCode',
      '--format csv requires --output-path. ' +
        'For console output, use --format json or --format default (or omit the flag).'
    );
  }
}

/**
 * 校验版本号是否有效且顺序正确。
 */
function validateVersionsInCatalog(
  options: CheckOptions,
  availableVersions: string[]
): void {
  const missing: string[] = [];
  if (
    options.sourceVersion &&
    !availableVersions.includes(options.sourceVersion)
  ) {
    missing.push(`--source-version "${options.sourceVersion}"`);
  }
  if (
    options.targetVersion &&
    !availableVersions.includes(options.targetVersion)
  ) {
    missing.push(`--target-version "${options.targetVersion}"`);
  }
  if (missing.length > 0) {
    const verb = missing.length > 1 ? 'are' : 'is';
    throw new ValidationError(
      'errorCode',
      `${missing.join(' and ')} ${verb} not in the available SDK version list.\n` +
        `Run \`devecocli compat versions\` to see all available versions.`
    );
  }

  if (options.sourceVersion && options.targetVersion) {
    const sourceIdx = availableVersions.indexOf(options.sourceVersion);
    const targetIdx = availableVersions.indexOf(options.targetVersion);
    if (sourceIdx >= targetIdx) {
      throw new ValidationError(
        'errorCode',
        `--target-version "${options.targetVersion}" must be later than ` +
          `--source-version "${options.sourceVersion}". ` +
          `Run \`devecocli compat versions\` to see the available order.`
      );
    }
  }
}

/**
 * 按格式输出扫描结果。
 */
function outputRecords(
  records: ApiChangeRecord[],
  csvPath: string | null,
  format: FormatValue,
  limit: number,
  outputTargetKind: 'file' | 'dir' | 'none'
): void {
  // 1. 明细段：仅在没传 --output-path 时打印（否则明细已经在文件里）
  if (outputTargetKind === 'none') {
    if (format === 'json') {
      printDetailsJson(records, limit);
    } else {
      printDetailsText(records, limit);
    }
  }

  // 2. 汇总段：所有组合都统一格式
  printSummary(records, csvPath);
}

/**
 * 打印可手动复跑的命令行。
 */
function debugLogRunnableCommand(scriptPath: string, args: string[]): void {
  const scriptDir = path.dirname(scriptPath);
  const scriptBase = path.basename(scriptPath);
  const relArgs = args
    .slice(1)
    .map((a) => (a.startsWith('--') ? a : `"${a}"`))
    .join(' ');
  debugLog(
    cyan(
      `[compat:check] command: cd "${scriptDir}" && node "${scriptBase}" ${relArgs}`
    )
  );
}

/**
 * 删除临时报告文件。
 */
function cleanupTmpReport(csvPath: string): void {
  try {
    unlinkSync(csvPath);
    debugLog(cyan(`[compat:check] cleaned up tmp report: "${csvPath}"`));
  } catch (err) {
    debugLog(
      cyan(
        `[compat:check] failed to clean up tmp report: ${(err as Error).message}`
      )
    );
  }
}

/**
 * 文件输出支持的扩展名。
 */
const FILE_OUTPUT_EXTS = ['.csv', '.json'] as const;
type FileOutputExt = (typeof FILE_OUTPUT_EXTS)[number];

function isFileOutputExt(ext: string): ext is FileOutputExt {
  return (FILE_OUTPUT_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * 输出目标类型。
 */
type OutputTarget =
  | { kind: 'file'; filePath: string; ext: FileOutputExt }
  | { kind: 'dir'; dirPath: string }
  | { kind: 'none' };

/**
 * 解析输出目标类型，同时校验 format 与 outputPath 的组合。
 */
function resolveOutputTarget(
  outputPath: string | undefined,
  format: FormatValue
): OutputTarget {
  if (!outputPath) {
    return { kind: 'none' };
  }

  const ext = path.extname(outputPath).toLowerCase();
  if (!isFileOutputExt(ext)) {
    return { kind: 'dir', dirPath: path.resolve(outputPath) };
  }

  const isCsvFormat = format === 'default' || format === 'csv';
  if (
    (ext === '.csv' && !isCsvFormat) ||
    (ext === '.json' && format !== 'json')
  ) {
    throw new ValidationError(
      'errorCode',
      `The --output-path file extension '${ext}' does not match --format ${format}. ` +
        `Use --format ${ext === '.json' ? 'json' : 'default'}, or rename the file.`
    );
  }
  return { kind: 'file', filePath: path.resolve(outputPath), ext };
}

/**
 * 校验输出目标是否可写。
 */
function validateOutputTarget(target: OutputTarget): void {
  if (target.kind === 'file') {
    if (existsSync(target.filePath)) {
      throw new ValidationError(
        'errorCode',
        `Target file "${target.filePath}" already exists. ` +
          `Remove it first, or choose a different --output-path.`
      );
    }
    const parentDir = path.dirname(target.filePath);
    if (!existsSync(parentDir)) {
      throw new ValidationError(
        'errorCode',
        `Target directory "${parentDir}" does not exist. ` +
          `Create it first, or choose a different --output-path.`
      );
    }
  } else if (target.kind === 'dir') {
    if (!existsSync(target.dirPath)) {
      throw new ValidationError(
        'errorCode',
        `Target directory "${target.dirPath}" does not exist. ` +
          `Create it first, or choose a different --output-path.`
      );
    }
  }
}

/**
 * 序列化记录为 JSON 报告文本（count + records,2 空格缩进,末尾换行）。
 */
function buildJsonReport(records: ApiChangeRecord[]): string {
  return (
    JSON.stringify({ records, count: records.length }, null, 2) + '\n'
  );
}

/**
 * 写入报告文件。
 */
function writeReportFile(
  tmpCsvPath: string,
  records: ApiChangeRecord[],
  filePath: string,
  ext: FileOutputExt
): void {
  if (ext === '.csv') {
    copyFileSync(tmpCsvPath, filePath);
  } else {
    writeFileSync(filePath, buildJsonReport(records), 'utf8');
  }
  debugLog(cyan(`[compat:check] saved report: "${filePath}"`));
}

/**
 * 复制报告到用户指定目录,按 format 决定写 .csv 还是 .json。
 */
function persistReportToDir(
  tmpCsvPath: string,
  records: ApiChangeRecord[],
  userOutputDir: string,
  format: FormatValue
): string {
  if (format === 'json') {
    const baseName = path.basename(tmpCsvPath, '.csv');
    const jsonPath = path.join(userOutputDir, `${baseName}.json`);
    writeFileSync(jsonPath, buildJsonReport(records), 'utf8');
    debugLog(cyan(`[compat:check] saved report: "${jsonPath}"`));
    return jsonPath;
  }
  const destPath = path.join(userOutputDir, path.basename(tmpCsvPath));
  copyFileSync(tmpCsvPath, destPath);
  debugLog(cyan(`[compat:check] saved report: "${destPath}"`));
  return destPath;
}

/**
 * 执行 hvigor compileNative 生成 native 产物。
 */
async function runHvigorCompileNative(
  toolProvider: ToolProvider,
  options: CheckOptions
): Promise<void> {
  const hvigor = new HvigorAdapter(toolProvider, process.cwd(), true);
  const compileModule =
    options.modules && options.modules.length > 0
      ? options.modules[0]
      : undefined;
  try {
    await hvigor.compileNative('default', compileModule);
  } catch (cause) {
    throw new ValidationError(
      'errorCode',
      `hvigorw compileNative failed (module=${compileModule ?? '<project>'}): ` +
        (cause as Error).message,
      { cause }
    );
  }
}

/**
 * 校验参数并返回运行时上下文。
 */
async function prepareCheckContext(files: string[], options: CheckOptions) {
  validateCheckOptions(files, options);

  const project = Project.discover(process.cwd());
  await projectSkillChecker.warnInvalidBundledLinks(project.rootDir);
  if (options.modules && options.modules.length > 0) {
    validateModulesExist(project, options.modules);
  }
  if (files.length > 0) {
    validateFiles(files);
  }

  const toolProvider = await ToolProvider.new();
  const { apiChangeDir, scriptPath } = toolProvider.getApiscanPaths();
  debugLog(cyan(`[compat:check] script: "${scriptPath}"`));

  const availableVersions = listApiChangeVersions(apiChangeDir);
  validateVersionsInCatalog(options, availableVersions);

  if (options.outputPath) {
    debugLog(cyan(`[compat:check] outputPath: "${options.outputPath}"`));
  }

  const target = resolveOutputTarget(options.outputPath, options.format);
  debugLog(cyan(`[compat:check] outputTarget: ${target.kind}`));
  validateOutputTarget(target);

  return { project, scriptPath, target, toolProvider };
}

/**
 * `compat` 命令入口。
 */
function writeScanOutput(
  tmpCsvPath: string,
  records: ApiChangeRecord[],
  target: OutputTarget,
  format: FormatValue
): string | null {
  if (target.kind === 'file') {
    writeReportFile(tmpCsvPath, records, target.filePath, target.ext);
    return target.filePath;
  }
  if (target.kind === 'dir') {
    return persistReportToDir(tmpCsvPath, records, target.dirPath, format);
  }
  if (target.kind === 'none') {
    return null;
  }
  throw new ValidationError(
    'errorCode',
    `Unexpected output target kind: ${(target as { kind: string }).kind}`
  );
}

async function runCheckAndReport(
  ctx: Awaited<ReturnType<typeof prepareCheckContext>>,
  files: string[],
  options: CheckOptions,
  start: number,
  cmdArgs: string[]
): Promise<void> {
  const spinner = ora({
    text: 'Running compatibility check...',
    color: 'cyan',
  }).start();
  try {
    await runHvigorCompileNative(ctx.toolProvider, options);

    const args = buildToolArgs(ctx.scriptPath, files, ctx.project, options);
    debugLogRunnableCommand(ctx.scriptPath, args);
    const stdout = await runScanTool(ctx.toolProvider, args);

    const tmpCsvPath = extractCsvPathFromOutput(stdout, os.tmpdir());
    if (!tmpCsvPath) {
      throw new ValidationError(
        'errorCode',
        'Scanner output format unexpected: missing report path.'
      );
    }
    debugLog(cyan(`[compat:check] tmp csv: "${tmpCsvPath}"`));
    const records = parseApiChangeCsv(tmpCsvPath);

    const finalPath = writeScanOutput(
      tmpCsvPath,
      records,
      ctx.target,
      options.format
    );
    cleanupTmpReport(tmpCsvPath);

    spinner.stop();
    outputRecords(
      records,
      finalPath,
      options.format,
      options.limit,
      ctx.target.kind
    );
    await trackCompat(start, true, null, cmdArgs);
  } catch (error) {
    spinner.fail('Compatibility check failed');
    const errorCode = deriveCompatErrorCode(error);
    await trackCompat(start, false, errorCode, cmdArgs);
    throw error;
  }
}

async function handleCheckCommand(
  files: string[],
  options: CheckOptions
): Promise<void> {
  const start = Date.now();
  const cmdArgs = ['check', 'compat'];
  try {
    const ctx = await prepareCheckContext(files, options);
    await runCheckAndReport(ctx, files, options, start, cmdArgs);
  } catch (error) {
    const errorCode = deriveCompatErrorCode(error);
    await trackCompat(start, false, errorCode, cmdArgs);
    throw error;
  }
}

export {
  handleCheckCommand,
  handleVersionsCommand,
};
export type { CheckOptions };
