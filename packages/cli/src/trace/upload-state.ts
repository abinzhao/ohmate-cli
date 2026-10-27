/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 上传间隔（毫秒）。MCP 调度器（startScheduler）与 CLI 后台触发（maybeSpawnTelemetryUpload）
 * 共用此阈值：MCP 按此间隔定时 flush；CLI 在 firstEventAt 距 now 超过此值时 spawn 后台进程。
 */
export const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;

/**
 * failed 文件重试间隔：CLI 后台 spawn 门控 + MCP startScheduler 的 retryTimer 共用。
 * 一轮重试要整文件 读 → 解密 → 重加密 → 回写，但单文件已被 TRACE_FILE_MAX_BYTES 封顶，
 * 代价有界（8 MiB / 约 7.6k 条，秒级），故保持 1h 以便断网恢复后尽快补传。
 */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** failed 文件保留上限：文件名日期超过此值直接删除（不再重试）。 */
export const FAILED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 单个打点文件字节上限（约 7.6k 条事件，单条密文行约 1.1KB）。
 * - 写入配额：moveToFailed 追加只保留装得进预算的最新事件，孤儿并回同受此限；
 * - 病态文件兜底：超限即历史遗留/异常堆积，直接丢弃，避免磁盘被无上限占用与超长重试。
 * live 文件每 UPLOAD_INTERVAL_MS 就被抽干一次，正常永远到不了配额，超限即病态/历史遗留。
 */
export const TRACE_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** `.pending` 视为中断遗留孤儿的 mtime 阈值：超过则回收（并回同名 .txt 或删除）。 */
export const PENDING_STALE_MS = 60 * 60 * 1000;

/** 在途认领后缀：flushFile rename `.txt` → `.txt.pending` 后、上传完成前的文件名。 */
const PENDING_SUFFIX = '.pending';

/** reclaim 认领后缀：`<base>.pending.reclaim-<pid>-<ts>`，回收方崩溃时的遗留形态。 */
const RECLAIM_SUFFIX_PATTERN = /\.reclaim-\d+-\d+$/;

/** 打点总开关（env `DEVECO_CLI_DISABLE_TELEMETRY=1`）：关闭后不采集、不落盘、不上传。 */
export function isTelemetryDisabled(): boolean {
  const value = process.env.DEVECO_CLI_DISABLE_TELEMETRY;
  return value === '1' || value === 'true';
}

export interface UploadState {
  /** 自上次上传以来第一条事件的时间戳（ms）；null 表示无待上传事件 */
  firstEventAt: number | null;
  /** 上次成功上传的时间戳（ms）；null 表示从未上传过 */
  lastUploadAt: number | null;
  /** 上次 failed 重试的时间戳（ms）；null 表示从未重试过 */
  lastRetryAt: number | null;
}

const STATE_FILENAME = 'upload-state.json';

function stateFile(storageDir: string): string {
  return path.join(storageDir, STATE_FILENAME);
}

function defaultState(): UploadState {
  return { firstEventAt: null, lastUploadAt: null, lastRetryAt: null };
}

export function readUploadState(storageDir: string): UploadState {
  try {
    const raw = fs.readFileSync(stateFile(storageDir), 'utf8');
    const obj = JSON.parse(raw) as Partial<UploadState>;
    return {
      firstEventAt:
        typeof obj.firstEventAt === 'number' ? obj.firstEventAt : null,
      lastUploadAt:
        typeof obj.lastUploadAt === 'number' ? obj.lastUploadAt : null,
      lastRetryAt: typeof obj.lastRetryAt === 'number' ? obj.lastRetryAt : null,
    };
  } catch {
    return defaultState();
  }
}

export function writeUploadState(storageDir: string, state: UploadState): void {
  try {
    fs.writeFileSync(stateFile(storageDir), JSON.stringify(state), 'utf8');
  } catch {
    // 打点状态写盘失败不应影响主流程
  }
}

/** 记录一条事件时调用：若 firstEventAt 为空则置为当前时间，标记本轮待上传批次起点。 */
export function markFirstEventIfPending(storageDir: string): void {
  const state = readUploadState(storageDir);
  if (state.firstEventAt === null) {
    state.firstEventAt = Date.now();
    writeUploadState(storageDir, state);
  }
}

/** flush 完成后调用：更新 lastUploadAt，重置 firstEventAt（下一轮事件重新计时）。 */
export function markUploadComplete(storageDir: string): void {
  const state = readUploadState(storageDir);
  state.lastUploadAt = Date.now();
  state.firstEventAt = null;
  writeUploadState(storageDir, state);
}

