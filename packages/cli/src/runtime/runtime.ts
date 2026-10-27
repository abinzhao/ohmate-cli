/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ToolSpecRegistry } from './registry.js';
import { inspectEnvironment } from '../environment/index.js';
import { inspectProject } from '../project-model/index.js';
import { createApproval, validApproval, consumeApproval } from './approval.js';
import { acquireExecutionLock, ResourceBusyError } from './execution-lock.js';
import { getTaskSpecs } from '../tasks/index.js';
import { getAgentSpecs } from '../agent/agent-specs.js';
import { getProjectSpecs } from '../project-model/project-specs.js';
import { getWebSpecs } from '../web/web-specs.js';
import { getWorkspaceSpecs } from '../workspace/index.js';
import { getConfigSpecs } from '../project-config/index.js';
import { getCreationSpecs } from '../project-create/index.js';
import { getDependencySpecs } from '../dependency/index.js';
import { getQualitySpecs } from '../quality/index.js';
import { getReleaseSpecs } from '../release/index.js';
import { getIntegrationSpecs } from '../integrate/index.js';
import { getPortableSkillSpecs } from '../portable-skill/index.js';
import { getScanSpecs } from '../scan/index.js';
import { getProjectDocsSpecs } from '../project-docs/index.js';
import { getDebugSpecs } from '../debug/index.js';
import { getProblemPackageSpecs } from '../problem-package/index.js';
import { getAnalysisSpecs } from '../analyze/index.js';
import { InputInvalidError } from './types.js';
import { toolContext } from './tool-context.js';
import type { ExecutionContext, ExitCode, Receipt, ToolResult, ToolSpec } from './types.js';

const STATUSES = { 0: 'passed', 1: 'findings', 2: 'error', 3: 'degraded', 4: 'invalid', 5: 'blocked', 6: 'failed', 130: 'cancelled' } as const;
const VERSION = process.env.npm_package_version ?? '0.1.0';

function envelope(id: string, context: ExecutionContext, start: number, result: ToolResult, adapter = 'native'): Receipt {
  return {
    ...result, schemaVersion: '1.0', toolVersion: VERSION,
    command: id, status: STATUSES[result.exitCode], locale: context.locale,
    startedAt: new Date(start).toISOString(), durationMs: Date.now() - start,
    project: { root: context.projectRoot, workspaceId: context.workspaceId },
    capabilities: {}, warnings: result.warnings ?? [], artifacts: result.artifacts ?? [],
    taskId: context.taskId ?? null, provenance: { ...result.provenance, adapter },
  };
}

function nativeSpec(id: string, command: string[], description: string, execute: ToolSpec['execute']): ToolSpec {
  return {
    id, command, description, execute, risk: 'R0', adapter: 'native',
    inputSchema: z.strictObject({}), outputSchema: z.object({ exitCode: z.number(), data: z.unknown() }).passthrough(),
    requirements: [], timeoutMs: 60_000, cancellable: true,
    idempotency: 'read', recovery: 'verify-and-retry', evidence: ['report'],
    arguments: [], options: [],
  };
}

export class OHMateRuntime {
  constructor(readonly registry: ToolSpecRegistry) {}

