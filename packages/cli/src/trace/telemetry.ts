/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceUploader } from './trace-uploader.js';
import { eventSerializer } from './json-serializer.js';
import {
  decryptTraceLine,
  encryptTraceLine,
  resolveTraceFileKey,
} from './file-crypto.js';
import { mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';
import type { BaseEvent, TrackMeasurement, TraceEvent } from './events.js';
import {
  FAILED_MAX_AGE_MS,
  PENDING_STALE_MS,
  RETRY_INTERVAL_MS,
  TRACE_FILE_MAX_BYTES,
  UPLOAD_INTERVAL_MS,
  isOrphanPendingName,
  isTelemetryDisabled,
  markFirstEventIfPending,
  markRetryComplete,
  markUploadComplete,
  orphanTargetName,
  parseFailedFileDate,
} from './upload-state.js';
import { resolveInstallId } from './install-id.js';

export class Telemetry {
  private static readonly MAX_BATCH = 200;
  /** 单批 payload 字节数上限(约 1.7 MiB) */
  private static readonly MAX_PAYLOAD_BYTES = Math.floor(1.7 * 1024 * 1024);
  /** 打点平台版本 */
  private static readonly TRACE_OS_VERSION = '1.0';
  private static readonly COUNTRY_CODE = 'CN';
  private static readonly EVENT_PREFIX = 'devecocli_';
  private readonly uploader = new TraceUploader();
  private storageDir = '';
  private failedDir = '';
  private installId = '';
  /** 打点总开关：关闭后不采集/不落盘/不上传（upload-state.ts isTelemetryDisabled） */
  private readonly disabled = isTelemetryDisabled();
  /** 落盘加密密钥，由本机独立随机密钥派生，不随事件上报（file-crypto.ts） */
  private traceFileKey: Buffer = Buffer.alloc(0);
  private readonly sessionId = crypto.randomUUID();
  private cliVersion = '';
  private devecoStudioVersion: string | null = null;
  private sourceType = '';
  private cltVersion: string | null = null;
  private nodeVersion = '';
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private retryInitialTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  /** flush / retryFailed 串行化链：同进程内不并发，避免并发写同一 failed 文件 */
  private flushChain: Promise<unknown> = Promise.resolve();

  constructor() {
    mcpLog.debug(`[telemetry] instance created, sessionId=${this.sessionId}`);
  }

  init(storageDir: string): void {
    this.storageDir = storageDir;
    this.failedDir = path.join(storageDir, 'failed');
    this.cliVersion = process.env.npm_package_version || '0.0.0';
    this.nodeVersion = process.version;
    this.installId = resolveInstallId(storageDir).replace(/-/g, '');
    this.traceFileKey = resolveTraceFileKey(storageDir);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(this.failedDir, { recursive: true });
    mcpLog.debug(
      `[telemetry] init: dir=${storageDir}, failedDir=${this.failedDir}, ` +
        `cliVersion=${this.cliVersion}, os=${this.resolveOsName()}, arch=${this.resolveOsArch()}, node=${this.nodeVersion}`
    );
  }

  setStudioVersion(version: string): void {
    this.devecoStudioVersion = version;
    mcpLog.debug(`[telemetry] studio version set: ${version}`);
  }

  setSourceType(sourceType: string): void {
    this.sourceType = sourceType;
    mcpLog.debug(`[telemetry] sourceType set: ${sourceType}`);
  }

  setCltVersion(version: string): void {
    this.cltVersion = version;
    mcpLog.debug(`[telemetry] CLT version set: ${version}`);
  }

  track<T>(event: BaseEvent, fn: () => Promise<T> | T): Promise<T>;
  track(event: BaseEvent, measurement: TrackMeasurement): Promise<void>;
  track(event: BaseEvent): Promise<void>;
  async track<T>(
    event: BaseEvent,
    fnOrMeasurement?: (() => Promise<T> | T) | TrackMeasurement
  ): Promise<T | undefined> {
    if (this.disabled) {
      // 关闭打点：不采集不记录，但 fn 照常执行并透传结果/异常
      if (typeof fnOrMeasurement === 'function') {
        return fnOrMeasurement();
      }
      return undefined;
    }
    if (!this.storageDir) {
      throw new Error('Telemetry not initialized. Call init() first.');
    }
    if (!fnOrMeasurement) {
      await this.record(event, 0, true, null);
      return undefined;
    }
    if (typeof fnOrMeasurement !== 'function') {
      const m = fnOrMeasurement;
      await this.record(event, m.duration_ms, m.success, m.error_code);
      return undefined;
    }
    const fn = fnOrMeasurement;
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      await this.record(event, duration, true, null);
      return result;
    } catch (e) {
      const duration = Date.now() - start;
      const code = this.toErrorCode(e);
      await this.record(event, duration, false, code);
      throw e;
    }
  }

  private async record(
    event: BaseEvent,
    durationMs: number,
    success: boolean,
    errorCode: string | null
  ): Promise<void> {
    const traceEvent = this.buildTraceEvent(
      event,
      durationMs,
      success,
      errorCode
    );
    try {
      const line = encryptTraceLine(
        JSON.stringify(traceEvent),
        this.traceFileKey
      );
      await fs.promises.appendFile(this.currentFile(), line + '\n', 'utf8');
      markFirstEventIfPending(this.storageDir);
    } catch {
      // 落盘失败静默，不影响主流程
    }
  }

  private buildTraceEvent(
    event: BaseEvent,
    durationMs: number,
    success: boolean,
    errorCode: string | null
  ): TraceEvent {
    const wireEvent = `${Telemetry.EVENT_PREFIX}${event.event}`;
    const eventDetail = eventSerializer.toObject(event) as Record<
      string,
      unknown
    >;
    if (eventDetail && typeof eventDetail === 'object') {
      delete eventDetail.event;
    }
    return {
      countryCode: Telemetry.COUNTRY_CODE,
      event: wireEvent,
      eventtime: String(Date.now()),
      properties: {
        uid: this.installId,
        trace_uuid: crypto.randomUUID(),
        trace_os_version: Telemetry.TRACE_OS_VERSION,
        os_arch: this.resolveOsArch(),
        action: wireEvent,
        trace_os_name: this.resolveOsName(),
        version: `${this.cliVersion}_${this.resolveOsSuffix()}`,
        deveco_studio_version: this.formatVersion(this.devecoStudioVersion),
        command_line_version: this.formatVersion(this.cltVersion),
        source_type: this.sourceType,
        session_id: this.sessionId,
        node_version: this.nodeVersion,
        ram: this.resolveTotalRam(),
        duration_ms: durationMs,
        success,
        error_code: errorCode,
        event_detail: eventDetail,
      },
    };
  }

  private toErrorCode(e: unknown): string {
    if (e instanceof Error) {
      const code = (e as NodeJS.ErrnoException).code;
      return code ?? e.name;
    }
    return 'UnknownError';
  }

  private resolveOsArch(): string {
    const arch = os.arch();
    return arch === 'x64' ? 'amd64' : arch;
  }

  private resolveOsName(): string {
    switch (process.platform) {
      case 'win32': {
        const parts = os.release().split('.');
        const build = parseInt(parts[parts.length - 1], 10) || 0;
        return build >= 22000 ? 'Windows 11' : 'Windows 10';
      }
      case 'darwin':
        return 'macOS';
      case 'linux':
        return 'Linux';
      default:
        return process.platform;
    }
  }

  private resolveOsSuffix(): string {
    switch (process.platform) {
      case 'win32':
        return 'windows';
      case 'darwin':
        return os.arch() === 'arm64' ? 'mac_arm' : 'mac';
      default:
        return 'linux';
    }
  }

  private resolveTotalRam(): string {
    const kb = Math.round(os.totalmem() / 1024);
    return `${kb}KB`;
  }

  /** 版本格式化：有值则 `<version>_<os>`，无值则空字符串。 */
  private formatVersion(version: string | null): string {
    return version ? `${version}_${this.resolveOsSuffix()}` : '';
  }

  private dateString(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  private currentFile(): string {
    return path.join(this.storageDir, `telemetry-${this.dateString()}.txt`);
  }

  startScheduler(): void {
    this.stopScheduler();
    if (this.disabled) {
      mcpLog.debug('[telemetry] scheduler not started (telemetry disabled)');
      return;
    }
    mcpLog.debug(
      `[telemetry] scheduler started (flush every ${UPLOAD_INTERVAL_MS / 1000}s, retry failed every ${RETRY_INTERVAL_MS / 1000}s)`
    );
    this.initialTimer = setTimeout(() => {
      this.flush().catch(() => {
        /* 调度内 flush 失败静默，不阻塞下一轮 */
      });
      this.intervalTimer = setInterval(() => {
        this.flush().catch(() => {
          /* 调度内 flush 失败静默，不阻塞下一轮 */
        });
      }, UPLOAD_INTERVAL_MS);
    }, UPLOAD_INTERVAL_MS);
    this.retryInitialTimer = setTimeout(() => {
      this.retryFailed().catch(() => {
        /* 调度内 retry 失败静默，不阻塞下一轮 */
      });
      this.retryTimer = setInterval(() => {
        this.retryFailed().catch(() => {
          /* 调度内 retry 失败静默，不阻塞下一轮 */
        });
      }, RETRY_INTERVAL_MS);
    }, RETRY_INTERVAL_MS);
  }

  stopScheduler(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.retryInitialTimer) {
      clearTimeout(this.retryInitialTimer);
      this.retryInitialTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    mcpLog.debug('[telemetry] scheduler stopped');
  }

  async flush(): Promise<boolean> {
    if (this.disabled) {
      return true;
    }
    return this.runExclusive(() => this.performFlush());
  }

  private async performFlush(): Promise<boolean> {
    if (!this.storageDir) {
      throw new Error('Telemetry not initialized. Call init() first.');
    }
    const files = await this.listPendingFiles();
    let allOk = true;
    for (const file of files) {
      if (!(await this.flushFile(file))) {
        allOk = false;
      }
    }
    markUploadComplete(this.storageDir);
    return allOk;
  }

  /**
   * 重试 failed 目录下上传失败的事件文件（每 RETRY_INTERVAL_MS 一次，由 startScheduler 调度）。
   * 先回收两处目录里中断遗留的 `.pending` 孤儿，再处理 failed/telemetry-*.txt：
   * 文件名日期在 7 天内的重新走 flushFile 上传，超过 7 天的直接删除。
   * 与 flush() 共用 runExclusive 串行化。
   */
  async retryFailed(): Promise<boolean> {
    if (this.disabled) {
      return true;
    }
    return this.runExclusive(() => this.performRetryFailed());
  }

  private async performRetryFailed(): Promise<boolean> {
    if (!this.storageDir) {
      throw new Error('Telemetry not initialized. Call init() first.');
    }
    await this.reclaimStalePending();
    const now = Date.now();
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.failedDir);
    } catch {
      return true;
    }
    const files = entries
      .filter((f) => f.startsWith('telemetry-') && f.endsWith('.txt'))
      .map((f) => path.join(this.failedDir, f));
    let allOk = true;
    for (const file of files) {
      const baseName = path.basename(file);
      const eventTime = parseFailedFileDate(baseName);
      if (eventTime === null) {
        continue;
      }
      if (now - eventTime > FAILED_MAX_AGE_MS) {
        try {
          await fs.promises.unlink(file);
        } catch {
          // ignore
        }
        continue;
      }
      // 复用 flushFile：rename → .pending 认领、解密、批量上传；
      // 失败时 moveToFailed 会把剩余行写回 failedDir/<baseName>（同名），等下轮重试。
      if (!(await this.flushFile(file))) {
        allOk = false;
      }
    }
    if (!allOk) {
      mcpLog.warn('[telemetry] retry failed');
    }
    markRetryComplete(this.storageDir);
    return allOk;
  }

  /**
   * 回收中断遗留的 `.pending` 孤儿（storageDir 与 failedDir 两处，含 reclaim 认领遗留）：
   * mtime 超过 PENDING_STALE_MS 的，预算内原样并回同名 `.txt` 重新进入重试链路；
   * 超预算（历史遗留大文件）直接删除，避免磁盘被无上限占用。
   */
  private async reclaimStalePending(): Promise<void> {
    const now = Date.now();
    for (const dir of [this.storageDir, this.failedDir]) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (isOrphanPendingName(entry)) {
          await this.reclaimOrphan(path.join(dir, entry), now);
        }
      }
    }
  }

  /**
   * 单个孤儿：未陈旧的跳过（可能仍在被其它进程处理）；陈旧的先原子认领，
   * 再按预算并回同名 `.txt`；超预算（历史遗留大文件）直接删除，避免磁盘被无上限占用；
   * 合并本身失败（IO 错误）则保留认领文件等下一轮重试，不与"超预算丢弃"混为一谈。
   */
  private async reclaimOrphan(orphan: string, now: number): Promise<void> {
    let size: number;
    try {
      const st = await fs.promises.stat(orphan);
      if (now - st.mtimeMs < PENDING_STALE_MS) {
        return;
      }
      size = st.size;
    } catch {
      return;
    }
    const dir = path.dirname(orphan);
    const targetName = orphanTargetName(path.basename(orphan));
    if (targetName === null) {
      return;
    }
    const claimed = await this.claimOrphan(orphan, dir, targetName);
    if (claimed === null) {
      return;
    }
    const target = path.join(dir, targetName);
    const budget = TRACE_FILE_MAX_BYTES - (await this.fileSize(target));
    if (size > budget) {
      try {
        await fs.promises.unlink(claimed);
      } catch {
        // ignore
      }
      mcpLog.warn(
        `[telemetry] dropped stale orphan pending: ${claimed} ` +
          `(${size} bytes > budget ${budget})`
      );
      return;
    }
    if (await this.mergeOrphanInto(claimed, target)) {
      mcpLog.warn(
        `[telemetry] reclaimed orphan pending: ${claimed} (${size} bytes)`
      );
      return;
    }
    // 认领文件名仍匹配 isOrphanPendingName，且 claimOrphan 已刷新 mtime，
    // 因此保留它既不会被本轮重复认领，也能在下一轮被重新回收。
    mcpLog.warn(
      `[telemetry] merge failed, kept orphan pending for retry: ${claimed} ` +
        `(${size} bytes)`
    );
  }

  /**
   * 原子认领孤儿：rename 到 `<base>.pending.reclaim-<pid>-<ts>`（顺带剥掉上一轮 reclaim
   * 遗留的后缀，避免文件名逐轮变长），rename 失败即已被其它进程抢走，返回 null。
   * 认领后立刻刷新 mtime——rename 保留旧 mtime，不刷新会被其它进程当作陈旧孤儿再次认领。
   */
  private async claimOrphan(
    orphan: string,
    dir: string,
    targetName: string
  ): Promise<string | null> {
    const claimed = path.join(
      dir,
      `${targetName}.pending.reclaim-${process.pid}-${Date.now()}`
    );
    try {
      await fs.promises.rename(orphan, claimed);
    } catch {
      return null;
    }
    await this.touch(claimed);
    return claimed;
  }

  /**
   * 两侧都是「一行一个密文 blob」，原样字节追加即可，无需解密重加密。
   * 追加失败返回 false（调用方保留孤儿等下轮重试）；追加成功后删除残留失败只记日志，数据已进 target。
   */
  private async mergeOrphanInto(
    orphan: string,
    target: string
  ): Promise<boolean> {
    try {
      await fs.promises.appendFile(target, await fs.promises.readFile(orphan));
    } catch (err) {
      mcpLog.warn(
        `[telemetry] merge orphan pending failed: ${orphan} -> ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }
    try {
      await fs.promises.unlink(orphan);
    } catch (err) {
      mcpLog.warn(
        `[telemetry] merged but failed to remove orphan pending: ${orphan}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return true;
  }

  /** 文件字节数；不存在或读取失败返回 0。 */
  private async fileSize(file: string): Promise<number> {
    try {
      return (await fs.promises.stat(file)).size;
    } catch {
      return 0;
    }
  }

  /** 把 mtime 刷成当前时间；失败忽略（只影响孤儿判定推迟一轮，不影响正确性）。 */
  private async touch(file: string): Promise<void> {
    const now = new Date();
    try {
      await fs.promises.utimes(file, now, now);
    } catch {
      // ignore
    }
  }

  /** 串行化 flush / retryFailed：同进程内排队执行，避免并发写同一 failed 文件。 */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => fn();
    const result = this.flushChain.then(run, run);
    this.flushChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async listPendingFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.storageDir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.startsWith('telemetry-') && f.endsWith('.txt'))
      .map((f) => path.join(this.storageDir, f))
      .sort();
  }

  private async flushFile(file: string): Promise<boolean> {
    const size = await this.fileSize(file);
    if (size > TRACE_FILE_MAX_BYTES) {
      // 超限即病态/历史遗留文件，直接丢弃，避免磁盘被无上限占用与超长重试
      mcpLog.warn(
        `[telemetry] ${path.basename(file)} is ${size} bytes ` +
          `(> ${TRACE_FILE_MAX_BYTES}), dropped without uploading`
      );
      try {
        await fs.promises.unlink(file);
      } catch {
        // ignore
      }
      return true;
    }
    const pendingFile = file + '.pending';
    try {
      await fs.promises.rename(file, pendingFile);
    } catch {
      return false;
    }
    // rename 保留旧 mtime（事件可能是几小时前写入的）：刷新为当前时间，
    // 否则在途 .pending 会被其它进程立刻误判为陈旧孤儿，并回 .txt 造成重复上传
    await this.touch(pendingFile);
    let content: string;
    try {
      content = await fs.promises.readFile(pendingFile, 'utf8');
    } catch {
      return false;
    }
    const rawLines = content
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawLines.length === 0) {
      try {
        await fs.promises.unlink(pendingFile);
      } catch {
        // ignore
      }
      return true;
    }
    // 不在此全量解密：原始密文行交 uploadInBatches 按批惰性解密，
    // 峰值内存仅约文件大小（不再 4~5 倍）；失败时原始密文行原样写回 failed
    return this.uploadInBatches(pendingFile, rawLines);
  }

  /** 从 rawLines[cursor] 起惰性解密最多 MAX_BATCH 条，坏行跳过，遇 payload 字节上限即停。返回本批明文与消费后的 cursor。 */
  private collectDecryptBatch(
    rawLines: string[],
    cursor: number
  ): { batch: string[]; next: number } {
    const batch: string[] = [];
    let approxBytes = 16; // [{action,detail,timestamp}] 基础开销
    let i = cursor;
    while (i < rawLines.length && batch.length < Telemetry.MAX_BATCH) {
      const plain = decryptTraceLine(rawLines[i], this.traceFileKey);
      if (plain === null) {
        i++;
        continue; // 坏行跳过，但仍消费 cursor
      }
      const inc = Buffer.byteLength(plain, 'utf8') + 1; // +1 comma
      if (batch.length > 0 && approxBytes + inc > Telemetry.MAX_PAYLOAD_BYTES) {
        break;
      }
      batch.push(plain);
      approxBytes += inc;
      i++;
    }
    return { batch, next: i };
  }

  /** 分批上传：任一批失败即把「该批起」的剩余密文写回 failed 并停止。 */
  private async uploadInBatches(
    pendingFile: string,
    rawLines: string[]
  ): Promise<boolean> {
    let cursor = 0;
    while (cursor < rawLines.length) {
      const batchStart = cursor;
      const { batch: plainBatch, next } = this.collectDecryptBatch(
        rawLines,
        cursor
      );
      cursor = next;
      const items = this.buildPayloadItems(plainBatch);
      if (items.length === 0) {
        continue; // 本批全为坏行，cursor 已推进
      }
      const payload = JSON.stringify(items);
      let ok = false;
      try {
        ok = await this.uploader.upload(payload, this.installId);
      } catch {
        // upload 异常按失败处理，下面统一打 debug 日志
      }
      if (!ok) {
        mcpLog.warn('[telemetry] upload failed');
        // 剩余原始密文行原样写回 failed，无需 re-encrypt
        const remaining = rawLines.slice(batchStart).join('\n') + '\n';
        await this.moveToFailed(pendingFile, remaining);
        return false;
      }
    }
    try {
      await fs.promises.unlink(pendingFile);
    } catch {
      // ignore
    }
    return true;
  }

  /** 原始 TraceEvent 行 → 新接口数组元素：action 取原 event 字段，detail 传 properties 层（去掉 countryCode 等外层）。 */
  private buildPayloadItems(
    lines: string[]
  ): { action: string; detail: string; timestamp: number }[] {
    const items: { action: string; detail: string; timestamp: number }[] = [];
    for (const line of lines) {
      try {
        const traceEvent = JSON.parse(line) as TraceEvent;
        items.push({
          action: traceEvent.event,
          detail: JSON.stringify(traceEvent.properties),
          timestamp: Number(traceEvent.eventtime) || Date.now(),
        });
      } catch {
        // 跳过无法解析的行
      }
    }
    return items;
  }

  /**
   * 上传失败后把剩余原始密文行追加回 failedDir/&lt;baseName&gt;。源文件已在 flushFile 里被
   * rename 认领，这里写的是重建的同名文件，不会重复累积；追加受 TRACE_FILE_MAX_BYTES
   * 约束，预算不足时只保留最新事件，较旧的直接丢弃。行已是密文，原样写入无需 re-encrypt。
   */
  private async moveToFailed(
    pendingFile: string,
    rawContent: string
  ): Promise<void> {
    const baseName = path.basename(pendingFile, '.pending');
    const failedPath = path.join(this.failedDir, baseName);
    const lines = rawContent.split('\n').filter(Boolean);
    const budget = TRACE_FILE_MAX_BYTES - (await this.fileSize(failedPath));
    const kept = this.takeNewestWithinBudget(lines, budget);
    if (kept.length < lines.length) {
      mcpLog.warn(
        `[telemetry] failed file capped at ${TRACE_FILE_MAX_BYTES} bytes, ` +
          `dropped ${lines.length - kept.length} older events`
      );
    }
    try {
      if (kept.length > 0) {
        await fs.promises.appendFile(
          failedPath,
          kept.join('\n') + '\n',
          'utf8'
        );
      }
    } catch {
      // 写 failed 目录失败静默；保留 .pending 文件等下轮重试，不删
      return;
    }
    try {
      await fs.promises.unlink(pendingFile);
    } catch {
      // ignore
    }
  }

  /** 按落盘字节预算从尾部（最新）往前取连续行；预算不足一行时返回空数组。行已是密文，按实际字节数 + 换行计。 */
  private takeNewestWithinBudget(lines: string[], budget: number): string[] {
    if (budget <= 0) {
      return [];
    }
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = Buffer.byteLength(lines[i], 'utf8') + 1; // +1 newline
      if (used + cost > budget) {
        break;
      }
      used += cost;
      kept.push(lines[i]);
    }
    kept.reverse();
    return kept;
  }
}
