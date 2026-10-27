/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 安装 ID 解析（对齐 codeGenie trace 上传接口的 device-token 算法）：
 * 初始化时在本机随机生成 UUIDv4 并落盘存储，不读取 MAC 地址、硬件或任何系统信息。
 * 同机同数据目录每次解析结果一致；删除数据目录后重新生成，重置前后的遥测事件无法关联到同一安装。
 * 多进程并发生成时以先写入者为准（wx 独占创建 + 失败重读），保证各进程 ID 一致。
 */
const INSTALL_ID_FILENAME = 'install-id';

function installFile(storageDir: string): string {
  return path.join(storageDir, INSTALL_ID_FILENAME);
}

/** 读取落盘的合法 UUIDv4；文件缺失、损坏或非 UUID 返回 null。 */
function readStoredId(file: string): string | null {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return isValidUuid(value) ? value : null;
  } catch {
    return null;
  }
}

/** 校验是否为合法 UUIDv4 字符串，避免读到脏文件后误用。 */
function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

/**
 * 解析本机安装 ID：随机 UUIDv4 生成后写入 `<storageDir>/install-id`。
 * 已存在则复用；并发竞争（wx 失败）时复用先写入者的 ID；写盘失败返回进程内 ID，下次进程重试。
 * 任何 fs 异常均被吞掉，解析失败不影响主流程。
 */
export function resolveInstallId(storageDir: string): string {
  const file = installFile(storageDir);
  const existing = readStoredId(file);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    try {
      fs.writeFileSync(file, id, { flag: 'wx' });
    } catch {
      // 并发进程已先写入：复用其 ID；内容损坏则覆盖重写
      const winner = readStoredId(file);
      if (winner) {
        return winner;
      }
      fs.writeFileSync(file, id);
    }
  } catch {
    // 目录或写盘失败（只读 fs 等）：返回进程内 ID，本次不落盘，下次进程重新生成
  }
  return id;
}
