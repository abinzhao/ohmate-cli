/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ZodType } from 'zod';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3';
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 130;
export type Locale = 'zh-CN' | 'en-US';
export class InputInvalidError extends Error {}
export interface Diagnostic {
  code: string;
  message: string;
}
export interface ToolResult {
  exitCode: ExitCode;
  data: unknown;
  warnings?: Diagnostic[];
  artifacts?: Artifact[];
  provenance?: Record<string, unknown>;
}
export interface Artifact {
  path: string;
  sha256: string;
  kind: string;
}
export interface Receipt extends ToolResult {
  schemaVersion: '1.0';
  toolVersion: string;
  command: string;
  status: 'passed' | 'findings' | 'error' | 'degraded' | 'invalid' | 'blocked' | 'failed' | 'cancelled';
  locale: Locale;
  startedAt: string;
  durationMs: number;
  project: { root: string | null; workspaceId: string };
  capabilities: Record<string, unknown>;
  warnings: Diagnostic[];
  artifacts: Artifact[];
  taskId: string | null;
  provenance: { adapter: string } & Record<string, unknown>;
}
export interface RuntimeEvent {
  taskId: string;
  sequence: number;
  type: string;
  time: string;
  payload: unknown;
}
export interface ExecutionContext {
  projectRoot: string | null;
  workspaceId: string;
  cwd: string;
  locale: Locale;
  config: Readonly<Record<string, unknown>>;
  toolchain: Readonly<Record<string, unknown>>;
  target: { device?: string };
  abortSignal: AbortSignal;
  eventSink: (event: RuntimeEvent) => void | Promise<void>;
  artifactStore: { root: string };
  dataDir: string;
  policy: { telemetry: boolean; nonInteractive: boolean; approvedPlan?: string };
  taskId?: string;
  sessionId?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  forceSignal?: AbortSignal;
  protocolStdin?: boolean;
  console?: () => Promise<ToolResult>;
  privatePairing?: (text: string) => Promise<void>;
}
export interface CliOption {
  flags: string;
  description: string;
  required: boolean;
  optional: boolean;
  mandatory: boolean;
  defaultValue?: unknown;
  choices?: string[];
}
export interface ToolSpec {
  id: string;
  command: string[];
  description: string;
  inputSchema: ZodType;
  outputSchema: ZodType;
  risk: Risk;
  requirements: string[];
  timeoutMs: number;
  cancellable: boolean;
  idempotency: 'read' | 'artifact' | 'none';
  recovery: 'verify-and-retry' | 'manual';
  evidence: string[];
  adapter: 'native' | 'legacy-child';
  protocol?: boolean;
  hidden?: boolean;
  arguments: { name: string; required: boolean; variadic: boolean }[];
  options: CliOption[];
  resolveRisk?: (input: unknown, context: ExecutionContext) => Risk | Promise<Risk>;
  review?: (input: unknown, context: ExecutionContext) => Promise<unknown>;
  execute: (input: unknown, context: ExecutionContext) => Promise<ToolResult>;
}
