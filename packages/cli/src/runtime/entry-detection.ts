/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(url: string): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
