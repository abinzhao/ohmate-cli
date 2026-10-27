/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { toFileUri } from '../../utils/common.js';

/** LSP FileChangeType（与标准协议一致）。 */
const FILE_CHANGE_TYPE = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const;

export interface SourceChange {
  uri: string;
  type: number;
}

export interface SourceChangeEvent {
  changes: SourceChange[];
}

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

/**
 * 不下钻这些目录（工具/缓存目录，永不与用户源码目录同名，可按名安全排除）：
 * oh_modules / node_modules / build / .hvigor / .git / .idea / .cxx / .preview。
 * resources / rawfile / libs / cpp 等可能与用户目录同名的，不按名排除（且本监听器
 * 在命中 src 下 /ets 目录后即停止下钻，src 内的 resources 根本不会被遍历到）。
 */
const SKIP_DIRS = new Set([
  'oh_modules',
  'node_modules',
  'build',
  '.hvigor',
  '.git',
  '.idea',
  '.cxx',
  '.preview',
]);

/** 源 ets 目录：路径含 `/src/` 且以 `/ets` 结尾（覆盖 src/main/ets、src/ohosTest/ets 等）。 */
function isSourceEtsDir(p: string): boolean {
  const u = p.replace(/\\/g, '/');
  return u.endsWith('/ets') && u.includes('/src/');
}

/**
 * 源文件（.ets）监听器。
 *
 * 监听各模块源 ets 目录（src 下以 /ets 结尾，覆盖 src/main/ets、src/ohosTest/ets 等）
 * 下的 .ets 文件变化，驱动 ace-server 刷新跨文件缓存：发现 Created/Changed/Deleted
 * 后，批量发出 `sourceChanged` 事件，由 ArktsLspManager 转成
 * `workspace/didChangeWatchedFiles` 通知发给 server（标准/私有/socket 三模式共用同一条 send 链）。
 *
 * 机制：递归 fs.watch 各源根 + 防抖全量重扫（stat mtime/size diff）+ 轮询兜底漏事件。
 * 用 stat 而非 content-hash：源文件可能上千，全量 hash 过重；stat diff 足够触发
 * server 重读（即便偶发误报，server 重读同内容也是无副作用 no-op）。
 *
 * 与 IDE 的差异：IDE 对"编辑器已打开文件的内容变更"走 didChange、不重复发
 * didChangeWatchedFiles；本监听器不做编辑器打开态跟踪（拿不到 didChange 通道），
 * 故对所有 .ets 变更（含编辑器打开的）一律发 didChangeWatchedFiles。
 */
export class SourceFileWatcher extends EventEmitter {
  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private sourceDirs: string[] = [];
  private watchers = new Map<string, fs.FSWatcher>();
  private snapshot = new Map<string, FileSnapshot>();
  /** 防抖定时器：任一 fs.watch 事件后攒一批，到期全量重扫并 emit。 */
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private initialScanDone = false;

  constructor(projectRoot: string, debounceMs = 500, pollMs = 10_000) {
    super();
    this.projectRoot = projectRoot;
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
  }

  public start(): void {
    this.sourceDirs = this.discoverSourceDirs();
    if (this.sourceDirs.length === 0) {
      logger.warn(
        '[SourceFileWatcher] No src/main/ets dir found, skip watching'
      );
      return;
    }
    this.refreshSnapshot();
    this.initialScanDone = true;

    for (const dir of this.sourceDirs) {
      this.addSourceDirWatcher(dir);
    }

    this.pollInterval = setInterval(() => this.scanAndEmit(), this.pollMs);
    logger.info(
      `[SourceFileWatcher] Started, watching ${this.sourceDirs.length} source dir(s), ${this.snapshot.size} ets file(s)`
    );
  }

