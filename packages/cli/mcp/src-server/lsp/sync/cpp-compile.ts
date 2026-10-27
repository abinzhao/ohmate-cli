/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfoParse } from '../parse/ModuleInfoParse.js';
import { executeBuildCommand } from './buildProject.js';
import { CommonUtils } from '../../../../src/utils/common-utils.js';
import { compileCommandsPath } from '../../utils/common.js';
import { mcpLog } from '../../utils/mcp-logger.js';

/** build-profile.json5 中的模块信息（与 ModuleInfoParse 的 BuildProfileModule 结构兼容）。 */
export interface ModuleInfo {
    name: string;
    srcPath: string;
    type?: string;
}

/** compile_commands.json 中的单条编译命令。 */
export interface CompileCommand {
    directory: string;
    command?: string;
    file?: string;
    output?: string;
}

/** 判断给定文件路径是否是 C/C++ 源/头文件（不含 .ipp/.ixx/.inl/.inc/.tpp 等辅助扩展名）。 */
export function isCppFile(filePath: string): boolean {
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    return [
        'c', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx', 'hh',
    ].includes(ext);
}

/** 判断单个目录条目是否包含 C++ 信号（.cxx 子目录、递归子目录含 C++、或自身是 C++ 文件）。 */
function entryHasCppSignal(modulePath: string, entry: fs.Dirent): boolean {
    const fullPath = path.join(modulePath, entry.name);
    if (entry.isDirectory()) {
        return entry.name === '.cxx' || hasCppFiles(fullPath);
    }
    return isCppFile(fullPath);
}

/** 递归检查目录是否包含 C++ 文件或 .cxx 子目录。 */
export function hasCppFiles(modulePath: string): boolean {
    if (!fs.existsSync(modulePath)) {
        return false;
    }
    try {
        const entries = fs.readdirSync(modulePath, { withFileTypes: true });
        return entries.some((entry) => entryHasCppSignal(modulePath, entry));
    } catch {
        // ignore permission errors
    }
    return false;
}

