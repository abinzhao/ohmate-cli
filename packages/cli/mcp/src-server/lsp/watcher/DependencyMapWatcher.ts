/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { Constants, DEPENDENCY_MAP_PATH, DEPENDENCY_MAP_JSON5 } from '../parse/Constants.js';
import { findJsonObject, toUnixPath } from '../utils.js';

import { CommonUtils } from '../../../../src/utils/common-utils.js';

/**
 * 模块变更的语义类型
 */
export enum DepChangeKind {
    /** 项目级依赖变化（oh-package.json5） */
    ProjectDepsChanged = 'projectDepsChanged',
    /** 模块级依赖变化（{moduleName}/oh-package.json5） */
    ModuleDepsChanged = 'moduleDepsChanged',
    /** 新增模块 */
    ModuleAdded = 'moduleAdded',
    /** 删除模块 */
    ModuleRemoved = 'moduleRemoved',
    /** 重命名模块名（srcPath 不变，name 变了） */
    ModuleRenamed = 'moduleRenamed',
    /** 重命名文件夹（name 不变，srcPath 变了） */
    ModuleMoved = 'moduleMoved',
}

/**
 * 重命名/移动信息
 * 每条要么是「只改名」(ModuleRenamed)，要么是「只移动」(ModuleMoved)。
 * 若用户同时改了 name 和 srcPath，当前 diff 会识别为「删除 + 新增」，不会产生 RenameInfo。
 */
export interface RenameInfo {
    oldName: string;
    newName: string;
    oldSrcPath: string;
    newSrcPath: string;
    /** 本条是改名还是移动，便于按条打日志或分支逻辑 */
    kind: DepChangeKind.ModuleRenamed | DepChangeKind.ModuleMoved;
}

/**
 * reload 事件的负载
 */
export interface ReloadEvent {
    /** 是否需要全量重载（项目级 oh-package.json5 变化） */
    fullReload: boolean;
    /** 本次变更包含的语义类型集合 */
    kinds: DepChangeKind[];
    /** 增量重载时需要重新解析的模块名列表 */
    changedModules?: string[];
    /** 增量重载时需要移除的模块名列表 */
    removedModuleNames?: string[];
    /** 增量重载中“新增”的模块名（来自 dep-added 或 rename 的新名），用于 moduleSet 的 type='add' */
    addedModuleNames?: string[];
    /** 重命名/移动信息（ModuleRenamed / ModuleMoved 时携带） */
    renames?: RenameInfo[];
}

/**
 * dependencyMap.json5 中的模块信息
 */
interface DepMapModule {
    name: string;
    srcPath: string;
}

/**
 * 缓存文件监听器
 *
 * 监听 .hvigor/dependencyMap/ 目录下的缓存文件变化，驱动模型重载：
 *
 * 1. dependencyMap/oh-package.json5 （项目级依赖）变化 → 全量重载
 * 2. dependencyMap/dependencyMap.json5 （模块列表）变化 → 增量重载（diff 新旧列表）
 * 3. dependencyMap/{moduleName}/oh-package.json5 （模块级依赖）变化 → 增量重载（该模块）
 *
 * 聚合窗口机制：
 * sync 操作通常会在短时间内依次写入多个缓存文件（模块级 → 项目级），
 * 为避免中间状态的不一致重载，所有文件变化先收集到聚合窗口，
 * 等窗口到期后统一发出一次 reload 事件。
 * 若窗口内包含项目级变化，直接升级为全量重载。
 *
 * Events:
 *   - 'reload': ReloadEvent
 */
export class DependencyMapWatcher extends EventEmitter {
    /** 递归监听整个 dependencyMap 目录，避免 Windows 上对单文件 watch 的 EPERM */
    private dirWatcher: fs.FSWatcher | null = null;
    private contentHashes = new Map<string, string>();
    /** 当前已知的模块快照，用于 diff */
    private lastModules: DepMapModule[] = [];
    private readonly debounceMs: number;
    /** dependencyMap 目录的绝对路径 */
    private readonly depMapDir: string;

