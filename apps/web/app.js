/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { initialize, execute, request } from './api.js';
import { $, node, button, empty, guarded, toast, icon, hydrateIcons, setDrawerState, trapFocus } from './view.js';
import { projects, registerProject, models, modelMenu, files, tools, contextPreview, settings } from './panels.js';
import { taskView, subscribe, stopStream, showResult, taskTitle, filterTasks, closeResult, syncResultPanel } from './tasks.js';
import { debugView, stopDebugView } from './debug.js';
import { DEFAULT_ALLOWED_TOOLS, bindProject, mergeApplications, parseRoute } from './ui-model.js';

const state = { projectRoot: null, projectName: null, modelId: null, files: [], writePaths: [],
  allowedTools: [...DEFAULT_ALLOWED_TOOLS], tasks: [], selected: null, command: null };
const intents = [
  ['开发应用', 'plus', '开发一个鸿蒙应用，先明确功能与验证范围。'],
  ['修复问题', 'activity', '分析并修复应用问题，先定位原因，再给最小修改方案。'],
  ['界面设计', 'layout-grid', '设计鸿蒙应用页面，先确认页面关系、视觉与交互。'],
  ['上架海报', 'file-text', '制作应用上架海报，先核对真实截图、卖点与导出尺寸。'],
  ['应用检测', 'check', '检查应用的工程、兼容与质量问题，保留诊断依据。'],
  ['性能优化', 'activity', '分析应用性能问题，先核对采样来源、构建与设备条件。'],
];
const drawerMedia = matchMedia('(max-width: 767px)');
let drawerReturnFocus = null;
const drawerElements = () => ({
  body: document.body, sidebar: $('sidebar'), main: document.querySelector('.main-shell'),
  backdrop: $('sidebar-backdrop'), trigger: $('sidebar-toggle'), skip: document.querySelector('.skip-link'),
});
function closeSidebar(restore = false) {
  const wasOpen = document.body.classList.contains('sidebar-open');
  setDrawerState(drawerElements(), false, drawerMedia.matches);
  if (restore && wasOpen && drawerReturnFocus instanceof HTMLElement && drawerReturnFocus.isConnected) {
    drawerReturnFocus.focus();
  }
  drawerReturnFocus = null;
}
function openSidebar() {
  drawerReturnFocus = document.activeElement;
  setDrawerState(drawerElements(), true, drawerMedia.matches);
  setTimeout(() => $('sidebar-close').focus({ preventScroll: true }), 0);
}
function setIconLabel(element, name, label) {
  element.replaceChildren(icon(name), node('span', {}, [label]));
}
async function refresh() {
  state.tasks = (await request('tasks')).data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const query = $('history-search')?.value ?? '', status = $('history-filter')?.value ?? 'all';
  const matches = filterTasks(state.tasks, query, status);
  $('history-list').replaceChildren(...matches.slice(0, 50).map((task) =>
    button(node('span', { class: 'history-copy' }, [
      node('strong', {}, [taskTitle(task)]),
      node('small', {}, [({
        queued: '等待执行', planning: '检查条件', 'awaiting-approval': '等待确认', running: '执行中',
        verifying: '验证中', succeeded: '已完成', failed: '失败', cancelled: '已停止', blocked: '需补充条件',
      })[task.state] ?? task.state]),
    ]), () => openTask(task), `history-item ${task.id === state.selected?.id ? 'active' : ''}`)));
  if (!matches.length) {
    $('history-list').append(node('p', { class: 'muted' }, [query || status !== 'all' ? '没有匹配的任务。' : '暂无任务，从一个目标开始。']));
  }
}
function updateSelectors() {
  $('app-picker').textContent = state.projectName ?? (state.projectRoot ? state.projectRoot.split(/[\\/]/).at(-1) : '未选择应用');
  setIconLabel($('model-picker'), 'cpu', state.modelId ?? '无模型 · 本地工具');
}
function applyProject(root, name) {
  const hadCommand = Boolean(state.command);
  const hadScope = state.files.length > 0 || (state.writePaths?.length ?? 0) > 0 || Boolean(state.sessionId) ||
    state.allowedTools.join('\n') !== DEFAULT_ALLOWED_TOOLS.join('\n');
  const reset = bindProject(state, root, name);
  updateSelectors();
  if (reset) {
    if (hadCommand) {
      $('prompt').value = '';
      $('composer-caption').textContent = '本地工具无需模型；模型发送前可预览上下文。';
    }
    updateScopes();
    if (hadScope) { toast('已切换工程，已清空文件、修改范围、工具与会话。'); }
  }
  return reset;
}
function updateScopes() {
  const scope = $('composer-scopes'), items = [
    ...(state.files.length ? [[`${state.files.length} 个只读文件`, 'file-text']] : []),
    ...(state.writePaths.length ? [[`${state.writePaths.length} 个可修改路径`, 'alert-triangle']] : []),
    ...(state.allowedTools.length ? [[`${state.allowedTools.length} 个工具`, 'terminal']] : []),
    ...(state.sessionId ? [['已关联会话', 'activity']] : []),
  ];
  scope.hidden = !items.length;
  scope.replaceChildren(...items.map(([label, iconName]) =>
    node('span', { class: 'composer-scope-chip' }, [icon(iconName, 14), label])));
}
function home() {
  stopStream(); state.selected = null; state.command = null; state.sessionId = undefined;
  $('prompt').value = '';
  $('composer-caption').textContent = '本地工具无需模型；模型发送前可预览上下文。';
  $('page-title').textContent = '新任务'; $('page-context').textContent = '当前工作';
  $('composer-dock').hidden = false; closeResult(false);
  $('canvas').replaceChildren(node('div', { class: 'welcome' }, [
    node('div', { class: 'welcome-mark', 'aria-hidden': 'true' }, [icon('activity', 28)]),
    node('h1', {}, ['今天想完成什么鸿蒙工作？']),
    node('p', { class: 'welcome-subtitle' }, ['从一个目标开始，让每次修改都有依据。']),
    node('div', { class: 'quick-intents' }, intents.map(([title, iconName, prompt]) =>
      button(node('span', {}, [icon(iconName), node('span', {}, [title])]), () => {
        state.command = null; $('prompt').value = prompt; $('prompt').focus();
      }, 'intent-btn'))),
    node('div', { class: 'runtime-home-tools' }, [
      button('检查本地环境', () => submit('doctor', {})),
      button('查看可用工具', () => tools(state, state.catalog)),
    ]),
  ]));
}
async function collection(page) {
  stopStream(); $('composer-dock').hidden = true; closeResult(false); state.selected = null;
  $('page-title').textContent = page === 'apps' ? '我的应用' : '成果与报告';
  $('page-context').textContent = page === 'apps' ? '工程与最近工作' : '成果、报告与验证';
  const header = node('div', { class: 'collection-header' }, [
    node('div', {}, [node('h1', {}, [page === 'apps' ? '我的应用' : '成果与报告']),
      node('p', { class: 'collection-intro' }, [page === 'apps' ? '连接一个本机工程，继续开发与检查。' : '真实任务回执与已生成产物，保留来源和验证范围。'])]),
  ]);
  const content = node('div', { class: 'collection' }, [header]);
  if (page === 'apps') {
    const applications = mergeApplications(state.projectRoot, state.projectName, (await execute('project.list')).data);
    header.append(button('添加应用', () => registerProject(state, async (root, name) => {
      applyProject(root, name); await collection(page);
    })));
    applications.forEach((app) => content.append(button(node('div', { class: 'application-row-copy' }, [
      node('div', { class: 'application-row-title' }, [
        node('h3', {}, [app.name]),
        ...(app.current ? [node('span', { class: 'status-badge success' }, ['当前应用'])] : []),
        ...(!app.saved ? [node('span', { class: 'status-badge neutral' }, ['本次工作台'])] : []),
      ]),
      node('p', { class: 'muted' }, [app.root]),
    ]), () => { applyProject(app.root, app.name); location.hash = 'home'; }, 'artifact-row')));
    if (!applications.length) { content.append(empty('还没有连接应用', '添加真实工程目录后，可查看该应用的任务与成果。')); }
  } else {
    const search = node('input', { type: 'search', id: 'library-search', class: 'collection-search',
      placeholder: '搜索成果、任务或工程', 'aria-label': '搜索成果' });
    const filter = node('select', { id: 'library-filter', class: 'collection-filter', 'aria-label': '按状态筛选' },
      [['all', '全部状态'], ['succeeded', '已完成'], ['failed', '失败'], ['cancelled', '已停止'],
        ['blocked', '需补充条件'], ['running', '执行中']].map(([value, label]) => node('option', { value }, [label])));
    const list = node('div', { class: 'artifact-list' });
    const render = () => {
      const receipts = filterTasks(state.tasks.filter((task) => task.receipt), search.value, filter.value);
      list.replaceChildren(...receipts.map((task) => button(node('div', {}, [
        node('h3', {}, [taskTitle(task)]),
        node('p', { class: 'muted' }, [`${task.receipt.status} · ${new Date(task.updatedAt).toLocaleString('zh-CN')}`]),
      ]), async () => { await openTask(task); showResult(task); }, 'artifact-row')));
      if (!receipts.length) {
        list.append(empty('暂无执行成果', search.value || filter.value !== 'all' ? '没有匹配的成果，调整搜索条件后重试。' :
          '完成环境检查或其它任务后，记录会保存在这里。', button('检查本地环境', () => submit('doctor', {}))));
      }
    };
    search.addEventListener('input', render); filter.addEventListener('change', render);
    header.append(node('div', { class: 'collection-tools' }, [search, filter]));
    content.append(list); render();
  }
  $('canvas').replaceChildren(content);
}
async function openTask(task, push = true) {
  stopDebugView();
  const sameProject = state.projectRoot === task.projectRoot;
  applyProject(task.projectRoot, sameProject ? state.projectName : null);
  state.selected = task;
  $('composer-dock').hidden = false; closeResult(false);
  $('page-context').textContent = '任务执行与证据';
  if (push && location.hash !== `#task/${task.id}`) { location.hash = `task/${task.id}`; }
  updateSelectors(); updateScopes(); syncTaskStatus(task); closeSidebar();
  await refresh();
  taskView(task, changedTask, continueSession, state.tasks, openTask, continueAgent);
  await subscribe(task, changedTask);
}
async function changedTask(task) {
  if (state.selected?.id !== task.id) { return; }
  state.selected = task; syncTaskStatus(task);
  await refresh();
  taskView(task, changedTask, continueSession, state.tasks, openTask, continueAgent);
}
function continueSession(task) {
  state.sessionId = task.sessionId; state.command = null;
  $('prompt').value = ''; $('prompt').focus(); updateScopes();
  toast('已关联原会话。发送前会重新预览历史、文件与工具回执。');
}
function continueAgent(task) {
  const source = task.input && typeof task.input === 'object' ? task.input : {};
  const input = { prompt: source.prompt ?? '', files: source.files ?? [], writePaths: source.writePaths ?? [],
    allowedTools: source.allowedTools ?? [], sessionId: task.sessionId,
    ...(source.modelId ? { modelId: source.modelId } : {}),
    ...(source.maxTurns ? { maxTurns: source.maxTurns } : {}),
    ...(source.maxToolCalls ? { maxToolCalls: source.maxToolCalls } : {}) };
  state.sessionId = task.sessionId; updateScopes();
  contextPreview(state, async (payload) => submit('agent.run', payload), input);
}
function syncTaskStatus(task) {
  if (task.toolId !== 'deveco.device.list') { return; }
  const label = !task.receipt ? '设备 · 检查中' : task.receipt.exitCode === 0 ? '设备 · 已检查' : '设备 · 检查失败';
  setIconLabel($('device-button'), 'smartphone', label);
}
async function submit(toolId, input) {
  const result = await request('tasks', { toolId, input, projectRoot: state.projectRoot });
  if (result.exitCode !== 0) { throw new Error(result.data?.message ?? result.data?.code); }
  await openTask(result.data);
}
async function send(event) {
  event.preventDefault();
  if ($('send-button').disabled) { return; }
  $('send-button').disabled = true;
  try {
    if (state.command) { const command = state.command; state.command = null; await submit(command.toolId, command.input); return; }
    if (!$('prompt').value.trim()) { toast('先描述目标，或选择本地命令。'); return; }
    if (!state.modelId) { await models(state, updateSelectors); toast('自然语言任务需要模型 API。本地工具无需配置模型。'); return; }
    await contextPreview(state, async (input) => submit('agent.run', input));
  } finally { $('send-button').disabled = false; }
}
function bind() {
  hydrateIcons();
  $('composer-form').addEventListener('submit', guarded(send));
  $('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('composer-form').requestSubmit(); }
  });
  $('app-picker').onclick = guarded(() => projects(state, applyProject));
  $('models-button').onclick = guarded(() => models(state, updateSelectors));
  $('model-picker').onclick = guarded(() => modelMenu(state, updateSelectors));
  $('settings-button').onclick = guarded(() => settings(state, updateSelectors));
  $('files-button').onclick = guarded(() => files(state, updateScopes));
  $('tools-button').onclick = guarded(() => tools(state, state.catalog));
  $('context-button').onclick = guarded(() => contextPreview(state));
  $('device-button').onclick = guarded(() => submit('deveco.device.list', { argv: [] }));
  $('debug-button').onclick = () => { location.hash = 'debug'; };
  $('result-close').onclick = () => closeResult();
  $('result-backdrop').onclick = () => closeResult();
  $('result-panel').addEventListener('keydown', (event) => {
    if (!$('result-panel').hidden && matchMedia('(max-width: 1199px)').matches) { trapFocus(event, $('result-panel')); }
  });
  matchMedia('(max-width: 1199px)').addEventListener('change', () => syncResultPanel());
  $('history-search').addEventListener('input', () => { void refresh(); });
  $('history-filter').addEventListener('change', () => { void refresh(); });
  $('sidebar-toggle').onclick = () => {
    if (document.body.classList.contains('sidebar-open')) { closeSidebar(true); } else { openSidebar(); }
  };
  $('sidebar-close').onclick = () => closeSidebar(true);
  $('sidebar-backdrop').onclick = () => closeSidebar(true);
  $('sidebar').addEventListener('keydown', (event) => {
    if (document.body.classList.contains('sidebar-open')) { trapFocus(event, $('sidebar')); }
  });
  drawerMedia.addEventListener('change', () => closeSidebar());
  window.addEventListener('hashchange', guarded(navigate));
  document.querySelectorAll('[data-nav]').forEach((link) => link.addEventListener('click', guarded(async (event) => {
    if (link.hash === location.hash) { event.preventDefault(); await navigate(); }
  })));
  window.addEventListener('pagehide', () => { stopStream(); stopDebugView(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('result-panel').hidden && matchMedia('(max-width: 1199px)').matches) {
      closeResult(); return;
    }
    if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) { closeSidebar(true); }
    if (event.key === 'n' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); location.hash = 'home'; home(); }
  });
  closeSidebar();
}
async function navigate() {
  stopDebugView();
  const route = parseRoute(location.hash), page = route.page;
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === page) { link.setAttribute('aria-current', 'page'); } else { link.removeAttribute('aria-current'); }
  });
  closeSidebar();
  if (page === 'task') {
    if (state.selected?.id === route.id && document.querySelector('#canvas .task-heading')) { return; }
    try {
      const task = (await request(`tasks/${route.id}`)).data;
      await openTask(task, false);
    } catch (error) {
      stopStream(); state.selected = null; $('composer-dock').hidden = true;
      $('page-title').textContent = '任务未找到'; $('page-context').textContent = '任务执行与证据';
      $('canvas').replaceChildren(empty('任务未找到', error.message, button('返回新任务', () => { location.hash = 'home'; })));
    }
  } else if (page === 'debug') { stopStream(); state.selected = null; await debugView(state.bootstrap, openTask); }
  else if (page === 'home') { home(); } else { await refresh(); await collection(page); }
}
async function boot() {
  state.bootstrap = await initialize();
  state.projectRoot = state.bootstrap.projectRoot;
  state.catalog = (await request('capabilities')).data;
  state.modelId = (await execute('model.list')).data.selected?.id ?? null;
  state.openTask = openTask; updateSelectors(); updateScopes(); bind(); await refresh(); await navigate();
}
boot().catch((error) => {
  $('composer-dock').hidden = true;
  $('canvas').replaceChildren(empty('工作台暂未连接', error.message, button('重新连接', () => location.reload())));
});
