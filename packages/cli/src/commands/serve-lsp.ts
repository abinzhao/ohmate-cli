/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ToolProvider } from '../toolchain/index.js';
import {
  findHarmonyProjectInDir,
  getMcpLogDirectory,
  normalizePath,
  resolveArktsServerEntry,
} from '../../mcp/src-server/utils/common.js';
import { buildAceServerArgs, computeLspServerMaxSize, resolveNodePath } from '../../mcp/src-server/lsp/utils.js';
import { ModulesDependencyParse } from '../../mcp/src-server/lsp/parse/ModulesDependencyParse.js';
import { ModuleInfoParse } from '../../mcp/src-server/lsp/parse/ModuleInfoParse.js';
import type { ModuleModel } from '../../mcp/src-server/lsp/model/ModuleModel.js';
import { DependencyMapParseStatus } from '../../mcp/src-server/lsp/constant.js';
import { initMcpLogger, mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';
import { telemetry, EventType, type ServeLspOperation } from '../trace/index.js';
import { readProcessRss, formatBytesMb } from '../utils/process-rss.js';

export interface ArktsLspOptions {
  projectPath?: string;
  /** 未指定 --project-path 时，开启后从 cwd 及其子目录向下查找工程根（不向上搜索）。 */
  autoDetect?: boolean;
}

/**
 * 仅负责拉起 ArkTS LSP (ace-server) 子进程，并在父进程 stdin/stdout 与子进程
 * 之间建立透明字节桥接。--projectPath / --sdkPath 完全由本命令自行解析（不由
 * 用户传入），initialize / initialized 等握手流程由连接到本命令的 LSP 客户端
 * （编辑器）自行驱动，本命令不参与。
 */
export async function startArktsLspServer(options: ArktsLspOptions): Promise<void> {
  initMcpLogger(false);

  const { serverPath, logPath, projectPath, sdkPath, serverMaxSize, nodePath } = await resolvePaths(options);
  const child = spawnAceServer(serverPath, logPath, projectPath, sdkPath, serverMaxSize, nodePath);

  mcpLog.info('ace-server started, bridging stdio (initialize is left to the client)');
  setupBridge(child);

  await trackServeLspStart(child.pid ?? null, buildServeLspArgs('--arkts', options));
}

/**
 * 手工构造打点 args：仅 flag 名，取值（如 --project-path 的路径）不记录，
 * 与 buildRunEvent 等既有惯例一致。
 */
export function buildServeLspArgs(
  serverFlag: string,
  options: { projectPath?: string; autoDetect?: boolean }
): string[] {
  return [
    serverFlag,
    ...(options.projectPath ? ['--project-path'] : []),
    ...(options.autoDetect ? ['--auto-detect'] : []),
  ];
}

/**
 * 落盘一条 `devecocli_serve_lsp` 事件：event_detail 含 `devecocli serve lsp` 之后的
 * 命令行 flag 名（args，仅 flag 不含取值，如 --arkts / --cpp，遵循 PRIVACY.md）与
 * LSP 子进程启动期内存（lspMemory，spawn 后即时采样）。
 * 用 §3.1 无被测函数重载——仅记录发生，duration=0 / success=true。
 */
export async function trackServeLspStart(
  childPid: number | null,
  args: string[]
): Promise<void> {
  let lspMemory = 'unknown';
  if (childPid !== null) {
    const rssKb = await readProcessRss(childPid);
    if (rssKb !== null) {
      lspMemory = formatBytesMb(Number(rssKb) * 1024);
    }
  }
  const event: ServeLspOperation = {
    event: EventType.ServeLsp,
    args,
    lspMemory,
  };
  await telemetry.track(event);
}

async function resolvePaths(options: ArktsLspOptions): Promise<{
  projectPath: string;
  sdkPath: string;
  serverPath: string;
  logPath: string;
  serverMaxSize: number;
  nodePath: string;
}> {
  const toolProvider = await ToolProvider.new();
  // 指定路径→直接用（不搜，安全）；未指定+--auto-detect→从 cwd 向下搜（不向上）；否则用 cwd。
  let projectPath: string;
  if (options.projectPath) {
    projectPath = normalizePath(path.resolve(options.projectPath));
    mcpLog.info(`projectPath=specified ('${projectPath}'), no search`);
  } else if (options.autoDetect) {
    const found = findHarmonyProjectInDir(process.cwd());
    projectPath = normalizePath(found ?? process.cwd());
    mcpLog.info(`findHarmonyProjectInDir('${process.cwd()}') => ${found ?? 'null, fallback to cwd'}`);
  } else {
    projectPath = normalizePath(process.cwd());
    mcpLog.info(`projectPath=cwd ('${projectPath}'), no search (pass --auto-detect to search subdirs)`);
  }
  // 启动期一次性固定 sdkPath / arktsLangServerPath（按 CLT|Studio 布局派生）。
  const sdkPath = toolProvider.sdkPath;
  const arktsLangServerPath = toolProvider.arktsLangServerPath;
  if (!arktsLangServerPath) {
    mcpLog.error('ace-server not found (install DevEco Studio / CLT).');
    process.exit(1);
  }
  const serverPath = resolveArktsServerEntry(arktsLangServerPath, true);
  const logPath = path.join(getMcpLogDirectory(), 'lsp-server', String(Date.now()));
  fs.mkdirSync(logPath, { recursive: true });
  const serverMaxSize = resolveServerMaxSize(projectPath, sdkPath);

  mcpLog.info(`projectPath=${projectPath}, sdkPath=${sdkPath}, arktsLangServerPath=${arktsLangServerPath}, serverPath=${serverPath}, logPath=${logPath}, serverMaxSize=${serverMaxSize}MB`);
  return { projectPath, sdkPath, serverPath, logPath, serverMaxSize, nodePath: toolProvider.nodePath };
}

/**
 * 动态计算 ace-server 进程的 --max-old-space-size（单位 MB），规则与 `serve mcp` 路径一致。
 * 优先用 `.hvigor/dependencyMap` 解析的模块数（需已 sync）；失败则回退到 `build-profile.json5`
 * 的模块数；`NODE_MAX_OLD_SPACE_SIZE` 环境变量可显式 override，仍受物理内存 70% 上限约束。
 */
function resolveServerMaxSize(projectPath: string, sdkPath: string): number {
  const overrideRaw = process.env.NODE_MAX_OLD_SPACE_SIZE;
  const overrideParsed = overrideRaw ? parseInt(overrideRaw, 10) : NaN;
  const overrideSize = Number.isFinite(overrideParsed) && overrideParsed > 0 ? overrideParsed : undefined;

  const moduleCount = resolveModuleCount(projectPath, sdkPath);
  const size = computeLspServerMaxSize(moduleCount, overrideSize);
  mcpLog.info(`[serve-lsp] serverMaxSize=${size}MB (moduleCount=${moduleCount}, override=${overrideSize ?? 'none'})`);
  return size;
}

function resolveModuleCount(projectPath: string, sdkPath: string): number {
  try {
    const moduleModels: ModuleModel[] = [];
    const parser = new ModulesDependencyParse(projectPath, sdkPath);
    const result = parser.getAllDependencyMap(moduleModels);
    if (result.status === DependencyMapParseStatus.OK) {
      return moduleModels.length;
    }
    return new ModuleInfoParse(projectPath).getAllModuleInfo().length;
  } catch {
    return 0;
  }
}

function spawnAceServer(
  serverPath: string,
  logPath: string,
  projectPath: string,
  sdkPath: string,
  serverMaxSize: number,
  nodePath: string,
): ChildProcess {
  const lspLogPath = path.join(logPath, 'lspLog');
  fs.mkdirSync(lspLogPath, { recursive: true });
  const args = buildAceServerArgs({
    serverPath,
    lspLogPath,
    serverMaxSize,
    projectPath,
    sdkPath,
  });
  const resolvedNodePath = resolveNodePath(nodePath);
  mcpLog.info(`[serve-lsp] spawn: ${resolvedNodePath} ${args.join(' ')}`);
  return spawn(resolvedNodePath, args, {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * 透明字节桥接：子进程 stdout → 父进程 stdout；父进程 stdin → 子进程 stdin。
 * 不解析、不拦截任何 LSP 消息（包括 initialize / initialized）。
 */
function setupBridge(child: ChildProcess): void {
  child.on('error', (err) => {
    mcpLog.error(`[ace-server] spawn error: ${err.message}`);
    process.exit(1);
  });
  child.stdout?.on('error', (err) => {
    mcpLog.error(`[ace-server] stdout error: ${err.message}`);
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('error', (err) => {
    mcpLog.error(`[ace-server] stderr error: ${err.message}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    mcpLog.error(`[ace-server] ${chunk.toString('utf8').trim()}`);
  });
  child.stdin?.on('error', (err) => {
    mcpLog.error(`[ace-server] stdin error: ${err.message}`);
  });
  process.stdin.on('data', (chunk: Buffer) => {
    child.stdin?.write(chunk);
  });
  process.stdin.on('end', () => {
    mcpLog.info('Editor disconnected, shutting down');
    child.kill();
    process.exit(0);
  });
  child.on('exit', (code) => {
    mcpLog.info(`ace-server exited with code ${code}`);
    process.exit(code ?? 0);
  });
}
