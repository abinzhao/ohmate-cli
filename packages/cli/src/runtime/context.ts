/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExecutionContext, Locale } from './types.js';

export interface ContextOptions {
  cwd?: string;
  projectRoot?: string;
  dataDir?: string;
  locale?: Locale;
  abortSignal?: AbortSignal;
  nonInteractive?: boolean;
  approvedPlan?: string;
  stdout?: ExecutionContext['stdout'];
  stderr?: ExecutionContext['stderr'];
  forceSignal?: AbortSignal;
  protocolStdin?: boolean;
  target?: ExecutionContext['target'];
  eventSink?: ExecutionContext['eventSink'];
  taskId?: string;
  sessionId?: string;
}

export function resolveLocale(explicit?: Locale): Locale {
  const value = explicit ?? process.env.OHMATE_LANG ?? process.env.LANG ?? '';
  return value.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export async function createExecutionContext(options: ContextOptions = {}): Promise<ExecutionContext> {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const projectRoot = options.projectRoot ? await realpath(resolve(cwd, options.projectRoot)) : null;
  if (!(await stat(projectRoot ?? cwd)).isDirectory()) {
    throw new Error('Project/cwd must be a directory');
  }
  const dataDir = resolve(options.dataDir ?? process.env.OHMATE_DATA_DIR ?? join(homedir(), '.local', 'share', 'ohmate'));
  return {
    cwd, projectRoot, dataDir,
    workspaceId: createHash('sha256').update(projectRoot ?? cwd).digest('hex').slice(0, 24),
    locale: resolveLocale(options.locale),
    config: {}, toolchain: {}, target: options.target ?? {},
    abortSignal: options.abortSignal ?? new AbortController().signal,
    eventSink: options.eventSink ?? (() => undefined),
    artifactStore: { root: join(dataDir, 'artifacts') },
    policy: {
      telemetry: false,
      nonInteractive: options.nonInteractive ?? true,
      approvedPlan: options.approvedPlan,
    },
    stdout: options.stdout,
    stderr: options.stderr,
    forceSignal: options.forceSignal, protocolStdin: options.protocolStdin, taskId: options.taskId, sessionId: options.sessionId,
  };
}
