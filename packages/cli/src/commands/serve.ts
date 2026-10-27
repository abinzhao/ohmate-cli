/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolProvider } from '../toolchain/index.js';
import { telemetry } from '../trace/index.js';

// The MCP server is a separate bundle entry: loading it here keeps its schema
// validation stack out of every other command's startup footprint.
function mcpServerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith('commands')
    ? join(here, '..', 'mcp', 'src-server', 'standalone.ts')
    : join(here, 'mcp-server.js');
}

/**
 * 启动 stdio 模式的 MCP server，并接管当前进程的 stdin/stdout 作为通信通道。
 */
async function startStdioMcpServer(): Promise<void> {
  const { createMcpServer } = await import(mcpServerEntry());
  const PROJECT_PATH = process.env.PROJECT_PATH || '';
  const NODE_MAX_OLD_SPACE_SIZE = process.env.NODE_MAX_OLD_SPACE_SIZE;
  const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  // C++ LSP 开关：默认开启，设为 'false' 或 '0' 关闭（跳过 compileNative + clangd）
  const CPP_ENABLED = process.env.DEVECO_CLI_CPP_ENABLED !== 'false' &&
    process.env.DEVECO_CLI_CPP_ENABLED !== '0';
  // 用户自定义 compile_commands.json 路径（绝对路径，指向文件）。
  // 指定后 C++ 初始化跳过 compileNative 同步，clangd 直接读取该编译数据库。
  const CPP_COMPILE_COMMANDS = process.env.DEVECO_CLI_CPP_COMPILE_COMMANDS?.trim() || '';
  // 组件路径（sdk / arkts-lsp / node / ohpm / hvigor / clangd）由 ToolProvider 按 CLT|Studio 布局一次性解析，
  // 作为 config 注入 MCP server，MCP 内部不再自行解析安装布局。
  const projectPath = PROJECT_PATH;
  const toolProvider = await ToolProvider.new();

  const server = createMcpServer({
    projectPath,
    sdkPath: toolProvider.sdkPath,
    arktsLangServerPath: toolProvider.arktsLangServerPath ?? undefined,
    nodePath: toolProvider.nodePath,
    ohpmJsPath: toolProvider.ohpmJsPath,
    hvigorJsPath: toolProvider.hvigorJsPath,
    clangdPath: toolProvider.clangdPath ?? undefined,
    nodeMaxOldSpaceSize: NODE_MAX_OLD_SPACE_SIZE,
    debug: DEBUG,
    cppEnabled: CPP_ENABLED,
    cppCompileCommandsPath: CPP_COMPILE_COMMANDS || undefined,
    telemetry,
  });

  // server.start() resolves immediately (fire-and-forget via StdioTransport).
  // Block here until a shutdown signal so the caller (parseAsync) doesn't
  // resolve prematurely — otherwise cli.ts stops the telemetry scheduler
  // before the first flush ever runs.
  let resolveShutdown!: () => void;
  const shutdownSignal = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const shutdown = async (): Promise<void> => {
    await server.shutdown();
    resolveShutdown();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', shutdown);
  }

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start MCP server:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  await shutdownSignal;
}

const serveCommand = new Command('serve').description(
  'Host bundled auxiliary protocol servers'
);

serveCommand
  .command('mcp')
  .description('Start a local stdio-based MCP server')
  .action(async () => {
    await startStdioMcpServer();
  });

serveCommand
  .command('lsp')
  .description('Start a bundled LSP language server')
  .option('--arkts', 'Start the ArkTS language server (ace-server)')
  .option('--cpp', 'Start the C/C++ language server (clangd)')
  .option('--project-path <path>', 'project root path (used as-is, no search)')
  .option('--auto-detect', 'When --project-path is not specified, search the current directory and its subdirectories for the project root (no upward search)')
  .action(async (options) => {
    if (options.arkts && options.cpp) {
      console.error('--arkts and --cpp are mutually exclusive. Specify only one.');
      process.exit(1);
    }
    if (options.arkts) {
      // Loaded on demand; language-server startup is a separate protocol session.
      const { startArktsLspServer } = await import('./serve-lsp.js');
      await startArktsLspServer({
        projectPath: options.projectPath,
        autoDetect: options.autoDetect,
      });
    } else if (options.cpp) {
      const { startClangdLspServer } = await import('./serve-lsp-cpp.js');
      await startClangdLspServer({
        projectPath: options.projectPath,
        autoDetect: options.autoDetect,
      });
    } else {
      console.error('Use --arkts or --cpp to specify which language server to start.');
      process.exit(1);
    }
  });

export default serveCommand;
