/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * HTTP Response wrapper
 */
export interface HttpResponse {
  data: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * HTTP Request configuration
 */
export interface HttpRequestConfig {
  timeout?: number;
  headers?: Record<string, string>;
  params?: Record<string, unknown> | string;
}
