/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * HiLog 区段提取（cppcrash/extract_hilog.py 的移植）。
 *
 * HiLog 区段从首个以 'HiLog:' 开头的行开始，到文件末尾结束。
 */
/** 提取 HiLog 区段原文；无该区段时返回空串（由调用方决定是否报错）。 */
export function extractHilogText(lines: string[]): string {
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trimStart().startsWith('HiLog:')) {
      return lines.slice(index).join('\n');
    }
  }
  return '';
}
