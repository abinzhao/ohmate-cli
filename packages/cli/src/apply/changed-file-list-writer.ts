/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { debugLog } from '../utils/logger.js';
import type { ModuleNode } from '../utils/project.js';

enum FileClass {
  ETS_TS = 'ets_ts',
  RAW_FILE = 'raw_file',
  RES_FILE = 'res_file',
  NATIVE = 'native',
  UNKNOWN = 'unknown',
}

interface FileClassifyResult {
  fileClass: FileClass;
  moduleSrcPath: string;
}

interface ApplyEntry {
  filePath: string;
  belongProjectPath: string;
}

interface PatchResourceEntry {
  filePath: string;
  resourcePath: string;
}

interface ModuleChangeCollector {
  hotReloadEntries: ApplyEntry[];
  patchEtsFiles: string[];
  patchRawFiles: PatchResourceEntry[];
  patchResFiles: PatchResourceEntry[];
  nativeFiles: string[];
}

export interface WriteResult {
  writtenModules: string[];
  skippedFiles: string[];
}

const PRODUCT_DEFAULT = 'default';

export class ChangedFileListWriter {
  public static writeChangedFileLists(
    projectRoot: string,
    productName: string,
    changedFiles: string[],
    activeModuleName?: string
  ): WriteResult {
    const product = productName || PRODUCT_DEFAULT;
    const profile = ChangedFileListWriter.loadBuildProfile(projectRoot);
    if (!profile) {
      return { writtenModules: [], skippedFiles: changedFiles };
    }

    const modules = profile.modules as ModuleNode[];
    const runnableModules = ChangedFileListWriter.filterRunnableModules(projectRoot, modules);
    if (runnableModules.length === 0) {
      return { writtenModules: [], skippedFiles: changedFiles };
    }

    const reverseDeps = ChangedFileListWriter.buildReverseDependencyMap(projectRoot, modules);
    const collectors = ChangedFileListWriter.createCollectors(runnableModules);
    const skippedFiles = ChangedFileListWriter.collectChanges(
      changedFiles, projectRoot, modules, reverseDeps, collectors
    );
    const writtenModules = ChangedFileListWriter.flushCollectors(
      projectRoot, product, runnableModules, collectors, activeModuleName
    );

    return { writtenModules, skippedFiles };
  }

  public static initEmptyChangedFileLists(
    projectRoot: string,
    productName: string,
    activeModuleName?: string
  ): string[] {
    const product = productName || PRODUCT_DEFAULT;
    const profile = ChangedFileListWriter.loadBuildProfile(projectRoot);
    if (!profile) {
      return [];
    }

    const modules = profile.modules as ModuleNode[];
    const initialized: string[] = [];

    for (const m of modules) {
      const type = ChangedFileListWriter.getModuleType(projectRoot, m.srcPath);
      if (type !== 'entry' && type !== 'shared') {
        continue;
      }

      const isActive = !activeModuleName || m.name === activeModuleName;
      ChangedFileListWriter.initEmptyForModule(projectRoot, product, m.srcPath, isActive);
      initialized.push(m.name);
    }

    return initialized;
  }

  private static filterRunnableModules(
    projectRoot: string, modules: ModuleNode[]
  ): ModuleNode[] {
    return modules.filter((m) => {
      const type = ChangedFileListWriter.getModuleType(projectRoot, m.srcPath);
      return type === 'entry' || type === 'shared';
    });
  }

  private static createCollectors(
    modules: ModuleNode[]
  ): Map<string, ModuleChangeCollector> {
    const collectors = new Map<string, ModuleChangeCollector>();
    for (const m of modules) {
      collectors.set(m.name, {
        hotReloadEntries: [],
        patchEtsFiles: [],
        patchRawFiles: [],
        patchResFiles: [],
        nativeFiles: [],
      });
    }
    return collectors;
  }