  async execute(id: string, input: unknown, context: ExecutionContext): Promise<Receipt> {
    const start = Date.now();
    const spec = this.registry.get(id);
    if (!spec) {
      return envelope(id, context, start, { exitCode: 2, data: { code: 'TOOL_NOT_FOUND' } });
    }
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) {
      return envelope(id, context, start, { exitCode: 4, data: { code: 'INPUT_SCHEMA_INVALID', issues: parsed.error.issues } });
    }
    if (context.abortSignal.aborted) {
      return envelope(id, context, start, { exitCode: 130, data: { code: 'CANCELLED' } });
    }
    try {
      context = await toolContext(spec, parsed.data, context);
      const result = await this.perform(spec, parsed.data, context);
      spec.outputSchema.parse(result);
      return envelope(id, context, start, result, spec.adapter);
    } catch (error) {
      if (error instanceof InputInvalidError) {
        return envelope(id, context, start, { exitCode: 4, data: { code: 'INPUT_INVALID', message: error.message } }, spec.adapter);
      }
      if (error instanceof ResourceBusyError) {
        return envelope(id, context, start, { exitCode: 5, data: { code: 'RESOURCE_BUSY', message: error.message } }, spec.adapter);
      }
      const exitCode: ExitCode = context.abortSignal.aborted ? 130 : 6;
      return envelope(id, context, start, { exitCode, data: { code: 'TOOL_FAILED', message: error instanceof Error ? error.message : String(error) } }, spec.adapter);
    }
  }

  async risk(spec: ToolSpec, input: unknown, context?: ExecutionContext): Promise<ToolSpec['risk']> {
    if (spec.resolveRisk && context) { return spec.resolveRisk(input, context); }
    const { effectiveLegacyRisk } = await import('../legacy/catalog.js');
    return spec.adapter === 'legacy-child' ? effectiveLegacyRisk(spec, input) : spec.risk;
  }

  async checkPolicy(spec: ToolSpec, input: unknown, context: ExecutionContext): Promise<ToolResult | null> {
    const risk = await this.risk(spec, input, context);
    if (risk === 'R0' || risk === 'R1') {
      return null;
    }
    if (await validApproval(spec, input, risk, context)) {
      return null;
    }
    const plan = await createApproval(spec, input, risk, context);
    return {
      exitCode: 5,
      data: { code: context.policy.approvedPlan ? 'APPROVAL_STALE' : 'APPROVAL_REQUIRED', ...plan,
        resume: `ohmatecli execute ${spec.id} --input <json> --approve-plan ${plan.planId}` },
    };
  }

  private async perform(spec: ToolSpec, input: unknown, context: ExecutionContext): Promise<ToolResult> {
    if (spec.protocol && !context.protocolStdin) {
      return { exitCode: 5, data: { code: 'PROTOCOL_REQUIRES_TERMINAL' } };
    }
    const risk = await this.risk(spec, input, context);
    const release = await acquireExecutionLock(spec, risk, context);
    try {
      const policy = await this.checkPolicy(spec, input, context);
      if (policy) { return policy; }
      if (risk === 'R2' || risk === 'R3') { await consumeApproval(context); }
      const timeout = new AbortController();
      const timer = spec.timeoutMs > 0 ? setTimeout(() => timeout.abort('timeout'), spec.timeoutMs) : undefined;
      timer?.unref();
      try {
        const signal = AbortSignal.any([context.abortSignal, timeout.signal]);
        const result = await spec.execute(input, { ...context, abortSignal: signal });
        return timeout.signal.aborted && !context.abortSignal.aborted
          ? { exitCode: 6, data: { code: 'TOOL_TIMEOUT', timeoutMs: spec.timeoutMs, partial: result.data } } : result;
      } finally { clearTimeout(timer); }
    } finally { await release(); }
  }
}

export async function createRuntime(): Promise<OHMateRuntime> {
  const registry = new ToolSpecRegistry();
  const { getLegacySpecs } = await import('../legacy/catalog.js');
  for (const spec of getLegacySpecs()) {
    if (!['deveco.create', 'deveco.build'].includes(spec.id)) { registry.register(spec); }
  }
  for (const spec of getCreationSpecs()) { registry.register(spec); }
  registry.register(nativeSpec('doctor', ['doctor'], 'Read-only local environment diagnosis', (_, context) => inspectEnvironment(context)));
  registry.register(nativeSpec('capabilities', ['capabilities'], 'Registered commands, schemas and execution contracts', async () => ({ exitCode: 0, data: registry.describe() })));
  registry.register(nativeSpec('project.inspect', ['project', 'inspect'], 'Discover evidenced ArkTS, Cloud and Native project facets without running builds', async (_, context) => {
    try {
      const project = await inspectProject(context);
      return { exitCode: project.kind === 'unknown' ? 2 : project.completeness === 'incomplete' ? 3 : 0, data: project };
    } catch {
      context.abortSignal.throwIfAborted();
      return { exitCode: 2, data: { code: 'PROJECT_INVALID', message: 'Project evidence is unavailable' } };
    }
  }));
  const runtime = new OHMateRuntime(registry);
  for (const spec of getTaskSpecs(runtime)) { registry.register(spec); }
  for (const spec of getAgentSpecs(runtime)) { registry.register(spec); }
  for (const spec of getProjectSpecs()) { registry.register(spec); }
  for (const spec of getWebSpecs()) { registry.register(spec); }
  for (const spec of getDebugSpecs()) { registry.register(spec); }
  for (const spec of getProblemPackageSpecs()) { registry.register(spec); }
  for (const spec of getAnalysisSpecs()) { registry.register(spec); }
  for (const spec of getWorkspaceSpecs()) { registry.register(spec); }
  for (const spec of getConfigSpecs()) { registry.register(spec); }
  for (const spec of getDependencySpecs()) { registry.register(spec); }
  for (const spec of getQualitySpecs()) { registry.register(spec); }
  for (const spec of getScanSpecs()) { registry.register(spec); }
  for (const spec of getProjectDocsSpecs()) { registry.register(spec); }
  for (const spec of getReleaseSpecs()) { registry.register(spec); }
  for (const spec of getIntegrationSpecs(runtime)) { registry.register(spec); }
  for (const spec of getPortableSkillSpecs(registry)) { registry.register(spec); }
  return runtime;
}
