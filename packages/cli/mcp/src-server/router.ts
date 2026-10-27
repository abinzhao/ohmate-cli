/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventType, type McpToolCall, type Telemetry } from '../../src/trace/index.js';
import { readProcessRss, formatBytesMb } from '../../src/utils/process-rss.js';
import { extractToolMetrics, triggerFileExt } from './utils/tool-metrics.js';
import { mcpLog } from './utils/mcp-logger.js';

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * Tool definition interface
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

/**
 * Tool handler interface
 */
export interface ToolHandler {
  (args: Record<string, unknown>): Promise<ToolCallResult>;
}


/**
 * Registered tool entry
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRouter {
  private tools: Map<string, RegisteredTool> = new Map();

  constructor(
    private readonly telemetry?: Telemetry,
    private readonly getAceServerPid?: () => number | null,
    private readonly getProjectPath?: () => string,
    private readonly getSdkPath?: () => string,
  ) {}

  /**
   * Add a tool to the router
   */
  add(definition: ToolDefinition, handler: ToolHandler): this {
    this.tools.set(definition.name, { definition, handler });
    return this;
  }

  /**
   * Get all registered tools
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register all tools to an MCP server
   */
  registerToServer(server: McpServer): void {
    for (const { definition, handler } of this.getAll()) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema as never,
        },
        (async (args: Record<string, unknown>) => {
          return this.invokeTool(definition.name, args, handler);
        }) as never,
      );
    }
  }

  private async invokeTool(
    name: string,
    args: Record<string, unknown>,
    handler: ToolHandler,
  ): Promise<ToolCallResult> {
    mcpLog.debug(`[telemetry] mcp tool call: ${name}`);
    if (!this.telemetry) {
      return handler(args);
    }
    const mcpMemory = formatBytesMb(process.memoryUsage().rss);
    const lspMemory = await this.resolveLspMemory();
    const start = Date.now();
    let success = true;
    let errorCode: string | null = null;
    let result: ToolCallResult | undefined;
    try {
      result = await handler(args);
    } catch (e) {
      success = false;
      errorCode =
        e instanceof Error
          ? (e as NodeJS.ErrnoException).code ?? e.name
          : 'UnknownError';
      throw e;
    } finally {
      await this.trackToolCall(
        name,
        args,
        result,
        start,
        mcpMemory,
        lspMemory,
        success,
        errorCode
      );
    }
    return result!;
  }

  /** 记录一次工具调用的打点：返回型错误(isError)记失败并按响应模式分类 error_code。 */
  private async trackToolCall(
    name: string,
    args: Record<string, unknown>,
    result: ToolCallResult | undefined,
    start: number,
    mcpMemory: string,
    lspMemory: string,
    success: boolean,
    errorCode: string | null
  ): Promise<void> {
    if (!this.telemetry) {
      return;
    }
    const isError = result?.isError === true;
    const metrics =
      result && !isError
        ? extractToolMetrics(name, result, args, this.getProjectPath?.() ?? '', this.getSdkPath?.() ?? '')
        : {};
    const finalSuccess = isError ? false : success;
    const finalErrorCode =
      isError && result ? classifyMcpToolError(result) : errorCode;
    const event: McpToolCall & Record<string, unknown> = {
      event: EventType.McpToolCall,
      subAction: name,
      mcpMemory,
      lspMemory,
      fileExt: triggerFileExt(args),
      ...metrics,
    };
    if (typeof args.direction === 'string') {
      event.direction = args.direction;
    }
    await this.telemetry.track(event, {
      duration_ms: Date.now() - start,
      success: finalSuccess,
      error_code: finalErrorCode,
    });
  }

  /** 读 ace-server 子进程 RSS（MB）；pid 未就绪或读取失败为 "unknown"。 */
  private async resolveLspMemory(): Promise<string> {
    const pid = this.getAceServerPid?.() ?? null;
    if (pid === null) {
      return 'unknown';
    }
    const rssKb = await readProcessRss(pid);
    return rssKb === null ? 'unknown' : formatBytesMb(Number(rssKb) * 1024);
  }
}

/**
 * MCP 工具返回型错误(isError 响应)的轻量分类：按已知响应模式映射短码，
 * 供打点 error_code 使用；无法识别时兜底 ToolError。
 */
function classifyMcpToolError(result: ToolCallResult): string {
  const text = result.content.map((c) => c.text).join('\n');
  if (
    /not ready|not initialized|initializing|please retry|retry \d+s|syncing|C\+\+ project initialization failed/i.test(
      text
    )
  ) {
    return 'NotReady';
  }
  if (/No project detected|PROJECT_PATH|no project path/i.test(text)) {
    return 'NoProject';
  }
  if (
    /Missing.*parameter|invalid parameters|Unknown feature|must be|Must specify|cannot be used together|invalid/i.test(
      text
    )
  ) {
    return 'BadRequest';
  }
  if (/Too many files|Maximum allowed/i.test(text)) {
    return 'TooManyFiles';
  }
  if (
    /does not exist|not exist|not found|No valid|not a .ets|not a supported|Unsupported/i.test(
      text
    )
  ) {
    return 'InvalidFile';
  }
  return 'ToolError';
}

/**
 * Create a new tool router
 */
export function createToolRouter(
  telemetry?: Telemetry,
  getAceServerPid?: () => number | null,
  getProjectPath?: () => string,
  getSdkPath?: () => string,
): ToolRouter {
  return new ToolRouter(telemetry, getAceServerPid, getProjectPath, getSdkPath);
}
