/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { extname } from 'node:path';
import { z } from 'zod';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { saveEvidence, saveEvidenceBytes } from '../quality/evidence.js';
import type { ExecutionContext, ToolResult, ToolSpec } from '../runtime/types.js';
import { releaseSchema, type ReleaseSelection } from './types.js';
import { resolveRelease } from './release-inputs.js';
import { verifyRelease } from './release-gates.js';
import { releaseHtml, releaseSarif } from './render-report.js';

type Report = Awaited<ReturnType<typeof verifyRelease>>;
function exit(report: Report): ToolResult['exitCode'] { return report.summary.failed ? 1 : report.summary.incomplete ? 3 : 0; }
function guidance(report: Report, context: ExecutionContext) {
  const chinese = context.locale === 'zh-CN', ready = report.ready;
  const steps = chinese ? [
    '使用固定产品、模块和工具链执行 Release 构建，保存原始 build manifest。',
    '补齐门禁中列出的 Producer 证据，再运行 release verify；未验证项保持未就绪。',
    '人工核对权限、导出组件、隐私文案和目标设备回归。',
    '通过 release artifacts 保存同构建 SourceMap、nameCache 和 Native 符号。',
    '全部门禁就绪后，由开发者在官方发布流程中手动登录、签名、上传并提交审核。',
  ] : [
    'Build the selected release product/modules with a fixed toolchain and preserve the original build manifest.',
    'Supply the missing producer evidence and rerun release verify; unresolved gates remain incomplete.',
    'Manually review permissions, exported components, privacy disclosures and target-device regression.',
    'Archive build-matched SourceMap, nameCache and Native symbols with release artifacts.',
    'After all gates are ready, use the official release workflow to manually authenticate, sign, upload and submit.',
  ];
  const title = chinese ? `Release 人工交付指南 — ${ready ? '就绪' : '未就绪'}` : `Release manual guide — ${ready ? 'Ready' : 'Not ready'}`;
  const rows = report.gates.map((g) => `| ${g.number} | ${g.id} | ${g.status} | ${g.missing.join(', ') || '—'} |`);
  return `# ${title}\n\n${chinese ? '仅生成报告和人工步骤。已执行外部动作：无。' : 'Report and manual steps only. External actions performed: none.'}\n\n` +
    `| # | Gate | Status | Missing evidence |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
    steps.map((step, index) => `${index + 1}. ${step}`).join('\n') + '\n';
}
async function reportResult(input: unknown, context: ExecutionContext, guide = false): Promise<ToolResult> {
  const selection = await resolveRelease(input, context), report = await verifyRelease(selection, context);
  const artifact = await saveEvidence(context, 'release-report', report), artifacts = [artifact];
  artifacts.push(await saveEvidenceBytes(context, 'release-purity-sarif', JSON.stringify(releaseSarif(report), null, 2), 'sarif'));
  artifacts.push(await saveEvidenceBytes(context, 'release-purity-html', releaseHtml(report), 'html'));
  if (guide) { artifacts.push(await saveEvidenceBytes(context, 'release-guide', guidance(report, context), 'md')); }
  return { exitCode: exit(report), data: { ...report, ...(guide ? { manualOnly: true, performed: [] } : {}) }, artifacts,
    provenance: { completeness: report.ready ? 'complete' : 'incomplete', reportHash: artifact.sha256,
      manifestHash: selection.manifest?.file.sha256 ?? null, analyzerVersion: report.analyzerVersion } };
}
async function archiveSelection(selection: ReleaseSelection, context: ExecutionContext) {
  if (!selection.manifest) { throw new Error('Select an immutable build manifest before archiving release evidence'); }
  const files = [
    { kind: 'build-provenance', file: selection.manifest.file },
    ...selection.packages.map((p) => ({ kind: 'release-package', file: p.file })),
    ...selection.symbols.map((file) => ({ kind: 'release-symbol', file })),
  ];
  const archive = [], artifacts = [];
  for (const { kind, file } of files) {
    context.abortSignal.throwIfAborted();
    const artifact = await saveEvidenceBytes(context, kind, file.bytes, extname(file.path).slice(1));
    artifacts.push(artifact); archive.push({ kind, originalPath: file.path, archivedPath: artifact.path, sha256: file.sha256, size: file.size });
  }
  const index = { schemaVersion: '1.0', completeness: 'incomplete', manifestHash: selection.manifest.file.sha256,
    product: selection.product, modules: selection.modules, archive,
    missing: ['producer-buildId-and-symbol-correlations', 'complete-input-closure'],
    sourceInputs: selection.manifest.value.inputs, originalManifestUnchanged: true };
  artifacts.push(await saveEvidence(context, 'release-archive-index', index));
  return { exitCode: 3 as const, data: index, artifacts, provenance: { completeness: 'incomplete', manifestHash: index.manifestHash } };
}
const options = [
  valueOption('product', 'Declared Release product'), valueOption('modules', 'Declared module@target selections', true),
  valueOption('manifest', 'Project or private evidence-store build manifest'),
  valueOption('artifacts', 'Explicit build-matched HAP/HAR/HSP/APP files', true),
  valueOption('symbols', 'Explicit SourceMap/nameCache/Native symbol files', true),
];
export function getReleaseSpecs(): ToolSpec[] {
  const specs = [
    serviceSpec('release.verify', 'Verify all fourteen Release gates from selected source, package and producer evidence', releaseSchema, reportResult, options),
    serviceSpec('release.guide', 'Generate readiness and manual release steps; no signing or upload', releaseSchema,
      (input, context) => reportResult(input, context, true), options),
    serviceSpec('release.artifacts', 'Archive selected build artifacts and symbols without overwriting originals',
      releaseSchema.extend({ manifest: z.string().min(1).max(4096) }),
      async (input, context) => archiveSelection(await resolveRelease(input, context), context), options),
  ];
  return specs.map((spec) => ({ ...spec, risk: 'R1', evidence: ['input-hashes', 'release-report', 'immutable-evidence'],
    requirements: ['project'], idempotency: 'artifact' }));
}
