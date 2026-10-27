/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { Constants } from '../parse/Constants.js';
import { findJsonObject } from '../utils.js';

export type ConfigChangeSource = 'ohPackage' | 'buildProfile';

export enum ConfigChangeKind {
    ModulesAdded = 1,
    ModulesRemoved = 2,
    /** 模块重命名（srcPath 不变，name 变了） */
    ModulesRenamed = 3,
    OhPackageChanged = 4,
    ModulesMixed = 5,
    /** 模块移动（name 不变，srcPath 变了） */
    ModulesMoved = 6,
}

export interface ConfigChangeEvent {
    source: ConfigChangeSource;
    kind: ConfigChangeKind;
    filePath: string;
    relativePath: string;
    timestamp: number;
    fileName?: string;
    moduleName?: string;
    removedModuleName?: string;
}

/**
 * build-profile.json5 中的模块信息
 */
interface BuildProfileModule {
    name: string;
    srcPath: string;
}

/** 模块 diff 结果 */
interface ModuleDiffResult {
    added: BuildProfileModule[];
    removed: BuildProfileModule[];
    renamed: { before: BuildProfileModule; after: BuildProfileModule }[];
    moved: { before: BuildProfileModule; after: BuildProfileModule }[];
}

/** 模块匹配状态 */
interface ModuleMatchState {
    matchedOld: Set<BuildProfileModule>;
    matchedNew: Set<BuildProfileModule>;
    newBySrc: Map<string, BuildProfileModule>;
    newByName: Map<string, BuildProfileModule>;
}

/**
 * 项目配置文件监听器
 */
export class ConfigFileWatcher extends EventEmitter {
    /** oh-package.json5 文件的 watcher */
    private watchers = new Map<string, fs.FSWatcher>();
    private debounceTimers = new Map<string, NodeJS.Timeout>();
    /** 每个被监听文件的内容 hash，用于判断"内容是否真的变了" */
    private contentHashes = new Map<string, string>();
    /** build-profile.json5 的 watcher（检测模块新增/删除/重命名） */
    private buildProfileWatcher: fs.FSWatcher | null = null;
    /** 上一次 build-profile.json5 中 modules 的快照，用于判断模块列表是否真的变了 */
    private lastModulesSnapshot: string = '';
    /** 上一次解析到的模块列表，用于计算增删改 */
    private lastModules: BuildProfileModule[] = [];
    private readonly debounceMs: number;

    constructor(
        private readonly projectRoot: string,
        debounceMs: number = 500,
    ) {
        super();
        this.debounceMs = debounceMs;
    }

    /**
     * 启动监听
     * 1. 从 build-profile.json5 获取模块列表，监听各模块 + 根目录的 oh-package.json5
     * 2. 监听 build-profile.json5 本身，检测新增/删除模块时自动刷新监听列表
     */
    public start(): void {
        // 记录初始模块列表快照
        const initialModules = this.parseModulesFromBuildProfile();
        this.lastModules = initialModules;
        this.lastModulesSnapshot = this.computeModulesSnapshot(initialModules);
        this.refreshWatchTargets();
        this.watchBuildProfile();
    }

    /**
     * 刷新监听目标
     * 重新从 build-profile.json5 收集模块列表，
     * 增量更新 oh-package.json5 的监听
     */
    private refreshWatchTargets(): void {
        const newTargets = new Set(this.collectWatchTargets());
        const currentTargets = new Set(this.watchers.keys());

        // 新增的文件：启动监听
        for (const filePath of newTargets) {
            if (!currentTargets.has(filePath)) {
                this.watchFile(filePath);
            }
        }

        // 已删除的文件：停止监听
        for (const filePath of currentTargets) {
            if (!newTargets.has(filePath)) {
                this.unwatchFile(filePath);
                logger.info(`[ConfigFileWatcher] Stopped watching: ${filePath}`);
            }
        }

        logger.info(`[ConfigFileWatcher] Watching ${this.watchers.size} oh-package.json5 file(s)`);
    }

