/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const web = (name: string) => readFile(new URL(`../../../../apps/web/${name}`, import.meta.url), 'utf8');

it('keeps only the three product destinations and exposes debug as contextual work', async () => {
  const html = await web('index.html');
  expect([...html.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]))
    .toEqual(['home', 'apps', 'library']);
  expect(html).toContain('id="debug-button"');
  expect(html).toContain('aria-label="打开调试工作区"');
});

it('provides a modal mobile navigation contract instead of leaving the work surface focusable', async () => {
  const [html, app, view] = await Promise.all([web('index.html'), web('app.js'), web('view.js')]);
  expect(html).toContain('id="sidebar-backdrop"');
  expect(html).toContain('id="sidebar-backdrop" class="sidebar-backdrop" type="button" aria-label="关闭导航" tabindex="-1"');
  expect(html).toContain('id="sidebar-close"');
  expect(app).toContain('setDrawerState');
  expect(app).toContain('trapFocus');
  expect(app).toContain("setTimeout(() => $('sidebar-close').focus({ preventScroll: true }), 0)");
  expect(view).toContain('main.inert = open');
  expect(view).toContain('skip.inert = open');
  expect(view).toContain("main.setAttribute('aria-hidden', 'true')");
  expect(view).toContain('backdrop.hidden = !open');
});

