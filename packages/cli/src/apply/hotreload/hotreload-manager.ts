/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import { green, yellow } from 'colorette';
import { ToolProvider } from '../../toolchain';
import type { Project } from '../../utils/project.js';
import { parseApplyFileList } from '../changefile-parser.js';
import { ChangedFileListWriter } from '../changed-file-list-writer.js';
import { resolveModuleSrcPath } from '../module-path.js';
import { BuildConfigManager } from '../build-config.js';
import { InstallHqf } from '../install-hqf.js';
import { HvigorDaemonClient } from './hvigor-daemon-client.js';
import { HvigorAdapter } from '../../utils/hvigor-adapter.js';
import { withBuildLock } from '../../utils/build-lock.js';
import { PatchManager } from './patch-manager.js';
import { GenSignHqf, type GenSignHqfResult } from './gen-sign-hqf.js';


export interface HotReloadApplyContext {
  applyFileName: string;
  projectPath: string;
  moduleName: string;
  productName: string;
  bundleName: string;
  toolProvider: ToolProvider;
  targetDeviceId: string;
  moduleSpecs: string[];
}

export interface HotReloadApplyResult {
  success: boolean;
  message: string;
}

export async function executeHotReloadApply(
  ctx: HotReloadApplyContext
): Promise<HotReloadApplyResult> {
  const t0 = Date.now();
  const moduleSrcPath = resolveModuleSrcPath(ctx.projectPath, ctx.moduleName);
  const applyFile = resolveApplyFile(ctx);

  console.log(yellow('[HotReload] Ensure the project source is trusted before proceeding.'));
  const daemonClient = assertHotReloadReady(ctx);

  const files = parseApplyFileList(applyFile, ctx.projectPath);
  console.log(`[HotReload] Parsed ${files.length} changed file(s) from ${ctx.applyFileName}`);

  writeChangeList(ctx, files);
  generatePatch(ctx, moduleSrcPath);
  await runDaemonHotCompile(ctx, daemonClient);

  const patchJsonPath = path.join(ctx.projectPath, moduleSrcPath, 'patch.json');
  const signedHqfPaths = await resolveHqf(ctx, moduleSrcPath, patchJsonPath);

  await deployHqf(ctx, signedHqfPaths);

  console.log(green('[HotReload] hot reload applied successfully (app not restarted).'));
  console.log(`[Timing] TOTAL executeHotReloadApply: ${Date.now() - t0}ms`);
  return { success: true, message: 'Hot reload applied successfully.' };
}

function resolveApplyFile(ctx: HotReloadApplyContext): string {
  if (path.basename(ctx.applyFileName) !== ctx.applyFileName) {
    throw new Error(
      `apply file must be a plain file name (under .hvigor/), got: ${ctx.applyFileName}`
    );
  }
  return path.join(ctx.projectPath, '.hvigor', ctx.applyFileName);
}

function assertHotReloadReady(ctx: HotReloadApplyContext): HvigorDaemonClient {
  const { projectPath, toolProvider } = ctx;
  const daemonClient = new HvigorDaemonClient(projectPath, toolProvider);
  if (!daemonClient.findProjectDaemon()) {
    throw new Error(
      'No running hvigor daemon found. Run `devecocli run --hotreload` first to start the daemon.'
    );
  }
  return daemonClient;
}

function writeChangeList(ctx: HotReloadApplyContext, files: string[]): void {
  const result = ChangedFileListWriter.writeChangedFileLists(
    ctx.projectPath,
    ctx.productName,
    files,
    ctx.moduleName
  );
  if (result.writtenModules.length === 0) {
    throw new Error('No changed files belong to a runnable module');
  }
  console.log(
    green(`[HotReload] changedFileList written for: ${result.writtenModules.join(', ')}`)
  );
  if (result.skippedFiles.length > 0) {
    console.warn(yellow(`[HotReload] skipped ${result.skippedFiles.length} file(s)`));
  }
}

function generatePatch(ctx: HotReloadApplyContext, moduleSrcPath: string): void {
  const patchConfig = PatchManager.generateOrUpdate(
    ctx.projectPath,
    moduleSrcPath,
    ctx.moduleName
  );
  console.log(
    green(
      `[HotReload] patch.json ready (patchVersionCode=${patchConfig.app.patchVersionCode})`
    )
  );
}

async function runDaemonHotCompile(
  ctx: HotReloadApplyContext,
  daemonClient: HvigorDaemonClient
): Promise<void> {
  const t3 = Date.now();
  const watchLogPath = daemonClient.getWatchLogPath();
  try {
    console.log('[HotReload] Daemon hot compile (socket short connection)...');
    const exitCode = await daemonClient.sendHotCompile({
      moduleSpecs: ctx.moduleSpecs,
      productName: ctx.productName,
    });
    if (exitCode !== 0) {
      const detail = readWatchLogTail(watchLogPath);
      throw new Error(
        `Daemon hot compile exited with code ${exitCode}` +
          (detail ? `\n--- compile output (from watch session) ---\n${detail}` : '')
      );
    }
  } finally {
    daemonClient.disconnect();
  }
  console.log(`[Timing] daemon hot compile: ${Date.now() - t3}ms`);
}

function readWatchLogTail(watchLogPath: string): string {
  try {
    if (!fs.existsSync(watchLogPath)) {
      return '';
    }
    const lines = fs.readFileSync(watchLogPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-40).join('\n');
  } catch {
    return '';
  }
}