    /**
     * 监听 build-profile.json5
     *
     * 用户新增/删除模块时，IDE 或命令行工具会修改此文件的 modules 数组。
     * 检测到变化后，解析新的模块列表，动态刷新 oh-package.json5 的监听目标。
     */
    private watchBuildProfile(): void {
        const buildProfilePath = this.getBuildProfilePath();
        if (!fs.existsSync(buildProfilePath)) {
            logger.warn(
                `[ConfigFileWatcher] build-profile.json5 not found at ${buildProfilePath}, cannot watch for module changes`,
            );
            return;
        }

        try {
            this.buildProfileWatcher = fs.watch(buildProfilePath, (eventType) => {
                if (eventType === 'change') {
                    this.onBuildProfileChanged();
                }
            });

            this.buildProfileWatcher.on('error', (err) => {
                logger.error(`[ConfigFileWatcher] build-profile.json5 watch error: ${err.message}`);
            });

            logger.info(`[ConfigFileWatcher] Watching module registry: ${buildProfilePath}`);
        } catch (e) {
            logger.error(
                `[ConfigFileWatcher] Failed to watch build-profile.json5: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }

    private emitModuleAddedEvents(modules: BuildProfileModule[], ts: number): void {
        for (const mod of modules) {
            const moduleDir = path.resolve(this.projectRoot, mod.srcPath);
            this.emit('configChanged', {
                source: 'buildProfile',
                kind: ConfigChangeKind.ModulesAdded,
                filePath: moduleDir,
                relativePath: mod.srcPath,
                timestamp: ts,
                moduleName: mod.name,
            });
        }
    }

    private emitModuleRemovedEvents(modules: BuildProfileModule[], ts: number): void {
        for (const mod of modules) {
            const moduleDir = path.resolve(this.projectRoot, mod.srcPath);
            this.emit('configChanged', {
                source: 'buildProfile',
                kind: ConfigChangeKind.ModulesRemoved,
                filePath: moduleDir,
                relativePath: mod.srcPath,
                timestamp: ts,
                removedModuleName: mod.name,
            });
        }
    }

    private emitModuleRenamedEvents(renamed: { before: BuildProfileModule; after: BuildProfileModule }[], ts: number): void {
        for (const r of renamed) {
            const moduleDir = path.resolve(this.projectRoot, r.after.srcPath);
            this.emit('configChanged', {
                source: 'buildProfile',
                kind: ConfigChangeKind.ModulesRenamed,
                filePath: moduleDir,
                relativePath: r.after.srcPath,
                timestamp: ts,
                moduleName: r.after.name,
                removedModuleName: r.before.name,
            });
        }
    }

    private emitModuleMovedEvents(moved: { before: BuildProfileModule; after: BuildProfileModule }[], ts: number): void {
        for (const m of moved) {
            const moduleDir = path.resolve(this.projectRoot, m.after.srcPath);
            this.emit('configChanged', {
                source: 'buildProfile',
                kind: ConfigChangeKind.ModulesMoved,
                filePath: moduleDir,
                relativePath: m.after.srcPath,
                timestamp: ts,
                moduleName: m.after.name,
            });
        }
    }

    private processBuildProfileDiff(diff: ModuleDiffResult): void {
        this.refreshWatchTargets();
        const ts = Date.now();
        this.emitModuleAddedEvents(diff.added, ts);
        this.emitModuleRemovedEvents(diff.removed, ts);
        this.emitModuleRenamedEvents(diff.renamed, ts);
        this.emitModuleMovedEvents(diff.moved, ts);
    }

    /**
     * build-profile.json5 变化处理
     *
     * build-profile.json5 包含很多配置（app、products、compatibleSdkVersion 等），
     * 通过对 modules 数组做快照和 diff，比对模块的增删改（重命名）。
     * 其他字段的改动不会触发事件。
     */
    private onBuildProfileChanged(): void {
        const key = '__build_profile__';
        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(key);

            const newModules = this.parseModulesFromBuildProfile();
            const newSnapshot = this.computeModulesSnapshot(newModules);
            if (newSnapshot === this.lastModulesSnapshot) {
                logger.info('[ConfigFileWatcher] build-profile.json5 changed but modules unchanged, skipping');
                return;
            }

            const diff = this.diffModules(this.lastModules, newModules);
            this.lastModules = newModules;
            this.lastModulesSnapshot = newSnapshot;
            logger.info(
                `[ConfigFileWatcher] build-profile.json5 modules changed, added=${diff.added.length}, removed=${diff.removed.length}, renamed=${diff.renamed.length}, moved=${diff.moved.length}`,
            );

            this.processBuildProfileDiff(diff);
        }, this.debounceMs);

        this.debounceTimers.set(key, timer);
    }

    /**
     * 计算 modules 数组的快照字符串
     * 只提取 name + srcPath，排序后序列化，确保顺序无关的比对
     */
    private computeModulesSnapshot(modules: BuildProfileModule[]): string {
        const normalized = modules.map((m) => `${m.name}::${m.srcPath}`).sort();
        return normalized.join('|');
    }

    /**
     * 计算模块列表的 diff：新增 / 删除 / 重命名 / 移动
     */
    private diffModules(
        oldModules: BuildProfileModule[],
        newModules: BuildProfileModule[],
    ): ModuleDiffResult {
        const state = this.buildModuleMatchState(newModules);
        const result: ModuleDiffResult = {
            added: [],
            removed: [],
            renamed: [],
            moved: [],
        };

        this.matchExactModules(oldModules, state);
        this.matchRenamedModules(oldModules, state, result);
        this.matchMovedModules(oldModules, state, result);
        this.collectRemovedModules(oldModules, state, result);
        this.collectAddedModules(newModules, state, result);

        return result;
    }

    /**
     * 构建新模块的索引和匹配状态
     */
    private buildModuleMatchState(newModules: BuildProfileModule[]): ModuleMatchState {
        const newBySrc = new Map<string, BuildProfileModule>();
        const newByName = new Map<string, BuildProfileModule>();
        for (const m of newModules) {
            newBySrc.set(m.srcPath, m);
            newByName.set(m.name, m);
        }
        return {
            matchedOld: new Set<BuildProfileModule>(),
            matchedNew: new Set<BuildProfileModule>(),
            newBySrc,
            newByName,
        };
    }

    /**
     * 匹配完全相同的模块（name 和 srcPath 都相同）
     */
    private matchExactModules(
        oldModules: BuildProfileModule[],
        state: ModuleMatchState,
    ): void {
        for (const oldMod of oldModules) {
            const newMod = state.newBySrc.get(oldMod.srcPath);
            if (newMod && newMod.name === oldMod.name) {
                state.matchedOld.add(oldMod);
                state.matchedNew.add(newMod);
            }
        }
    }

    /**
     * 检测重命名（srcPath 相同，name 不同）
     */
    private matchRenamedModules(
        oldModules: BuildProfileModule[],
        state: ModuleMatchState,
        result: ModuleDiffResult,
    ): void {
        for (const oldMod of oldModules) {
            if (state.matchedOld.has(oldMod)) {
                continue;
            }
            const newMod = state.newBySrc.get(oldMod.srcPath);
            if (newMod && !state.matchedNew.has(newMod) && newMod.name !== oldMod.name) {
                result.renamed.push({ before: oldMod, after: newMod });
                state.matchedOld.add(oldMod);
                state.matchedNew.add(newMod);
            }
        }
    }

    /**
     * 检测移动（name 相同，srcPath 不同）
     */
    private matchMovedModules(
        oldModules: BuildProfileModule[],
        state: ModuleMatchState,
        result: ModuleDiffResult,
    ): void {
        for (const oldMod of oldModules) {
            if (state.matchedOld.has(oldMod)) {
                continue;
            }
            const newMod = state.newByName.get(oldMod.name);
            if (newMod && !state.matchedNew.has(newMod) && newMod.srcPath !== oldMod.srcPath) {
                result.moved.push({ before: oldMod, after: newMod });
                state.matchedOld.add(oldMod);
                state.matchedNew.add(newMod);
            }
        }
    }

    /**
     * 收集删除的模块（未被匹配的旧模块）
     */
    private collectRemovedModules(
        oldModules: BuildProfileModule[],
        state: ModuleMatchState,
        result: ModuleDiffResult,
    ): void {
        for (const oldMod of oldModules) {
            if (!state.matchedOld.has(oldMod)) {
                result.removed.push(oldMod);
            }
        }
    }

    /**
     * 收集新增的模块（未被匹配的新模块）
     */
    private collectAddedModules(
        newModules: BuildProfileModule[],
        state: ModuleMatchState,
        result: ModuleDiffResult,
    ): void {
        for (const newMod of newModules) {
            if (!state.matchedNew.has(newMod)) {
                result.added.push(newMod);
            }
        }
    }

    /**
     * 从 build-profile.json5 解析模块列表
     */
    private parseModulesFromBuildProfile(): BuildProfileModule[] {
        const buildProfilePath = this.getBuildProfilePath();
        try {
            const obj = findJsonObject(buildProfilePath);
            if (typeof obj !== 'object' || obj === null) {
                return [];
            }
            const modules = (obj as Record<string, unknown>).modules;
            if (!Array.isArray(modules)) {
                return [];
            }
            return modules.filter((m): m is BuildProfileModule => {
                if (typeof m !== 'object' || m === null) {
                    return false;
                }
                const rec = m as Record<string, unknown>;
                return typeof rec.name === 'string' && typeof rec.srcPath === 'string';
            });
        } catch (e) {
            logger.warn(
                `[ConfigFileWatcher] Failed to parse build-profile.json5: ${e instanceof Error ? e.message : String(e)}`,
            );
            return [];
        }
    }

    /**
     * 收集需要监听的 oh-package.json5 文件路径
     */
    private collectWatchTargets(): string[] {
        const targets: string[] = [];

        const rootOhPackage = path.join(this.projectRoot, Constants.OH_PACKAGE_JSON5);
        if (fs.existsSync(rootOhPackage)) {
            targets.push(rootOhPackage);
        }

        // 从 build-profile.json5 获取各模块，监听各模块的 oh-package.json5
        const modules = this.parseModulesFromBuildProfile();
        for (const mod of modules) {
            const modulePath = path.resolve(this.projectRoot, mod.srcPath);
            const moduleOhPackage = path.join(modulePath, Constants.OH_PACKAGE_JSON5);
            if (fs.existsSync(moduleOhPackage)) {
                targets.push(moduleOhPackage);
            }
        }

        return targets;
    }

    /**
     * 获取 build-profile.json5 的路径
     */
    private getBuildProfilePath(): string {
        return path.join(this.projectRoot, 'build-profile.json5');
    }

    /**
     * 计算文件内容的 hash
     */
    private computeFileHash(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return createHash('sha256').update(content).digest('hex');
        } catch {
            return null;
        }
    }

    /**
     * 监听单个文件
     */
    private watchFile(filePath: string): void {
        if (this.watchers.has(filePath)) {
            return;
        }

        try {
            // 记录初始 hash
            const initialHash = this.computeFileHash(filePath);
            if (initialHash) {
                this.contentHashes.set(filePath, initialHash);
            }

            const watcher = fs.watch(filePath, (eventType) => {
                if (eventType === 'change') {
                    this.onFileChanged(filePath);
                }
            });

            watcher.on('error', (err) => {
                logger.error(`[ConfigFileWatcher] Watch error for ${filePath}: ${err.message}`);
            });

            this.watchers.set(filePath, watcher);
        } catch (e) {
            logger.error(
                `[ConfigFileWatcher] Failed to watch ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }

    /**
     * 停止监听单个文件
     */
    private unwatchFile(filePath: string): void {
        const watcher = this.watchers.get(filePath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(filePath);
        }
        this.contentHashes.delete(filePath);

        const timer = this.debounceTimers.get(filePath);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(filePath);
        }
    }

    /**
     * 文件变化处理
     */
    private onFileChanged(filePath: string): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);

            // 计算新 hash，与旧 hash 比对
            const newHash = this.computeFileHash(filePath);
            if (!newHash) {
                logger.warn(`[ConfigFileWatcher] Could not read file for hash: ${filePath}`);
                return;
            }

            const oldHash = this.contentHashes.get(filePath);
            if (oldHash === newHash) {
                logger.info(`[ConfigFileWatcher] File touched but content unchanged, skipping: ${filePath}`);
                return;
            }

            this.contentHashes.set(filePath, newHash);
            logger.info(`[ConfigFileWatcher] Config file content changed: ${filePath}`);

            const event: ConfigChangeEvent = {
                source: 'ohPackage',
                kind: ConfigChangeKind.OhPackageChanged,
                filePath,
                fileName: path.basename(filePath),
                relativePath: path.relative(this.projectRoot, filePath),
                timestamp: Date.now(),
            };

            this.emit('configChanged', event);
        }, this.debounceMs);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * 停止所有监听
     */
    public stop(): void {
        for (const [, watcher] of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();

        if (this.buildProfileWatcher) {
            this.buildProfileWatcher.close();
            this.buildProfileWatcher = null;
        }

        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.contentHashes.clear();

        logger.info('[ConfigFileWatcher] All watchers stopped');
    }
}
