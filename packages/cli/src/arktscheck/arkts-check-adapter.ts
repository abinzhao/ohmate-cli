/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from '../utils/logger.js';
import { Project } from '../utils/project.js';
import { projectSkillChecker } from '../skills/index.js';
import type { ArktsCheckRequest, ArktsCheckResult } from './types.js';

const SCRIPT_RESOURCE_REL = path.join('resources', 'arkts-check.cjs');

/** 封装 arkts-check.cjs 脚本定位、命令执行和结果解析。 */
export class ArktsCheckAdapter {
  private readonly toolProvider: ToolProvider;
  private readonly cwd: string;

  constructor(toolProvider: ToolProvider, cwd: string) {
    this.toolProvider = toolProvider;
    this.cwd = cwd;
  }

  /** 执行一次 ArkTS 检查并返回标准化结果。 */
  public async check(request: ArktsCheckRequest): Promise<ArktsCheckResult> {
    const projectRoot = this.resolveProjectRoot(
      request.projectRoot,
      request.files
    );
    await projectSkillChecker.warnInvalidBundledLinks(projectRoot);
    const files = this.resolveFiles(projectRoot, request.files);
    const scriptPath = this.resolveScriptPath();
    const args = this.buildArgs(scriptPath, projectRoot, files, request.fix);
    const env = this.buildEnv();

    debugLog(`Executing: ${this.toolProvider.nodePath} ${args.join(' ')}`);

    const result = await execa(this.toolProvider.nodePath, args, {
      cwd: projectRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });

    return this.parseResult(result.stdout, result.stderr, result.exitCode ?? 1);
  }

