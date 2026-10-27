/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import querystring from 'querystring';
import { spawn } from 'child_process';
import { httpClient } from '../../utils/http-client';
import { debugLog } from '../../utils/logger';
import { AgreementConfig } from '../auth-config';

/**
 * 登录成功后上报隐私协议已签署（子进程方式，不阻塞主进程）
 * @param accessToken 用户的 accessToken
 */
export function reportAgreementSigned(accessToken: string): void {
  try {
    const signReq = JSON.stringify({
      signInfo: [
        { agrType: AgreementConfig.PRIVACY_ID, country: 'CN', language: 'zh_CN', isAgree: true },
      ],
    });
    const body = querystring.stringify({
      nsp_svc: 'as.user.sign',
      access_token: accessToken,
      request: signReq,
    });

    const child = spawn('curl', [
      '-s', '-X', 'POST', AgreementConfig.TMS_URL,
      '-H', 'Content-Type: application/x-www-form-urlencoded',
      '-d', body,
      '--max-time', '5',
      '-o', '/dev/null',
      '-w', '%{http_code}',
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.unref();
    child.stdout?.on('data', (data: Buffer) => {
      const code = data.toString().trim();
      if (code === '200') {
        debugLog('Agreement sign reported successfully');
      } else {
        debugLog(`Agreement sign failed: HTTP ${code}`);
      }
    }).on('error', () => {});
  } catch (err) {
    debugLog(`Agreement sign error: ${(err as Error).message}`);
  }
}

/**
 * 查询协议签署状态
 * @param accessToken 用户的 accessToken
 */
export async function queryAgreementStatus(accessToken: string): Promise<string> {
  const queryReq = JSON.stringify({
    obtainVersion: true,
    agrInfo: [
      { agrType: AgreementConfig.PRIVACY_ID, country: 'CN', signType: 0, branchId: 0 },
    ],
  });
  const body = querystring.stringify({
    nsp_svc: 'as.user.query',
    access_token: accessToken,
    request: queryReq,
  });

  const response = await httpClient.post(AgreementConfig.TMS_URL, {
    params: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
}