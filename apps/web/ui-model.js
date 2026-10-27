/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const DEFAULT_ALLOWED_TOOLS = ['doctor', 'project.inspect', 'workspace.read'];

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function normalizeScopePath(path) {
  return String(path ?? '').trim();
}

export function splitScopePaths(text) {
  return [...new Set(String(text ?? '').split('\n').map(normalizeScopePath).filter(Boolean))];
}

export function appendScopePath(text, path) {
  const value = normalizeScopePath(path), paths = splitScopePaths(text);
  if (value && !paths.includes(value)) { paths.push(value); }
  return paths.join('\n');
}

export function removeScopePath(text, path) {
  const value = normalizeScopePath(path);
  return splitScopePaths(text).filter((item) => item !== value).join('\n');
}

export function bindProject(state, root, name) {
  const changed = state.projectRoot !== root;
  state.projectRoot = root;
  state.projectName = name ?? null;
  if (changed) {
    state.files = [];
    state.writePaths = [];
    state.allowedTools = [...DEFAULT_ALLOWED_TOOLS];
    state.sessionId = undefined;
    state.command = null;
  }
  return changed;
}

const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseRoute(hash) {
  const value = String(hash ?? '').replace(/^#/, '');
  if (!value || value === 'home') { return { page: 'home' }; }
  if (['apps', 'library', 'debug'].includes(value)) { return { page: value }; }
  const match = /^task\/([^/]+)$/.exec(value);
  if (match && routeId.test(match[1])) { return { page: 'task', id: match[1] }; }
  return { page: 'home' };
}

const TOOL_SYNONYMS = {
  构建: ['build', 'assemble', 'compile', 'hvigor'],
  检查: ['scan', 'inspect', 'check', 'doctor', 'verify', 'lint'],
  检测: ['scan', 'inspect', 'check', 'doctor', 'verify', 'lint'],
  设备: ['device', 'hdc', 'emulator'],
  真机: ['device', 'hdc', 'emulator'],
  调试: ['debug', 'faultlog', 'crash', 'inspector'],
  测试: ['test', 'unittest', 'instrument', 'local'],
  报告: ['report', 'sbom', 'evidence', 'provenance', 'artifact'],
  证据: ['evidence', 'provenance', 'artifact', 'sbom'],
  签名: ['sign', 'signing', 'certificate', 'profile'],
  性能: ['performance', 'benchmark', 'trace', 'profile'],
  日志: ['log', 'crash', 'faultlog', 'hilog'],
  依赖: ['deps', 'dependency', 'ohpm', 'sbom'],
  模拟器: ['emulator'],
  文档: ['docs', 'documentation', 'knowledge'],
  安装: ['install', 'deploy'],
  运行: ['run', 'start', 'launch'],
  发布: ['release', 'publish', 'store', 'gallery'],
  上架: ['release', 'publish', 'store', 'gallery', 'poster'],
  截图: ['screenshot', 'capture'],
  录屏: ['screenrecord', 'record'],
  网络: ['network', 'http', 'socket'],
  内存: ['memory', 'heap', 'leak'],
  崩溃: ['crash', 'faultlog'],
  工程: ['project', 'module', 'workspace'],
  模板: ['template', 'create', 'scaffold'],
};
export function toolMatches(spec, query, extra = '') {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) { return true; }
  const terms = [text];
  for (const [word, values] of Object.entries(TOOL_SYNONYMS)) {
    if (text.includes(word)) { terms.push(...values); }
  }
  const haystack = [spec?.id, ...(spec?.command ?? []), spec?.description, spec?.title, extra]
    .filter(Boolean).join(' ').toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export function mergeApplications(currentRoot, currentName, saved) {
  const entries = saved.map((item) => ({ ...item, current: item.root === currentRoot, saved: true }));
  const current = entries.find((item) => item.current);
  if (current) {
    if (currentName) { current.name = currentName; }
  } else if (currentRoot) {
    entries.unshift({ root: currentRoot, name: currentName ?? basename(currentRoot), workspaceId: null, current: true, saved: false });
  }
  return entries.sort((left, right) => Number(right.current) - Number(left.current));
}

export function extensionState(extension) {
  if (extension.status === 'unverified') { return { label: '未验证', tone: 'warning', actionable: false }; }
  return extension.enabled ?
    { label: '已启用', tone: 'success', actionable: true } :
    { label: '已停用', tone: 'neutral', actionable: true };
}
