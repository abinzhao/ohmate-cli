/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import json5 from 'json5';
import { VENDOR_NAME } from './constants';
import { mcpLog } from './mcp-logger.js';

/** Maximum search depth for finding Harmony project */
const MAX_SEARCH_DEPTH = 3;

/**
 * Check if a path is a Harmony project directory.
 */
export function isHarmonyosProject(dirPath: string): boolean {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false;
  }

  const hasBuildProfile = fs.existsSync(path.join(dirPath, 'build-profile.json5'));
  const hasHvigorfile =
    fs.existsSync(path.join(dirPath, 'hvigorfile.js')) ||
    fs.existsSync(path.join(dirPath, 'hvigorfile.ts'));

  if (!hasBuildProfile || !hasHvigorfile) {
    return false;
  }

  // Verify build-profile.json5 has 'app' field (project-level)
  try {
    const content = fs.readFileSync(path.join(dirPath, 'build-profile.json5'), 'utf-8');
    const profile = json5.parse(content) as { app?: unknown };
    return profile.app !== undefined;
  } catch {
    return false;
  }
}

/**
 * Recursively search subdirectories for a Harmony project (BFS with depth limit).
 */
function searchHarmonyProject(
  currentDir: string,
  depth: number,
  maxDepth: number
): string | null {
  if (depth >= maxDepth) {
    return null;
  }

  const subDirs = collectSubDirs(currentDir);
  const directHit = findDirectHarmonyChild(subDirs);
  if (directHit) {
    return directHit;
  }

  for (const subDir of subDirs) {
    const found = searchHarmonyProject(subDir, depth + 1, maxDepth);
    if (found) {
      return found;
    }
  }
  return null;
}

function collectSubDirs(currentDir: string): string[] {
  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const subDirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subDirs.push(path.join(currentDir, entry.name));
      }
    }
    return subDirs;
  } catch {
    // Ignore permission errors
    return [];
  }
}

function findDirectHarmonyChild(subDirs: string[]): string | null {
  for (const subPath of subDirs) {
    if (isHarmonyosProject(subPath)) {
      return subPath;
    }
  }
  return null;
}

/**
 * Find a Harmony project starting from a given path.
 *
 * @param startPath - The starting path for the search
 * @returns The found project root directory, or null if not found
 */
export function findHarmonyProject(startPath: string): string | null {
  if (!startPath || startPath.trim() === '') {
    return null;
  }

  const resolvedPath = path.resolve(startPath);

  let realResolvedPath: string;
  try {
    realResolvedPath = fs.realpathSync(resolvedPath);
  } catch {
    realResolvedPath = resolvedPath;
  }

  if (!fs.existsSync(realResolvedPath)) {
    return null;
  }

  // 1. Check self
  if (isHarmonyosProject(realResolvedPath)) {
    return realResolvedPath;
  }

  // 2. Check ancestors (up to 3 levels)
  let current = realResolvedPath;
  for (let i = 1; i <= 3; i++) {
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached root
    }
    if (isHarmonyosProject(parent)) {
      return parent;
    }
    current = parent;
  }

  // 3. Check descendants (BFS, depth limit 3)
  if (fs.statSync(realResolvedPath).isDirectory()) {
    const found = searchHarmonyProject(realResolvedPath, 0, MAX_SEARCH_DEPTH);
    if (found) {
      return found;
    }
  }

  return null;
}

/**
 * 从 startPath **向下**查找 Harmony 工程根：自身命中即返回，否则 BFS 子目录（深度上限 MAX_SEARCH_DEPTH）。
 * 不向上搜索祖先目录——避免扫描到指定范围之外的工程（安全考量）。
 * 适用于「未显式指定工程路径、用户主动开启自动发现」的场景。
 */
export function findHarmonyProjectInDir(startPath: string): string | null {
  if (!startPath || startPath.trim() === '') {
    return null;
  }
  const resolvedPath = path.resolve(startPath);
  let realResolvedPath: string;
  try {
    realResolvedPath = fs.realpathSync(resolvedPath);
  } catch {
    realResolvedPath = resolvedPath;
  }
  if (!fs.existsSync(realResolvedPath) || !fs.statSync(realResolvedPath).isDirectory()) {
    return null;
  }
  if (isHarmonyosProject(realResolvedPath)) {
    return realResolvedPath;
  }
  return searchHarmonyProject(realResolvedPath, 0, MAX_SEARCH_DEPTH);
}

