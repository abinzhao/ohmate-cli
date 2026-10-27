/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFileSync } from 'node:fs';
import { CertConstants, SignatureErrorMessages } from '../config/signature.js';
import { Project } from '../utils/project.js';
import type { AuthInfo, GenerateCertificateResult } from './types.js';
import {
  addCertificate,
  buildAutoSignCerName,
  deleteRemoteCert,
  findCertByName,
  getDownloadUrl,
} from './cert-api.js';
import { downloadFile } from './download.js';
import { checkCertificateValidate, deleteLocalSignFiles } from './local-material.js';
import { generateP12AndCSR, getAutoSignFilePath } from './signature-tool.js';

/**
 * 生成 HarmonyOS 自动签名证书。
 * 步骤3 由 generateP12AndCSR 生成本地 p12 + csr，并读取 csr 内容供云侧新增证书。
 * 本地 cer 路径与 p12/csr 共用 getAutoSignFilePath 基名；
 * 云侧证书名用 auto_debug_/auto_release_<teamId>.cer（buildAutoSignCerName）。
 *
 * @param auth 用户权限信息
 * @param productName 产品名
 * @param type 签名类型：'debug' | 'release'，默认 'debug'
 */
export async function generateCertificate(
  auth: AuthInfo,
  productName?: string,
  type?: string
): Promise<GenerateCertificateResult> {
  const product = productName ?? '';
  const projectRoot = Project.discover(process.cwd()).rootDir;

  await deleteLocalSignFiles(product, projectRoot, type);

  const certName = buildAutoSignCerName(auth.teamId, type === 'release');
  const existCert = await findCertByName(auth, certName);
  if (existCert) {
    const deleted = await deleteRemoteCert(auth, existCert.id);
    if (!deleted) {
      throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
    }
  }

  const p12AndCsr = await generateP12AndCSR(productName, undefined, undefined, type);
  let csrContent: string;
  try {
    csrContent = readFileSync(p12AndCsr.csrFilePath, 'utf-8');
  } catch {
    throw new Error(SignatureErrorMessages.ERR_READ_CSR);
  }

  console.log('Start generating certificate');
  const certType = type === 'release'
    ? CertConstants.CERT_TYPE_RELEASE : CertConstants.CERT_TYPE_DEBUG;
  await addCertificate(auth, csrContent, certName, certType);

  const newCert = await findCertByName(auth, certName);
  if (!newCert) {
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }

  const downloadUrlInfo = await getDownloadUrl(auth, newCert.certObjectId);
  if (!downloadUrlInfo) {
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }

  const cerFilePath = await getAutoSignFilePath(product, projectRoot, 'cer', type);
  await downloadFile(downloadUrlInfo.newUrl, cerFilePath, downloadUrlInfo.sha256);

  checkCertificateValidate(cerFilePath);

  const profileFilePath = await getAutoSignFilePath(product, projectRoot, 'p7b', type);

  return {
    p12FilePath: p12AndCsr.p12FilePath,
    csrFilePath: p12AndCsr.csrFilePath,
    cerFilePath,
    profileFilePath,
    certId: newCert.id,
    keyAlias: p12AndCsr.keyAlias,
    keyPwd: p12AndCsr.keyPwd,
    storePassword: p12AndCsr.keyPwd,
  };
}
