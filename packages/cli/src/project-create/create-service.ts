/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createProject, getApiVersionConfig, getTemplateDir, SUPPORTED_DEVICE_TYPES } from '../utils/template-provider.js';
import { ToolProvider } from '../toolchain/index.js';
import { sha256 } from '../agent/context-files.js';
import { inspectEnvironment } from '../environment/index.js';
import { readProject } from '../project-model/index.js';
import { InputInvalidError, type ExecutionContext, type ToolResult } from '../runtime/types.js';
import { createTarget } from './target-state.js';
import { templateFiles } from './template-files.js';
import { writeProjectBaseline } from './project-baseline.js';

export const createSchema = z.strictObject({
  appName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
  projectPath: z.string().min(1).max(1024).optional(),
  bundleName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/).max(128).optional(),
  apiLevel: z.string().regex(/^\d+$/).optional(),
  deviceTypes: z.array(z.enum(SUPPORTED_DEVICE_TYPES)).min(1).max(6).default(['phone']),
});

async function options(input: unknown, context: ExecutionContext) {
  const parsed = createSchema.parse(input), target = await createTarget(parsed.projectPath ?? parsed.appName, context);
  const provider = await ToolProvider.new().catch(() => undefined);
  const observed = provider?.getAvailableApiLevel(), apiLevel = parsed.apiLevel ? Number(parsed.apiLevel) : observed;
  if (!apiLevel || apiLevel < 17 || !getApiVersionConfig(apiLevel) || (observed !== undefined && apiLevel > observed)) {
    throw new InputInvalidError('Template API mapping or observed SDK API is unavailable; specify a supported API level');
  }
  return { ...parsed, ...target, apiLevel, provider,
    bundleName: parsed.bundleName ?? `com.example.${parsed.appName.toLowerCase()}`,
    deviceTypes: [...new Set(parsed.deviceTypes)], apiSource: parsed.apiLevel ? 'user-input' : 'sdk-metadata',
    sdkMetadataAvailable: observed !== undefined, sdkApiLevel: observed ?? null,
    toolchainVersion: provider?.readVersion() ?? null };
}
async function artifactDirectory(context: ExecutionContext): Promise<string> {
  const root = resolve(context.artifactStore.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) { throw new Error('Unsafe project evidence directory'); }
  return root;
}

async function generated<T>(input: unknown, context: ExecutionContext, use: (value: Awaited<ReturnType<typeof options>>, stage: string,
  review: Awaited<ReturnType<typeof creationReview>>) => Promise<T>): Promise<T> {
  let stage: string | undefined;
  try {
    const value = await options(input, context);
    stage = join(await artifactDirectory(context), `create-preview-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    createProject(stage, value.appName, value.bundleName, value.apiLevel, value.deviceTypes, value.provider?.devecoStudioPath);
    await writeProjectBaseline(stage, value.appName);
    const review = await creationReview(value, stage);
    return await use(value, stage, review);
  } catch (error) {
    if (error instanceof InputInvalidError) { throw error; }
    throw new InputInvalidError(error instanceof Error ? error.message : String(error));
  } finally { if (stage) { await rm(stage, { recursive: true, force: true }); } }
}
async function creationReview(value: Awaited<ReturnType<typeof options>>, stage: string) {
  const source = (await templateFiles(getTemplateDir())).map(({ path, sha256 }) => ({ path, sha256 }));
  return { schemaVersion: '1.0', target: value.target, targetIdentity: value.identity,
    appName: value.appName, bundleName: value.bundleName, apiLevel: value.apiLevel,
    apiSource: value.apiSource, sdkMetadataAvailable: value.sdkMetadataAvailable, sdkApiLevel: value.sdkApiLevel,
    toolchainVersion: value.toolchainVersion,
    template: { source: 'supplied-deveco-snapshot', hash: sha256(JSON.stringify(source)) },
    files: await templateFiles(stage), atomicity: 'directory-rename-with-external-writer-race',
    recovery: 'Created files are identified by this manifest; preserve later user edits before any removal',
    verification: { build: 'not-run', test: 'not-run', device: 'not-run' } };
}
export async function reviewCreation(input: unknown, context: ExecutionContext) {
  return generated(input, context, async (_value, _stage, review) => review);
}
async function saveManifest(context: ExecutionContext, review: unknown) {
  const path = join(await artifactDirectory(context), `project-create-${randomUUID()}.json`);
  const text = JSON.stringify({ schemaVersion: '1.0', planId: context.policy.approvedPlan, review });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  return { path, sha256: sha256(text), kind: 'project-create-manifest' };
}
export async function executeCreation(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  return generated(input, context, async (value, stage, review) => {
    const project = await readProject(stage), doctor = await inspectEnvironment({ ...context, projectRoot: stage });
    if (!project.modules.length || doctor.exitCode !== 0) { throw new Error('Generated project markers are incomplete'); }
    const artifact = await saveManifest(context, review);
    await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(),
      type: 'project.create.prepared', payload: { target: value.name, manifestHash: artifact.sha256 } });
    await commitCreation(value, stage, review.files, context);
    return { exitCode: 0, data: { code: 'PROJECT_CREATED', root: value.target,
      appName: value.appName, bundleName: value.bundleName, apiLevel: value.apiLevel,
      project: { ...project, root: value.target, modules: project.modules.map((item) => ({
        ...item, path: item.path.replace(stage, value.target),
      })) }, verification: { doctor: 'passed', project: 'passed', build: 'not-run', test: 'not-run', device: 'not-run' },
      next: ['ohmatecli doctor', 'ohmatecli project inspect', 'ohmatecli build --help'] },
    artifacts: [artifact], warnings: [...doctor.warnings ?? [],
      ...review.files.some((file) => file.format === 'fallback-icon') ? [{
        code: 'TEMPLATE_FALLBACK_ICONS', message: 'Studio artwork was unavailable; bundled template uses 1x1 fallback icons. Replace before release.',
      }] : []] };
  });
}

async function commitCreation(value: Awaited<ReturnType<typeof options>>, source: string,
  expected: Awaited<ReturnType<typeof templateFiles>>, context: ExecutionContext) {
  const stage = join(dirname(value.target), `.ohmate-create-${randomUUID()}`);
  let committed = false;
  await mkdir(stage, { mode: 0o700 });
  try {
    await cp(source, stage, { recursive: true, force: false, errorOnExist: true });
    if (JSON.stringify(await templateFiles(stage)) !== JSON.stringify(expected)) { throw new Error('Generated file hashes changed before commit'); }
    context.abortSignal.throwIfAborted();
    const current = await createTarget(value.target, context);
    if (current.identity !== value.identity) { throw new Error('Creation target changed after approval'); }
    if (value.identity !== null) { await rmdir(value.target); }
    // Node does not expose a portable no-replace rename for directories.
    await rename(stage, value.target);
    committed = true;
  } finally { if (!committed) { await rm(stage, { recursive: true, force: true }); } }
}
