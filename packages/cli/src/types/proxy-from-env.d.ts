/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// proxy-from-env ships no type declarations. Minimal ambient declaration.
declare module 'proxy-from-env' {
  /**
   * Returns the proxy URL string for `url` (from HTTP_PROXY/HTTPS_PROXY env), or
   * '' when `url` matches NO_PROXY (or no proxy is configured). This is the same
   * function axios uses internally (lib/adapters/http.js:253).
   */
  export function getProxyForUrl(url: string): string;
}
