/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import { CommonUtils } from '../utils/common-utils.js';

/**
 * parseApplyFileList
 *
 * 解析 apply 修改文件清单（.txt）。
 *
 * 职责：
 *  1. 读取 txt 清单，按行解析，跳过空行与 # 注释行
 *  2. 校验每条路径必须位于工程目录内（防路径穿越 + symlink 逃逸，复用 CommonUtils.isPathContainedWithSymlink）
 *  3. 校验每条路径在磁盘上真实存在
 *  4. 去重后返回绝对路径数组
 */
export function parseApplyFileList(txtPath: string, projectRoot: string): string[] {
  if (!fs.existsSync(txtPath)) {
    throw new Error(`Apply file list not found: ${txtPath}`);
  }
  const raw = fs.readFileSync(txtPath, 'utf-8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error('Apply file list is empty (no valid entries)');
  }

  const normalizedRoot = path.resolve(projectRoot);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const abs = path.resolve(normalizedRoot, line);
    const relativeLine = path.isAbsolute(line) ? path.relative(normalizedRoot, line) : line;
    if (relativeLine.startsWith('..')) {
      throw new Error(`File path is outside the project directory: ${line}`);
    }
    const check = CommonUtils.isPathContainedWithSymlink(relativeLine, normalizedRoot);
    if (!check.contained) {
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${line}`);
      }
      const suffix = check.reason ? `; ${check.reason}` : '';
      throw new Error(`File path is outside the project directory: ${line}${suffix}`);
    }
    if (!seen.has(abs)) {
      seen.add(abs);
      result.push(abs);
    }
  }
  return result;
}