  public stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.snapshot.clear();
    this.initialScanDone = false;
    logger.info('[SourceFileWatcher] Stopped');
  }

  /** 为单个源目录启动递归 fs.watch。 */
  private addSourceDirWatcher(dir: string): void {
    if (this.watchers.has(dir)) {
      return;
    }
    try {
      const watcher = fs.watch(
        dir,
        { recursive: true },
        (_eventType, filename) => this.onFsEvent(filename)
      );
      watcher.on('error', (err: Error) => {
        logger.error(
          `[SourceFileWatcher] watch error for ${dir}: ${err.message}`
        );
      });
      this.watchers.set(dir, watcher);
    } catch (e) {
      logger.error(
        `[SourceFileWatcher] Failed to watch ${dir}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * 重新发现 sourceDirs 并增量增删 watcher、静默刷新快照。
   * 由 ArktsLspManager 在 ConfigFileWatcher 检测到模块增删/重命名/移动时调用
   * （模块结构变化的单一 owner 是 ConfigFileWatcher，本类不再自监听 build-profile）。
   * 静默并入新模块文件 / 丢弃已删模块文件，不发 Created/Deleted——模块结构变化
   * 由 ConfigFileWatcher → didChangeConfiguration → needsResync 通知 server 重 sync。
   */
  public refreshSourceDirs(): void {
    if (!this.initialScanDone) {
      return;
    }
    const next = this.discoverSourceDirs();
    const current = new Set(this.sourceDirs);
    const nextSet = new Set(next);
    const added = next.filter((dir) => !current.has(dir));
    const removed = [...current].filter((dir) => !nextSet.has(dir));
    if (added.length === 0 && removed.length === 0) {
      return;
    }
    for (const dir of added) {
      this.addSourceDirWatcher(dir);
    }
    for (const dir of removed) {
      const w = this.watchers.get(dir);
      if (w) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    this.sourceDirs = next;
    this.refreshSnapshot();
    logger.info(
      `[SourceFileWatcher] Module dirs changed: +${added.length} -${removed.length}, now ${this.sourceDirs.length} source dir(s)`
    );
  }

  /** 扫描工程根，收集所有源 ets 目录（src 下以 /ets 结尾，覆盖 src/main/ets、src/ohosTest/ets）。 */
  private discoverSourceDirs(): string[] {
    const result: string[] = [];
    this.collectSourceDirs(
      path.resolve(this.projectRoot),
      result,
      new Set<string>(),
      new Set<string>()
    );
    return result;
  }

  /**
   * 递归收集源 ets 目录：命中（src 下以 /ets 结尾）即记入 result（不再下钻，由 recursive watch 覆盖）。
   * 不限深度——项目结构可能很深（多模块/嵌套模块）；用 visited（realpath）防 symlink 环。
   */
  private collectSourceDirs(
    dir: string,
    result: string[],
    seen: Set<string>,
    visited: Set<string>
  ): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) {
      return;
    }
    visited.add(realDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const child = path.resolve(dir, entry.name);
      if (!isSourceEtsDir(child)) {
        this.collectSourceDirs(child, result, seen, visited);
        continue;
      }
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      result.push(child);
    }
  }

  /** fs.watch 回调：只关心 .ets，触发一次防抖全量重扫。 */
  private onFsEvent(filename: string | Buffer | null): void {
    if (!filename || typeof filename !== 'string') {
      return;
    }
    if (!filename.replace(/\\/g, '/').toLowerCase().endsWith('.ets')) {
      return;
    }
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scanAndEmit();
    }, this.debounceMs);
  }

  /** 全量重扫、diff、emit（无变更则静默）。 */
  private scanAndEmit(): void {
    if (!this.initialScanDone) {
      return;
    }
    const changes = this.diffScan();
    if (changes.length > 0) {
      this.emit('sourceChanged', { changes } satisfies SourceChangeEvent);
    }
  }

  /** 仅刷新快照，不 emit（用于初始扫描）。 */
  private refreshSnapshot(): void {
    const current = new Map<string, FileSnapshot>();
    for (const dir of this.sourceDirs) {
      this.collectEtsFiles(dir, current);
    }
    this.snapshot = current;
  }

  /** 全量扫描 + 与旧快照 diff，返回变更列表并更新快照。 */
  private diffScan(): SourceChange[] {
    const current = new Map<string, FileSnapshot>();
    for (const dir of this.sourceDirs) {
      this.collectEtsFiles(dir, current);
    }
    const changes: SourceChange[] = [];
    for (const [file, snap] of current) {
      const prev = this.snapshot.get(file);
      if (!prev) {
        changes.push({ uri: toFileUri(file), type: FILE_CHANGE_TYPE.Created });
      } else if (prev.mtimeMs !== snap.mtimeMs || prev.size !== snap.size) {
        changes.push({ uri: toFileUri(file), type: FILE_CHANGE_TYPE.Changed });
      }
    }
    for (const [file] of this.snapshot) {
      if (!current.has(file)) {
        changes.push({ uri: toFileUri(file), type: FILE_CHANGE_TYPE.Deleted });
      }
    }
    this.snapshot = current;
    return changes;
  }

  /** 递归收集 .ets 文件的 mtime/size 快照（ets 目录内部不按名排除，扫全部 .ets）。 */
  private collectEtsFiles(dir: string, out: Map<string, FileSnapshot>): void {
    this.collectEtsFilesInto(dir, out, new Set<string>());
  }

  /** collectEtsFiles 的递归实现：用 visited（realpath）防 symlink 环。 */
  private collectEtsFilesInto(
    dir: string,
    out: Map<string, FileSnapshot>,
    visited: Set<string>
  ): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) {
      return;
    }
    visited.add(realDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectEtsFilesInto(child, out, visited);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ets')) {
        continue;
      }
      this.recordSnapshot(child, out);
    }
  }

  /** stat 单个 .ets 并写入快照；扫描瞬间被删等异常静默忽略。 */
  private recordSnapshot(file: string, out: Map<string, FileSnapshot>): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    out.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
  }
}
