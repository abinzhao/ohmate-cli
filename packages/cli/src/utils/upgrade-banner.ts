/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { Command } from 'commander';

/**
 * 机器可读输出的命令必须保持 stdout 为单一可解析载荷，需跳过升级提示：
 * - `log --format json | hilog`：stdout 为 JSON 或 HiLog 文本，供管道/工具解析；
 * - `ui screenrecord status --format json`：stdout 为单个 JSON 对象。
 */
export function shouldSuppressUpgradeBanner(actionCommand: Command): boolean {
  const opts = actionCommand.opts() as { format?: string };
  if (actionCommand.name() === 'log') {
    return opts.format === 'json' || opts.format === 'hilog';
  }
  if (actionCommand.name() !== 'status' || opts.format !== 'json') {
    return false;
  }
  let current: Command | null = actionCommand.parent;
  while (current !== null) {
    if (current.name() === 'screenrecord') {
      return true;
    }
    current = current.parent;
  }
  return false;
}
