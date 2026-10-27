/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { request, download } from './api.js';
import { $, node, button, details, pre, toast, empty, icon, statusBadge, modal } from './view.js';
import { problemReview } from './problem.js';

const toolNames = {
  doctor: '检查本地环境',
  'project.inspect': '检查应用工程',
  'deveco.device.list': '检查连接设备',
  'model.check': '检查模型连接',
  'model.trae': '发现 TRAE 模型',
  'model.trae-cli': '发现 TRAE CLI 模型',
  'workspace.patch': '修改工程文件',
  'debug.problem.export': '导出调试问题包',
};
const resultTabs = ['摘要', '发现', '变更', '计划', '证据', '原始数据'];
const progressLabels = ['理解目标', '检查条件', '等待确认', '执行', '验证'];
export const taskTitle = (task) => task.toolId === 'agent.run' ? task.input.prompt : toolNames[task.toolId] ?? task.toolId;
export function taskStage(task) {
  if (task.state === 'succeeded') {
    if (task.receipt?.status === 'degraded' || task.receipt?.exitCode === 3) {
      return { label: '完成，证据不完整', index: 5, tone: 'warning', next: '查看未验证项并补充真实证据' };
    }
    if (task.receipt?.status === 'findings' || task.receipt?.exitCode === 1) {
      return { label: '已发现问题', index: 5, tone: 'warning', next: '查看发现并选择下一步' };
    }
    return { label: '任务完成', index: 5, tone: 'success', next: '查看成果、证据或继续任务' };
  }
  return ({
    queued: { label: '等待执行', index: 0, tone: 'neutral', next: '等待本地执行资源' },
    planning: { label: '检查条件', index: 1, tone: 'neutral', next: '核对应用、工具和执行条件' },
    'awaiting-approval': { label: '等待确认', index: 2, tone: 'warning', next: '检查影响范围并确认是否执行' },
    running: { label: '正在执行', index: 3, tone: 'neutral', next: '等待工具完成，期间可停止任务' },
    verifying: { label: '验证结果', index: 4, tone: 'neutral', next: '正在核对回执、产物与证据' },
    failed: { label: '执行失败', index: 5, tone: 'danger', next: '查看失败原因并按建议重试' },
    cancelled: { label: '已停止', index: 5, tone: 'neutral', next: '任务记录已保留，可重新开始' },
    blocked: { label: '需要补充条件', index: 5, tone: 'warning', next: '查看缺失条件并补充后重试' },
  })[task.state] ?? { label: task.state, index: 0, tone: 'neutral', next: '查看技术详情' };
}
export function taskProgress(task) {
  const processes = Array.isArray(task.processes) ? task.processes.length : 0;
  const terminal = ['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.state);
  let reached = 0;
  if (task.state === 'planning') { reached = 1; }
  else if (task.state === 'awaiting-approval') { reached = 2; }
  else if (task.state === 'running') { reached = 3; }
  else if (task.state === 'verifying') { reached = 4; }
  else if (task.state === 'succeeded') { reached = 5; }
  else if (task.state === 'failed') { reached = 4; }
  else if (task.state === 'cancelled') { reached = processes ? 3 : task.plan ? 2 : 3; }
  else if (task.state === 'blocked') { reached = task.plan ? 2 : 3; }
  return progressLabels.map((label, index) => ({
    label,
    status: index < reached ? 'complete' : index === reached ? 'current' : terminal ? 'skipped' : 'upcoming',
  }));
}

export function logEntry(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  if (event?.type === 'tool.stdout' || event?.type === 'tool.stderr') {
    return { sequence: event.sequence, channel: event.type === 'tool.stdout' ? 'stdout' : 'stderr',
      text: String(payload.text ?? '') };
  }
  if (event?.type === 'process.started' || event?.type === 'process.closed') {
    return { sequence: event.sequence, channel: 'process',
      text: `${event.type === 'process.started' ? '进程已启动' : '进程已结束'} · PID ${payload.pid ?? '未知'}` };
  }
  return null;
}

export function taskSignature(task, pending = []) {
  const pendingKey = (Array.isArray(pending) ? pending : []).map((item) => `${item.id}:${item.state}`).join(',');
  return [task.id, task.state, task.plan?.planId ?? '', task.approvedPlan ?? '', task.receipt?.exitCode ?? '',
    task.receipt?.data?.code ?? '', task.sessionId ?? '', task.cancelRequested ? 'c' : '',
    task.forceRequested ? 'f' : '', task.processes?.length ?? 0, pendingKey].join('|');
}

export function filterTasks(tasks, query = '', state = 'all') {
  const text = String(query ?? '').trim().toLowerCase();
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (state !== 'all' && task.state !== state) { return false; }
    if (!text) { return true; }
    return `${taskTitle(task)} ${task.toolId} ${task.projectRoot ?? ''} ${task.receipt?.data?.code ?? ''} ${task.state}`
      .toLowerCase().includes(text);
  });
}

