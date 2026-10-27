/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import JSON5 from 'json5';
import { dirname, resolve } from 'node:path';
import { sourceTokens, type SourceToken } from '../quality/source-tokens.js';
import type { Finding, Gate, ReleaseSelection, SourceEvidence } from './types.js';
import { runtimeProfileManifestSchema } from '../integrate/runtime-profile.js';

export function addFinding(gate: Gate, source: { path: string; sha256: string }, code: string, message: string,
  detail: { line?: number; entry?: string } = {}, confidence: Finding['confidence'] = 'observed') {
  gate.findings.push({ code, message, confidence, evidence: [{ path: source.path, sha256: source.sha256, ...detail }] });
}
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const debugName = /(?:^|[/@_.-])(?:debug|mock|test|fixture|replay)(?:$|[/_.-])/i;
const sensitiveLog = /\b(?:token|password|secret|authorization|privateKey|accessKey)\b/i;
const writeDebug = /^(?:setWebDebuggingAccess|startMock|startCapture|startReplay|highlightNode|executeJavaScript|setDebugPort|openDebugCenter)$/;
function sourceCalls(source: SourceEvidence, gates: Map<string, Gate>) {
  let tokens: SourceToken[];
  try { tokens = sourceTokens(source.text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) { throw error; }
    for (const id of ['release.web-debug', 'release.kit-core', 'release.probes', 'release.debug-writes', 'release.sensitive-logs']) {
      gates.get(id)!.missing.push(`${source.path}:source-lexical-coverage`);
    }
    return;
  }
  let line = 1, previous = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    line += source.text.slice(previous, token.offset).split('\n').length - 1; previous = token.offset;
    if (token.literal !== undefined && (tokens[index - 1]?.text === 'from' || tokens[index - 1]?.text === 'import')) {
      checkImport(source, token.literal, line, gates);
    }
    if ((writeDebug.test(token.text) || /^(?:debug|info|warn|error|fatal|log)$/.test(token.text)) &&
      token.literal === undefined && tokens[index + 1]?.text === '(') {
      checkCall(source, tokens, index, line, gates);
    }
  }
}
function checkImport(source: SourceEvidence, name: string, line: number, gates: Map<string, Gate>) {
  if (/ohmatekit\/(?:debug|bridge|mock|replay)|@ohmate\/(?:debug|desktop|test)-/.test(name) ||
    /^@ohmate\/ohmatekit\/src\/main\/ets\/(?:api\/(?:runtime|debug|test|window)(?:$|\/)|debug\/|testbridge\/|host-integration\/|providers\/)/.test(name)) {
    addFinding(gates.get('release.kit-core')!, source, 'KIT_DEBUG_IMPORT', 'Production source imports an explicit Kit debug entry', { line });
  }
  if (/(?:^|\/)(?:AbcKitTS|debug-aspect)(?:$|\/)/i.test(name)) {
    addFinding(gates.get('release.probes')!, source, 'DEBUG_PROBE_IMPORT', 'Source imports a debug instrumentation entry', { line });
  }
}
function callArguments(tokens: SourceToken[], index: number) {
  let depth = 1, end = index + 2;
  for (; end < tokens.length; end++) {
    if (tokens[end].text === '(') { depth++; }
    if (tokens[end].text === ')' && --depth === 0) { break; }
  }
  return tokens.slice(index + 2, end);
}
function checkCall(source: SourceEvidence, tokens: SourceToken[], index: number, line: number, gates: Map<string, Gate>) {
  const name = tokens[index].text, args = callArguments(tokens, index);
  if (name === 'setWebDebuggingAccess' && !(args.length === 1 && args[0].text === 'false')) {
    addFinding(gates.get('release.web-debug')!, source, 'WEB_DEBUG_ACCESS', 'ArkWeb debug access is enabled or not statically false', { line },
      args.length === 1 && args[0].text === 'true' ? 'observed' : 'inferred');
  }
  if (writeDebug.test(name) && name !== 'setWebDebuggingAccess') {
    addFinding(gates.get('release.debug-writes')!, source, 'DEBUG_WRITE_CANDIDATE', 'Source contains a debug or Web script execution candidate requiring purity verification', { line }, 'inferred');
  }
  if (/^(?:debug|info|warn|error|fatal|log)$/.test(name) && tokens[index - 1]?.text === '.' &&
    /^(?:console|hilog)$/.test(tokens[index - 2]?.text ?? '') && args.some((arg) => sensitiveLog.test(arg.text))) {
    addFinding(gates.get('release.sensitive-logs')!, source, 'SENSITIVE_LOG_CANDIDATE', 'Log arguments reference a sensitive field', { line }, 'inferred');
  }
}
function moduleMetadata(source: SourceEvidence, gates: Map<string, Gate>) {
  const module = obj(obj(JSON5.parse(source.text)).module);
  for (const item of [...Array.isArray(module.abilities) ? module.abilities : [], ...Array.isArray(module.extensionAbilities) ? module.extensionAbilities : []]) {
    if (debugName.test(String(obj(item).name))) { addFinding(gates.get('release.entries')!, source, 'DEBUG_ABILITY', 'Module declares a debug/test Ability candidate', {}, 'inferred'); }
  }
  for (const permission of Array.isArray(module.requestPermissions) ? module.requestPermissions : []) {
    if (/SYSTEM_FLOAT_WINDOW|MANAGE_FLOAT_WINDOW/.test(String(obj(permission).name))) {
      addFinding(gates.get('release.probes')!, source, 'SYSTEM_OVERLAY_PERMISSION', 'Module requests a system overlay permission');
    }
  }
}
function obfuscationConfig(source: SourceEvidence, selection: ReleaseSelection, gate: Gate) {
  const profile = obj(JSON5.parse(source.text)), base = obj(profile.buildOption);
  const release = (Array.isArray(profile.buildOptionSet) ? profile.buildOptionSet : []).find((p) => obj(p).name === 'release');
  const ark = { ...obj(base.arkOptions), ...obj(obj(release).arkOptions) }, rule = obj(obj(ark.obfuscation).ruleOptions);
  if (rule.enable !== true) { gate.missing.push(`${source.path}:effective-obfuscation-policy`); return; }
  const paths = Array.isArray(rule.files) ? rule.files : [];
  if (!paths.length) { gate.missing.push(`${source.path}:effective-rule-files`); }
  for (const path of paths) {
    if (typeof path !== 'string' || !selection.sources.some((s) => resolve(selection.model.root, s.path) === resolve(selection.model.root, dirname(source.path), path))) {
      addFinding(gate, source, 'ARKGUARD_RULE_UNAVAILABLE', 'An enabled rule file is absent from the selected source evidence');
    }
  }
}
function profileManifest(source: SourceEvidence, gate: Gate) {
  let value: unknown;
  try { value = JSON5.parse(source.text); } catch { value = null; }
  const parsed = runtimeProfileManifestSchema.safeParse(value);
  if (!parsed.success) {
    addFinding(gate, source, 'PROFILE_MANIFEST_INVALID', 'Generated Profile manifest has invalid fields');
    return;
  }
  if (!parsed.data.profile.startsWith('release-') || parsed.data.buildMode !== 'release') {
    addFinding(gate, source, 'DEBUG_PROFILE_MANIFEST', 'Selected source includes a Debug/Test Profile manifest');
  }
  if (parsed.data.probes.length) {
    addFinding(gate, source, 'RELEASE_DEBUG_PROBE_MANIFEST', 'Selected Profile manifest declares Debug probes');
  }
  gate.missing.push(`${source.path}:compiler-bound-profile-manifest`);
}
export function inspectSources(selection: ReleaseSelection, gates: Map<string, Gate>) {
  for (const source of selection.sources) {
    if (/\.(?:ets|ts|js|mjs|cjs)$/.test(source.path)) { sourceCalls(source, gates); }
    if (/(?:^|\/)ohmate-profile-manifest\.json$/.test(source.path)) { profileManifest(source, gates.get('release.probes')!); }
    if (source.path.endsWith('/src/main/module.json5')) { moduleMetadata(source, gates); }
    if (source.path.endsWith('/build-profile.json5')) { obfuscationConfig(source, selection, gates.get('release.arkguard')!); }
    if (source.path.endsWith('/consumer-rules.txt') && /^-enable-/m.test(source.text.replace(/#.*$/gm, ''))) {
      const module = selection.model.modules.find((m) => resolve(selection.model.root, dirname(source.path)) === m.path);
      if (module?.type === 'har' || module?.type === 'shared') {
        addFinding(gates.get('release.arkguard')!, source, 'CONSUMER_OBFUSCATION_ENABLE', 'HAR/HSP consumer rules enable obfuscation instead of only preserving public names');
      }
    }
    if (/resources\/rawfile\/.*(?:^|[/_.-])(?:mock|test|fixture)(?:[/_.-]|$)/i.test(source.path)) {
      addFinding(gates.get('release.entries')!, source, 'TEST_RAWFILE_CANDIDATE', 'Selected source contains a test-data rawfile candidate', {}, 'inferred');
    }
  }
}
