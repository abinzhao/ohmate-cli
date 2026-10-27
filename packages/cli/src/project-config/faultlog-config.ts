/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { posix } from 'node:path';
import JSON5 from 'json5';
import { readSnapshot } from '../workspace/patch-review.js';
import type { ExecutionContext } from '../runtime/types.js';
import { parseSpans } from './json5-spans.js';
import { checkFaultLogSources, type FaultLogFinding, type FaultLogSource } from './faultlog-sources.js';

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const invalid = new Set(['FAULTLOG_EXPORTED', 'FAULTLOG_SOURCE_PATH_INVALID', 'FAULTLOG_SOURCE_MISSING',
  'FAULTLOG_NAME_DUPLICATE', 'FAULTLOG_NAME_INVALID', 'FAULTLOG_API_TOO_LOW', 'FAULTLOG_FORBIDDEN_MODULE', 'FAULTLOG_SOURCE_DRIFT']);
function finding(code: string, path: string): FaultLogFinding { return { code, source: 'ohmate-static', path }; }
function entryIssues(entry: Record<string, unknown>, all: unknown[], path: string): FaultLogFinding[] {
  const findings: FaultLogFinding[] = [];
  if (typeof entry.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,126}$/.test(entry.name)) {
    findings.push(finding('FAULTLOG_NAME_INVALID', path));
  }
  if (all.filter((item) => obj(item).name === entry.name).length !== 1) { findings.push(finding('FAULTLOG_NAME_DUPLICATE', path)); }
  if (entry.exported !== undefined && entry.exported !== false) { findings.push(finding('FAULTLOG_EXPORTED', path)); }
  if (typeof entry.srcEntry !== 'string' || !/^\.\/ets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ets$/.test(entry.srcEntry)) {
    findings.push(finding('FAULTLOG_SOURCE_PATH_INVALID', path));
  }
  return findings;
}
function apiVersion(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) { return value; }
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:\(\d+\))?$/.test(value)) { return undefined; }
  return Number(value.match(/\((\d+)\)$/)?.[1] ?? value.split('.')[0]);
}
async function apiIssues(context: ExecutionContext, path: string) {
  try {
    const snapshot = await readSnapshot(context, 'build-profile.json5');
    if (snapshot.text === null) { return [finding('FAULTLOG_API_UNVERIFIED', path)]; }
    parseSpans(snapshot.text);
    const profile = obj(JSON5.parse(snapshot.text)), products = obj(profile.app).products;
    if (!Array.isArray(products) || !products.length) { return [finding('FAULTLOG_API_UNVERIFIED', path)]; }
    const versions = products.map((item) => apiVersion(obj(item).compatibleSdkVersion));
    if (versions.some((version) => version !== undefined && version < 21)) { return [finding('FAULTLOG_API_TOO_LOW', path)]; }
    return versions.some((version) => version === undefined) ? [finding('FAULTLOG_API_UNVERIFIED', path)] : [];
  } catch { return [finding('FAULTLOG_API_UNVERIFIED', path)]; }
}
export async function validateFaultLogConfig(value: unknown, path: string, context: ExecutionContext) {
  const module = obj(obj(value).module), entries = module.extensionAbilities;
  if (!Array.isArray(entries) || !entries.some((entry) => obj(entry).type === 'faultLog')) {
    return { status: 'not-configured' as const, staticValid: null, sources: [], findings: [] };
  }
  const sources: FaultLogSource[] = [], findings = await apiIssues(context, path);
  const moduleRoot = path.endsWith('/src/main/module.json5') ? path.slice(0, -'/src/main/module.json5'.length) : '';
  if (!moduleRoot || !['entry', 'feature'].includes(String(module.type))) { findings.push(finding('FAULTLOG_HOST_UNVERIFIED', path)); }
  for (const raw of entries.filter((entry) => obj(entry).type === 'faultLog')) {
    const entry = obj(raw), issues = entryIssues(entry, entries, path);
    findings.push(...issues);
    if (issues.length || !moduleRoot) { continue; }
    const entryPath = posix.join(moduleRoot, 'src/main', String(entry.srcEntry).slice(2));
    const result = await checkFaultLogSources(entryPath, String(entry.name), moduleRoot, context);
    findings.push(...result.findings); sources.push(...result.sources);
  }
  return { status: findings.some((item) => invalid.has(item.code)) ? 'invalid' as const : 'incomplete' as const,
    staticValid: !findings.length, sources, findings, integration: 'extension',
    minimumApi: 21, stageModel: 'required', syscap: 'SystemCapability.HiviewDFX.Hiview.FaultLogger',
    hostRegistration: 'not-verified', delayedExecution: 'not-run', buildIdentity: 'unverified',
    missing: ['same-name-empty-host-watcher', 'distinct-normal-watcher', 'host-registration-before-fault',
      'ten-second-lifecycle-budget', 'device-api-syscap', 'delayed-system-launch', 'release-build-integration'],
    restrictedModulesSource: '@ohos.hiviewdfx.FaultLogExtensionAbility API26 Appendix',
  };
}