  private resolveProjectRoot(explicit?: string, files?: string[]): string {
    if (explicit) {
      const resolved = path.resolve(this.cwd, explicit);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Project path not found: ${resolved}`);
      }
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        const found = this.discoverRootFrom(path.dirname(resolved));
        if (found) {
          return found;
        }
        throw new Error(
          `--project path is a file, not a project root: ${resolved}\n` +
            'Could not find a project-level build-profile.json5 above it. ' +
            'Pass the project root directory instead.'
        );
      }
      if (this.discoverRootFrom(resolved) !== resolved) {
        throw new Error(
          `Not a valid Harmony project root: ${resolved}\n` +
            '(project-level build-profile.json5 not found).'
        );
      }
      return resolved;
    }
    // 当有文件参数时，优先从文件路径推断项目根目录
    if (files && files.length > 0) {
      for (const f of files) {
        const abs = path.isAbsolute(f) ? f : path.resolve(this.cwd, f);
        const found = this.discoverRootFrom(path.dirname(abs));
        if (found) {
          return found;
        }
      }
    }
    // 没有文件参数或文件路径上找不到项目，回退到 cwd
    const fromCwd = this.discoverRootFrom(this.cwd);
    if (fromCwd) {
      return fromCwd;
    }
    throw new Error(
      'Not in a valid Harmony project directory ' +
        '(project-level build-profile.json5 not found). ' +
        'Run this command inside a project, or pass --project <path>.'
    );
  }

  /** 从指定目录向上查找项目根（复用 Project.discover），找不到返回 undefined。 */
  private discoverRootFrom(startDir: string): string | undefined {
    try {
      return Project.discover(startDir).rootDir;
    } catch {
      return undefined;
    }
  }

  private resolveFiles(projectRoot: string, files: string[]): string[] {
    if (files.length === 0) {
      return [];
    }
    // 相对路径先按 cwd 解析（与 resolveProjectRoot 的发现逻辑一致），
    // 文件不存在时再按 projectRoot 兜底（覆盖 --project 指向其它目录的场景）。
    const resolved = files.map((file) => {
      if (path.isAbsolute(file)) {
        return file;
      }
      const fromCwd = path.resolve(this.cwd, file);
      if (fs.existsSync(fromCwd)) {
        return fromCwd;
      }
      return path.resolve(projectRoot, file);
    });
    // 1. 不存在的文件直接报错
    const notFound = resolved.filter((f) => !fs.existsSync(f));
    if (notFound.length > 0) {
      throw new Error(
        `File(s) not found:\n` + notFound.map((f) => `  ${f}`).join('\n')
      );
    }
    // 2. 项目外的文件直接报错（无论扩展名）
    const outside = resolved.filter((file) => {
      const rel = path.relative(projectRoot, file);
      return rel.startsWith('..') || path.isAbsolute(rel);
    });
    if (outside.length > 0) {
      throw new Error(
        `File(s) outside the project root ${projectRoot}:\n` +
          outside.map((f) => `  ${f}`).join('\n')
      );
    }
    // 3. 过滤出待检查的 .ets 文件（.d.ets 为声明文件，与 cjs 侧过滤保持一致）
    const etsFiles = resolved.filter(
      (file) =>
        fs.statSync(file).isFile() &&
        file.endsWith('.ets') &&
        !file.endsWith('.d.ets')
    );
    if (etsFiles.length === 0) {
      throw new Error(
        `No .ets files found in the given file(s):\n` +
          resolved.map((f) => `  ${f}`).join('\n')
      );
    }
    return etsFiles;
  }

  private buildArgs(
    scriptPath: string,
    projectRoot: string,
    files: string[],
    fix: boolean
  ): string[] {
    const args = [scriptPath, '--project', projectRoot];
    args.push(fix ? '--fix' : '--no-fix');
    if (files.length > 0) {
      args.push('--files', ...files);
    }
    return args;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DEVECO_HOME: this.resolveDevecoHome(),
    };
  }

  /**
   * 推导 DEVECO_HOME：SDK 必须位于 <DEVECO_HOME>/sdk 下。
   * macOS Studio 场景 toolchainRoot 是剥掉 Contents 的 .app 根（见
   * normalizeMacStudioRoot），而 SDK 实际在 <app>/Contents/sdk 下，需补回。
   */
  private resolveDevecoHome(): string {
    const root = this.toolProvider.toolchainRoot;
    if (os.platform() === 'darwin' && !fs.existsSync(path.join(root, 'sdk'))) {
      const contents = path.join(root, 'Contents');
      if (fs.existsSync(path.join(contents, 'sdk'))) {
        return contents;
      }
    }
    return root;
  }

  private parseResult(
    stdout: string,
    stderr: string,
    exitCode: number
  ): ArktsCheckResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      const detail = stderr.trim();
      throw new Error(
        `arkts-check exited with code ${exitCode} but produced no output` +
          (detail ? `: ${detail}` : '')
      );
    }
    try {
      const parsed = JSON.parse(trimmed) as ArktsCheckResult;
      return {
        success: parsed.success ?? false,
        error: parsed.error,
        errors: parsed.errors ?? [],
        fixed: parsed.fixed ?? [],
        alsoModified: parsed.alsoModified ?? [],
        summary: {
          errorCount: parsed.summary?.errorCount ?? 0,
          warnCount: parsed.summary?.warnCount ?? 0,
          fixedCount: parsed.summary?.fixedCount ?? 0,
          checkerDiagCount: parsed.summary?.checkerDiagCount,
          fileCount: parsed.summary?.fileCount ?? 0,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to parse arkts-check output: ${trimmed.slice(0, 500)}`,
        { cause: error }
      );
    }
  }

  private resolveScriptPath(): string {
    const currentFilePath = fileURLToPath(import.meta.url);
    const dir = path.dirname(currentFilePath);

    if (currentFilePath.includes('dist')) {
      const projectRoot = path.dirname(dir);
      const candidate = path.join(projectRoot, 'src', SCRIPT_RESOURCE_REL);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const srcDir = path.dirname(dir);
    const projectRoot = path.dirname(srcDir);
    const candidate = path.join(projectRoot, 'src', SCRIPT_RESOURCE_REL);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    throw new Error(
      'arkts-check.cjs not found in deveco-cli package resources. ' +
        'Reinstall deveco-cli.'
    );
  }
}
