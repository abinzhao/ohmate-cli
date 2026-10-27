/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import type { ProcessOutput } from '../runtime/process-runner.js';
import { changedInputs, digest, evidenceFile, inputEvidence, saveEvidence, saveEvidenceBytes, type FileEvidence } from './evidence.js';
import { inspectBuildTools, officialAdapters, observedTasks } from './toolchain.js';
import { resolveTests } from './test-scope.js';
import { buildDiagnostics } from './build-service.js';
import { parseTestResults } from './test-results.js';

const reportPath = (module: string, kind: 'local' | 'instrument') =>
  join(module, '.test/default/intermediates', kind === 'local' ? 'test' : 'ohosTest', 'coverage_data/test_result.txt');
async function priorReports(selection: Awaited<ReturnType<typeof resolveTests>>) {
  const reports = new Map<string, FileEvidence | null>();
  for (const name of selection.modules) {
    const module = selection.project.modules.find((item) => item.name === name)!;
    reports.set(name, await evidenceFile(selection.project.root, reportPath(module.path, selection.kind)).catch(() => null));
  }
  return reports;
}
async function collectReports(selection: Awaited<ReturnType<typeof resolveTests>>, before: Map<string, FileEvidence | null>, context: ExecutionContext) {
  const reports = [];
  for (const name of selection.modules) {
    const module = selection.project.modules.find((item) => item.name === name)!, file = reportPath(module.path, selection.kind);
    const current = await evidenceFile(selection.project.root, file).catch(() => null), previous = before.get(name);
    const fresh = current && (!previous || current.sha256 !== previous.sha256 || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs);
    if (!current || !fresh) {
      reports.push({ module: name, status: current ? 'stale' : 'missing', result: null, passed: 0, failed: 0,
        complete: false, scopeMatched: false, missingCases: selection.selections.find((item) => item.module === name)!.expectedCases }); continue;
    }
    if (current.size > 8 * 1024 * 1024) { throw new Error('Test result exceeds 8 MiB'); }
    const text = await readFile(file, 'utf8');
    if (digest(text) !== current.sha256) { throw new Error('Test result changed during collection'); }
    const parsed = parseTestResults(text), expected = selection.selections.find((item) => item.module === name)!.expectedCases;
    const missingCases = expected.filter((name) => !parsed.cases.includes(name));
    const scopeMatched = parsed.cases.every((name) => expected.includes(name));
    const raw = await saveEvidenceBytes(context, 'test-raw-result', text, 'txt');
    reports.push({ module: name, status: 'fresh', result: { ...current, absolutePath: raw.path, sourcePath: file }, ...parsed, scopeMatched, missingCases,
      verdict: parsed.complete ? 'recognized-case-records' : 'incomplete-or-unknown-format' });
  }
  return reports;
}
export async function reviewTest(input: unknown, context: ExecutionContext) {
  const selection = await resolveTests(input, context), tools = await inspectBuildTools(), inputs = await inputEvidence(context);
  return { kind: selection.kind, modules: selection.modules, scope: selection.scope, files: selection.files ?? [],
    coverage: selection.coverage, asan: selection.asan, device: selection.device ?? null, tools: tools.evidence,
    execution: 'not-run', writes: ['test build/cache and result directories', 'private tool home', 'immutable test evidence'],
    buildOnly: selection.buildOnly, selections: selection.selections,
    inputs: inputs.files.map(({ path, sha256 }) => ({ path, sha256 })), excludedInputs: inputs.skipped,
    network: 'toolchain-bootstrap-and-project-scripts-may-download', source: 'official-hvigor-tasks-must-be-observed-after-approval' };
}
export async function executeTests(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const selection = await resolveTests(input, context), tools = await inspectBuildTools(), invocations: ProcessOutput[] = [];
  if (selection.kind === 'instrument' && !selection.buildOnly) {
    return { exitCode: 3, data: { ...selection, execution: 'not-run', code: selection.device ? 'VERIFIED_DEVICE_SELECTOR_UNAVAILABLE' : 'DEVICE_NOT_SELECTED',
      verification: { arkts: 'not-run', native: 'not-run', coverage: 'not-run', asan: 'not-run' } } };
  }
  if (selection.kind === 'local' && process.platform === 'linux') {
    return { exitCode: 3, data: { execution: 'not-run', code: 'LOCAL_TEST_PLATFORM_UNSUPPORTED' } };
  }
  const before = await priorReports(selection), inputs = await inputEvidence(context);
  const adapters = await officialAdapters(context, tools.provider, invocations);
  let failure: unknown, unsupported = false;
  try {
    await adapters.initialize();
    await adapters.hvigor.tasks('default', selection.modules.map((name) => `${name}@default`));
    const task = selection.kind === 'local' ? selection.buildOnly ? 'UnitTestBuild' : 'test' : 'assembleHap';
    unsupported = !new Set([...observedTasks(invocations), ...tools.evidence.taskDefinitions.tasks]).has(task);
    if (!unsupported) {
      if (selection.kind === 'instrument' && selection.buildOnly) {
        await adapters.hvigor.buildModules('default', 'debug', selection.modules.map((name) => `${name}@ohosTest`), new Set(['assembleHap']));
      } else {
        for (const target of selection.selections) {
          await adapters.hvigor.test(selection.kind, [target.module], target.scope, selection.coverage, selection.asan, selection.buildOnly);
        }
      }
    }
  } catch (error) { failure = error; }
  finally { await adapters.close(); }
  const reports = await collectReports(selection, before, context), failed = reports.reduce((sum, report) => sum + report.failed, 0);
  const sourceDrift = await changedInputs(context, inputs.files);
  const complete = !sourceDrift.length && reports.every((report) => report.status === 'fresh' && report.complete && report.passed + report.failed > 0 &&
    report.scopeMatched && !report.missingCases?.length);
  const execution = context.abortSignal.aborted ? 'cancelled' : failure ? 'failed' : unsupported ? 'not-run' : selection.buildOnly || !complete ? 'build-only' : 'executed';
  const report = { schemaVersion: '1.0', kind: selection.kind, execution, modules: selection.modules, scope: selection.scope,
    reports, invocations, tools: tools.evidence, inputs: inputs.files, sourceDrift, selections: selection.selections, diagnostics: buildDiagnostics(invocations),
    coverage: { requested: selection.coverage, status: 'not-collected' }, asan: { requested: selection.asan, status: 'not-run' },
    failure: failure instanceof Error ? failure.message : null, code: unsupported ? 'OFFICIAL_TEST_TASK_UNAVAILABLE' : null,
    facets: { arkts: execution, native: 'not-run', cloudFunctions: 'not-run', cloudContracts: 'not-run' } };
  const evidence = await saveEvidence(context, 'test-report', report);
  return { exitCode: context.abortSignal.aborted ? 130 : failure ? 6 : unsupported || !complete || selection.buildOnly ? 3 : failed ? 1 : 0,
    data: report, artifacts: [evidence, ...reports.flatMap((item) => item.result ?
      [{ path: item.result.absolutePath, sha256: item.result.sha256, kind: 'test-raw-result' }] : [])],
    warnings: complete ? [] : [{ code: 'TEST_RESULT_INCOMPLETE', message: 'A zero build exit code is insufficient without fresh recognized test evidence' }] };
}