async function resolveHqf(
  ctx: HotReloadApplyContext,
  moduleSrcPath: string,
  patchJsonPath: string
): Promise<string[]> {
  const intermediates = path.join(
    ctx.projectPath,
    moduleSrcPath,
    'build',
    ctx.productName,
    'intermediates'
  );
  // abc location per buildConfig patchConfig.patchAbcPath:
  //   hot  (--hot-compile): intermediates/hotReload/patchAbcPath/ets/modules.abc
  //   cold (no hotCompile): intermediates/patch/default/ets/modules.abc
  // checkAbcExists looks for <dir>/ets/modules.abc, so pass the dir that
  // contains the `ets/` subfolder (NOT the parent that lacks it).
  const abcCandidates = [
    path.join(intermediates, 'hotReload', 'patchAbcPath'),
    path.join(intermediates, 'patch', 'default'),
  ];
  const t4 = Date.now();
  const genSign = new GenSignHqf(ctx.toolProvider, ctx.projectPath);
  const isEmulator = ctx.targetDeviceId.includes('127.0.0.1') || ctx.targetDeviceId.includes('localhost');
  let hqfResult: GenSignHqfResult | null = null;
  for (const dir of abcCandidates) {
    const r = await genSign.generateAndSign(
      ctx.moduleName,
      dir,
      patchJsonPath,
      ctx.productName,
      isEmulator
    );
    if (r.success && r.signedHqfPaths.length > 0) {
      hqfResult = r;
      break;
    }
    hqfResult = r;
  }
  console.log(`[Timing] gen+sign hqf: ${Date.now() - t4}ms`);
  if (!hqfResult?.success || hqfResult.signedHqfPaths.length === 0) {
    throw new Error(
      `hqf generation/signing failed (no abc found in any candidate). ` +
        `Last: ${hqfResult?.message ?? 'unknown'}`
    );
  }
  return hqfResult.signedHqfPaths;
}

async function deployHqf(
  ctx: HotReloadApplyContext,
  signedHqfPaths: string[]
): Promise<void> {
  const t5 = Date.now();
  const installer = new InstallHqf(ctx.toolProvider);
  const installResult = await installer.install(
    ctx.targetDeviceId,
    signedHqfPaths,
    ctx.bundleName
  );
  console.log(`[Timing] quickfix install: ${Date.now() - t5}ms`);
  if (!installResult.success) {
    throw new Error(`hqf install failed: ${installResult.message}`);
  }
}

// --- run-side hot-reload flow helpers (used by run.ts flows) ---

export function assertSingleHotReloadModule(
  moduleArg: string[] | undefined,
  moduleName: string
): void {
  if (!moduleArg || moduleArg.length === 0) {
    throw new Error(
      `Hot reload requires --module <name> (a single target module; har deps are fine). Got: '${moduleName ?? ''}' (no --module passed).`
    );
  }
}

// Hot reload targets a single module (any type, har deps folded in). Changes in
// feature/hsp *dependency* modules (not the target) are NOT hot-reloadable.
export function warnUnsupportedModules(
  project: Project,
  targetModule: string,
  applyFileName: string
): void {
  const applyFile = path.join(project.rootDir, '.hvigor', applyFileName);
  let files: string[];
  try {
    files = parseApplyFileList(applyFile, project.rootDir);
  } catch {
    return;
  }
  const unsupported = new Set<string>();
  for (const f of files) {
    const mod = project.findOwningModule(f);
    if (!mod || mod === targetModule) {
      continue;
    }
    const t = project.getModuleType(mod);
    if (t === 'feature' || t === 'shared') {
      unsupported.add(`${mod} (${t})`);
    }
  }
  if (unsupported.size > 0) {
    console.warn(
      yellow(
        `[HotReload] Changed files belong to feature/hsp dependency module(s): ${[...unsupported].join(', ')}. ` +
          'These are NOT hot-reloadable — run `devecocli run` (full redeploy) for them. ' +
          'Only the target module (+ har deps) will be hot-reloaded this time.'
      )
    );
  }
}

export function resolveHotReloadArtifacts(
  project: Project,
  moduleName: string,
  targetName: string,
  isEmulator: boolean,
  productName: string
): string[] {
  const artifactSet = new Set<string>();
  const nonHarModules = project.collectNonHarDependentModuleList(moduleName);
  for (const hsp of nonHarModules) {
    artifactSet.add(project.findArtifactPath(hsp, targetName, isEmulator, productName));
  }
  artifactSet.add(project.findArtifactPath(moduleName, targetName, isEmulator, productName));
  return [...artifactSet];
}

export async function stopHotReloadDaemon(
  toolProvider: ToolProvider,
  project: Project
): Promise<void> {
  const hvigorAdapter = new HvigorAdapter(toolProvider, project.rootDir);
  try {
    await hvigorAdapter.stopDaemon();
  } finally {
    // daemon 停止失败（如已死）时更要清理残留，故放 finally；持构建锁执行，
    // 避免删掉持锁中的 --apply（withBuildConfig）正在使用的 buildConfig.json
    await withBuildLock(
      project.rootDir,
      async () => {
        BuildConfigManager.removeAll(project);
      },
      () => console.log('Another build is already running for this project. Waiting for completion...')
    );
  }
  console.log(green('Hvigor daemon stopped.'));
}
