/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import https from 'node:https';
import Endpoints from '../config/endpoints.json';

interface HttpResponse {
  code: number;
  body: string;
}

/**
 * codeGenie trace 上传器。
 * 协议对齐 test_upload 样例（uploader.ts flush）：
 * POST <endpoint>，headers 带 sender / deviceid，body 为明文 JSON 数组
 * [{ action, detail: <事件对象 JSON 字符串>, timestamp }, ...]。
 *
 * 上传器本身静默（不记 URL / 报文 / 响应体），成败由调用方 telemetry.ts 统一打 debug 日志。
 */
export class TraceUploader {
  static readonly ENDPOINT = Endpoints.devecoApiTraceUpload;
  static readonly SENDER = 'deveco-cli';

  public async upload(payload: string, installId: string): Promise<boolean> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      sender: TraceUploader.SENDER,
      deviceid: installId.replace(/-/g, ''),
      'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    };
    try {
      const { body: respBody } = await this.httpPost(
        TraceUploader.ENDPOINT,
        headers,
        Buffer.from(payload, 'utf8'),
        60000
      );
      return TraceUploader.isSuccess(respBody);
    } catch {
      return false;
    }
  }

  /**
   * 服务端返回体解析：`code` 或 `errorCode` 为 200 视为成功（兼容 number / string 两种类型）。
   * 实测响应格式为 `{"code":200,"message":"success"}`，故以 `code` 优先，`errorCode` 兜底。
   */
  private static isSuccess(body: string): boolean {
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown;
        errorCode?: unknown;
      };
      const resultCode = parsed?.code ?? parsed?.errorCode;
      return String(resultCode) === '200';
    } catch {
      return false;
    }
  }

  private async httpPost(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number
  ): Promise<HttpResponse> {
    const target = new URL(url);
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              code: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
