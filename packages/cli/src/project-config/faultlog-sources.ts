/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { dirname, posix } from 'node:path';
import { sourceTokens, type SourceToken } from '../quality/source-tokens.js';
import { readSnapshot } from '../workspace/patch-review.js';
import { publicPath } from '../workspace/path-guard.js';
import type { ExecutionContext } from '../runtime/types.js';

export interface FaultLogFinding { code: string; source: string; path?: string }
export interface FaultLogSource { path: string; sha256: string }
interface Dependency { name: string; members: string[]; uncertain: boolean }
const forbidden = new Set([
  '@ohos.multimedia.avsession', '@ohos.UIAbilityContext', '@ohos.window', '@ohos.multimedia.audio',
  '@ohos.backgroundTaskManager', '@ohos.reminderAgent', '@ohos.reminderAgentManager',
  '@ohos.resourceschedule.backgroundTaskManager', '@ohos.power', '@ohos.wallpaper',
  '@ohos.multimedia.camera', '@ohos.multimedia.cameraPicker', '@ohos.wifiManager',
  '@ohos.wifiManagerExt', '@ohos.wifiext', '@ohos.inputMethod', '@ohos.multimedia.movingphotoview',
  '@ohos.notification', '@ohos.notificationManager', '@ohos.notificationSubscribe', '@ohos.vibrator',
  '@ohos.telephony.call', '@ohos.telephony.sim', '@ohos.telephony.sms', '@ohos.userIAM.faceAuth',
  '@ohos.userIAM.userAuth',
]);
const restrictedMembers: Record<string, string[]> = {
  '@kit.AVSessionKit': ['avSession'], '@kit.AudioKit': ['audio'],
  '@kit.BackgroundTasksKit': ['backgroundTaskManager', 'reminderAgent', 'reminderAgentManager'],
  '@kit.CameraKit': ['camera', 'cameraPicker'], '@kit.IMEKit': ['inputMethod'],
  '@kit.NotificationKit': ['notification', 'notificationManager', 'notificationSubscribe'],
  '@kit.TelephonyKit': ['call', 'sim', 'sms'], '@kit.UserAuthenticationKit': ['faceAuth', 'userAuth'],
  '@kit.ArkUI': ['window'], '@kit.AbilityKit': ['UIAbilityContext'],
  '@kit.BasicServicesKit': ['power', 'wallpaper'], '@kit.ConnectivityKit': ['wifiManager', 'wifiManagerExt', 'wifiext'],
  '@kit.MediaLibraryKit': ['movingphotoview'], '@kit.SensorServiceKit': ['vibrator'],
};
function finding(code: string, path: string): FaultLogFinding { return { code, source: 'ohmate-static', path }; }
function imports(tokens: SourceToken[]) {
  const dependencies: Dependency[] = [];
  let uncertain = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.literal !== undefined) { continue; }
    if (token.text === 'require' || token.text.startsWith('`')) { uncertain = true; }
    if (token.text !== 'import' && token.text !== 'export') { continue; }
    if (tokens[index + 1]?.text === '(') { uncertain = true; continue; }
    if (tokens[index + 1]?.literal !== undefined) {
      dependencies.push({ name: tokens[index + 1].literal!, members: [], uncertain: true }); continue;
    }
    const members: string[] = [];
    const named = tokens[index + 1]?.text === '{';
    let namespace = false;
    for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 128); cursor++) {
      const current = tokens[cursor];
      if (current.text === ';' || (cursor > index + 1 && ['import', 'export'].includes(current.text))) { break; }
      if (current.text === '*') { namespace = true; }
      if (named && /^[A-Za-z_$][\w$]*$/.test(current.text) &&
        (tokens[cursor - 1]?.text === '{' || tokens[cursor - 1]?.text === ',')) { members.push(current.text); }
      if (current.text === 'from' && tokens[cursor + 1]?.literal !== undefined) {
        dependencies.push({ name: tokens[cursor + 1].literal!, members, uncertain: !named || namespace }); break;
      }
    }
  }
  return { dependencies, uncertain };
}
function external(dependency: Dependency, path: string): FaultLogFinding | undefined {
  if (forbidden.has(dependency.name) ||
    dependency.members.some((member) => restrictedMembers[dependency.name]?.includes(member))) {
    return finding('FAULTLOG_FORBIDDEN_MODULE', path);
  }
  const allowed = dependency.name === '@kit.PerformanceAnalysisKit'
    ? ['FaultLogExtensionAbility', 'hiAppEvent', 'hilog']
    : dependency.name === '@kit.BasicServicesKit' ? ['systemDateTime'] : [];
  if (dependency.uncertain || !dependency.members.length || dependency.members.some((member) => !allowed.includes(member))) {
    return finding('FAULTLOG_DEPENDENCY_UNVERIFIED', path);
  }
}
function verifiedEntry(tokens: SourceToken[], name: string): boolean {
  const imported = tokens.some((token, index) => token.text === 'FaultLogExtensionAbility' &&
    tokens[index - 1]?.text === '{' && tokens.slice(index, index + 16).some((item) => item.literal === '@kit.PerformanceAnalysisKit'));
  return imported && tokens.some((token, index) => token.text === 'class' && tokens[index - 1]?.text === 'default' &&
    tokens[index + 1]?.text === name && tokens[index + 2]?.text === 'extends' && tokens[index + 3]?.text === 'FaultLogExtensionAbility');
}
async function localSource(name: string, context: ExecutionContext) {
  for (const candidate of name.endsWith('.ets') || name.endsWith('.ts') ? [name] : [name + '.ets', name + '.ts']) {
    const snapshot = await readSnapshot(context, publicPath(candidate));
    if (snapshot.text !== null) { return snapshot; }
  }
  return null;
}
export async function checkFaultLogSources(path: string, name: string, moduleRoot: string, context: ExecutionContext) {
  const sources: FaultLogSource[] = [], findings: FaultLogFinding[] = [], pending = [{ path, depth: 0 }];
  const visited = new Set<string>(), resolved = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.shift()!;
    if (visited.has(item.path)) { continue; }
    if (sources.length >= 32 || item.depth > 16 || bytes > 512 * 1024) { findings.push(finding('FAULTLOG_DEPENDENCY_UNVERIFIED', item.path)); break; }
    visited.add(item.path);
    try {
      const file = await localSource(item.path, context);
      if (!file) { findings.push(finding(item.depth ? 'FAULTLOG_DEPENDENCY_UNVERIFIED' : 'FAULTLOG_SOURCE_MISSING', item.path)); continue; }
      if (resolved.has(file.path)) { continue; }
      resolved.add(file.path);
      bytes += Buffer.byteLength(file.text!);
      if (bytes > 512 * 1024) { findings.push(finding('FAULTLOG_DEPENDENCY_UNVERIFIED', item.path)); break; }
      sources.push({ path: file.path, sha256: file.oldHash! });
      const tokens = sourceTokens(file.text!), parsed = imports(tokens);
      if (!item.depth && !verifiedEntry(tokens, name)) { findings.push(finding('FAULTLOG_ENTRY_UNVERIFIED', file.path)); }
      if (parsed.uncertain) { findings.push(finding('FAULTLOG_DEPENDENCY_UNVERIFIED', file.path)); }
      for (const dependency of parsed.dependencies) {
        collectDependency(dependency, file.path, moduleRoot, item.depth, pending, findings);
      }
    } catch { findings.push(finding('FAULTLOG_DEPENDENCY_UNVERIFIED', item.path)); }
  }
  for (const source of sources) {
    try {
      if ((await readSnapshot(context, source.path)).oldHash !== source.sha256) { findings.push(finding('FAULTLOG_SOURCE_DRIFT', source.path)); }
    } catch { findings.push(finding('FAULTLOG_SOURCE_DRIFT', source.path)); }
  }
  return { sources, findings };
}
function collectDependency(dependency: Dependency, path: string, moduleRoot: string, depth: number,
  pending: { path: string; depth: number }[], findings: FaultLogFinding[]) {
  if (!dependency.name.startsWith('./') && !dependency.name.startsWith('../')) {
    const issue = external(dependency, path);
    if (issue) { findings.push(issue); }
    return;
  }
  const next = posix.normalize(posix.join(dirname(path), dependency.name));
  if (!next.startsWith(moduleRoot + '/') || /[\\:]/.test(dependency.name)) {
    findings.push(finding('FAULTLOG_DEPENDENCY_UNVERIFIED', path)); return;
  }
  pending.push({ path: next, depth: depth + 1 });
}