  private static collectChanges(
    changedFiles: string[],
    projectRoot: string,
    modules: ModuleNode[],
    reverseDeps: Map<string, string[]>,
    collectors: Map<string, ModuleChangeCollector>
  ): string[] {
    const skippedFiles: string[] = [];

    for (const filePath of changedFiles) {
      const normalized = path.normalize(filePath);
      const classify = ChangedFileListWriter.classifyFile(normalized, projectRoot, modules);

      if (classify.fileClass === FileClass.UNKNOWN) {
        skippedFiles.push(normalized);
        continue;
      }

      const owningModule = ChangedFileListWriter.findModuleByFilePath(normalized, projectRoot, modules);
      if (!owningModule) {
        skippedFiles.push(normalized);
        continue;
      }

      const targetModules = ChangedFileListWriter.resolveTargetModules(
        owningModule, projectRoot, modules, reverseDeps
      );
      if (targetModules.length === 0) {
        skippedFiles.push(normalized);
        continue;
      }

      ChangedFileListWriter.dispatchToCollectors(
        targetModules, collectors, normalized, classify, owningModule.srcPath, projectRoot
      );
    }

    return skippedFiles;
  }

  private static resolveTargetModules(
    owningModule: ModuleNode,
    projectRoot: string,
    modules: ModuleNode[],
    reverseDeps: Map<string, string[]>
  ): string[] {
    const moduleType = ChangedFileListWriter.getModuleType(projectRoot, owningModule.srcPath);

    if (moduleType === 'entry' || moduleType === 'shared') {
      return [owningModule.name];
    }

    return Array.from(
      ChangedFileListWriter.findTopLevelConsumers(owningModule.name, reverseDeps, projectRoot, modules)
    );
  }

  private static dispatchToCollectors(
    targetModules: string[],
    collectors: Map<string, ModuleChangeCollector>,
    filePath: string,
    classify: FileClassifyResult,
    owningSrcPath: string,
    projectRoot: string
  ): void {
    for (const targetName of targetModules) {
      const collector = collectors.get(targetName);
      if (!collector) {
        continue;
      }
      ChangedFileListWriter.addFileToCollector(collector, filePath, classify.fileClass, owningSrcPath, projectRoot);
    }
  }

  private static flushCollectors(
    projectRoot: string,
    productName: string,
    runnableModules: ModuleNode[],
    collectors: Map<string, ModuleChangeCollector>,
    activeModuleName?: string
  ): string[] {
    const writtenModules: string[] = [];
    for (const m of runnableModules) {
      const collector = collectors.get(m.name);
      if (!collector || !ChangedFileListWriter.hasAnyChange(collector)) {
        continue;
      }

      const isActive = !activeModuleName || m.name === activeModuleName;
      if (isActive && collector.hotReloadEntries.length > 0) {
        ChangedFileListWriter.writeApplyFile(
          projectRoot, m.srcPath, productName, collector.hotReloadEntries
        );
      }
      ChangedFileListWriter.writePatchFile(
        projectRoot, m.srcPath, productName,
        collector.patchEtsFiles, collector.patchRawFiles, collector.patchResFiles
      );
      writtenModules.push(m.name);
    }
    return writtenModules;
  }

  private static hasAnyChange(collector: ModuleChangeCollector): boolean {
    return collector.hotReloadEntries.length > 0 ||
      collector.patchEtsFiles.length > 0 ||
      collector.patchRawFiles.length > 0 ||
      collector.patchResFiles.length > 0 ||
      collector.nativeFiles.length > 0;
  }

