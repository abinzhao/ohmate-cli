/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { AuthInfo, AutoSignOptions, DownloadUrlInfo, ProfileInfo } from './types';
import {
  resolveSignatureFilePaths,
} from './local-material';
import fs from 'fs';
import { createHash } from 'crypto';
import { debugLog } from '../utils/logger.js';
import { debuglog } from 'node:util';
import { Buffer } from 'node:buffer';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as Forge from 'node-forge';
import { HttpResponse } from '../types/http';
import { httpClient } from '../utils/http-client';
import {
  CertConstants,
  SignatureEndpoints,
  SignatureErrorMessages,
  SignatureHttpStatusCode,
  SignatureResponseSignals,
} from '../config/signature';
import { downloadFile } from './download';

/**
 * 生成provision file
 *
 * @param auth 用户权限信息
 * @param options 签名信息（含 type: 'debug' | 'release'）
 */
export async function generateProfileFile(
  auth: AuthInfo,
  options: AutoSignOptions
): Promise<string> {
  console.log('Start generating profile');
  const { productName, bundleName, projectPath, aclPermissionList, allDeviceIds, certIds, keyAlias, keyPwd } = options;

  const isRelease = options.type === 'release';
  if (!isRelease && (allDeviceIds == null || allDeviceIds.length === 0)) {
    throw new Error(SignatureErrorMessages.DEVICE_LIST_EMPTY);
  }

  const provisionPath = isRelease
    ? SignatureEndpoints.PROVISION_ADD_REAL_PATH
    : SignatureEndpoints.PROVISION_ADD_TEST_PATH;
  const url = `${SignatureEndpoints.BASE_URL}${provisionPath}`;

  const finalProvisionName = generateProvisionName(productName, bundleName);
  const addProvisionResult = await addProvision(
    auth, url, certIds || [], bundleName, allDeviceIds ?? [], finalProvisionName, aclPermissionList || []
  );

  if (!addProvisionResult || !addProvisionResult.profileInfo || !addProvisionResult.profileInfo.provisionFileUrl) {
    debuglog('add provision failed, the provision file url is null');
    throw new Error(SignatureErrorMessages.ADD_PROFILE_FAIL);
  }

  const profileInfo = addProvisionResult.profileInfo;
  const downloadResult = await getDownLoadList(auth, profileInfo.provisionFileUrl);

  const urlList = downloadResult.urlList;
  const profileId = addProvisionResult.profileInfo.id;
  if (urlList && urlList.length > 0) {
    const signatureFiles = await resolveSignatureFilePaths(
      productName, projectPath, options.type
    );
    const profilePath = signatureFiles.profilePath;

    const downloaded = await downloadFromUrlList(urlList, profilePath);
    if (!downloaded) {
      await deleteProvision(auth, profileId);
      throw new Error(SignatureErrorMessages.ERROR_WHILE_DOWNLOAD_PROFILE);
    }

    await deleteProvision(auth, profileId);
    if (fs.existsSync(signatureFiles.certPath) && fs.existsSync(profilePath) && fs.existsSync(signatureFiles.p12Path)) {
      const certContent = fs.readFileSync(signatureFiles.certPath, 'utf8');
      const profileContent = fs.readFileSync(profilePath, 'utf8');

      const isValid = await checkCertificateInProfile(profileContent, certContent, signatureFiles.p12Path, keyAlias, keyPwd);

      if (!isValid) {
        deleteLocalSignFiles(profilePath);
      }
      return profilePath;
    }
  }
  throw new Error(SignatureErrorMessages.ADD_PROFILE_FAIL);
}

function generateProvisionName(
  productName: string,
  projectName: string
): string {
  const configPart = productName ? `${productName}_` : '';
  const hashStr = getHashString(`${configPart}${projectName}_${projectName}`);
  return `${hashStr}`;
}

function getHashString(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 16);
}

async function addProvision(
  auth: AuthInfo,
  url: string,
  certList: string[],
  packageName: string,
  deviceList: string[],
  provisionName: string,
  aclPermissionList: string[]
): Promise<{ profileInfo: ProfileInfo }> {
  validateBundleName(packageName);

  const headers = buildHeaders(auth);
  const body: Record<string, unknown> = {
    certList,
    packageName,
    provisionName,
  };
  if (deviceList.length > 0) {
    body.deviceList = deviceList;
  }
  if (aclPermissionList.length) {
    body.aclPermissionList = aclPermissionList;
  }

  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers,
    params: body,
  });

  if (!response) {
    debugLog('[generateProfile] add provision failed: response is null');
    throw new Error(SignatureErrorMessages.ADD_PROFILE_FAIL);
  }

  if (response.statusCode !== 200) {
    debugLog(`[generateProfile] add provision HTTP ${response.statusCode}: ${response.data}`);
    throw mapCloudProfileError(response.statusCode, response.statusText, response.data);
  }

  const data = JSON.parse(response.data);

  if (!data || !data.ret || data.ret.code !== 0) {
    debugLog(`[generateProfile] add provision fail: ${response.data}`);
    parsingAddProvisionException(response.data, provisionName);
    throw new Error(data.ret?.msg || SignatureErrorMessages.ADD_PROFILE_FAIL);
  }

  const provisionFileUrl = data.provisionFileUrl;
  const profileId = data.id;

  return {
    profileInfo: {
      id: profileId,
      name: provisionName,
      provisionFileUrl
    }
  };
}