/**
 * DevEco Studio 安装目录（Windows / macOS 通用）。
 */
const DEVECO_STUDIO_DIR_NAME = 'DevEco Studio';

/** 在默认安装位置探测 DevEco Studio（ToolProvider 解析失败时的兜底）。 */
export function findDevEcoPath(): string | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join('C:\\Program Files', VENDOR_NAME, DEVECO_STUDIO_DIR_NAME),
      path.join('C:\\Program Files (x86)', VENDOR_NAME, DEVECO_STUDIO_DIR_NAME),
    ];
    return firstExistingPath(candidates);
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/DevEco Studio.app',
      path.join(process.env.HOME ?? '', 'Applications', 'DevEco Studio.app'),
    ];
    return firstExistingPath(candidates);
  }
  return null;
}

function firstExistingPath(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 根据 arkts-lang-server 根目录拼接 server 入口 js 路径。
 * 自动区分两种目录布局：
 * - Studio: `<root>/ace-server/out/(standardIndex/)?index.js`
 * - CLT:    `<root>/out/(standardIndex/)?index.js`
 */
export function resolveArktsServerEntry(
  root: string,
  useStandardProtocol: boolean
): string {
  const entryFile = useStandardProtocol
    ? path.join('standardIndex', 'index.js')
    : 'index.js';

  if (fs.existsSync(path.join(root, 'ace-server'))) {
    return path.join(root, 'ace-server', 'out', entryFile);
  }
  return path.join(root, 'out', entryFile);
}

/**
 * 检测是否支持标准 LSP 协议（standardIndex/index.js 是否存在）。
 * 兼容 Studio 和 CLT 两种目录布局。
 */
export function detectStandardProtocol(root: string): boolean {
  return fs.existsSync(resolveArktsServerEntry(root, true));
}

/** 探测超时：解析到首个完整 JSON 即结束，超时只兜住 server 不认 --list-protocols 的情况。 */
const SOCKET_PROBE_TIMEOUT_MS = 5_000;
/** stdout 累积上限，防 server 刷屏时无界增长。 */
const SOCKET_PROBE_MAX_BYTES = 64 * 1024;
/** 按归一化 root 缓存探测 Promise：同一 root 只 spawn 一次，并发调用共享结果。 */
const socketProbeCache = new Map<string, Promise<boolean>>();

/**
 * 通过 spawn standardIndex/index.js --list-protocols 探测 server 是否支持 socket 传输。
 * - standardIndex/index.js 不存在 → false（老版本 server，只支持 stdio + legacy 协议）
 * - 存在 → 解析 stdout JSON，检查 protocols 是否包含 '--socket'
 * - spawn 失败 / 解析失败 / 超时 → false
 *
 * 异步实现，不阻塞事件循环；结果缓存，同一 root 只探测一次。
 *
 * @param nodeExecutable 调用方用 resolveNodePath 解析出的 node 路径，须与实际 spawn
 *   ace-server 所用的一致，否则探测结论与运行时不符。缺省回退 process.execPath。
 */
export function probeSocketSupport(root: string, nodeExecutable?: string): Promise<boolean> {
  const key = socketProbeCacheKey(root);
  const cached = socketProbeCache.get(key);
  if (cached) {
    return cached;
  }
  const probe = runSocketProbe(root, nodeExecutable).catch(() => false);
  socketProbeCache.set(key, probe);
  return probe;
}

/** 缓存 key 归一化：绝对化 + 统一分隔符 + Windows 下忽略盘符大小写。 */
function socketProbeCacheKey(root: string): string {
  const resolved = path.resolve(root).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 解析 --list-protocols 的 stdout JSON；尚不完整或无 protocols 字段时返回 null。 */
function parseSocketProtocols(buffered: string): boolean | null {
  try {
    const parsed = JSON.parse(buffered.trim()) as { protocols?: string[] };
    return Array.isArray(parsed.protocols) ? parsed.protocols.includes('--socket') : null;
  } catch {
    return null;
  }
}

function runSocketProbe(root: string, nodeExecutable?: string): Promise<boolean> {
  const standardEntry = resolveArktsServerEntry(root, true);
  if (!fs.existsSync(standardEntry)) {
    return Promise.resolve(false);
  }
  const node = nodeExecutable || process.execPath || 'node';
  const args = [standardEntry, '--list-protocols'];
  mcpLog.debug(`Executing: ${node} ${args.join(' ')}`);
  return new Promise<boolean>((resolve) => {
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buffered = '';
    let settled = false;
    const finish = (supported: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      resolve(supported);
    };
    const timer = setTimeout(() => finish(false), SOCKET_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered = (buffered + chunk.toString('utf8')).slice(-SOCKET_PROBE_MAX_BYTES);
      const supported = parseSocketProtocols(buffered);
      if (supported !== null) {
        finish(supported);
      }
    });
    child.on('error', () => finish(false));
    child.on('close', () => finish(parseSocketProtocols(buffered) ?? false));
  });
}

/**
 * 工程根下 `compile_commands.json` 的相对路径（由 DevEco / project_sync 生成）。
 */
export const COMPILE_COMMANDS_RELATIVE_SEGMENTS = [
  '.idea',
  '.deveco',
  'cxx',
  'compile_commands.json',
] as const;

/**
 * 工程根下 `compile_commands.json` 的绝对路径。
 */
export function compileCommandsPath(projectPath: string): string {
  return path.join(projectPath, ...COMPILE_COMMANDS_RELATIVE_SEGMENTS);
}

/** 通用 sleep 工具。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 受 clangd 支持的 C/C++ 源 / 头文件扩展名（小写、无前导点）。
 */
const CPP_SUPPORTED_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
]);

