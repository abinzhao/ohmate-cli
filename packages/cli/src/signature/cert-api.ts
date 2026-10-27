/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { HttpResponse } from '../types/http.js';
import { httpClient } from '../utils/http-client.js';
import {
  CertConstants,
  SignatureEndpoints,
  SignatureErrorMessages,
  SignatureHttpStatusCode,
  SignatureResponseSignals,
} from '../config/signature.js';
import type {
  AuthInfo,
  CertInfo,
  CertListResponse,
  DownloadUrlList,
  DownloadUrlInfo,
} from './types.js';

function buildHeaders(auth: AuthInfo): Record<string, string> {
  return {
    uid: auth.uid,
    teamId: auth.teamId,
    oauth2Token: auth.accessToken,
  };
}

export function buildAutoSignCerName(
  teamId: string,
  isRelease: boolean = false
): string {
  const sanitized = teamId.replace(CertConstants.TEAM_ID_INVALID_CHARS, '');
  const prefix = isRelease
    ? CertConstants.CERT_NAME_PREFIX_RELEASE
    : CertConstants.CERT_NAME_PREFIX;
  return `${prefix}${sanitized}.cer`;
}

/**
 * 云侧错误映射（对齐 AutoSigningConfigsService#responseErrorMessage，并按真实 API 校准）
 * - statusCode 403 + reasonPhrase 精确匹配 Openproxy → 网络错误
 * - statusCode 403（其他，如无 AGC 权限） → 无 AGC 权限
 * - statusCode 401 → 登录失效（真实 reason: getTokenInfo return null）
 * - 响应体含 205389904 → 非 Harmony 用户
 * - 响应体含 205389872 → 证书数量上限
 * - 兜底：解析响应体取 ret.msg，无则 ERR_DOWNLOAD_CER
 *
 * 报错内容在 HTTP reason phrase（statusText），body 多为空；ret.code/ret.msg 在 body。
 */
export function mapCloudError(
  statusCode: number | undefined,
  reasonPhrase: string,
  body: string
): Error {
  if (statusCode === SignatureHttpStatusCode.FORBIDDEN) {
    if (reasonPhrase === SignatureResponseSignals.OPENPROXY_BLOCKED_URL) {
      return new Error(SignatureErrorMessages.ERR_CERT_NETWORK_ERROR);
    }
    return new Error(SignatureErrorMessages.ERR_FORBIDDEN);
  }
  if (statusCode === SignatureHttpStatusCode.UNAUTHORIZED) {
    return new Error(SignatureErrorMessages.ERR_UNAUTHORIZED);
  }
  if (body.includes(SignatureResponseSignals.USER_NOT_HARMONY_CODE)) {
    return new Error(SignatureErrorMessages.ERR_USER_NOT_HARMONY);
  }
  if (body.includes(SignatureResponseSignals.CERT_LIMIT_CODE)) {
    return new Error(SignatureErrorMessages.ERR_CERT_LIMIT_REACHED);
  }
  const retMsg = extractRetMsg(body);
  return new Error(retMsg ?? SignatureErrorMessages.ERR_DOWNLOAD_CER);
}

/**
 * 解析响应体取 ret.msg。
 * ret 可能是对象或 JSON 字符串，均支持。
 */
function extractRetMsg(body: string): string | null {
  const parsed = safeParseJson(body);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const ret = (parsed as { ret?: unknown }).ret;
  if (ret == null) {
    return null;
  }
  const retObj = typeof ret === 'string' ? safeParseJson(ret) : ret;
  if (retObj && typeof retObj === 'object') {
    const msg = (retObj as { msg?: unknown }).msg;
    if (typeof msg === 'string' && msg.trim() !== '') {
      return msg;
    }
  }
  return null;
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseResponseData<T>(data: string): T {
  return JSON.parse(data) as T;
}

export async function getCertList(auth: AuthInfo): Promise<CertInfo[]> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.CERT_LIST_PATH}`;
  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers: buildHeaders(auth),
  });
  if (response.statusCode !== 200) {
    throw mapCloudError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }
  const data = parseResponseData<CertListResponse>(response.data);
  return data?.certList ?? [];
}

export async function findCertByName(
  auth: AuthInfo,
  certName: string
): Promise<CertInfo | null> {
  const list = await getCertList(auth);
  return list.find((c) => c.certName === certName) ?? null;
}

export async function deleteRemoteCert(
  auth: AuthInfo,
  certId: string
): Promise<boolean> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.CERT_DELETE_PATH}`;
  const response: HttpResponse = await httpClient.deleteAllowFailure(url, {
    headers: buildHeaders(auth),
    params: { certIds: [certId] },
  });
  if (response.statusCode !== 200) {
    throw mapCloudError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }
  const data = parseResponseData<{ ret?: { code?: number } }>(response.data);
  return data?.ret?.code === 0;
}

/**
 * 云侧新增证书。成功 = 响应体含 `"code":0`；
 * 失败按 mapCloudError 抛对应错误（含证书上限 205389872）。
 */
export async function addCertificate(
  auth: AuthInfo,
  csrContent: string,
  certName: string,
  certType: string = CertConstants.CERT_TYPE_DEBUG
): Promise<void> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.CERT_ADD_PATH}`;
  const body = {
    csr: csrContent,
    certName,
    certType,
  };
  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers: buildHeaders(auth),
    params: body,
  });
  if (response.statusCode !== 200) {
    throw mapCloudError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }
  if (!response.data.includes(SignatureResponseSignals.SUCCESS_MARKER)) {
    throw mapCloudError(undefined, response.statusText, response.data);
  }
}

export async function getDownloadUrl(
  auth: AuthInfo,
  certObjectId: string
): Promise<DownloadUrlInfo | null> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.CERT_DOWNLOAD_URL_PATH}`;
  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers: buildHeaders(auth),
    params: { sourceUrls: certObjectId },
  });
  if (response.statusCode !== 200) {
    throw mapCloudError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }
  const data = parseResponseData<DownloadUrlList>(response.data);
  return data?.urlsInfo?.[0] ?? null;
}