/** 查找项目中含有 C++ 文件的模块。 */
export function findCppModules(projectPath: string): ModuleInfo[] {
    try {
        const parser = new ModuleInfoParse(projectPath);
        const allModules = parser.getAllModuleInfo();
        const cppModules: ModuleInfo[] = [];
        for (const module of allModules) {
            const modulePath = path.resolve(projectPath, module.srcPath);
            if (hasCppFiles(modulePath)) {
                cppModules.push(module);
            }
        }
        return cppModules;
    } catch (err) {
        mcpLog.error(
            `[CppCompile] findCppModules threw: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        throw err;
    }
}

/* ---------- compile_commands.json helpers ---------- */

/** 查找所有模块下的 compile_commands.json 文件。 */
function findCompileCommandsFiles(projectPath: string): string[] {
    const results: string[] = [];
    const parser = new ModuleInfoParse(projectPath);
    const modules = parser.getAllModuleInfo();

    for (const module of modules) {
        const modulePath = path.resolve(projectPath, module.srcPath);
        const cxxPath = path.join(modulePath, '.cxx');

        if (!fs.existsSync(cxxPath)) {
            continue;
        }

        findCompileCommandsRecursive(cxxPath, results);
    }

    return results;
}

/** 递归查找目录下的 compile_commands.json 文件。 */
function findCompileCommandsRecursive(dir: string, results: string[]): void {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findCompileCommandsRecursive(fullPath, results);
            } else if (entry.name === 'compile_commands.json') {
                results.push(fullPath);
            }
        }
    } catch {
        // ignore permission errors
    }
}

/** 合并多个 compile_commands.json 文件的内容。 */
function mergeCompileCommands(files: string[]): CompileCommand[] {
    const merged: CompileCommand[] = [];
    for (const filePath of files) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content) as CompileCommand[];
            merged.push(...parsed);
        } catch {
            // skip invalid files
        }
    }
    return merged;
}

/** 将合并后的 compile_commands 写入标准位置。 */
function writeCompileCommands(projectPath: string, commands: CompileCommand[]): void {
    const targetDir = path.join(projectPath, ...COMPILE_COMMANDS_RELATIVE_SEGMENTS.slice(0, -1));
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'compile_commands.json');
    fs.writeFileSync(targetPath, JSON.stringify(commands, null, 2), 'utf8');
}

/** 查找所有模块下的 compile_commands.json 并合并写入。 */
export function findAndMergeCompileCommands(projectPath: string): void {
    const compileCommandsFiles = findCompileCommandsFiles(projectPath);

    if (compileCommandsFiles.length > 0) {
        const merged = mergeCompileCommands(compileCommandsFiles);
        writeCompileCommands(projectPath, merged);
        mcpLog.info(
            `[CppCompile] compile_commands.json generated, ${merged.length} compile commands`,
        );
    } else {
        mcpLog.warn('[CppCompile] No compile_commands.json files found');
    }
}

/* ---------- 文件覆盖检查 ---------- */

/** 构建被 compile_commands.json 覆盖的文件集合（用 realpath 规范化）。 */
export function buildCoveredFileSet(commands: CompileCommand[]): Set<string> {
    const coveredFiles = new Set<string>();
    for (const cmd of commands) {
        if (!cmd.file) {
            continue;
        }
        try {
            coveredFiles.add(fs.realpathSync(cmd.file));
        } catch {
            coveredFiles.add(cmd.file);
        }
    }
    return coveredFiles;
}

/** 检查单个文件是否被覆盖集合包含。 */
export function isFileCoveredBySet(file: string, coveredFiles: Set<string>): boolean {
    try {
        const canonical = fs.realpathSync(file);
        if (!coveredFiles.has(canonical)) {
            mcpLog.info(
                `[CppCompile] File not covered by compile_commands.json: ${file}`,
            );
            return false;
        }
    } catch {
        // file doesn't exist, will be caught by collectValidFiles
    }
    return true;
}

/** 检查待检查的 C++ 文件是否被 compile_commands.json 覆盖。返回 true 表示全部覆盖。 */
export function checkFilesCoveredByCompileCommands(
    compileCommandsPath: string,
    filesToCheck: string[],
): boolean {
    if (!fs.existsSync(compileCommandsPath)) {
        return false;
    }

    try {
        const content = fs.readFileSync(compileCommandsPath, 'utf8');
        const commands = JSON.parse(content) as CompileCommand[];
        const coveredFiles = buildCoveredFileSet(commands);
        for (const file of filesToCheck) {
            if (!isFileCoveredBySet(file, coveredFiles)) {
                return false;
            }
        }
        return true;
    } catch (err) {
        mcpLog.warn(`[CppCompile] Failed to read/parse compile_commands.json: ${err}`);
        return false;
    }
}

/* ---------- C++ project initialization (compileNative) ---------- */

/** compile_commands.json 的相对路径段（与 common.ts COMPILE_COMMANDS_RELATIVE_SEGMENTS 一致）。 */
const COMPILE_COMMANDS_RELATIVE_SEGMENTS = [
    '.idea',
    '.deveco',
    'cxx',
    'compile_commands.json',
] as const;

/**
 * 执行 compileNative 构建以生成 compile_commands.json。
 * node/hvigor 由启动期固定（ToolProvider 注入），不再从 sdkPath 派生。
 */
export async function runCompileNative(
    projectPath: string,
    sdkPath: string,
    nodePath: string,
    hvigorJsPath: string,
    cppModules: ModuleInfo[],
): Promise<void> {
    if (!hvigorJsPath) {
        mcpLog.warn(`[CppCompile] hvigorw.js path not injected (sdk '${sdkPath}')`);
        return;
    }
    mcpLog.info(`[CppCompile] sdkPath: ${sdkPath}, hvigorPath: ${hvigorJsPath}`);

    for (const module of cppModules) {
        const moduleName = module.name;
        try {
          CommonUtils.assertModuleName(moduleName);
        } catch {
          mcpLog.warn(`[CppCompile] Skipping module with invalid name: ${moduleName}`);
          continue;
        }
        const hvigorArgs = [
            '--mode', 'module',
            '-p', `module=${module.name}`,
            '-p', 'product=default',
            'compileNative',
        ].join(' ');

        mcpLog.info(`[CppCompile] Running compileNative for module: ${module.name}`);

        const result = await executeBuildCommand(
            projectPath,
            nodePath,
            hvigorJsPath,
            sdkPath,
            hvigorArgs,
        );

        if (result.success) {
            mcpLog.info(`[CppCompile] compileNative ${module.name} succeeded`);
        } else {
            mcpLog.warn(`[CppCompile] compileNative ${module.name} failed: ${result.output}`);
        }
    }
}

/**
 * 完整的 C++ 工程初始化流程：
 * 1. 查找含 C++ 的模块
 * 2. 对每个模块执行 compileNative
 * 3. 合并 compile_commands.json
 * 4. 写入源文件清单 manifest（供启动期 {@link checkCppSyncRequired} 对比增删）
 */
export async function initializeCppProject(projectPath: string, sdkPath: string, nodePath: string, hvigorJsPath: string): Promise<void> {
    const cppModules = findCppModules(projectPath);

    if (cppModules.length === 0) {
        mcpLog.info('[CppCompile] No C++ modules found, skipping initialization');
        return;
    }

    mcpLog.info(
        `[CppCompile] Found ${cppModules.length} C++ module(s): ${cppModules.map((m) => m.name).join(', ')}`,
    );

    await runCompileNative(projectPath, sdkPath, nodePath, hvigorJsPath, cppModules);
    findAndMergeCompileCommands(projectPath);
    writeCppSourceManifest(projectPath, cppModules);
}

/** 检查是否需要进行 C++ 初始化。返回 true 表示需要初始化，false 表示可以直接检查。 */
export function prepareCppCheck(projectPath: string, filesToCheck: string[]): boolean {
    const ccPath = compileCommandsPath(projectPath);

    // 1. compile_commands.json 不存在 → 需要初始化
    if (!fs.existsSync(ccPath)) {
        mcpLog.info('[CppCompile] compile_commands.json not found, needs initialization');
        return true;
    }

    // 2. 检查是否存在 cpp_modules
    const cppModules = findCppModules(projectPath);
    if (cppModules.length === 0) {
        mcpLog.info('[CppCompile] No cpp modules found, no initialization needed');
        return false;
    }

    // 3. 检查传入文件是否被 compile_commands.json 覆盖
    const covered = checkFilesCoveredByCompileCommands(ccPath, filesToCheck);
    if (!covered) {
        mcpLog.info('[CppCompile] Files not fully covered by compile_commands.json, needs initialization');
        return true;
    }

    mcpLog.info('[CppCompile] All files covered, no initialization needed');
    return false;
}

/**
 * 校验用户自定义 compile_commands.json 路径（DEVECO_CLI_CPP_COMPILE_COMMANDS）。
 * 支持三种形态：
 *  - 绝对路径：原样使用
 *  - `{workspace}` 占位符模板：替换为工程根（如 `{workspace}/compile_commands.json`），
 *    使多工程共享同一份 agent 配置时各自命中自己的编译数据库
 *  - 相对路径：按工程根解析
 * 文件存在且为合法 JSON 数组时返回其所在目录（供 clangd --compile-commands-dir 使用）；
 * 否则告警并返回 null（回退到默认的 compileNative 同步流程）。
 */
export function resolveCustomCompileCommandsDir(customPath?: string, projectRoot?: string): string | null {
    const trimmed = customPath?.trim() ?? '';
    if (!trimmed) {
        return null;
    }
    let candidate = trimmed;
    if (/\{workspace\}/i.test(candidate)) {
        if (!projectRoot) {
            mcpLog.warn('[CppCompile] {workspace} placeholder in compile_commands path but no project root resolved, falling back to default sync');
            return null;
        }
        candidate = candidate.replace(/\{workspace\}/gi, projectRoot);
    } else if (!path.isAbsolute(candidate)) {
        if (!projectRoot) {
            mcpLog.warn(`[CppCompile] Relative compile_commands path '${candidate}' requires a project root, falling back to default sync`);
            return null;
        }
        candidate = path.join(projectRoot, candidate);
    }
    const filePath = path.resolve(candidate);
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            mcpLog.warn(`[CppCompile] Custom compile_commands.json not found: ${filePath}, falling back to default sync`);
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!Array.isArray(parsed)) {
            mcpLog.warn(`[CppCompile] Custom compile_commands.json is not a JSON array: ${filePath}, falling back to default sync`);
            return null;
        }
    } catch (err) {
        mcpLog.warn(`[CppCompile] Failed to read custom compile_commands.json (${filePath}): ${err}, falling back to default sync`);
        return null;
    }
    return path.dirname(filePath);
}

/* ---------- C++ 同步必要性检查（MCP 启动期） ---------- */

/**
 * mtime 容差（毫秒）。与 project-check.ts 保持一致，
 * 部分文件系统（FAT32、网络挂载）的 mtime 精度为 2s，引入 1s 容差避免误判。
 */
const CPP_MTIME_TOLERANCE_MS = 1000;

/** C++ 模块中 CMakeLists.txt 的标准相对路径段。 */
const CMAKE_LISTS_RELATIVE_SEGMENTS = ['src', 'main', 'cpp', 'CMakeLists.txt'] as const;

/** 递归遍历时跳过的目录名（构建产物 / 依赖缓存，非源码）。 */
const SKIP_DIR_NAMES = new Set(['.cxx', 'build', 'node_modules', '.preview', '.hvigor', '.idea']);

/** C++ 源文件扩展名（compile_commands.json 仅记录编译单元，不含头文件）。 */
const CPP_SOURCE_EXTENSIONS = new Set(['c', 'cpp', 'cxx', 'cc']);

/** manifest 文件名（与 compile_commands.json 同目录）。 */
const CPP_SOURCE_MANIFEST_FILENAME = 'cpp-source-manifest.json';

/** C++ 同步必要性检查结果。 */
export interface CppSyncCheckResult {
    required: boolean;
    reason: string;
}

/** manifest 文件结构。 */
interface CppSourceManifest {
    /** 上次初始化时记录的 C++ 源文件相对路径列表（已排序）。 */
    files: string[];
    /** 写入时间戳（ms）。 */
    updatedAt: number;
}

/** 判断是否为 C++ 源文件（编译单元，不含头文件）。 */
function isCppSourceFile(fileName: string): boolean {
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    return CPP_SOURCE_EXTENSIONS.has(ext);
}

/** 文件存在且 mtime 晚于 baseline（含容差）则返回 true。 */
function isFileNewerThan(filePath: string, baseline: number): boolean {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    return fs.statSync(filePath).mtimeMs - baseline > CPP_MTIME_TOLERANCE_MS;
}

/** manifest 文件绝对路径（与 compile_commands.json 同目录）。 */
function cppSourceManifestPath(projectPath: string): string {
    return path.join(path.dirname(compileCommandsPath(projectPath)), CPP_SOURCE_MANIFEST_FILENAME);
}

/** 递归收集模块源目录下所有 C++ 源文件的相对路径（readdirSync，不逐文件 statSync）。 */
function collectCppSourceRelPaths(dir: string, projectRoot: string, result: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) {
                continue;
            }
            collectCppSourceRelPaths(fullPath, projectRoot, result);
        } else if (isCppSourceFile(entry.name)) {
            result.push(path.relative(projectRoot, fullPath).replace(/\\/g, '/'));
        }
    }
}

/** 收集所有 C++ 模块的源文件相对路径（已排序）。 */
function collectAllCppSourceRelPaths(projectPath: string, cppModules: ModuleInfo[]): string[] {
    const result: string[] = [];
    for (const mod of cppModules) {
        // srcPath 来自用户自己的 build-profile.json5（与 IDE/hvigor 信任级别一致），
        // 允许指向工程外（外部模块），不做路径穿越校验。
        const modulePath = path.resolve(projectPath, mod.srcPath);
        collectCppSourceRelPaths(modulePath, projectPath, result);
    }
    return result.sort();
}

/**
 * 在 initializeCppProject 成功后写 manifest，记录当前 C++ 源文件清单。
 * 启动期 {@link checkCppSyncRequired} 据此对比文件集是否变化（新增/删除 .cpp）。
 */
export function writeCppSourceManifest(projectPath: string, cppModules: ModuleInfo[]): void {
    const files = collectAllCppSourceRelPaths(projectPath, cppModules);
    const manifest: CppSourceManifest = { files, updatedAt: Date.now() };
    const manifestPath = cppSourceManifestPath(projectPath);
    try {
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        mcpLog.info(`[CppCompile] C++ source manifest written, ${files.length} files`);
    } catch (e) {
        mcpLog.warn(`[CppCompile] Failed to write C++ source manifest: ${e}`);
    }
}

/**
 * 检查 3（内部）：源文件清单对比。
 * 读取 manifest 中记录的文件集，重新遍历当前源目录，对比是否一致（新增/删除 .cpp）。
 * @returns null 表示清单一致无需初始化；否则返回需要初始化的结果。
 */
function checkCppSourceManifest(projectPath: string, cppModules: ModuleInfo[]): CppSyncCheckResult | null {
    const manifestPath = cppSourceManifestPath(projectPath);
    if (!fs.existsSync(manifestPath)) {
        return { required: true, reason: 'C++ source manifest not found, needs initialization' };
    }
    let recordedFiles: string[];
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<CppSourceManifest>;
        recordedFiles = Array.isArray(manifest.files) ? manifest.files : [];
    } catch {
        return { required: true, reason: 'C++ source manifest corrupted, needs initialization' };
    }
    const currentFiles = collectAllCppSourceRelPaths(projectPath, cppModules);
    if (currentFiles.length !== recordedFiles.length ||
        currentFiles.some((f, i) => f !== recordedFiles[i])) {
        return {
            required: true,
            reason: `C++ source file set changed (recorded=${recordedFiles.length}, actual=${currentFiles.length})`,
        };
    }
    return null;
}

/**
 * 判断 MCP 启动时是否需要执行 C++ 初始化（compileNative + 合并 compile_commands.json）。
 *
 * 三级检查（短路求值，命中即返回）：
 *   1. 基准存在性 — compile_commands.json 不存在 → 需要初始化
 *   2. C++ 构建配置 mtime — build-profile.json5 或 CMakeLists.txt 晚于基准 → 需要初始化
 *   3. 源文件清单对比 — manifest 中记录的文件集与当前目录不一致（新增/删除 .cpp）→ 需要初始化
 *
 * 设计依据：
 *   compile_commands.json 是编译数据库（编译命令 + flags + 文件列表），不是编译产物。
 *   已有 .cpp 文件的内容编辑不改变它（clangd 通过 didOpen/didChange 感知内容变化），
 *   只有结构性变更（配置变化、文件增删）才需要重新生成。
 *
 *   - 检查 2 查 build-profile.json5（含 buildNativeOption：CMake 路径/参数/ABI）
 *     + CMakeLists.txt（C++ 专属构建配置：flags、include 路径、显式源文件列表），
 *     覆盖配置内容变更。
 *   - 检查 3 的 manifest 覆盖 CMake glob 新增/删除 .cpp 文件的场景
 *     （CMakeLists.txt 未变但文件集变了）。
 *
 * 性能：检查 2 是 O(模块数 × 2) 次 statSync（毫秒级）；检查 3 仅在检查 2 通过后执行，
 * 遍历用 readdirSync（每目录一次 syscall）不逐文件 statSync，1000 文件 / 50 目录 ≈ <10ms。
 *
 * @param projectPath 项目根目录
 */
export function checkCppSyncRequired(projectPath: string): CppSyncCheckResult {
    // ---- 检查 1：基准存在性 ----
    const baselinePath = compileCommandsPath(projectPath);
    if (!fs.existsSync(baselinePath)) {
        return { required: true, reason: 'C++ baseline (compile_commands.json) not found, needs initialization' };
    }
    const baseline = fs.statSync(baselinePath).mtimeMs;

    const cppModules = findCppModules(projectPath);
    if (cppModules.length === 0) {
        return { required: false, reason: 'no C++ modules, skip compileNative' };
    }

    // ---- 检查 2：C++ 构建配置 mtime 对比 ----
    for (const mod of cppModules) {
        // 允许外部模块（srcPath 指向工程外），与 IDE/hvigor 行为一致，不做穿越校验。
        const modulePath = path.resolve(projectPath, mod.srcPath);

        // build-profile.json5（含 buildNativeOption 段：CMake 路径/参数/ABI）
        if (isFileNewerThan(path.join(modulePath, 'build-profile.json5'), baseline)) {
            return { required: true, reason: `module '${mod.name}': build-profile.json5 newer than baseline` };
        }

        // CMakeLists.txt（C++ 专属构建配置：flags、include 路径、显式源文件列表）
        const cmakeListsPath = path.join(modulePath, ...CMAKE_LISTS_RELATIVE_SEGMENTS);
        if (isFileNewerThan(cmakeListsPath, baseline)) {
            return { required: true, reason: `module '${mod.name}': CMakeLists.txt newer than baseline` };
        }
    }

    // ---- 检查 3：源文件清单对比（CMake glob 新增/删除 .cpp）----
    const manifestResult = checkCppSourceManifest(projectPath, cppModules);
    if (manifestResult) {
        return manifestResult;
    }

    return {
        required: false,
        reason: `C++ project up-to-date (baseline: ${new Date(baseline).toISOString()})`,
    };
}