  private static initEmptyForModule(
    projectRoot: string, product: string, moduleSrcPath: string, initApply: boolean
  ): void {
    const patchDir = path.join(projectRoot, moduleSrcPath, 'build', product, 'intermediates', 'patch', 'default');
    const patchPath = path.join(patchDir, 'changedFileList.json');
    if (!fs.existsSync(patchPath)) {
      fs.mkdirSync(patchDir, { recursive: true });
      fs.writeFileSync(
        patchPath, JSON.stringify({ resources: { resFile: [], rawFile: [] }, modifiedFiles: [] }), 'utf-8'
      );
    }

    if (!initApply) {
      return;
    }

    const hotReloadDir = path.join(projectRoot, moduleSrcPath, 'build', product, 'intermediates', 'hotReload');
    const hotReloadPath = path.join(hotReloadDir, 'changedFileList.json');
    if (!fs.existsSync(hotReloadPath)) {
      fs.mkdirSync(hotReloadDir, { recursive: true });
      fs.writeFileSync(hotReloadPath, JSON.stringify({ modifiedFilesV2: [] }, null, 2), 'utf-8');
    }
  }

  public static loadBuildProfile(projectRoot: string): { modules: ModuleNode[] } | null {
    const profilePath = path.join(projectRoot, 'build-profile.json5');
    if (!fs.existsSync(profilePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      return json5.parse(content) as { modules: ModuleNode[] };
    } catch {
      return null;
    }
  }

  private static classifyFile(
    filePath: string, projectRoot: string, modules: ModuleNode[]
  ): FileClassifyResult {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.ets' || ext === '.ts') {
      const owning = ChangedFileListWriter.findModuleByFilePath(filePath, projectRoot, modules);
      return { fileClass: FileClass.ETS_TS, moduleSrcPath: owning?.srcPath ?? '' };
    }

    if (ext === '.cpp' || ext === '.cc' || ext === '.c' || ext === '.h' || ext === '.hpp') {
      const owning = ChangedFileListWriter.findModuleByFilePath(filePath, projectRoot, modules);
      return { fileClass: FileClass.NATIVE, moduleSrcPath: owning?.srcPath ?? '' };
    }

    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('/resources/rawfile/')) {
      const owning = ChangedFileListWriter.findModuleByFilePath(filePath, projectRoot, modules);
      return { fileClass: FileClass.RAW_FILE, moduleSrcPath: owning?.srcPath ?? '' };
    }
    if (normalized.includes('/resources/resfile/')) {
      const owning = ChangedFileListWriter.findModuleByFilePath(filePath, projectRoot, modules);
      return { fileClass: FileClass.RES_FILE, moduleSrcPath: owning?.srcPath ?? '' };
    }