/** retryFailed 完成后调用：更新 lastRetryAt（CLI 后台 spawn 据此按 1h 门控 failed 重试）。 */
export function markRetryComplete(storageDir: string): void {
  const state = readUploadState(storageDir);
  state.lastRetryAt = Date.now();
  writeUploadState(storageDir, state);
}

/** 解析 `telemetry-YYYY-MM-DD.txt` 文件名中的日期为本地 0 点 ms；无法解析返回 null。 */
export function parseFailedFileDate(fileName: string): number | null {
  const m = fileName.match(/^telemetry-(\d{4})-(\d{2})-(\d{2})\.txt$/);
  if (!m) {
    return null;
  }
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 孤儿名 → 回收目标 `.txt` 文件名：剥掉 reclaim 认领后缀与 `.pending`。
 * 非孤儿（普通 `.txt`、其它文件、剥完不是 `.txt`）返回 null。
 */
export function orphanTargetName(fileName: string): string | null {
  if (!fileName.startsWith('telemetry-')) {
    return null;
  }
  const reclaim = RECLAIM_SUFFIX_PATTERN.exec(fileName);
  const pendingName = reclaim ? fileName.slice(0, reclaim.index) : fileName;
  if (!pendingName.endsWith(PENDING_SUFFIX)) {
    return null;
  }
  const target = pendingName.slice(0, -PENDING_SUFFIX.length);
  return target.endsWith('.txt') ? target : null;
}

/** 目录条目是否为待回收孤儿：在途 `.pending`，或回收方崩溃遗留的 `.pending.reclaim-*`。 */
export function isOrphanPendingName(fileName: string): boolean {
  return orphanTargetName(fileName) !== null;
}

/** `.pending` 文件是否已陈旧到可判定为进程中断遗留（读不到 stat 视为否）。 */
export function isStalePending(
  file: string,
  now: number = Date.now()
): boolean {
  try {
    return now - fs.statSync(file).mtimeMs >= PENDING_STALE_MS;
  } catch {
    return false;
  }
}

/** 目录内是否存在陈旧的 `.pending` 孤儿（含 reclaim 认领遗留）。 */
export function hasStaleOrphanPending(
  dir: string,
  now: number = Date.now()
): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(
    (f) => isOrphanPendingName(f) && isStalePending(path.join(dir, f), now)
  );
}

/**
 * 是否存在需要后台上传进程处理的文件：
 * - storageDir / failed 目录里 mtime 超过 PENDING_STALE_MS 的孤儿（待回收）；或
 * - failed 目录里文件名日期在 7 天内的 `.txt`（待重试）。
 * storageDir 的 `.txt` 不在此列：它们由 firstEventAt 门控（UPLOAD_INTERVAL_MS）负责。
 */
export function hasPendingUploadWork(
  storageDir: string,
  now: number = Date.now()
): boolean {
  if (hasStaleOrphanPending(storageDir, now)) {
    return true;
  }
  const failedDir = path.join(storageDir, 'failed');
  if (hasStaleOrphanPending(failedDir, now)) {
    return true;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(failedDir);
  } catch {
    return false;
  }
  for (const f of entries) {
    if (!f.startsWith('telemetry-') || !f.endsWith('.txt')) {
      continue;
    }
    const t = parseFailedFileDate(f);
    if (t !== null && now - t <= FAILED_MAX_AGE_MS) {
      return true;
    }
  }
  return false;
}

/**
 * 判断是否应 spawn 后台上传进程（OR 逻辑）：
 * - 有待上传事件且最早事件已等待超过 UPLOAD_INTERVAL_MS；或
 * - 有孤儿 `.pending` 待回收，或 failed 目录有 7 天内的 `.txt` 待重试，
 *   且距上次重试超过 RETRY_INTERVAL_MS。
 * 任一成立即 spawn 同一进程，进程内 flush + retryFailed 一起执行。
 */
export function isUploadDue(
  storageDir: string,
  now: number = Date.now()
): boolean {
  const state = readUploadState(storageDir);
  if (
    state.firstEventAt !== null &&
    now - state.firstEventAt >= UPLOAD_INTERVAL_MS
  ) {
    return true;
  }
  if (
    hasPendingUploadWork(storageDir, now) &&
    (state.lastRetryAt === null || now - state.lastRetryAt >= RETRY_INTERVAL_MS)
  ) {
    return true;
  }
  return false;
}
