/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface SdkMeta {
  version: string;
}

interface SdkData {
  apiVersion: string | number;
  displayName: string;
  path: string;
  platformVersion: string;
  releaseType: string;
  version: string;
  stage: string;
}

interface SdkInfoJson {
  meta: SdkMeta;
  data: SdkData;
}

/**
 * 打印受限制的acl permission提示
 *
 * @param sdkPath sdk路径
 */
export function getApiVersionFromFile(sdkPath: string): number {
  const absolutePath = path.resolve(sdkPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`SDK info file not found: ${absolutePath}`);
  }

  let text: string;

  try {
    text = fs.readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read SDK info file: ${absolutePath}`, {
      cause: error,
    });
  }

  let json: SdkInfoJson;

  try {
    json = JSON.parse(text) as SdkInfoJson;
  } catch (error) {
    throw new Error(`Invalid JSON in SDK info file: ${absolutePath}`, {
      cause: error,
    });
  }

  const apiVersion = json?.data?.apiVersion;

  if (apiVersion === undefined || apiVersion === null || apiVersion === '') {
    throw new Error(
      `Missing data.apiVersion in SDK info file: ${absolutePath}`
    );
  }

  const apiVersionNumber = Number(apiVersion);

  if (!Number.isFinite(apiVersionNumber)) {
    throw new Error(
      `Invalid data.apiVersion in SDK info file: ${String(apiVersion)}`
    );
  }

  return apiVersionNumber;
}