/** 判断给定文件路径是否是受支持的 C/C++ 源 / 头文件。 */
export function isSupportedCppFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return ext.length > 0 && CPP_SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * 根据文件后缀推断 LSP `languageId`。
 * - `.c` → `c`
 * - 其它（`.cpp/.cc/.hpp/...`） → `cpp`
 */
export function inferCppLanguageId(filePath: string): 'c' | 'cpp' {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return ext === 'c' ? 'c' : 'cpp';
}

/**
 * 规范化为正斜杠路径；Windows 下盘符大写。
 */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(s)) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * 转为"标准路径"（无 file:// 前缀），用于在 LSP 消息中发送。
 *  - Windows: D:/path/to/file.ets
 *  - Mac/Linux: /path/to/file.ets
 */
export function toStandardPath(p: string): string {
  return normalizePath(p);
}

/**
 * 转为 file URI（可用作 diagnostic_waiters 的 key）。
 */
export function toFileUri(p: string): string {
  const std = toStandardPath(p);
  if (std.startsWith('/')) {
    return `file://${std}`;
  }
  return `file:///${std}`;
}

/**
 * 把 LSP 返回的 file URI 规范化为与 {@link toFileUri} 一致的形式。
 */
export function normalizeDiagnosticUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'file:') {
      // u.pathname 形如 /D:/foo/bar 或 /foo/bar
      let pathPart = decodeURIComponent(u.pathname);
      // Windows: 去掉前导斜杠（/D:/foo -> D:/foo）
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(pathPart)) {
        pathPart = pathPart.slice(1);
      }
      return toFileUri(pathPart);
    }
  } catch {
    // 不是合法 URL，原样返回
  }
  return uri;
}

/**
 * 对可能被 proxy/ace 写坏的 uri 生成候选 key（例如
 * `.../src-server/file:/D%3A/.../Index.ets`），用于二次匹配。
 */
