/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { CertConstants, SignatureErrorMessages } from '../config/signature.js';
import { getAutoSignFilePath, type SignFileSuffix } from './signature-tool.js';
import { SignatureFiles } from './types';

/**
 * 本地签名材料后缀（对齐 AutoSigningHandleService#deleteLocalSignFiles：
 * 删除 getAutoSignFilePath() 基名下的 .p12/.cer/.csr/.p7b 四个文件）
 */
const LOCAL_MATERIAL_SUFFIXES: SignFileSuffix[] = ['p12', 'cer', 'csr', 'p7b'];

/**
 * 删除本地签名材料（p12/cer/csr/p7b）。
 * 在生成前统一清理 getAutoSignFilePath() 基名下的四个文件，
 * 避免 generate-keypair 因已存在且密码不同的 keystore 失败。
 * projectRoot 由调用方统一发现后传入，避免重复 discovery。
 */
export async function deleteLocalSignFiles(
  productName: string,
  projectRoot: string,
  type?: string
): Promise<void> {
  for (const suffix of LOCAL_MATERIAL_SUFFIXES) {
    const file = await getAutoSignFilePath(
      productName,
      projectRoot,
      suffix,
      type
    );
    await fs.rm(file, { force: true });
  }
}

/**
 * 校验已下载 .cer 的合法性（场景5）：regex 匹配 BEGIN/END CERTIFICATE。
 */
export function checkCertificateValidate(cerFilePath: string): void {
  let content: string;
  try {
    content = readFileSync(cerFilePath, 'utf-8');
  } catch {
    throw new Error(SignatureErrorMessages.ERR_CERT_INVALIDATE);
  }
  if (!CertConstants.CERT_PATTERN.test(content)) {
    throw new Error(SignatureErrorMessages.ERR_CERT_INVALIDATE);
  }
}

/**
 * 签名材料路径
 *
 * @param productName product
 * @param projectRoot 工程路径
 */
export async function resolveSignatureFilePaths(
  productName: string,
  projectRoot: string,
  type?: string
): Promise<SignatureFiles> {
  return {
    certPath: await getAutoSignFilePath(productName, projectRoot, 'cer', type),
    csrPath: await getAutoSignFilePath(productName, projectRoot, 'csr', type),
    p12Path: await getAutoSignFilePath(productName, projectRoot, 'p12', type),
    profilePath: await getAutoSignFilePath(
      productName,
      projectRoot,
      'p7b',
      type
    ),
  };
}
