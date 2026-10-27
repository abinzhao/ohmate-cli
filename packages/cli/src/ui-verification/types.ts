/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface UiVerificationConfig {
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
}

export interface UiVerificationOptions {
  testPlan?: string;
  bundleName?: string;
  freshStart: boolean;
  device?: string;
}

export class UiVerificationCancelledError extends Error {
  readonly exitCode: number;

  constructor(signal: 'SIGINT' | 'SIGTERM') {
    super('Verification cancelled by user');
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

export interface UiVerificationResult {
  success: boolean;
  reason: string;
  successPart: string;
  failPart: string;
  id: string;
}

export type ProgressHandler = (
  progress: number,
  total?: number,
  message?: string
) => void;
