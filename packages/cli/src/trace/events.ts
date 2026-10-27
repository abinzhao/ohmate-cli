/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface BaseEvent {
  event: string;
}

export interface CommandExecuted extends BaseEvent {
  args: string[];
  [key: string]: unknown;
}

/** log 命令打点事件：覆盖 --crash（Identify-FaultLog）与 --stack（采样栈）本地解析及设备日志获取。 */
export interface LogTraceEvent extends CommandExecuted {
  /** 操作类型：hilog（普通日志）| faultlogger_report（--crash 设备报告）| local_identify（--path 本地识别） */
  operation: 'hilog' | 'faultlogger_report' | 'local_identify';
  /** 分析意图：common（普通日志流）| crash（faultlog 解析）| stack（采样栈解析） */
  logType: 'common' | 'crash' | 'stack';
  /** 应用模块名：本地识别成功时从日志内容回填（Module name 头字段），其余场景为 --bundle-name 过滤参数（缺省 ALL） */
  bundleName: string;
  /** 故障类型（成功取解析结果的分类判定，失败取错误携带的判定，覆盖 out_of_scope/unknown/ambiguous；采样栈不写，由 logType 区分） */
  faultType?: 'app_freeze' | 'cpp_crash' | 'js_error' | 'unknown' | 'out_of_scope' | 'ambiguous';
  /** 失败原因文本（error.message，路径类内容已掩码为 ***.<扩展名>） */
  errorMessage?: string;
}

export interface McpToolCall extends BaseEvent {
  /** 具体工具名（hover / check 等）或内部动作（init_arkts / init_cpp），落 event_detail.sub_action */
  subAction: string;
  /** 调用方向（callHierarchy 的 incoming/outgoing），有则落 event_detail.direction */
  direction?: string;
  /** devecocli(mcp)父进程内存（RSS，MB） */
  mcpMemory: string;
  /** ace-server(LSP)子进程内存（RSS，MB）；未就绪/读取失败为 "unknown" */
  lspMemory: string;
  /** 触发文件扩展名（小写无点，如 ets/ts/cpp）；workspaceSymbol 无文件则缺省，落 event_detail.file_ext */
  fileExt?: string;
  fileCount?: number;
  lineCount?: number;
  errorCount?: number;
  warningCount?: number;
}

/** check 工具：诊断计数（severity: 1=error/2=warn/3=info/4=hint→info）+ 命中规则名。 */
export interface CheckToolCall extends McpToolCall {
  diagTotal: number;
  diagError: number;
  diagWarn: number;
  diagInfo: number;
  rules?: string[];
}

/** hover 工具：是否命中。 */
export interface HoverToolCall extends McpToolCall {
  hit: boolean;
}

/** definition / declaration 工具：是否找到、是否同文件、来源分类(user_project/sdk/system)。 */
export interface DefinitionToolCall extends McpToolCall {
  found: boolean;
  sameFile: boolean;
  sourceType: string;
}

/** references 工具：引用总数、涉及文件数。 */
export interface ReferencesToolCall extends McpToolCall {
  refTotal: number;
  fileCount: number;
}

/** implementation 工具：实现数量、是否找到。 */
export interface ImplementationToolCall extends McpToolCall {
  implTotal: number;
  found: boolean;
}

/** documentSymbol 工具：符号总数（含嵌套）、kind 分布。 */
export interface DocumentSymbolToolCall extends McpToolCall {
  symbolTotal: number;
  kindDist: Record<string, number>;
}

/** callHierarchy 工具：调用数、被调用者来源分布。 */
export interface CallHierarchyToolCall extends McpToolCall {
  callsTotal: number;
  calleeSrcDist: Record<string, number>;
}

/** workspaceSymbol 工具：结果总数、kind 分布、deprecated 命中数、query 长度。 */
export interface WorkspaceSymbolToolCall extends McpToolCall {
  resultTotal: number;
  kindDist: Record<string, number>;
  deprecatedHit: number;
  queryLen?: number;
}