    // ─── 聚合窗口：将短时间内多个文件变化合并为一次 reload ───
    /** 聚合窗口内收集到的简单 tag 列表（root-oh-package / module:xxx / dep-added:xxx / dep-removed:xxx） */
    private pendingTags: string[] = [];
    /** 聚合窗口内收集到的重命名/移动信息（结构化，避免字符串编解码） */
    private pendingRenames: Array<{ kind: DepChangeKind.ModuleRenamed | DepChangeKind.ModuleMoved; info: RenameInfo }> =
        [];
    /** 聚合窗口的定时器 */
    private coalesceTimer: NodeJS.Timeout | null = null;
    /** 聚合窗口时长，应略大于单文件 debounce，保证同一批写入的文件全部落入窗口 */
    private readonly coalesceMs: number;
    /** 任一目录事件后触发的「全量扫描」防抖定时器，避免漏事件 */
    private fullScanTimer: NodeJS.Timeout | null = null;
    /** 轮询定时器：外部触发 sync 或 fs.watch 漏事件时仍能发现缓存变化 */
    private pollInterval: NodeJS.Timeout | null = null;
    /** 是否已完成首次扫描（用于只初始化 hashes、不触发 reload） */
    private initialScanDone = false;

    constructor(
        private readonly projectRoot: string,
        debounceMs: number = 500,
    ) {
        super();
        this.debounceMs = debounceMs;
        // 聚合窗口 = debounce + 300ms 余量，确保同一批文件写入都能被收集
        this.coalesceMs = debounceMs + 300;
        this.depMapDir = path.join(projectRoot, DEPENDENCY_MAP_PATH);
    }

    /**
     * 启动监听。
     * 使用「递归监听整个 dependencyMap 目录」，避免 Windows 上对单文件 fs.watch 的 EPERM。
     */
    public start(): void {
        if (!fs.existsSync(this.depMapDir)) {
            logger.warn(`[DependencyMapWatcher] dependencyMap dir not found: ${this.depMapDir}, skip watching`);
            return;
        }

        this.lastModules = this.parseModulesFromDepMap();

        try {
            this.dirWatcher = fs.watch(this.depMapDir, { recursive: true }, (eventType, filename) =>
                this.onDirEvent(eventType, filename),
            );
            this.dirWatcher.on('error', (err: Error) => {
                logger.error(`[DependencyMapWatcher] Directory watch error for ${this.depMapDir}: ${err.message}`);
            });
        } catch (e) {
            logger.error(
                `[DependencyMapWatcher] Failed to watch directory ${this.depMapDir}: ${e instanceof Error ? e.message : String(e)}`,
            );
            return;
        }

        this.pollInterval = setInterval(() => this.scanAllCacheFiles(), 2500);
        logger.info(
            `[DependencyMapWatcher] Started, watching directory (recursive): ${this.depMapDir}, modules: [${this.lastModules.map((m) => m.name).join(', ')}]`,
        );
    }

    /** 规范路径，保证 contentHashes/debounce 用同一 key，避免 Windows 下漏判 */
    private canonicalPath(filePath: string): string {
        return toUnixPath(path.resolve(filePath));
    }

    /**
     * 目录 watch 回调：只关心 .json5，任一相关事件都触发一次防抖后的「全量扫描」。
     * 全量扫描会检查所有缓存文件 hash，避免单文件事件漏触发（如 Windows 二次写入）。
     */
    private onDirEvent(eventType: string, filename: string | null): void {
        if (!filename || typeof filename !== 'string') {
            return;
        }
        const normalized = filename.replace(/\\/g, '/');
        let tag: string;
        if (normalized === Constants.OH_PACKAGE_JSON5) {
            tag = 'root-oh-package';
        } else if (normalized === DEPENDENCY_MAP_JSON5) {
            tag = 'dep-map-json';
        } else {
            const match = normalized.match(/^([^/]+)\/oh-package\.json5$/);
            tag = match ? `module:${match[1]}` : '';
        }
        if (!tag) {
            return;
        }
        const filePath = path.join(this.depMapDir, filename);
        if (!fs.existsSync(filePath)) {
            return;
        }
        this.scheduleDebouncedFullScan();
    }

