/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { inspectQualityProducer, qualityProducer } from '../quality/official-producers.js';
import { readEvidenceText, resolveSourceScope, sourceDrift, sourceScopeSchema, type SourceScope } from '../quality/source-scope.js';
import { digest, saveEvidence, saveEvidenceBytes } from '../quality/evidence.js';
import { escapeHtml } from '../scan/render-report.js';
import { patchPath, publicPath } from '../workspace/path-guard.js';
import type { Artifact, ExecutionContext, ToolResult } from '../runtime/types.js';
import type { ProcessOutput } from '../runtime/process-runner.js';
import { apiModelSchema, diffApi, exposeArkDoc, extractArkDocJson, type ApiEntry } from './api-model.js';
import { resolvePublicApi, type PublicSymbol } from './compiler-exports.js';

export const docsSchema = sourceScopeSchema.extend({ baseline: z.string().min(1).max(2048).regex(/\.json$/).optional() });
async function baselineModel(path: string | undefined, context: ExecutionContext, scope: SourceScope, exactFiles: boolean) {
  if (!path) { return null; }
  const privateRelative = isAbsolute(path) ? relative(context.artifactStore.root, path) : '..';
  const privateArtifact = !privateRelative.startsWith(`..${sep}`) && privateRelative !== '..' && !isAbsolute(privateRelative);
  const root = privateArtifact ? context.artifactStore.root : scope.project.root;
  const file = privateArtifact ? path : await patchPath(root, isAbsolute(path) ? relative(root, path).split(sep).join('/') : path, context.dataDir);
  const { text, evidence } = await readEvidenceText(root, file);
  const model = apiModelSchema.parse(JSON.parse(text));
  const outside = model.scope.files.some((name) => !scope.project.modules.some((module) =>
    scope.modules.includes(module.name) && /^src\/.+\.(?:ets|ts)$/.test(relative(module.path, join(scope.project.root, publicPath(name))).split(sep).join('/'))));
  if (JSON.stringify(model.scope.modules) !== JSON.stringify(scope.modules) || outside ||
    exactFiles && JSON.stringify(model.scope.files) !== JSON.stringify(scope.files) ||
    model.entries.some((entry) => !model.scope.files.includes(entry.file) || entry.id !== digest(JSON.stringify([entry.file, entry.kind, entry.name]))) ||
    new Set(model.entries.map((entry) => entry.id)).size !== model.entries.length) { throw new Error('Baseline identity or scope does not match selected public APIs'); }
  return { model, evidence };
}
async function collectApi(scope: SourceScope, context: ExecutionContext, producer: Awaited<ReturnType<typeof qualityProducer>>,
  sdk: string, artifacts: Artifact[], symbols: PublicSymbol[]) {
  const entries: ApiEntry[] = [];
  const files = [...new Set(symbols.map((symbol) => symbol.declarationFile))].sort();
  for (const [index, file] of files.entries()) {
    const output = join(producer.home, `output-${index}`);
    await mkdir(output);
    const invocation = await producer.invoke(['-s', sdk, '-w', scope.project.root, '-i', file, '-d', output,
      '--logPath', producer.home, '--lang', 'en']);
    const { text } = await readEvidenceText(producer.home, join(output, 'docs/index.html'));
    artifacts.push(await saveEvidenceBytes(context, 'docs-official-html', text, 'html'));
    if (invocation.toolExitCode !== 0 || invocation.truncated || invocation.signal) { throw new Error('Official ArkTSDoc failed; consult the original invocation'); }
    const raw = extractArkDocJson(text);
    artifacts.push(await saveEvidence(context, 'docs-official-model', raw));
    entries.push(...exposeArkDoc(raw, file, symbols.filter((symbol) => symbol.declarationFile === file)));
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}
function docsHtml(model: z.infer<typeof apiModelSchema>, hash: string): string {
  const entries = model.entries.map((entry) => `<article id="${entry.id}"><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.file)}</p><pre>${escapeHtml(entry.signature)}</pre><p>${escapeHtml(entry.description)}</p><pre>${escapeHtml(JSON.stringify(entry.tags, null, 2))}</pre></article>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OHMate API</title>
<style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#17212b;overflow-wrap:anywhere}article{border-top:1px solid #ddd;margin:24px 0;padding-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>OHMate public API</h1><p>Model SHA-256: ${hash}</p><p>Public exports and callable signatures resolved by the SDK compiler frontend; documentation from official ArkTSDoc. This export program does not establish a build input closure. Native exports and Cloud contracts require dedicated producers.</p>${entries}</html>`;
}
export async function executeProjectDocs(kind: 'generate' | 'check', input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const value = docsSchema.parse(input), scope = await resolveSourceScope({ modules: value.modules, files: value.files }, context);
  const baseline = await baselineModel(value.baseline, context, scope, Boolean(value.files));
  let tools: Awaited<ReturnType<typeof inspectQualityProducer>>;
  try { tools = await inspectQualityProducer('docs'); }
  catch (error) { return { exitCode: 3, data: { execution: 'not-run', code: 'OFFICIAL_PRODUCER_UNAVAILABLE',
    reason: error instanceof Error ? error.message : String(error) } }; }
  const invocations: ProcessOutput[] = [], artifacts: Artifact[] = [];
  const producer = await qualityProducer(context, tools, invocations);
  let entries: ApiEntry[] = [], failure: string | null = null;
  let compiler: Awaited<ReturnType<typeof resolvePublicApi>> | undefined;
  try {
    compiler = await resolvePublicApi(scope, tools.provider.sdkPath, context);
    artifacts.push(await saveEvidence(context, 'docs-compiler-exports', compiler.evidence));
    if (compiler.evidence.failure) { throw new Error(compiler.evidence.failure); }
    entries = await collectApi(scope, context, producer, tools.provider.sdkPath, artifacts, compiler.exports);
  }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { await producer.close(); }
  const drift: string[] = await sourceDrift(context, scope.inputs.files).catch((error) => {
    failure ??= `Source verification failed: ${error instanceof Error ? error.message : String(error)}`;
    return [];
  });
  drift.push(...await compiler?.verify() ?? []);
  const model = apiModelSchema.parse({ schemaVersion: '1.0', producer: 'official-arktsdoc',
    scope: { modules: scope.modules, files: scope.files }, entries });
  const modelHash = digest(JSON.stringify(model)), diff = baseline ? diffApi(baseline.model.entries, entries) : null;
  const undocumented = entries.filter((entry) => !entry.description.trim());
  const report = { schemaVersion: '1.0', execution: context.abortSignal.aborted ? 'cancelled' : failure ? 'failed' : 'executed',
    model, modelHash, diff, undocumented: undocumented.map(({ file, name, id }) => ({ file, name, id })),
    inputs: scope.inputs, sourceDrift: [...new Set(drift)].sort(), invocations, tools: tools.evidence,
    compiler: compiler?.evidence ?? null, baseline: baseline?.evidence ?? null, failure,
    coverage: { arkts: failure ? 'failed' : 'official-with-compiler-exports', native: 'not-run', cloud: 'not-run' } };
  artifacts.push(await saveEvidence(context, 'docs-report', report));
  if (!failure && !drift.length) {
    artifacts.push(await saveEvidence(context, 'docs-ai-json', model),
      await saveEvidence(context, 'docs-index', { modelHash, entries: model.entries.map(({ id, name, file, signature }) => ({ id, name, file, signature })) }),
      await saveEvidenceBytes(context, 'docs-html', docsHtml(model, modelHash), 'html'));
  }
  const findings = kind === 'check' && (diff ? diff.added.length + diff.removed.length + diff.changed.length : undocumented.length);
  return { exitCode: context.abortSignal.aborted ? 130 : failure ? 6 : drift.length ? 3 : findings ? 1 : 0,
    data: report, artifacts, provenance: { producer: tools.evidence, modelHash } };
}
