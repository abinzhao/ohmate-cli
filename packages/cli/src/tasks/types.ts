/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { Receipt, RuntimeEvent } from '../runtime/index.js';
import type { ApprovalPlan } from '../runtime/approval.js';

export type TaskState = 'queued' | 'planning' | 'awaiting-approval' | 'running' | 'verifying' |
  'succeeded' | 'failed' | 'cancelled' | 'blocked';
export interface TaskRequest {
  toolId: string;
  input: unknown;
  projectRoot: string | null;
  sessionId?: string;
  cwd?: string;
  locale?: 'zh-CN' | 'en-US';
  target?: { device?: string };
}
export interface TaskRecord extends TaskRequest {
  id: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  cancelRequested: boolean;
  forceRequested: boolean;
  receipt?: Receipt;
  plan?: ApprovalPlan;
  approvedPlan?: string;
  processes: TaskProcess[];
}
export interface TaskProcess {
  pid: number;
  identity: string;
  group: boolean;
  attempt: string;
}
export type TaskEvent = RuntimeEvent;