function list(value) { return Array.isArray(value) ? value : []; }
export function resultProjection(task) {
  const receipt = task.receipt, data = receipt?.data && typeof receipt.data === 'object' && !Array.isArray(receipt.data) ? receipt.data : {};
  const stage = taskStage(task), project = task.projectRoot?.split(/[\\/]/).at(-1) ?? '本地工作空间';
  const summary = [
    { label: '任务', value: taskTitle(task) },
    { label: '结果', value: stage.label, tone: stage.tone },
    { label: '耗时', value: `${receipt?.durationMs ?? 0} ms` },
  ];
  if (typeof data.text === 'string') { summary.push({ label: '结论', value: data.text }); }
  if (data.code) { summary.push({ label: '状态代码', value: String(data.code) }); }
  if (task.toolId === 'doctor') {
    if (data.node?.version) { summary.push({ label: 'Node.js', value: `${data.node.version}${data.node.supported === false ? ' · 不受支持' : ' · 可用'}` }); }
    if (data.platform) { summary.push({ label: '平台', value: `${data.platform}${data.arch ? ` · ${data.arch}` : ''}` }); }
    summary.push({ label: '工程', value: data.project?.root?.split(/[\\/]/).at(-1) ?? project });
    if (data.toolchain) { summary.push({ label: '工具链', value: data.toolchain.available === false ? '不可用' : '已检测' }); }
  }
  const findings = [...(receipt?.warnings ?? []).map((item) => ({ severity: 'warning', ...item })),
    ...list(data.findings), ...list(data.diagnostics), ...list(data.issues)];
  const planFiles = list(task.plan?.review?.files);
  const applied = Boolean(receipt && (['applied', 'recovery-required'].includes(data.phase) ||
    data.code === 'PATCH_APPLIED' || data.code === 'PATCH_RECOVERY_REQUIRED'));
  const receiptChanges = [...list(data.changes),
    ...list(data.files).filter((item) => item && typeof item === 'object' && ('operation' in item || 'diff' in item))];
  const byPath = new Map();
  for (const file of [...(applied ? planFiles : []), ...receiptChanges]) {
    if (file?.path) { byPath.set(file.path, { ...(byPath.get(file.path) ?? {}), ...file }); }
  }
  const appliedChanges = [...byPath.values()];
  const planStatus = !task.plan ? 'none' : applied ? 'applied' :
    task.state === 'awaiting-approval' ? 'pending' : task.state === 'cancelled' ? 'cancelled' : 'not-applied';
  return {
    summary, findings, changes: appliedChanges, appliedChanges, planChanges: planFiles, planStatus,
    evidence: {
      source: receipt?.provenance?.adapter ?? 'unknown', project, startedAt: receipt?.startedAt,
      durationMs: receipt?.durationMs, artifacts: receipt?.artifacts ?? [], warnings: receipt?.warnings ?? [],
      capabilities: receipt?.capabilities ?? {},
    },
    raw: receipt,
  };
}
let stream, generation = 0, renderedTask, renderedSignature, refreshTimer, lastEvents = [], logEntries = [], logBytes = 0;
const LOG_LIMIT = 600, LOG_BYTE_LIMIT = 128 * 1024;
const resultMedia = matchMedia('(max-width: 1199px)');
const compactDrawer = matchMedia('(max-width: 767px)');
let resultReturnFocus;
export function stopStream() {
  generation++; stream?.close(); stream = undefined; clearTimeout(refreshTimer);
}
function pendingFor(task, tasks = []) {
  const ids = Array.isArray(task.receipt?.data?.pendingTasks) ? task.receipt.data.pendingTasks : [];
  return ids.map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
}
function appendLog(event) {
  const entry = logEntry(event);
  if (!entry) { return false; }
  logEntries.push(entry);
  logBytes += entry.text.length * 2 + 48;
  while (logEntries.length > LOG_LIMIT || logBytes > LOG_BYTE_LIMIT) {
    const removed = logEntries.shift();
    logBytes -= removed.text.length * 2 + 48;
  }
  return true;
}
function ingestEvent(event) {
  lastEvents.push(event); lastEvents = lastEvents.slice(-50);
  if (appendLog(event)) { renderLogs(); }
  renderEvents();
}
function renderLogs() {
  const box = $('task-log'), status = document.querySelector('.log-status');
  if (!box) { return; }
  box.hidden = logEntries.length === 0;
  box.textContent = logEntries.map((entry) => entry.channel === 'process' ?
    `[process] ${entry.text}` : `[${entry.channel}] ${entry.text}`).join('\n');
  if (status) {
    status.textContent = logEntries.length ? `已记录 ${logEntries.length} 条输出，显示最近内容。` : '暂无标准输出或错误输出。';
  }
}
function fullRender(task, onChanged, onContinue, tasks, onOpenTask, onAgentContinue) {
  renderedTask = task;
  renderedSignature = taskSignature(task, pendingFor(task, tasks));
  $('page-title').textContent = taskTitle(task);
  $('page-context').textContent = '任务执行与证据';
  const stage = taskStage(task), steps = taskProgress(task);
  const openDetails = [...($('canvas').querySelectorAll('details[open]') ?? [])]
    .map((item) => item.querySelector('summary')?.textContent).filter(Boolean);
  const area = document.querySelector('.conversation-area'), scroll = area?.scrollTop ?? 0;
  const thread = node('div', { class: 'thread' }, [
    node('div', { class: 'user-message' }, [node('p', {}, [taskTitle(task)])]),
    node('div', { class: 'assistant-author' }, [node('span', { class: 'assistant-mark' }, [icon('activity', 16)]), 'OHMate']),
    node('div', { class: 'task-heading' }, [node('h2', {}, [stage.label]), statusBadge(stage.label, stage.tone)]),
    node('p', { class: 'task-status', role: 'status' }, [
      `${task.projectRoot ? task.projectRoot.split(/[\\/]/).at(-1) : '本地工作空间'} · ${new Date(task.updatedAt).toLocaleString('zh-CN')}`,
    ]),
    node('p', { class: 'task-next' }, [stage.next]),
    node('ol', { class: 'task-progress', 'aria-label': '任务阶段' }, steps.map((step, index) =>
      node('li', { class: step.status, 'aria-current': step.status === 'current' ? 'step' : undefined }, [
        node('span', { class: 'progress-dot', 'aria-hidden': 'true' }, [
          step.status === 'complete' ? icon('check', 12) : step.status === 'skipped' ? '—' : String(index + 1),
        ]),
        node('span', {}, [step.status === 'skipped' ? `${step.label} · 未执行` : step.label]),
      ]))),
  ]);
  if (task.plan && task.state === 'awaiting-approval') {
    thread.append(approvalSection(task, onChanged));
  }
  const pending = pendingFor(task, tasks);
  if (pending.length) { thread.append(pendingSection(task, pending, onAgentContinue, onOpenTask)); }
  if (task.receipt?.data?.text) { thread.append(node('p', { class: 'status-copy' }, [task.receipt.data.text])); }
  if (task.receipt?.data?.code) { thread.append(node('p', { class: 'notice' }, [explain(task.receipt.data.code)])); }
  if (task.receipt?.data?.code === 'TOOL_APPROVAL_REQUIRED' && task.sessionId) {
    thread.append(node('div', { class: 'task-actions' }, [
      button('继续助手', () => onAgentContinue(task), 'btn primary'),
    ]));
  }
  const actions = node('div', { class: 'task-actions' });
  if (!['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.state)) {
    actions.append(button('停止任务', () => cancelTask(task, false, onChanged)));
  }
  if (task.cancelRequested && (task.processes?.length ?? 0) > 0 && !['succeeded', 'failed', 'cancelled'].includes(task.state)) {
    actions.append(button('强制停止', () => forceStop(task, onChanged), 'btn danger'));
  }
  if (['queued', 'planning', 'running', 'verifying'].includes(task.state)) {
    actions.append(button('核验并恢复', () => resumeTask(task, onChanged)));
  }
  if (task.receipt) {
    actions.append(button('查看成果与依据', () => showResult(task)));
    actions.append(button('导出执行记录', () => download(task, `ohmate-task-${task.id}.json`)));
  }
  if (task.sessionId) { actions.append(button('继续此会话', () => onContinue(task))); }
  const eventList = node('ul', { id: 'task-events', class: 'events', 'aria-label': '实时执行事件' });
  thread.append(actions, node('section', { class: 'task-logs', 'aria-labelledby': 'task-logs-title' }, [
    node('h3', { id: 'task-logs-title' }, ['运行日志']),
    node('p', { class: 'log-status muted', role: 'status' }, ['暂无标准输出或错误输出。']),
    node('pre', { id: 'task-log', class: 'task-log', tabindex: '0', 'aria-label': '运行日志' }),
  ]), details('计划、输入与完整回执', { taskId: task.id, tool: task.toolId, input: task.input,
    plan: task.plan ?? null, receipt: task.receipt ?? null }),
  node('details', { class: 'details event-disclosure' }, [
    node('summary', {}, ['技术执行事件']), eventList,
  ]));
  $('canvas').replaceChildren(thread);
  [...$('canvas').querySelectorAll('details')].forEach((item) => {
    if (openDetails.includes(item.querySelector('summary')?.textContent)) { item.open = true; }
  });
  if (area) { area.scrollTop = scroll; }
  renderEvents(); renderLogs();
}
function updateLive(task) {
  renderedTask = task;
  const status = document.querySelector('.task-status');
  if (status) {
    status.textContent = `${task.projectRoot ? task.projectRoot.split(/[\\/]/).at(-1) : '本地工作空间'} · ${new Date(task.updatedAt).toLocaleString('zh-CN')}`;
  }
}
export function taskView(task, onChanged, onContinue, tasks = [], onOpenTask = () => {}, onAgentContinue = () => {}) {
  if (renderedTask?.id !== task.id) { lastEvents = []; logEntries = []; logBytes = 0; }
  const signature = taskSignature(task, pendingFor(task, tasks));
  if (renderedTask?.id === task.id && signature === renderedSignature &&
    document.querySelector('#canvas .task-heading')) { updateLive(task); return; }
  fullRender(task, onChanged, onContinue, tasks, onOpenTask, onAgentContinue);
}
function approvalSection(task, onChanged) {
  return node('section', { class: 'approval-inline', 'aria-label': '待确认执行计划' }, [
    node('h3', {}, ['请确认这次操作的范围']),
    node('p', {}, [`工具：${toolNames[task.plan.tool] ?? task.plan.tool}`]),
    node('p', {}, [`目标：${task.plan.project}`]),
    node('p', { class: `risk-copy ${task.plan.risk}` }, [({
      R0: '只读操作，不修改工程。', R1: '会生成本地产物。', R2: '将修改工程，执行前请核对 Diff。',
      R3: '可能影响设备或外部系统，请核对不可恢复影响。',
    })[task.plan.risk] ?? `技术风险等级：${task.plan.risk}`]),
    ...(task.plan.tool === 'debug.problem.export' ? [problemReview(task.plan.review)] : []),
    ...patchDiffs(task.plan.review),
    details('查看参数、绑定指纹与恢复方式', task.plan),
    button('确认范围并执行', async () => {
      const result = await request(`tasks/${task.id}/approve`, { planId: task.plan.planId });
      await onChanged(result.data); await subscribe(result.data, onChanged);
    }, 'btn primary'),
  ]);
}
function pendingSection(parent, pending, onAgentContinue, onOpenTask) {
  return node('section', { class: 'approval-inline pending-inline', 'aria-label': '待审批的助手操作' }, [
    node('h3', {}, ['待审批的助手操作']),
    ...pending.map((item) => node('article', { class: 'pending-task' }, [
      node('p', {}, [`${toolNames[item.toolId] ?? item.toolId} · ${
        ({ 'awaiting-approval': '等待确认', succeeded: '已执行', failed: '执行失败', cancelled: '已停止' })[item.state] ?? item.state}`]),
      ...(item.plan ? patchDiffs(item.plan.review) : []),
      node('div', { class: 'task-actions' }, [
        ...(item.state === 'awaiting-approval' && item.plan ? [button('审批并继续', async () => {
          await request(`tasks/${item.id}/approve`, { planId: item.plan.planId, wait: true });
          onAgentContinue(parent);
        }, 'btn primary')] : []),
        ...(item.state === 'succeeded' ? [button('继续助手', () => onAgentContinue(parent), 'btn primary')] : []),
        button('查看子任务', () => onOpenTask(item)),
      ]),
    ])),
  ]);
}
async function cancelTask(task, force, onChanged) {
  const result = await request(`tasks/${task.id}/cancel`, force ? { force: true } : {});
  await onChanged(result.data); await subscribe(result.data, onChanged);
}
function forceStop(task, onChanged) {
  modal('强制停止任务', [
    node('p', {}, ['将强制结束该任务启动的本地进程。未完成的写入可能保留恢复证据。']),
    node('p', { class: 'muted' }, [`当前记录的进程数：${task.processes.length}。`]),
  ], [button('取消', () => $('dialog').close()), button('强制停止', async () => {
    $('dialog').close(); await cancelTask(task, true, onChanged);
  }, 'btn danger')], { kind: 'compact' });
}
async function resumeTask(task, onChanged) {
  const result = await request(`tasks/${task.id}/resume`, {});
  await onChanged(result.data); await subscribe(result.data, onChanged);
}
function patchDiffs(review) {
  return (review?.files ?? []).filter((file) => typeof file.diff === 'string').map((file) =>
    node('section', { class: 'patch-review', 'data-patch-path': file.path }, [
      node('h4', {}, [file.path]), node('p', { class: 'muted' }, [
        `${({ create: '新建', replace: '修改', delete: '删除' })[file.operation] ?? file.operation} · ` +
        `${file.oldHash?.slice(0, 12) ?? '不存在'} → ${file.newHash?.slice(0, 12) ?? '不存在'}`,
      ]), node('pre', { class: 'patch-diff', tabindex: '0', 'aria-label': `${file.path} 的文件差异` }, [file.diff]),
    ]));
}
function explain(code) {
  return ({ MODEL_REQUIRED: '此任务需要模型。请配置模型 API，或选择本地命令继续。',
    MODEL_CREDENTIAL_MISSING: '本机尚未配置指定的凭据环境变量。设置后重新启动工作台。',
    CONTEXT_APPROVAL_REQUIRED: '请先预览并确认模型发送范围。', CONTEXT_APPROVAL_STALE: '文件或上下文已变化，请重新预览。',
    TOOL_APPROVAL_REQUIRED: '助手已暂停。请在最近任务中查看并确认待审批操作，之后继续会话。',
    MODEL_REQUEST_FAILED: '模型请求未完成。请检查 API 设置与连接。', AGENT_BUDGET_EXHAUSTED: '任务达到预算限制。现有记录已保留。',
  })[code] ?? code;
}
export async function subscribe(task, onChanged) {
  stopStream(); lastEvents = []; logEntries = []; logBytes = 0;
  const current = generation, key = `ohmate-cursor-${task.id}`;
  let cursor = 0;
  try {
    const history = await request(`tasks/${task.id}/events?format=json&limit=800`);
    if (current !== generation) { return; }
    for (const event of history.events ?? []) { ingestEvent(event); }
    cursor = Number(history.nextCursor ?? 0) || 0;
  } catch {
    cursor = Number(sessionStorage.getItem(key) ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > task.sequence) { cursor = 0; }
  }
  if (current !== generation) { return; }
  stream = new EventSource(`/api/v1/tasks/${task.id}/events?after=${cursor}`);
  stream.onmessage = (message) => {
    if (current !== generation) { return; }
    const event = JSON.parse(message.data);
    cursor = event.sequence; sessionStorage.setItem(key, String(cursor));
    ingestEvent(event);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try { const result = await request(`tasks/${task.id}`); if (current === generation) { await onChanged(result.data); } }
      catch (error) { toast(error.message); }
    }, 100);
  };
  stream.addEventListener('end', async () => {
    if (current !== generation) { return; }
    stream.close(); clearTimeout(refreshTimer);
    try { const result = await request(`tasks/${task.id}`); if (current === generation) { await onChanged(result.data); } }
    catch (error) { toast(error.message); }
  });
  stream.onerror = () => { if (current === generation) { toast('事件连接中断，正在按已保存的序号重新连接。'); } };
}
function renderEvents() {
  if (!$('task-events')) { return; }
  $('task-events').replaceChildren(...lastEvents.map((event) => {
    const entry = logEntry(event);
    return node('li', {}, [
      node('small', {}, [`#${event.sequence}`]),
      node('span', {}, [humanEvent(event.type), entry ? ` · ${entry.text.slice(0, 160).replaceAll('\n', ' ')}` : '']),
    ]);
  }));
}
function humanEvent(type) {
  return ({
    'task.created': '任务已创建', 'task.state': '任务状态已更新', 'task.plan': '执行计划已形成',
    'task.receipt': '执行回执已保存', 'process.started': '本地进程已启动', 'process.closed': '本地进程已结束',
    'tool.stdout': '标准输出', 'tool.stderr': '错误输出',
    'agent.message_update': '模型回复已更新', 'agent.tool_call': '模型请求调用工具',
    'agent.tool_result': '工具结果已返回',
  })[type] ?? type;
}
function summaryView(items) {
  return node('dl', { class: 'result-summary' }, items.map((item) =>
    node('div', { class: 'result-summary-row' }, [
      node('dt', {}, [item.label]),
      node('dd', {}, [item.tone ? statusBadge(item.value, item.tone) : String(item.value)]),
    ])));
}
function findingsView(items) {
  if (!items.length) { return empty('没有记录到问题', '本次回执没有 findings、diagnostics 或 warnings。'); }
  return node('div', { class: 'result-list' }, items.map((item) => node('article', { class: 'result-list-row' }, [
    statusBadge(item.severity === 'error' ? '错误' : item.severity === 'warning' ? '注意' : '发现',
      item.severity === 'error' ? 'danger' : 'warning'),
    node('div', {}, [
      node('strong', {}, [item.message ?? item.code ?? '未命名发现']),
      item.code && item.message ? node('small', {}, [item.code]) : null,
    ]),
  ])));
}
function changesView(items) {
  if (!items.length) { return empty('没有已应用的变更', '本次任务没有提交文件修改；计划与产物可在其它视图查看。'); }
  return node('div', { class: 'result-list' }, items.map((item) => node('article', { class: 'result-list-row change-row' }, [
    statusBadge(({ create: '新建', replace: '修改', delete: '删除' })[item.operation] ?? item.operation ?? '变更',
      item.operation === 'delete' ? 'danger' : 'warning'),
    node('div', {}, [
      node('strong', {}, [item.path ?? '未命名文件']),
      item.diff ? node('pre', { class: 'patch-diff', tabindex: '0' }, [item.diff]) : null,
    ]),
  ])));
}
function evidenceView(value) {
  const metadata = [
    ['来源', value.source], ['工程', value.project],
    ['开始时间', value.startedAt ? new Date(value.startedAt).toLocaleString('zh-CN') : '未记录'],
    ['耗时', `${value.durationMs ?? 0} ms`],
  ];
  return node('div', {}, [
    summaryView(metadata.map(([label, item]) => ({ label, value: item }))),
    node('h3', { class: 'result-section-title' }, ['产物与哈希']),
    ...(value.artifacts.length ? value.artifacts.map((artifact) => node('div', { class: 'evidence-row' }, [
      node('strong', {}, [artifact.kind]), node('span', {}, [artifact.path]),
      node('code', {}, [artifact.sha256]),
    ])) : [empty('没有产物记录', '本次回执没有发布本地产物。')]),
    details('能力与告警依据', { capabilities: value.capabilities, warnings: value.warnings }),
  ]);
}
function planView(projected) {
  if (!projected.planChanges.length) { return empty('没有执行计划', '本次任务没有形成文件修改计划。'); }
  const status = ({ pending: '待审批', applied: '已执行', cancelled: '未执行（任务已停止）',
    'not-applied': '未执行' })[projected.planStatus] ?? projected.planStatus;
  return node('div', {}, [
    node('p', { class: 'notice' }, [`计划状态：${status}。计划中的文件不等于已发生变更。`]),
    changesView(projected.planChanges),
  ]);
}
export function closeResult(restore = true) {
  const panel = $('result-panel');
  if (!panel || panel.hidden) { return; }
  panel.hidden = true;
  $('result-backdrop').hidden = true;
  panel.removeAttribute('role'); panel.removeAttribute('aria-modal');
  const conversation = document.querySelector('.conversation-area'), topbar = document.querySelector('.topbar'), sidebar = $('sidebar');
  if (conversation) { conversation.inert = false; conversation.removeAttribute('aria-hidden'); }
  if (topbar) { topbar.inert = false; topbar.removeAttribute('aria-hidden'); }
  if (sidebar) {
    sidebar.inert = false;
    if (!compactDrawer.matches || document.body.classList.contains('sidebar-open')) {
      sidebar.removeAttribute('aria-hidden');
    } else { sidebar.setAttribute('aria-hidden', 'true'); }
  }
  if (restore && resultReturnFocus instanceof HTMLElement && resultReturnFocus.isConnected) { resultReturnFocus.focus(); }
  resultReturnFocus = null;
}
export function syncResultPanel() {
  const panel = $('result-panel');
  if (!panel || panel.hidden) { return; }
  const compact = resultMedia.matches;
  $('result-backdrop').hidden = !compact;
  const conversation = document.querySelector('.conversation-area'), topbar = document.querySelector('.topbar'), sidebar = $('sidebar');
  if (compact) {
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    if (conversation) { conversation.inert = true; conversation.setAttribute('aria-hidden', 'true'); }
    if (topbar) { topbar.inert = true; topbar.setAttribute('aria-hidden', 'true'); }
    if (sidebar) { sidebar.inert = true; sidebar.setAttribute('aria-hidden', 'true'); }
    setTimeout(() => $('result-close').focus({ preventScroll: true }), 0);
  } else {
    panel.removeAttribute('role'); panel.removeAttribute('aria-modal');
    if (conversation) { conversation.inert = false; conversation.removeAttribute('aria-hidden'); }
    if (topbar) { topbar.inert = false; topbar.removeAttribute('aria-hidden'); }
    if (sidebar) { sidebar.inert = false; sidebar.removeAttribute('aria-hidden'); }
  }
}
export function showResult(task = renderedTask) {
  if (!task?.receipt) { return; }
  const receipt = task.receipt, projected = resultProjection(task);
  if ($('result-panel').hidden) { resultReturnFocus = document.activeElement; }
  $('result-panel').hidden = false;
  syncResultPanel();
  const tablist = node('div', { class: 'result-tablist', role: 'tablist', 'aria-label': '成果视图' });
  const content = node('div', { class: 'result-tab-content', role: 'tabpanel' });
  const select = (name) => {
    const index = resultTabs.indexOf(name);
    [...tablist.children].forEach((tab, tabIndex) => {
      const selected = tab.dataset.resultTab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('active', selected);
      if (tabIndex === index) { content.setAttribute('aria-labelledby', tab.id); }
    });
    content.replaceChildren(name === '摘要' ? summaryView(projected.summary) :
      name === '发现' ? findingsView(projected.findings) :
      name === '变更' ? changesView(projected.appliedChanges) :
      name === '计划' ? planView(projected) :
      name === '证据' ? evidenceView(projected.evidence) :
      node('div', {}, [node('p', { class: 'notice' }, ['原始数据用于技术核对，不代表全部字段已验证。']), pre(projected.raw)]));
  };
  const bindKeys = (event) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
    const tabs = [...tablist.querySelectorAll('[role="tab"]')], current = tabs.indexOf(document.activeElement);
    if (current < 0) { return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? (current + 1) % tabs.length :
        (current - 1 + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].focus(); tabs[next].click();
  };
  tablist.addEventListener('keydown', bindKeys);
  resultTabs.forEach((name, index) => {
    const tab = button(name, () => select(name), 'result-tab');
    tab.id = `result-tab-${index}`; tab.dataset.resultTab = name; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'result-tab-content'); tab.tabIndex = -1; tablist.append(tab);
  });
  content.id = 'result-tab-content';
  $('result-body').replaceChildren(
    node('div', { class: 'result-title-row' }, [
      node('div', {}, [node('h3', {}, [taskTitle(task)]),
        node('p', { class: 'task-status' }, [`${taskStage(task).label} · 来源 ${receipt.provenance.adapter}`])]),
      button(node('span', {}, [icon('download'), '导出']), () => download(receipt, `ohmate-receipt-${task.id}.json`), 'btn'),
    ]),
    tablist, content,
  );
  select('摘要');
}