export interface SkillOperation extends BaseEvent {
  /** 操作类型：add / list / find / remove，落 event_detail.sub_action */
  subAction: string;
  /** 命令行参数（含命令路径，如 skills add；flag 仅记名，--agent 取值非敏感一并记录，--project/--path 等路径类取值剔除） */
  args: string[];
  /** add：本次下载数据量（MB） */
  diskUsage?: string;
  /** add/remove：操作结果计数（per-skill per-target） */
  opTotal?: number;
  opSuccess?: number;
  opFailed?: number;
  opSkipped?: number;
  /** add/remove：失败原因集合（去重，来自 results[].error）；仅 opFailed>0 时有 */
  failedErrors?: string[];
  /** list/find：结果总数 */
  resultTotal?: number;
  /** find：搜索词原文 */
  keyword?: string;
  /** find：搜索词长度 */
  queryLen?: number;
  /** add/remove：--skill 取值（实际操作的 skill 名称） */
  skillName?: string;
}

export interface McpConfigOperation extends BaseEvent {
  /** 操作类型: "install" / "remove"，落 event_detail.sub_action */
  subAction: string;
  /** 目标级别: "global" / "project";未指定时为空 */
  targetType?: string;
  /** 目标 agent: "claude" / "cursor";面向全部 agent 时为空 */
  agentName?: string;
}

export interface SkillConfigOperation extends BaseEvent {
  /** 操作类型，落 event_detail.sub_action */
  subAction: 'install';
  /** 安装目标类型，落 event_detail.target_type */
  targetType: 'global' | 'project' | 'path';
  /** 最终解析并实际参与安装的 Agent 列表 */
  agents: string[];
}

export type DocSubAction = 'search' | 'read' | 'catalog';

export interface DocOperation extends BaseEvent {
  /** 文档操作类型，落 event_detail.sub_action */
  subAction: DocSubAction;
  /** search：搜索词原文数组 */
  keywords?: string[];
  /** search：归一化后的搜索词总长度 */
  queryLen?: number;
  /** search：最终生效的文档分类，未指定时为 all */
  catalog?: string;
  /** read：归一化后的文档 ID */
  documentId?: string;
  /** catalog：最终生效的输出格式 */
  fmt?: 'default' | 'json';
}

export interface ServeLspOperation extends BaseEvent {
  /** `devecocli serve lsp` 之后的命令行参数（如 --arkts / --project-path） */
  args: string[];
  /** ace-server(LSP)子进程内存（RSS，MB）；读取失败为 "unknown" */
  lspMemory: string;
}

export interface CheckCommand extends BaseEvent {
  /** 命令行参数（如 check compat / check lint） */
  args: string[];
  /** devecocli 父进程内存（RSS，MB）；读取失败为 "unknown" */
  mcpMemory: string;
  /** check 子命令不涉及 LSP 子进程，固定 "unknown" */
  lspMemory: string;
}

/** 调用方预计算的打点测量结果，供 telemetry.track 直接传入，免去包裹函数 */
export interface TrackMeasurement {
  duration_ms: number;
  success: boolean;
  error_code: string | null;
}

/** 上报事件 properties 中的明细字段 */
export interface TraceEventProperties {
  /** 安装标识（codeGenie 契约字段名，值为随机安装 ID，与硬件无关） */
  uid: string;
  trace_uuid: string;
  trace_os_version: string;
  os_arch: string;
  action: string;
  trace_os_name: string;
  version: string;
  deveco_studio_version: string;
  command_line_version: string;
  source_type: string;
  session_id: string;
  node_version: string;
  /** 用户电脑物理内存总大小（如 "16GB"） */
  ram: string;
  duration_ms: number;
  success: boolean;
  error_code: string | null;
  /** 原始事件明细(原 events[0],由数组改为对象),已剔除 event 字段 */
  event_detail: Record<string, unknown>;
}

/** 单条上报事件(落盘一行) */
export interface TraceEvent {
  countryCode: string;
  event: string;
  eventtime: string;
  properties: TraceEventProperties;
}

/** 上报批次数组元素（codeGenie trace 上传接口）：action 为原 event 字段，detail 为原 TraceEvent 完整嵌套 JSON 字符串 */
export interface TraceUploadPayload {
  action: string;
  detail: string;
  timestamp: number;
}

export const EventType = {
  CommandExecuted: 'Command_executed',
  McpToolCall: 'serve_mcp',
  SkillOperation: 'skills',
  Init: 'mcp_config_operation',
  SkillConfigOperation: 'skill_config_operation',
  DocOperation: 'docs',
  ServeLsp: 'serve_lsp',
  CheckCommand: 'check',
} as const;