/**
 * 云侧错误映射（对齐 AutoSigningConfigsService#responseErrorMessage，并按真实 API 校准）
 * - statusCode 403 + reasonPhrase 精确匹配 Openproxy → 网络错误
 * - statusCode 403（其他，如无 AGC 权限） → 无 AGC 权限
 * - statusCode 401 → 登录失效（真实 reason: getTokenInfo return null）
 * - 响应体含 205389938 → profile数量上限
 *
 * 报错内容在 HTTP reason phrase（statusText），body 多为空；ret.code 在 body。
 */
function mapCloudProfileError(
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
  if (body.includes(SignatureResponseSignals.PROVISION_EXCEEDS_LIMIT_CODE)) {
    return new Error(SignatureErrorMessages.TEST_PROVISION_EXCEEDS_LIMIT);
  }
  return new Error(SignatureErrorMessages.ADD_PROFILE_FAIL);
}

function validateBundleName(bundleName: string): void {
  if (!bundleName || bundleName.trim().length === 0) {
    throw new Error(SignatureErrorMessages.ERROR_SIGN_BUNDLE_NAME_VALIDATE);
  }
  if (!CertConstants.BUNDLE_NAME_REGEX.test(bundleName)) {
    throw new Error(SignatureErrorMessages.ERROR_SIGN_BUNDLE_NAME_VALIDATE);
  }
}

function parsingAddProvisionException(
  responseContent: string,
  provisionName?: string
): void {
  if (
    responseContent.includes(SignatureResponseSignals.PROVISION_EXCEEDS_LIMIT_CODE)
  ) {
    throw new Error(SignatureErrorMessages.TEST_PROVISION_EXCEEDS_LIMIT);
  }
  if (responseContent.includes(SignatureResponseSignals.PROVISION_NAME_REPEAT_CODE) && provisionName) {
    throw new Error(SignatureErrorMessages.PROFILE_NAME_REPEAT);
  }
}

async function deleteProvision(auth: AuthInfo, id: string): Promise<void> {
  if (!id || id.trim().length === 0) {
    return;
  }
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.PROVISION_DELETE_PATH}?id=${id}`;
  const response: HttpResponse = await httpClient.deleteAllowFailure(url, {
    headers: buildHeaders(auth)
  });
  if (response.statusCode !== 200) {
    throw mapCloudProfileError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }
  const data = JSON.parse(response.data);
  if (!data || !data.ret || data.ret.code !== 0) {
    debuglog(`delete provision failed: ${response.data}`);
  }
}

function deleteLocalSignFiles(...filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      debuglog(`delete local sign file error: ${(error as Error).message}`);
    }
  }
}

async function getDownLoadList(
  auth: AuthInfo,
  sourceUrl: string
): Promise<{ urlList: DownloadUrlInfo[] | null; hasPermission: boolean }> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.CERT_DOWNLOAD_URL_PATH}`;
  const headers = buildHeaders(auth);
  const body: Record<string, string> = {
    sourceUrls: sourceUrl,
  };

  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers,
    params: body,
  });

  if (!response) {
    debuglog('get download list failed:  response is null');
    throw new Error(SignatureErrorMessages.ADD_PROFILE_FAIL);
  }
  if (response.statusCode !== 200) {
    throw mapCloudProfileError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }

  const data = JSON.parse(response.data);
  if (!data || !data.urlsInfo || data.urlsInfo.length === 0) {
    debuglog('download: The application does not exist');
    throw new Error(data.ret?.msg || SignatureErrorMessages.ADD_PROFILE_FAIL);
  }

  return {
    urlList: data.urlsInfo,
    hasPermission: true,
  };
}

async function downloadFromUrlList(
  urlsInfo: DownloadUrlInfo[],
  filePath: string
): Promise<boolean> {
  if (!urlsInfo || urlsInfo.length === 0) {
    return false;
  }
  const first = urlsInfo[0];
  await downloadFile(first.newUrl, filePath, first.sha256);
  return true;
}

async function checkCertificateInProfile(
  profileContent: string,
  certificateContent: string,
  p12Path: string,
  keyAlias?: string,
  keyPwd?: string
): Promise<boolean> {
  containCerInProfile(profileContent, certificateContent);
  keyAlias = keyAlias ? keyAlias : CertConstants.TARGET_FRIENDLY_NAME;
  keyPwd = keyPwd ? keyPwd : '';
  await checkCertificateInValidityPeriod(certificateContent, p12Path, keyAlias, keyPwd);
  return true;
}