    return { fileClass: FileClass.UNKNOWN, moduleSrcPath: '' };
  }

  public static findModuleByFilePath(
    filePath: string, projectRoot: string, modules: ModuleNode[]
  ): ModuleNode | null {
    const normalized = path.normalize(filePath);
    for (const m of modules) {
      const moduleDir = path.normalize(path.join(projectRoot, m.srcPath));
      const prefix = moduleDir + path.sep;
      if (normalized.startsWith(prefix) || normalized === moduleDir) {
        return m;
      }
    }
    return null;
  }

  public static getModuleType(projectRoot: string, moduleSrcPath: string): string {
    const moduleJsonPath = path.join(projectRoot, moduleSrcPath, 'src', 'main', 'module.json5');
    if (!fs.existsSync(moduleJsonPath)) {
      return 'entry';
    }
    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const parsed = json5.parse(content) as { module?: { type?: string } };
      return parsed?.module?.type || 'entry';
    } catch {
      return 'entry';
    }
  }

  private static buildReverseDependencyMap(
    projectRoot: string, modules: ModuleNode[]
  ): Map<string, string[]> {
    const reverseDeps = new Map<string, string[]>();

    for (const m of modules) {
      const localDeps = ChangedFileListWriter.readLocalDependencies(projectRoot, m.srcPath);
      for (const depModuleName of localDeps) {
        const list = reverseDeps.get(depModuleName) || [];
        if (!list.includes(m.name)) {
          list.push(m.name);
        }
        reverseDeps.set(depModuleName, list);
      }
    }

    return reverseDeps;
  }

  private static readLocalDependencies(projectRoot: string, moduleSrcPath: string): string[] {
    const pkgPath = path.join(projectRoot, moduleSrcPath, 'oh-package.json5');
    if (!fs.existsSync(pkgPath)) {
      return [];
    }
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = json5.parse(content) as { dependencies?: Record<string, string> };
      return ChangedFileListWriter.resolveDepModuleNames(projectRoot, moduleSrcPath, pkg.dependencies || {});
    } catch {
      return [];
    }
  }

  private static resolveDepModuleNames(
    projectRoot: string, moduleSrcPath: string, deps: Record<string, string>
  ): string[] {
    const profile = ChangedFileListWriter.loadBuildProfile(projectRoot);
    if (!profile) {
      return [];
    }
    const modules = profile.modules as ModuleNode[];
    const result: string[] = [];

    for (const depValue of Object.values(deps)) {
      if (typeof depValue !== 'string') {
        continue;
      }
      const resolved = ChangedFileListWriter.tryResolveDepModule(projectRoot, moduleSrcPath, depValue, modules);
      if (resolved) {
        result.push(resolved);
      }
    }
    return result;
  }

  private static tryResolveDepModule(
    projectRoot: string, moduleSrcPath: string, depValue: string, modules: ModuleNode[]
  ): string | null {
    let relativePath = depValue;
    const isLocal = relativePath.startsWith('file:') || relativePath.startsWith('.') || relativePath.startsWith('..');
    if (!isLocal) {
      return null;
    }
    if (relativePath.startsWith('file:')) {
      relativePath = relativePath.substring(5);
    }
    const depAbsDir = path.resolve(projectRoot, moduleSrcPath, relativePath);
    const depModule = modules.find(
      (mod) => path.resolve(projectRoot, mod.srcPath) === depAbsDir
    );
    return depModule?.name ?? null;
  }

  private static findTopLevelConsumers(
    moduleName: string,
    reverseDeps: Map<string, string[]>,
    projectRoot: string,
    modules: ModuleNode[]
  ): Set<string> {
    const consumers = new Set<string>();
    const visited = new Set<string>();
    const queue = [moduleName];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      ChangedFileListWriter.processDependents(current, reverseDeps, projectRoot, modules, consumers, queue);
    }

    return consumers;
  }

  private static processDependents(
    moduleName: string,
    reverseDeps: Map<string, string[]>,
    projectRoot: string,
    modules: ModuleNode[],
    consumers: Set<string>,
    queue: string[]
  ): void {
    const dependents = reverseDeps.get(moduleName) || [];
    for (const dep of dependents) {
      const depModule = modules.find((m) => m.name === dep);
      if (!depModule) {
        continue;
      }
      const type = ChangedFileListWriter.getModuleType(projectRoot, depModule.srcPath);
      if (type === 'entry' || type === 'shared') {
        consumers.add(dep);
      }
      if (type === 'har') {
        queue.push(dep);
      }
    }
  }

  private static addFileToCollector(
    collector: ModuleChangeCollector,
    filePath: string,
    fileClass: FileClass,
    owningModuleSrcPath: string,
    projectRoot: string
  ): void {
    const resourceDir = path.join(projectRoot, owningModuleSrcPath, 'src', 'main', 'resources');

    if (fileClass === FileClass.ETS_TS) {
      collector.hotReloadEntries.push({ filePath, belongProjectPath: projectRoot });
      collector.patchEtsFiles.push(filePath);
    } else if (fileClass === FileClass.RAW_FILE) {
      collector.patchRawFiles.push({ filePath, resourcePath: resourceDir });
    } else if (fileClass === FileClass.RES_FILE) {
      collector.patchResFiles.push({ filePath, resourcePath: resourceDir });
    } else if (fileClass === FileClass.NATIVE) {
      collector.nativeFiles.push(filePath);
    }
  }

  private static writeApplyFile(
    projectRoot: string, moduleSrcPath: string, productName: string, entries: ApplyEntry[]
  ): void {
    const srcPath = moduleSrcPath.replace(/^\.\//, '');
    const filePath = path.join(projectRoot, srcPath, 'build', productName, 'intermediates', 'hotReload', 'changedFileList.json');

    const existing = ChangedFileListWriter.readExistingApply(filePath);
    const merged = ChangedFileListWriter.mergeApplyEntries(existing, entries);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify({ modifiedFilesV2: merged }, null, 2), 'utf-8');
    debugLog(`[ChangedFileListWriter] Written hotReload: ${filePath} (${merged.length} entries)`);
  }

  private static readExistingApply(filePath: string): ApplyEntry[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as { modifiedFilesV2?: ApplyEntry[] };
      return parsed?.modifiedFilesV2 || [];
    } catch {
      return [];
    }
  }

  private static writePatchFile(
    projectRoot: string, moduleSrcPath: string, productName: string,
    etsFiles: string[], rawFiles: PatchResourceEntry[], resFiles: PatchResourceEntry[]
  ): void {
    const srcPath = moduleSrcPath.replace(/^\.\//, '');
    const filePath = path.join(
      projectRoot, srcPath, 'build', productName, 'intermediates', 'patch', 'default', 'changedFileList.json'
    );

    const existing = ChangedFileListWriter.readExistingPatch(filePath);
    const etsBaseDir = path.join(projectRoot, srcPath, 'src', 'main', 'ets');
    const relativeEtsFiles = etsFiles.map(
      (abs) => ChangedFileListWriter.resolveRelativePathForPatch(abs, etsBaseDir)
    );

    const mergedEts = ChangedFileListWriter.mergeStrings(existing.modifiedFiles, relativeEtsFiles);
    const mergedRaw = ChangedFileListWriter.mergePatchResources(existing.rawFile, rawFiles);
    const mergedRes = ChangedFileListWriter.mergePatchResources(existing.resFile, resFiles);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify({
      resources: { resFile: mergedRes, rawFile: mergedRaw },
      modifiedFiles: mergedEts,
    }), 'utf-8');
    debugLog(`[ChangedFileListWriter] Written patch: ${filePath}`);
  }

  private static readExistingPatch(filePath: string): {
    modifiedFiles: string[];
    rawFile: PatchResourceEntry[];
    resFile: PatchResourceEntry[];
  } {
    if (!fs.existsSync(filePath)) {
      return { modifiedFiles: [], rawFile: [], resFile: [] };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as {
        resources?: { resFile?: PatchResourceEntry[]; rawFile?: PatchResourceEntry[] };
        modifiedFiles?: string[];
      };
      return {
        modifiedFiles: parsed?.modifiedFiles || [],
        rawFile: parsed?.resources?.rawFile || [],
        resFile: parsed?.resources?.resFile || [],
      };
    } catch {
      return { modifiedFiles: [], rawFile: [], resFile: [] };
    }
  }

  private static resolveRelativePathForPatch(fileAbsPath: string, moduleEtsBaseDir: string): string {
    return path.relative(path.normalize(moduleEtsBaseDir), path.normalize(fileAbsPath)).replace(/\\/g, '/');
  }

  private static mergeApplyEntries(existing: ApplyEntry[], additions: ApplyEntry[]): ApplyEntry[] {
    const seen = new Set<string>();
    const result: ApplyEntry[] = [];
    for (const e of [...existing, ...additions]) {
      if (!seen.has(e.filePath)) {
        seen.add(e.filePath);
        result.push(e);
      }
    }
    return result;
  }

  private static mergeStrings(existing: string[], additions: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const s of [...existing, ...additions]) {
      if (!seen.has(s)) {
        seen.add(s);
        result.push(s);
      }
    }
    return result;
  }

  private static mergePatchResources(existing: PatchResourceEntry[], additions: PatchResourceEntry[]): PatchResourceEntry[] {
    const seen = new Set<string>();
    const result: PatchResourceEntry[] = [];
    for (const e of [...existing, ...additions]) {
      if (!seen.has(e.filePath)) {
        seen.add(e.filePath);
        result.push(e);
      }
    }
    return result;
  }
}
