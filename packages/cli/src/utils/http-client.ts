/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from 'axios';
import { NetworkConstants, TimeConstants } from '../config/constants';
import type { HttpResponse, HttpRequestConfig } from '../types/http';
import { getProxyForUrl } from 'proxy-from-env';
import { curlRequest } from './curl-proxy.js';
import type { CurlResponse } from './curl-proxy.js';

/**
 * Build an axios `proxy` config with DECODED credentials from a proxy URL.
 * axios's built-in env-proxy path reads URL.username/.password WITHOUT decoding
 * → wrong Basic → 407. Passing an explicit `proxy` object makes axios read
 * `proxy.auth` (http.js:292) and build its own tunneling agent with the decoded
 * creds → correct Proxy-Authorization.
 */
function buildProxyConfig(proxyUrl: string) {
  const u = new URL(proxyUrl);
  return {
    protocol: u.protocol,
    host: u.hostname,
    port: u.port
      ? Number.parseInt(u.port, 10)
      : u.protocol === 'https:'
        ? 443
        : 80,
    auth: {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
  };
}

/**
 * HTTP 客户端类
 * 封装 axios，提供简化的请求接口
 */
export class HttpClient {
  private client: AxiosInstance;

  constructor() {
    const axiosConfig: AxiosRequestConfig = {
      timeout: TimeConstants.HTTP_TIMEOUT_MS,
      headers: {
        'User-Agent': NetworkConstants.USER_AGENT,
        'accept-language': NetworkConstants.ACCEPT_LANGUAGE,
      },
      transformResponse: [(data) => data],
    };

    this.client = axios.create(axiosConfig);

    this.client.interceptors.request.use((config) => {
      const proxyUrl = getProxyForUrl(config.url ?? '');
      config.proxy = proxyUrl ? buildProxyConfig(proxyUrl) : false;
      return config;
    });
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        const proxyHint = `Network connection failed (${error.code}). Please check your proxy configuration or network settings`;
        const wrapped = new Error(`${error.message}\n${proxyHint}`);
        // 保留原始 AxiosError 字段，供 isProxyRelatedError 判断是否触发 curl 兜底
        (wrapped as Error & { code?: string }).code = error.code;
        (wrapped as Error & { response?: AxiosResponse }).response =
          error.response;
        throw wrapped;
      }
    );
  }

  /**
   * 发送 GET 请求
   * @param url 请求 URL
   * @param config 请求配置
   * @returns HTTP 响应
   */
  public async get(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    try {
      const response = await this.client.request({
        method: 'GET',
        url,
        params: config?.params,
        headers: config?.headers,
        timeout: config?.timeout,
      });
      return this.convertResponse(response);
    } catch (error) {
      return this.withCurlFallback(error, url, 'GET', config);
    }
  }

  /**
   * 发送 POST 请求
   * @param url 请求 URL
   * @param config 请求配置
   * @returns HTTP 响应
   */
  public async post(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    try {
      const response = await this.client.request({
        method: 'POST',
        url,
        data: config?.params,
        headers: config?.headers,
        timeout: config?.timeout,
      });
      return this.convertResponse(response);
    } catch (error) {
      return this.withCurlFallback(error, url, 'POST', config);
    }
  }

  /**
   * 将 axios 响应转换为统一的 HttpResponse 格式
   * @param response axios 响应
   * @returns 统一的 HTTP 响应格式
   */
  private convertResponse(response: AxiosResponse): HttpResponse {
    return {
      data:
        typeof response.data === 'string'
          ? response.data
          : JSON.stringify(response.data),
      statusCode: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers as Record<
        string,
        string | string[] | undefined
      >,
    };
  }

  /**
   * 解析 JSON 响应
   * @param response HTTP 响应
   * @returns 解析后的 JSON 对象
   */
  public parseJson<T>(response: HttpResponse): T {
    try {
      return JSON.parse(response.data) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * 发送 GET 请求并返回二进制数据
   * 用于下载文件等场景
   * @param url 请求 URL
   * @param config 请求配置
   * @returns Buffer 数据
   */
  public async getBinary(
    url: string,
    config?: HttpRequestConfig
  ): Promise<Buffer> {
    try {
      const response = await this.client.request({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        headers: config?.headers,
        timeout: config?.timeout,
      });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      return Buffer.from(response.data);
    } catch (error) {
      const curlResp = await this.tryCurlFallback(
        error,
        url,
        'GET',
        config,
        true
      );
      if (curlResp?.bodyBuffer) {
        if (curlResp.statusCode !== 200) {
          // eslint-disable-next-line preserve-caught-error
          throw new Error(`HTTP ${curlResp.statusCode}`);
        }
        return curlResp.bodyBuffer;
      }
      throw error;
    }
  }

  /**
   * 发送 POST 请求，4xx/5xx 不抛错，返回带状态码的响应
   * 用于需按 HTTP 状态码 + 响应体判定错误的云侧接口
   */
  public async postAllowFailure(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    try {
      const response = await this.client.request({
        method: 'POST',
        url,
        data: config?.params,
        headers: config?.headers,
        timeout: config?.timeout,
        validateStatus: () => true,
      });
      if (response.status === 407) {
        throw Object.assign(new Error('407 Proxy Authentication Required'), {
          response: { status: 407 },
        });
      }
      return this.convertResponse(response);
    } catch (error) {
      return this.withCurlFallback(error, url, 'POST', config);
    }
  }

  /**
   * 发送 DELETE 请求，4xx/5xx 不抛错，返回带状态码的响应
   */
  public async deleteAllowFailure(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    try {
      const response = await this.client.request({
        method: 'DELETE',
        url,
        data: config?.params,
        headers: config?.headers,
        timeout: config?.timeout,
        validateStatus: () => true,
      });
      if (response.status === 407) {
        throw Object.assign(new Error('407 Proxy Authentication Required'), {
          response: { status: 407 },
        });
      }
      return this.convertResponse(response);
    } catch (error) {
      return this.withCurlFallback(error, url, 'DELETE', config);
    }
  }

  /**
   * GET 二进制下载，4xx/5xx 不抛错，返回状态码 + 文本主体（用于错误判定）
   */
  public async getBinaryAllowFailure(
    url: string,
    config?: HttpRequestConfig
  ): Promise<{
    statusCode: number;
    statusText: string;
    buffer: Buffer;
    body: string;
  }> {
    try {
      const response = await this.client.request({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        headers: config?.headers,
        timeout: config?.timeout,
        validateStatus: () => true,
      });
      if (response.status === 407) {
        throw Object.assign(new Error('407 Proxy Authentication Required'), {
          response: { status: 407 },
        });
      }
      const buffer = Buffer.from(response.data);
      const body = buffer.toString('utf8');
      return {
        statusCode: response.status,
        statusText: response.statusText ?? '',
        buffer,
        body,
      };
    } catch (error) {
      const curlResp = await this.tryCurlFallback(
        error,
        url,
        'GET',
        config,
        true
      );
      if (curlResp?.bodyBuffer) {
        return {
          statusCode: curlResp.statusCode,
          statusText: curlResp.statusText,
          buffer: curlResp.bodyBuffer,
          body: curlResp.bodyBuffer.toString('utf8'),
        };
      }
      throw error;
    }
  }

  private async withCurlFallback(
    error: unknown,
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    const curlResp = await this.tryCurlFallback(
      error,
      url,
      method,
      config,
      false
    );
    if (curlResp) {
      return {
        data: curlResp.body,
        statusCode: curlResp.statusCode,
        statusText: curlResp.statusText,
        headers: curlResp.headers,
      };
    }
    throw error;
  }

  private async tryCurlFallback(
    error: unknown,
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    config?: HttpRequestConfig,
    binary = false
  ): Promise<CurlResponse | null> {
    if (
      process.platform !== 'win32' ||
      !(error instanceof Error) ||
      !isProxyRelatedError(error as AxiosError)
    ) {
      return null;
    }

    let data: string | undefined;
    let targetUrl = url;
    if (method === 'GET') {
      if (config?.params) {
        targetUrl = buildUrlWithParams(url, config.params);
      }
    } else if (config?.params !== undefined && config.params !== null) {
      data =
        typeof config.params === 'string'
          ? config.params
          : JSON.stringify(config.params);
    }
    return curlRequest({
      url: targetUrl,
      method,
      data,
      headers: config?.headers,
      timeoutMs: config?.timeout,
      binary,
    });
  }
}

/** HTTP 客户端单例实例 */
export const httpClient = new HttpClient();

function isProxyRelatedError(error: AxiosError): boolean {
  if (error.response?.status === 407) {
    return true;
  }

  const message = error.message ?? '';
  if (/proxy auth(?:oriz|entic)/i.test(message)) {
    return true;
  }

  return (
    error.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    error.code === 'CERT_HAS_EXPIRED' ||
    error.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  );
}

function buildUrlWithParams(url: string, params?: unknown): string {
  if (!params || typeof params !== 'object') {
    return url;
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(
    params as Record<string, unknown>
  )) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(`${key}[]`, String(item));
      }
    } else {
      searchParams.append(key, String(value));
    }
  }
  const query = searchParams.toString();
  if (!query) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${query}`;
}
