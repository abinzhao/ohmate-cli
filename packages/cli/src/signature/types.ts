/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface AuthInfo {
  uid: string;
  teamId: string;
  accessToken: string;
}

export interface CertInfo {
  id: string;
  certName: string;
  certObjectId: string;
}

export interface CertListResponse {
  certList: CertInfo[];
}

export interface DownloadUrlList {
  urlsInfo: DownloadUrlInfo[];
}

export interface GenerateCertificateResult {
  /** p12 密钥库绝对路径 */
  p12FilePath: string;
  /** csr 证书请求绝对路径 */
  csrFilePath: string;
  /** 下载的 .cer 证书绝对路径 */
  cerFilePath: string;
  /** profile 文件绝对路径 */
  profileFilePath: string;
  /** 云侧证书 id（HarmonyCertInfo.getId()，用于后续生成 profile） */
  certId: string;
  /** 密钥别名 */
  keyAlias: string;
  /** 明文密钥【高度敏感，禁止打印/持久化日志】 */
  keyPwd: string;
  /** 密钥库密码（与 keyPwd 相同） */
  storePassword: string;
}

export interface SignatureFiles {
  certPath: string;
  csrPath: string;
  p12Path: string;
  profilePath: string;
}

export interface AutoSignOptions {
  productName: string;
  bundleName: string;
  projectPath: string;
  teamId: string;
  force: boolean;
  aclPermissionList?: string[];
  allDeviceIds?: string[];
  certIds?: string[];
  keyAlias?: string;
  keyPwd?: string;
  /** 签名类型：'debug' | 'release'，默认 'debug' */
  type?: string;
}

export interface DownloadUrlInfo {
  sourceUrl: string;
  newUrl: string;
  fileName: number;
  sha256: string;
}

export interface DeviceInfo {
  id: string;
  udid: string;
  deviceName: string;
  deviceType?: string;
  createTime?: string;
}

export interface DevicePageResult {
  deviceList: DeviceInfo[];
  total: number;
}

export interface ProfileInfo {
  id: string;
  name: string;
  provisionFileUrl: string;
}