    /**
     * 停止所有监听
     */
    public stop(): void {
        if (this.dirWatcher) {
            this.dirWatcher.close();
            this.dirWatcher = null;
        }
        if (this.fullScanTimer) {
            clearTimeout(this.fullScanTimer);
            this.fullScanTimer = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.coalesceTimer) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
        this.pendingTags = [];
        this.pendingRenames = [];
        this.contentHashes.clear();
        this.initialScanDone = false;
        logger.info('[DependencyMapWatcher] All watchers stopped');
    }

    /** 任一事件后防抖触发全量扫描，避免单文件事件漏触发 */
    private scheduleDebouncedFullScan(): void {
        if (this.fullScanTimer) {
            clearTimeout(this.fullScanTimer);
        }
        this.fullScanTimer = setTimeout(() => {
            this.fullScanTimer = null;
            this.scanAllCacheFiles();
        }, this.debounceMs);
    }

    /**
     * 全量扫描所有关心的缓存文件，按 hash 发现变化并触发 reload。
     * 用于：1) 事件驱动时的统一检查，避免漏单文件事件；2) 轮询兜底，外部触发 sync 或 watch 漏事件时仍能发现。
     */
    private scanAllCacheFiles(): void {
        const rootOhPackage = path.join(this.depMapDir, Constants.OH_PACKAGE_JSON5);
        const depMapJson = path.join(this.depMapDir, DEPENDENCY_MAP_JSON5);
        const newModules = this.parseModulesFromDepMap();

        const filesToCheck: { path: string; tag: string }[] = [
            { path: rootOhPackage, tag: 'root-oh-package' },
            { path: depMapJson, tag: 'dep-map-json' },
            ...newModules.map((m) => ({
                path: (CommonUtils.assertModuleName(m.name), path.join(this.depMapDir, m.name, Constants.OH_PACKAGE_JSON5)),
                tag: `module:${m.name}` as string,
            })),
        ];

        for (const { path: filePath, tag } of filesToCheck) {
            if (!fs.existsSync(filePath)) {
                continue;
            }
            const canonical = this.canonicalPath(filePath);
            const newHash = this.computeFileHash(filePath);
            if (!newHash) {
                continue;
            }
            const oldHash = this.contentHashes.get(canonical);
            if (!this.initialScanDone) {
                this.contentHashes.set(canonical, newHash);
                continue;
            }
            if (oldHash === newHash) {
                continue;
            }
            this.contentHashes.set(canonical, newHash);
            logger.info(`[DependencyMapWatcher] Cache file changed: ${filePath} (tag=${tag})`);
            this.scheduleCoalescedReload(tag);
        }
        if (!this.initialScanDone) {
            this.initialScanDone = true;
        }
    }

    // ─── 内部方法 ───────────────────────────────────────────