export function diagnosticUriCandidates(uri: string): string[] {
  const out: string[] = [];
  const idx = uri.lastIndexOf('file:/');
  if (idx >= 0) {
    const suffix = uri.slice(idx).replace(/^file:\/+/, '');
    if (suffix) {
      const repaired = suffix.startsWith('/')
        ? `file://${suffix}`
        : `file:///${suffix}`;
      const candidate = normalizeDiagnosticUri(repaired);
      if (candidate !== uri && candidate !== normalizeDiagnosticUri(uri)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

/**
 * 获取 MCP server 日志根目录。
 *  - Windows: `%LOCALAPPDATA%/devecocli-mcp-server/logs`
 *  - macOS:   `~/Library/Logs/devecocli-mcp-server`
 *  - Linux:   `~/.local/share/devecocli-mcp-server/logs`
 */
export function getMcpLogDirectory(): string {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'devecocli-mcp-server', 'logs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'devecocli-mcp-server');
  }
  return path.join(os.homedir(), '.local', 'share', 'devecocli-mcp-server', 'logs');
}

/**
 * 读取 / 维护 mapping-config.properties，把 `key`（通常是工程根路径）
 * 映射到一个稳定的数字 ID（首次写入时取 `Date.now()`）。
 */
export function getRequestId(key: string, mappingConfigPath: string): number {
  const lines = readMappingLines(mappingConfigPath);
  const existing = lookupExistingId(lines, key);
  if (existing !== null) {
    return existing;
  }

  const timestamp = Date.now();
  const escapedKey = key.replace(/:/g, '\\:');
  const newLine = `${escapedKey}=${timestamp}`;
  const updatedLines = upsertMappingLine(lines, key, newLine);
  writeMappingLines(mappingConfigPath, updatedLines);
  return timestamp;
}

function readMappingLines(mappingConfigPath: string): string[] {
  let existing: string;
  try {
    existing = fs.readFileSync(mappingConfigPath, 'utf8');
  } catch {
    existing = '';
  }
  return existing.length > 0 ? existing.split(/\r?\n/) : [];
}

function lookupExistingId(lines: string[], key: string): number | null {
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const rawKey = line.slice(0, eq);
    if (rawKey.replace(/\\:/g, ':') !== key) {
      continue;
    }
    const n = parseInt(line.slice(eq + 1), 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
    return null; // key 命中但 value 非法 -> 重新生成
  }
  return null;
}

function upsertMappingLine(lines: string[], key: string, newLine: string): string[] {
  let replaced = false;
  const updated = lines.map((line) => {
    if (replaced) {
      return line;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      return line;
    }
    const rawKey = line.slice(0, eq);
    if (rawKey.replace(/\\:/g, ':') === key) {
      replaced = true;
      return newLine;
    }
    return line;
  });
  if (!replaced) {
    updated.push(newLine);
  }
  return updated;
}

function writeMappingLines(mappingConfigPath: string, lines: string[]): void {
  try {
    fs.mkdirSync(path.dirname(mappingConfigPath), { recursive: true });
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(mappingConfigPath, lines.join('\n') + '\n', 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 清理 `baseDir` 下超过 `maxAgeMs` 未修改的子目录。
 *
 * @param currentPath 当前正在使用的子目录路径
 * @param maxAgeMs 最大保留时间（毫秒）
 * @param logTag 日志前缀，默认 `[Cleanup]`
 */
export function cleanupOldSiblingDirs(
  currentPath: string,
  maxAgeMs: number,
  logTag = '[Cleanup]'
): void {
  try {
    const baseDir = path.dirname(currentPath);
    if (!fs.existsSync(baseDir)) {
      return;
    }
    const now = Date.now();
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      removeIfExpired(path.join(baseDir, entry.name), now, maxAgeMs, logTag);
    }
  } catch {
    // ignore
  }
}

function removeIfExpired(full: string, now: number, maxAgeMs: number, logTag: string): void {
  try {
    const { mtimeMs } = fs.statSync(full);
    if (now - mtimeMs <= maxAgeMs) {
      return;
    }
    fs.rmSync(full, { recursive: true, force: true });
    const ageSecs = Math.floor((now - mtimeMs) / 1000);
    console.error(
      `${logTag} Removed expired dir (age ${Math.floor(ageSecs / 86400)}d ${Math.floor(
        (ageSecs % 86400) / 3600
      )}h): ${full}`
    );
  } catch (e) {
    console.error(`${logTag} Failed to remove expired dir ${full}: ${e}`);
  }
}

