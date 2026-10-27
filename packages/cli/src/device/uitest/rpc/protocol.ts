/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { requestId } from '../common/utils/id.js';

export const OPERATE_MODULE = 'com.ohos.devicetest.hypiumApiHelper';
export const OPERATE_METHOD = 'callHypiumApi';

export interface RpcResponse {
  result?: unknown;
  exception?: unknown;
  request_id?: string;
  [key: string]: unknown;
}

export interface CreateEnvelopeOptions {
  module: string;
  method: string;
  params?: Record<string, unknown>;
  requestId?: string;
}

export interface RpcRequest {
  module: string;
  method: string;
  params: Record<string, unknown>;
  request_id: string;
  [key: string]: unknown;
}

export function createEnvelope({ module, method, params = {}, requestId: rid }: CreateEnvelopeOptions): RpcRequest {
  return {
    module,
    method,
    params,
    request_id: rid || requestId(),
  };
}

/**
 * Whether the response carries a remote business exception (connection is healthy, should not trigger reset)
 */
export function hasRemoteException(response: unknown): response is RpcResponse {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const exc = (response as RpcResponse).exception;
  return exc != null && exc !== '';
}

/**
 * Extract response body, throw on exception for caller to handle
 */
export function unwrapResult(response: unknown): unknown {
  return response ? (response as RpcResponse).result : undefined;
}