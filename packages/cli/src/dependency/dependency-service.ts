/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { inspectProjectInputs } from '../project-model/project-inspector.js';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { manifests } from './package-graph.js';
import { addOhpm, type DependencyResolution } from './ohpm-lock.js';
import { addNpm } from './npm-lock.js';
import { addNative, addImports } from './native-and-imports.js';
import { auditGraph, dependencyChains } from './graph-audit.js';
import { cycloneDx, spdx } from './sbom.js';
import type { ExecutionContext, ToolSpec, ToolResult } from '../runtime/types.js';
import type { DependencyGraph } from './types.js';

export async function analyzeDependencies(context: ExecutionContext): Promise<DependencyGraph> {
  const { project, files } = await inspectProjectInputs(context);
  const graph: DependencyGraph = { root: project.root, schemaVersion: '1.0', analyzerVersion: '1.0', completeness: 'complete',
    project, components: [], relationships: [], findings: project.diagnostics.filter((item) => item.code === 'DEPENDENCY_INPUT_UNAVAILABLE'), inputs: [...project.inputs],
    usage: { unused: 'not-evaluated', basis: ['literal-import-candidates', 'manifest-and-lock', 'literal-cmake', 'dynamic-resource-and-build-use-not-excluded'] },
    checks: { vulnerabilities: 'not-run', licenseValidation: 'not-run', nativeAbi: 'not-run', installedPackages: 'not-read' } };
  if (project.kind === 'unknown') {
    graph.findings.push({ code: 'PROJECT_FACETS_UNKNOWN', severity: 'info', confidence: 'observed',
      message: 'No complete project facet was identified; only available dependency inputs are analyzed', evidence: [] });
  }
  const owners = manifests(files, graph), resolutions: DependencyResolution = new Map();
  await addOhpm(owners, graph, resolutions); await addNpm(owners, graph, resolutions);
  context.abortSignal.throwIfAborted();
  addNative(files, graph); addImports(files, owners, graph, resolutions); auditGraph(graph);
  return graph;
}
function result(graph: DependencyGraph, data: unknown = graph): ToolResult {
  return { exitCode: graph.completeness === 'incomplete' ? 3 : graph.findings.some((item) => item.severity === 'warning') ? 1 : 0, data };
}
const empty = z.strictObject({});
const whySchema = z.strictObject({ name: z.string().min(1).max(256) });
const sbomSchema = z.strictObject({ standard: z.enum(['cyclonedx', 'spdx']).default('cyclonedx') });
export function getDependencySpecs(): ToolSpec[] {
  const specs = [
    serviceSpec('deps.analyze', 'Read OHPM, npm and literal Native dependency evidence without installation', empty,
      async (_, context) => result(await analyzeDependencies(context))),
    serviceSpec('deps.audit', 'Audit local dependency evidence; no online vulnerability scan', empty, async (_, context) => {
      const graph = await analyzeDependencies(context);
      return result(graph, { project: graph.project, completeness: graph.completeness, findings: graph.findings, checks: graph.checks, inputs: graph.inputs });
    }),
    serviceSpec('deps.why', 'Explain a package through recorded incoming dependency chains', whySchema, async (input, context) => {
      const { name } = whySchema.parse(input), graph = await analyzeDependencies(context);
      const components = graph.components.filter((node) => node.name === name || node.id === name);
      if (!components.length) { return { exitCode: 4, data: { code: 'DEPENDENCY_NOT_FOUND', name } }; }
      return result(graph, { name, project: graph.project, components, ...dependencyChains(graph, components.map((node) => node.id)), completeness: graph.completeness, inputs: graph.inputs });
    }, [valueOption('name', 'Package name or component identity')]),
    serviceSpec('deps.sbom', 'Export the observed three-ecosystem inventory as CycloneDX 1.6 or SPDX 2.3', sbomSchema, async (input, context) => {
      const { standard } = sbomSchema.parse(input), graph = await analyzeDependencies(context);
      return result(graph, { standard, project: graph.project, document: standard === 'spdx' ? spdx(graph) : cycloneDx(graph), completeness: graph.completeness,
        inputs: graph.inputs, relationships: graph.relationships, findings: graph.findings, checks: graph.checks });
    }, [valueOption('standard', 'cyclonedx (default) or spdx')]),
  ];
  return specs.map((spec) => ({ ...spec, idempotency: 'read', recovery: 'verify-and-retry', evidence: ['input-hash', 'dependency-relationships', 'receipt'] }));
}