function containCerInProfile(
  profileContent: string,
  certificateContent: string
): boolean {
  if (certificateContent.lastIndexOf(CertConstants.CERT_BEGIN_HEADER) < 0) {
    throw new Error(SignatureErrorMessages.ERROR_WHILE_PARSE_PROFILE);
  }

  const lastCertificate = JSON.stringify(
    certificateContent.substring(certificateContent.lastIndexOf(CertConstants.CERT_BEGIN_HEADER))
  ).replace(/\\r/g, '');

  if (!profileContent.includes(lastCertificate)) {
    throw new Error(
      SignatureErrorMessages.CERTIFICATION_AND_PROFILE_NOT_INCONSISTENT
    );
  }

  return true;
}

async function checkCertificateInValidityPeriod(
  certFileContent: string,
  storeFile: string,
  keyAlias: string,
  keyPwd: string
): Promise<void> {
  const matcher = certFileContent.matchAll(CertConstants.CERTIFICATE_PATTERN_GLOBAL);
  const x509CertificateChain: X509Certificate[] = [];
  const now = new Date();

  for (const match of matcher) {
    try {
      const pemBlock = match[0];
      const certificate = decodeBase64ToX509Certificate(pemBlock);

      const validFrom = new Date(certificate.validFrom);
      const validTo = new Date(certificate.validTo);

      if (now < validFrom || now > validTo) {
        const msg = `Certificate is not valid, Valid from ${validFrom} to ${validTo}`;
        console.warn(`checkCertificateInValidityPeriod: ${msg}`);
        throw new Error(SignatureErrorMessages.CERTIFICATE_HAS_EXPIRED);
      }
      x509CertificateChain.push(certificate);
    } catch (error) {
      console.warn(
        `checkCertificateInValidityPeriod： ${(error as Error).message}`
      );
      throw new Error(SignatureErrorMessages.CERTIFICATE_HAS_EXPIRED, {
        cause: error,
      });
    }
  }

  if (!x509CertificateChain || x509CertificateChain.length === 0) {
    throw new Error(SignatureErrorMessages.CERTIFICATE_HAS_EXPIRED);
  }

  const matched = await isCertificateMatchedInP12(storeFile, keyAlias, keyPwd, x509CertificateChain);

  if (!matched) {
    throw new Error(
      SignatureErrorMessages.CERTIFICATION_AND_PROFILE_NOT_INCONSISTENT
    );
  }
}

function decodeBase64ToX509Certificate(encodeString: string): X509Certificate {
  const PEM_HEADER = '-----BEGIN CERTIFICATE-----';
  const trimmedStr = encodeString.trim();

  try {
    if (trimmedStr.startsWith(PEM_HEADER)) {
      return new X509Certificate(trimmedStr);
    }

    const derBuffer = Buffer.from(trimmedStr, 'base64');
    return new X509Certificate(derBuffer);
  } catch (error) {
    throw new Error('decodeBase64ToX509Certificate', { cause: error });
  }
}

function extractPublicKeyDerFromBag(bag: Forge.pkcs12.Bag, forge: typeof import('node-forge')): Buffer | null {
  if (bag.cert) {
    const pem = forge.pki.publicKeyToPem(bag.cert.publicKey);
    const keyObj = createPublicKey(pem);
    return keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  }
  if (bag.asn1) {
    try {
      const certDerBytes = forge.asn1.toDer(bag.asn1).getBytes();
      const certDerBuffer = Buffer.from(certDerBytes, 'binary');
      const x509 = new X509Certificate(certDerBuffer);
      return x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    } catch (parseErr) {
      debuglog(`Failed to parse cert from asn1: ${parseErr}`);
      return null;
    }
  }
  return null;
}

async function isCertificateMatchedInP12(
  p12FilePath: string, keyAlias: string, keyPwd: string,
  x509CertificateChain: X509Certificate[]): Promise<boolean> {
  try {
    // PKCS12 parsing is only needed by explicit signing and stays off the workbench startup path.
    const forge = (await import('node-forge')).default;
    const p12Buffer = readFileSync(p12FilePath);
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, keyPwd);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const bags = certBags[forge.pki.oids.certBag] || [];

    for (const bag of bags) {
      const friendlyName: string | undefined = bag.attributes?.friendlyName?.[0];

      if (!friendlyName || friendlyName.toLowerCase() !== keyAlias.toLowerCase()) {
        continue;
      }

      const targetDer = extractPublicKeyDerFromBag(bag, forge);
      if (!targetDer) {
        continue;
      }

      const matched = x509CertificateChain.some((chainCert) => {
        const chainDer = chainCert.publicKey.export({
          type: 'spki',
          format: 'der',
        });
        return targetDer.equals(chainDer);
      });

      if (matched) {
        return true;
      }
    }

    return false;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debuglog(
      `Failed to process P12 file: ${p12FilePath}, error: ${errorMessage}`
    );
    return false;
  }
}

function buildHeaders(auth: AuthInfo): Record<string, string> {
  return {
    uid: auth.uid,
    teamId: auth.teamId,
    oauth2Token: auth.accessToken,
  };
}
