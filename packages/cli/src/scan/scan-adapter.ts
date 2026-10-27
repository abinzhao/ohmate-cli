/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { join } from 'node:path';
import { z } from 'zod';
import JSON5 from 'json5';
import { patchPath } from '../workspace/path-guard.js';
import { inspectQualityProducer, qualityProducer } from '../quality/official-producers.js';
import { readEvidenceText, resolveSourceScope, sourceDrift, sourceScopeSchema, type SourceScope } from '../quality/source-scope.js';
import { saveEvidence, saveEvidenceBytes } from '../quality/evidence.js';
import type { Artifact, ExecutionContext, ToolResult } from '../runtime/types.js';
import type { ProcessOutput } from '../runtime/process-runner.js';
import { normalizeLintReport, type ScanFinding } from './codelinter-report.js';
import { scanHtml, scanSarif } from './render-report.js';

export const domains = ['official', 'grammar', 'deprecated', 'arkui', 'arkweb', 'memory', 'module', 'dependency',
  'cloud', 'native', 'security', 'accessibility', 'localization', 'release'] as const;
export const scanSchema = sourceScopeSchema.extend({
  domains: z.array(z.enum(domains)).min(1).max(domains.length).default([...domains]),
  config: z.string().max(1024).regex(/\.json5?$/).optional(),
});
async function lintConfiguration(path: string | undefined, context: ExecutionContext) {
  if (!path) { return { path: null, evidence: null, rules: 'official-project-discovery' }; }
  const file = await patchPath(context.projectRoot ?? context.cwd, path, context.dataDir);
  const { text, evidence } = await readEvidenceText(context.projectRoot ?? context.cwd, file);
  const config = JSON5.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) { throw new Error('Linter config must be a JSON5 object'); }
  return { path: file, evidence, rules: config.rules ?? null };
}
async function collectLint(scope: SourceScope, config: Awaited<ReturnType<typeof lintConfiguration>>, context: ExecutionContext,
  producer: Awaited<ReturnType<typeof qualityProducer>>, artifacts: Artifact[]) {
  const findings: ScanFinding[] = [];
  for (const [index, file] of scope.files.entries()) {
    const output = join(producer.home, `lint-${index}.json`);
    const invocation = await producer.invoke([join(scope.project.root, file), ...(config.path ? ['--config', config.path] : []),
      '--format', 'json', '--output', output, '--exit-on', 'warn,error']);
    const { text } = await readEvidenceText(producer.home, output);
    artifacts.push(await saveEvidenceBytes(context, 'scan-raw-result', text));
    const items = normalizeLintReport(text, scope.project.root, [file]);
    if (invocation.truncated || invocation.signal || invocation.toolExitCode !== 0 && !(invocation.toolExitCode === 4 && items.length)) {
      throw new Error('Official Code Linter failed; consult the original invocation');
    }
    findings.push(...items);
  }
  return findings;
}
export async function executeScan(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const value = scanSchema.parse(input), scope = await resolveSourceScope({ modules: value.modules, files: value.files }, context);
  const config = await lintConfiguration(value.config, context);
  let tools: Awaited<ReturnType<typeof inspectQualityProducer>>;
  try { tools = await inspectQualityProducer('scan'); }
  catch (error) { return { exitCode: 3, data: { execution: 'not-run', code: 'OFFICIAL_PRODUCER_UNAVAILABLE',
    reason: error instanceof Error ? error.message : String(error) } }; }
  const invocations: ProcessOutput[] = [], artifacts: Artifact[] = [];
  const producer = await qualityProducer(context, tools, invocations);
  let findings: ScanFinding[] = [], failure: string | null = null;
  try { if (value.domains.includes('official')) { findings = await collectLint(scope, config, context, producer, artifacts); } }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { await producer.close(); }
  const drift = await sourceDrift(context, scope.inputs.files).catch((error) => {
    failure ??= `Source verification failed: ${error instanceof Error ? error.message : String(error)}`;
    return [];
  });
  const coverage = { completeness: value.domains.every((domain) => domain === 'official') && !failure && !drift.length ? 'requested-producer' : 'incomplete',
    domains: [...new Set(value.domains)].map((domain) => ({ domain, status: domain === 'official' ? failure ? 'failed' : 'executed' : 'not-run' })),
    limitation: 'Code Linter JSON lists diagnostic files only. Empty reports do not establish exhaustive ArkTS/compiler/Compat coverage.' };
  const report = { schemaVersion: '1.0', execution: context.abortSignal.aborted ? 'cancelled' : failure ? 'failed' : invocations.length ? 'executed' : 'not-run',
    scope: { modules: scope.modules, files: scope.files }, findings, coverage, tools: tools.evidence,
    configuration: config, inputs: scope.inputs, sourceDrift: drift, invocations, failure };
  artifacts.push(await saveEvidence(context, 'scan-report', report), await saveEvidence(context, 'scan-sarif', scanSarif(findings, coverage)),
    await saveEvidenceBytes(context, 'scan-html', scanHtml(findings, coverage), 'html'));
  return { exitCode: context.abortSignal.aborted ? 130 : failure ? 6 : coverage.completeness === 'incomplete' ? 3 : findings.length ? 1 : 0,
    data: report, artifacts, provenance: { producer: tools.evidence, completeness: coverage.completeness } };
}