    /**
     * 解析 dependencyMap.json5 中的模块列表
     */
    private parseModulesFromDepMap(): DepMapModule[] {
        const depMapJson = path.join(this.depMapDir, DEPENDENCY_MAP_JSON5);
        try {
            const obj = findJsonObject(depMapJson);
            if (typeof obj !== 'object' || obj === null) {
                return [];
            }
            const modules = (obj as Record<string, unknown>).modules;
            if (!Array.isArray(modules)) {
                return [];
            }
            return modules.filter((m): m is DepMapModule => {
                if (typeof m !== 'object' || m === null) {
                    return false;
                }
                const rec = m as Record<string, unknown>;
                return typeof rec.name === 'string' && typeof rec.srcPath === 'string';
            });
        } catch (e) {
            logger.warn(
                `[DependencyMapWatcher] Failed to parse dependencyMap.json5: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
        }
    }

    /**
     * 将 tag 加入聚合窗口。
     *
     * 每个文件的 debounce 回调确认"内容确实变了"后调用此方法。
     * 不立即 emit，而是收集到 pendingTags，等聚合窗口到期后统一处理。
     *
     * 这样可以把同一次 sync 产生的多个缓存文件变化（模块级 + 项目级）
     * 合并为一次 reload 事件，避免中间状态的无效/不一致重载。
     */
    private scheduleCoalescedReload(tag: string): void {
        this.pendingTags.push(tag);

        // 如果包含 dep-map-json，需要立即处理模块列表 diff（增删 watcher），
        // 但不立即 emit —— diff 结果记录在 pendingTags 中由 flush 统一处理
        if (tag === 'dep-map-json') {
            this.applyDepMapJsonDiff();
        }

        // 每收到新 tag，重置聚合窗口定时器（滑动窗口）
        if (this.coalesceTimer) {
            clearTimeout(this.coalesceTimer);
        }
        this.coalesceTimer = setTimeout(() => {
            this.coalesceTimer = null;
            this.flushPendingReload();
        }, this.coalesceMs);
    }

    private collectPendingState(): { tags: string[]; renameEntries: Array<{ kind: DepChangeKind.ModuleRenamed | DepChangeKind.ModuleMoved; info: RenameInfo }> } {
        const tags = this.pendingTags;
        const renameEntries = this.pendingRenames;
        this.pendingTags = [];
        this.pendingRenames = [];
        return { tags, renameEntries };
    }

    private processTagsIntoSets(
        tags: string[],
        kinds: Set<DepChangeKind>,
        changedSet: Set<string>,
        removedSet: Set<string>,
    ): void {
        for (const tag of tags) {
            if (tag.startsWith('module:')) {
                changedSet.add(tag.substring('module:'.length));
                kinds.add(DepChangeKind.ModuleDepsChanged);
            } else if (tag.startsWith('dep-added:')) {
                changedSet.add(tag.substring('dep-added:'.length));
                kinds.add(DepChangeKind.ModuleAdded);
            } else if (tag.startsWith('dep-removed:')) {
                removedSet.add(tag.substring('dep-removed:'.length));
                kinds.add(DepChangeKind.ModuleRemoved);
            }
        }
    }

    private processRenameEntries(
        renameEntries: Array<{ kind: DepChangeKind.ModuleRenamed | DepChangeKind.ModuleMoved; info: RenameInfo }>,
        kinds: Set<DepChangeKind>,
        changedSet: Set<string>,
        removedSet: Set<string>,
        renames: RenameInfo[],
    ): void {
        for (const entry of renameEntries) {
            renames.push(entry.info);
            changedSet.add(entry.info.newName);
            removedSet.add(entry.info.oldName);
            kinds.add(entry.kind);
        }
    }

    private buildAddedNamesSet(tags: string[], renameEntries: Array<{ info: RenameInfo }>): Set<string> {
        const addedNames = new Set<string>();
        for (const tag of tags) {
            if (tag.startsWith('dep-added:')) {
                addedNames.add(tag.substring('dep-added:'.length));
            }
        }
        for (const entry of renameEntries) {
            addedNames.add(entry.info.newName);
        }
        return addedNames;
    }

    private emitIncrementalReload(
        kinds: Set<DepChangeKind>,
        changedSet: Set<string>,
        removedSet: Set<string>,
        addedNames: Set<string>,
        renames: RenameInfo[],
    ): void {
        logger.info(
            `[DependencyMapWatcher] Coalesced → kinds=[${[...kinds].join(',')}], changed=[${[...changedSet].join(',')}], removed=[${[...removedSet].join(',')}], added=[${[...addedNames].join(',')}], renames=[${renames.map((r) => `${r.oldName}→${r.newName}`).join(',')}]`,
        );
        this.emit('reload', {
            fullReload: false,
            kinds: [...kinds],
            changedModules: [...changedSet],
            removedModuleNames: [...removedSet],
            addedModuleNames: [...addedNames],
            renames: renames.length > 0 ? renames : undefined,
        } satisfies ReloadEvent);
    }

    /**
     * 聚合窗口到期，根据收集到的所有 tag + pendingRenames 发出一次 reload 事件。
     *
     * 策略：
     * - 只要包含 root-oh-package → 全量重载（覆盖一切增量）
     * - 否则合并所有增量 tag + 结构化 renames 为一次增量重载
     */
    private flushPendingReload(): void {
        const { tags, renameEntries } = this.collectPendingState();

        if (tags.length === 0 && renameEntries.length === 0) {
            return;
        }

        logger.info(
            `[DependencyMapWatcher] Flushing coalesced reload, tags=[${tags.join(', ')}], renames=${renameEntries.length}`,
        );

        if (tags.includes('root-oh-package')) {
            logger.info('[DependencyMapWatcher] Root oh-package.json5 in batch → full reload');
            this.emit('reload', { fullReload: true, kinds: [DepChangeKind.ProjectDepsChanged] } satisfies ReloadEvent);
            return;
        }

        const kinds = new Set<DepChangeKind>();
        const changedSet = new Set<string>();
        const removedSet = new Set<string>();
        const renames: RenameInfo[] = [];

        this.processTagsIntoSets(tags, kinds, changedSet, removedSet);
        this.processRenameEntries(renameEntries, kinds, changedSet, removedSet, renames);

        for (const name of changedSet) {
            removedSet.delete(name);
        }

        if (changedSet.size === 0 && removedSet.size === 0 && renames.length === 0) {
            logger.info('[DependencyMapWatcher] Coalesced batch has no effective changes, skipping');
            return;
        }

        const addedNames = this.buildAddedNamesSet(tags, renameEntries);
        this.emitIncrementalReload(kinds, changedSet, removedSet, addedNames, renames);
    }

    /** 规范化 srcPath，避免路径分隔符不一致导致比对失败 */
    private normalizeSrcPath(p: string): string {
        return toUnixPath(p).replace(/^\.\//, '').replace(/\/$/, '');
    }

    private buildModuleLookupMaps(
        modules: DepMapModule[],
    ): { byName: Map<string, DepMapModule>; bySrcPath: Map<string, DepMapModule> } {
        const byName = new Map(modules.map((m) => [m.name, m]));
        const bySrcPath = new Map(modules.map((m) => [this.normalizeSrcPath(m.srcPath), m]));
        return { byName, bySrcPath };
    }

    private detectModuleRenames(
        oldBySrcPath: Map<string, DepMapModule>,
        newBySrcPath: Map<string, DepMapModule>,
        handledOldNames: Set<string>,
        handledNewNames: Set<string>,
    ): void {
        for (const [srcPath, oldMod] of oldBySrcPath) {
            const newMod = newBySrcPath.get(srcPath);
            if (!newMod || newMod.name === oldMod.name) {
                continue;
            }
            this.pendingRenames.push({
                kind: DepChangeKind.ModuleRenamed,
                info: {
                    oldName: oldMod.name,
                    newName: newMod.name,
                    oldSrcPath: oldMod.srcPath,
                    newSrcPath: newMod.srcPath,
                    kind: DepChangeKind.ModuleRenamed,
                },
            });
            handledOldNames.add(oldMod.name);
            handledNewNames.add(newMod.name);
            const oldModulePath = (CommonUtils.assertModuleName(oldMod.name), path.join(this.depMapDir, oldMod.name, Constants.OH_PACKAGE_JSON5));
            this.contentHashes.delete(this.canonicalPath(oldModulePath));
            logger.info(`[DependencyMapWatcher] Module renamed: ${oldMod.name} → ${newMod.name} (srcPath=${srcPath})`);
        }
    }

    private detectModuleMoves(
        oldByName: Map<string, DepMapModule>,
        newByName: Map<string, DepMapModule>,
        handledOldNames: Set<string>,
        handledNewNames: Set<string>,
    ): void {
        for (const [name, oldMod] of oldByName) {
            if (handledOldNames.has(name)) {
                continue;
            }
            const newMod = newByName.get(name);
            if (!newMod || newMod.srcPath === oldMod.srcPath) {
                continue;
            }
            this.pendingRenames.push({
                kind: DepChangeKind.ModuleMoved,
                info: {
                    oldName: oldMod.name,
                    newName: newMod.name,
                    oldSrcPath: oldMod.srcPath,
                    newSrcPath: newMod.srcPath,
                    kind: DepChangeKind.ModuleMoved,
                },
            });
            handledOldNames.add(name);
            handledNewNames.add(name);
            logger.info(`[DependencyMapWatcher] Module moved: ${name} srcPath ${oldMod.srcPath} → ${newMod.srcPath}`);
        }
    }

    private detectAddedModules(
        newByName: Map<string, DepMapModule>,
        oldByName: Map<string, DepMapModule>,
        handledNewNames: Set<string>,
    ): void {
        for (const [name] of newByName) {
            if (handledNewNames.has(name)) {
                continue;
            }
            if (!oldByName.has(name)) {
                this.pendingTags.push(`dep-added:${name}`);
                handledNewNames.add(name);
            }
        }
    }

    private detectRemovedModules(
        oldByName: Map<string, DepMapModule>,
        newByName: Map<string, DepMapModule>,
        handledOldNames: Set<string>,
    ): void {
        for (const [name] of oldByName) {
            if (handledOldNames.has(name)) {
                continue;
            }
            if (!newByName.has(name)) {
                this.pendingTags.push(`dep-removed:${name}`);
                handledOldNames.add(name);
                const removedModulePath = (CommonUtils.assertModuleName(name), path.join(this.depMapDir, name, Constants.OH_PACKAGE_JSON5));
                this.contentHashes.delete(this.canonicalPath(removedModulePath));
            }
        }
    }

    private logDepMapDiffResult(): void {
        const depTags = this.pendingTags.filter((t) => t.startsWith('dep-'));
        const renameDescs = this.pendingRenames.map((r) => `${r.kind}(${r.info.oldName}→${r.info.newName})`);
        logger.info(
            `[DependencyMapWatcher] dependencyMap.json5 diff complete, depTags: [${depTags.join(', ')}], renames: [${renameDescs.join(', ')}]`,
        );
    }

    /**
     * dependencyMap.json5 变化：diff 新旧模块列表，更新 watcher。
     *
     * 通过 name 和 srcPath 的交叉比对，区分出五种情况：
     * 1. 纯新增（name 不在旧列表，srcPath 也不在旧列表）
     * 2. 纯删除（name 不在新列表，srcPath 也不在新列表）
     * 3. 重命名模块名（srcPath 相同，name 不同）
     * 4. 重命名文件夹/移动（name 相同，srcPath 不同）
     * 5. 无变化
     *
     * 结果追加到 pendingTags，不直接 emit——由 flushPendingReload 统一处理。
     */
    private applyDepMapJsonDiff(): void {
        const newModules = this.parseModulesFromDepMap();
        const { byName: oldByName, bySrcPath: oldBySrcPath } = this.buildModuleLookupMaps(this.lastModules);
        const { byName: newByName, bySrcPath: newBySrcPath } = this.buildModuleLookupMaps(newModules);

        const handledOldNames = new Set<string>();
        const handledNewNames = new Set<string>();

        this.detectModuleRenames(oldBySrcPath, newBySrcPath, handledOldNames, handledNewNames);
        this.detectModuleMoves(oldByName, newByName, handledOldNames, handledNewNames);
        this.detectAddedModules(newByName, oldByName, handledNewNames);
        this.detectRemovedModules(oldByName, newByName, handledOldNames);

        this.lastModules = newModules;
        this.logDepMapDiffResult();
    }

    /**
     * 计算文件内容 hash
     */
    private computeFileHash(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return createHash('sha256').update(content).digest('hex');
        } catch {
            return null;
        }
    }
}