it('defines a shared icon surface and mobile-size interaction targets', async () => {
  const [html, view, styles] = await Promise.all([web('index.html'), web('view.js'), web('styles.css')]);
  expect(html).toContain('id="device-button" class="device-status" aria-label="查看设备状态"');
  expect(html).toContain('id="context-button" class="control-btn" aria-label="管理上下文"');
  expect(html).toContain('<span class="topbar-label">调试工作区</span>');
  expect(html).toContain('<span class="topbar-label">设备 · 未检测</span>');
  expect(styles).not.toMatch(/\.topbar-action span\s*\{/);
  expect(styles).not.toMatch(/\.device-status span,\s*\.topbar-action span\s*\{/);
  expect(view).toContain('export function icon(');
  expect(view).toContain("createElementNS('http://www.w3.org/2000/svg'");
  expect(view).toContain('viewBox');
  expect(styles).toMatch(/@media\s*\(max-width:\s*767px\)/);
  expect(styles).toContain('.sidebar .sidebar-close');
  expect(styles).toContain('transition: transform 180ms ease, visibility 0s linear 180ms');
  expect(styles).toContain('transition-delay: 0s, 0s');
  expect(styles).toContain('min-height: 44px');
  expect(styles).toContain('min-width: 44px');
  expect(styles).toMatch(/\.control-btn,\s*\.model-picker\s*\{[^}]*min-width:\s*44px/s);
});

it('uses contextual file, tool and model surfaces instead of raw-path-only dialogs', async () => {
  const [app, panels, view] = await Promise.all([web('app.js'), web('panels.js'), web('view.js')]);
  expect(panels).toContain("request('workspace/tree'");
  expect(panels).toContain("class: 'file-tree'");
  expect(panels).toContain("entry.type === 'directory' ? icon('chevron-right') : icon('plus')");
  expect(panels).toContain('function riskLabel');
  expect(panels).toContain('function toolDescription');
  expect(panels).toContain('function toolRank');
  expect(panels).toContain('function schemaFields');
  expect(app).toContain('modelMenu');
  expect(app).toContain('updateScopes');
  expect(view).toContain('export function popover(');
});

it('renders business stages, applied changes, plans and logs before raw technical data', async () => {
  const tasks = await web('tasks.js');
  expect(tasks).toContain("const resultTabs = ['摘要', '发现', '变更', '计划', '证据', '原始数据']");
  expect(tasks).toContain("class: 'task-progress'");
  expect(tasks).toContain('taskProgress(task)');
  expect(tasks).toContain('appliedChanges');
  expect(tasks).toContain('planChanges');
  expect(tasks).toContain("class: 'result-tablist'");
  expect(tasks).toContain('tab.dataset.resultTab = name');
  expect(tasks).toContain("tab.setAttribute('role', 'tab')");
  expect(tasks).toContain('ArrowRight');
  expect(tasks).toContain('resultProjection(task)');
  expect(tasks).toContain('技术执行事件');
  expect(tasks).toContain("id: 'task-log'");
  expect(tasks).toContain('tool.stdout');
  expect(tasks).toContain('tool.stderr');
  expect(tasks).toContain('taskSignature');
  expect(tasks).toContain("document.querySelector('#canvas .task-heading')");
  expect(tasks).toContain('pendingTasks');
  expect(tasks).toContain('审批并继续');
  expect(tasks).toContain('强制停止');
});

it('makes the result inspector modal on narrow screens and keeps errors persistent', async () => {
  const [html, app, tasks, view, styles] = await Promise.all([
    web('index.html'), web('app.js'), web('tasks.js'), web('view.js'), web('styles.css'),
  ]);
  expect(html).toContain('id="result-backdrop"');
  expect(html).toContain('id="history-search"');
  expect(html).toContain('id="history-filter"');
  expect(html).toContain('content="light dark"');
  expect(tasks).toContain("setAttribute('aria-modal', 'true')");
  expect(tasks).toContain('conversation.inert = true');
  expect(tasks).toContain('syncResultPanel');
  expect(app).toContain('closeResult');
  expect(app).toContain("event.key === 'Escape'");
  expect(app).toContain('parseRoute');
  expect(app).toContain('continueAgent');
  expect(app).toContain('filterTasks');
  expect(app).toContain('syncTaskStatus');
  expect(view).toContain("class: 'toast error'");
  expect(view).toMatch(/if \(tone === 'error'\) \{[\s\S]*?return;[\s\S]*?\n {2}\}/);
  expect(styles).toContain('@media (prefers-color-scheme: dark)');
  expect(styles).toContain('.result-backdrop');
  expect(styles).toContain('.task-log');
});

it('binds file scope to the selected project and keeps advanced text authoritative', async () => {
  const [app, panels, model] = await Promise.all([web('app.js'), web('panels.js'), web('ui-model.js')]);
  expect(model).toContain('export function bindProject');
  expect(model).toContain('export function splitScopePaths');
  expect(model).toContain('export function removeScopePath');
  expect(model).toContain('export function appendScopePath');
  expect(panels).toContain('splitScopePaths(paths.input.value)');
  expect(panels).toContain('splitScopePaths(writePaths.input.value)');
  expect(panels).toContain('removeScopePath(');
  expect(panels).toContain('appendScopePath(');
  expect(panels).not.toContain('selected.read.add(path)');
  expect(app).toContain('bindProject(');
  expect(app).toContain('applyProject(');
});

it('uses semantic settings and contextual debug sections instead of raw object dumps', async () => {
  const [app, panels, debug] = await Promise.all([web('app.js'), web('panels.js'), web('debug.js')]);
  expect(app).toContain('mergeApplications');
  expect(panels).toContain('mergeApplications(state.projectRoot');
  expect(panels).toContain("class: 'settings-layout'");
  expect(panels).toContain("role: 'tablist'");
  expect(panels).toContain('item.dataset.setting = name');
  expect(panels).toContain("item.setAttribute('role', 'tab')");
  expect(panels).toContain('ArrowRight');
  expect(debug).toContain('ArrowRight');
  expect(debug).toContain("setAttribute('role', 'tabpanel')");
  expect(panels).toContain("id: 'settings-content'");
  expect(panels).toContain("class: 'rule-row'");
  expect(debug).toContain("class: 'debug-section-nav'");
  expect(debug).toContain("['概览', '事件', '检查器', '离线问题包']");
  expect(debug).toContain("setAttribute('data-debug-section'");
  expect(debug).toContain("setAttribute('data-debug-tab'");
  expect(debug).toContain('调试工作区');
});
