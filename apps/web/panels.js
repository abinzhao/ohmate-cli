/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execute, request, download } from './api.js';
import { $, node, button, field, modal, pre, details, guarded, toast, empty, icon, popover, closePopover, statusBadge } from './view.js';
import { appendScopePath, extensionState, mergeApplications, removeScopePath, splitScopePaths, toolMatches } from './ui-model.js';

export async function projects(state, changed) {
  const list = mergeApplications(state.projectRoot, state.projectName, (await execute('project.list')).data);
  modal('选择应用', [
    node('p', { class: 'muted' }, ['当前工作台工程和已保存应用会同时显示。也可在终端通过 --project 指定工程。']),
    ...list.map((project) => button(node('span', { class: 'project-choice-copy' }, [
      node('span', {}, [node('strong', {}, [project.name]),
        ...(project.current ? [statusBadge('当前应用', 'success')] : [])]),
      node('small', {}, [project.root]),
    ]), async () => {
      $('dialog').close(); await changed(project.root, project.name);
    }, `choice ${project.root === state.projectRoot ? 'selected' : ''}`)),
  ], [button('添加应用文件夹', () => registerProject(state, changed))]);
}
export function registerProject(state, changed) {
  const path = field('本机应用文件夹路径', 'project-path', { required: true, hint: '输入完整路径；仅验证真实工程标记与公开配置。' });
  const form = node('form', {}, [path.view]);
  const submit = node('button', { type: 'submit', class: 'btn primary' }, ['验证并添加']);
  form.append(node('div', { class: 'modal-actions' }, [submit]));
  form.addEventListener('submit', guarded(async (event) => {
    event.preventDefault();
    if (submit.disabled) { return; }
    submit.disabled = true;
    try {
      const project = (await execute('project.register', { path: path.input.value })).data;
      $('dialog').close(); await changed(project.root, project.name);
    } finally { submit.disabled = false; }
  }));
  modal('添加已有应用', [node('p', { class: 'muted' }, ['浏览器无法直接提供本机目录绝对路径，请填写应用目录。']), form]);
}
export async function models(state, changed) {
  const result = (await execute('model.list')).data;
  const entries = [
    button('无模型 · 本地工具', async () => {
      state.modelId = null; $('dialog').close(); changed();
    }, `choice ${!state.modelId ? 'selected' : ''}`),
    ...result.models.map((model) => node('section', { class: 'setting-row' }, [
      node('h3', {}, [model.model]), node('p', { class: 'muted' }, [model.id, ' · ', model.api === 'trae-cli' ? model.executable : model.endpoint]),
      node('small', {}, [model.api === 'trae-cli' ? '使用 TRAE CLI 已登录的账号' : `凭据引用：${model.credentialEnv}`]),
      node('div', { class: 'task-actions' }, [
        button('选择', async () => {
          await execute('model.select', { id: model.id }); state.modelId = model.id; $('dialog').close(); changed();
        }),
        button('检查连接', async () => {
          const task = await request('tasks', { toolId: 'model.check', input: { id: model.id }, projectRoot: state.projectRoot });
          $('dialog').close(); await state.openTask(task.data);
        }),
        button('删除配置', async () => {
          await execute('model.remove', { id: model.id }); if (state.modelId === model.id) { state.modelId = null; }
          changed(); await models(state, changed);
        }),
      ]),
    ])),
  ];
  modal('模型连接', [node('p', { class: 'muted' }, ['可使用本机 TRAE CLI 账号或自有 API。API 密钥通过进程环境变量提供；连接检查会发送一个小请求。']), ...entries],
    [button('发现 TRAE CLI 模型', () => discoverTraeCli(state, changed)),
      button('发现 TRAE 模型桥', () => discoverTrae(state, changed)), button('添加 API', () => addModel(state, changed))]);
}
export async function modelMenu(state, changed) {
  const result = (await execute('model.list')).data;
  let panel;
  const choose = async (model) => {
    if (model) { await execute('model.select', { id: model.id }); }
    state.modelId = model?.id ?? null; closePopover(); changed();
  };
  const rows = [
    button(node('span', { class: 'model-option-copy' }, [
      node('strong', {}, ['本地工具']), node('small', {}, ['不调用模型']),
    ]), () => choose(null), `model-option ${!state.modelId ? 'selected' : ''}`),
    ...result.models.map((model) => button(node('span', { class: 'model-option-copy' }, [
      node('strong', {}, [model.model]),
      node('small', {}, [model.api === 'trae-cli' ? 'TRAE CLI 已登录账号' : model.api]),
    ]), () => choose(model), `model-option ${state.modelId === model.id ? 'selected' : ''}`)),
    button(node('span', { class: 'model-manage' }, [icon('settings'), '管理模型连接']), async () => {
      closePopover(); await models(state, changed);
    }, 'model-manage-button'),
  ];
  panel = popover($('model-picker'), [
    node('div', { class: 'popover-heading' }, [
      node('strong', {}, ['选择执行模型']), node('small', {}, ['只显示已保存配置']),
    ]),
    node('div', { class: 'model-options' }, rows),
  ], { label: '选择模型', className: 'model-popover' });
  return panel;
}
function discoverTraeCli(state, changed) {
  const executable = field('TRAE CLI 可执行文件', 'trae-executable', { required: true, value: 'trae-cli', maxlength: 4096,
    hint: '默认从 PATH 查找 trae-cli，也可填写完整路径。请先在本机终端完成 trae-cli 登录。' });
  const form = node('form', {}, [executable.view]);
  const submit = node('button', { class: 'btn primary', type: 'submit' }, ['发现并保存模型配置']);
  form.append(node('div', { class: 'modal-actions' }, [submit]));
  form.addEventListener('submit', guarded(async (event) => {
    event.preventDefault(); if (submit.disabled) { return; } submit.disabled = true;
    try {
      const result = await request('tasks', { toolId: 'model.trae-cli', input: { executable: executable.input.value },
        projectRoot: state.projectRoot, wait: true });
      const receipt = result.data?.receipt;
      if (receipt?.exitCode !== 0) {
        throw new Error(receipt?.data?.message ?? receipt?.data?.code ?? result.data?.state ?? '模型发现未完成');
      }
      toast(`发现 ${receipt.data.models.length} 个公开模型。请选择模型后使用。`);
      await models(state, changed);
    } finally { submit.disabled = false; }
  }));
  modal('发现 TRAE CLI 模型', [node('p', { class: 'muted' }, ['读取本机 TRAE CLI 提供的模型列表，发现后可选择模型并检查连接。']), form]);
}
function discoverTrae(state, changed) {
  const endpoint = field('TRAE 模型桥地址', 'trae-endpoint', { required: true, type: 'url',
    hint: '在 TRAE 中启动 OHMate 模型桥并复制连接设置。仅填写 http://127.0.0.1:<端口>/v1；密钥通过宿主环境变量提供。' });
  const form = node('form', {}, [endpoint.view]);
  const submit = node('button', { class: 'btn primary', type: 'submit' }, ['发现并保存模型配置']);
  form.append(node('div', { class: 'modal-actions' }, [submit]));
  form.addEventListener('submit', guarded(async (event) => {
    event.preventDefault(); if (submit.disabled) { return; } submit.disabled = true;
    try {
      const result = await request('tasks', { toolId: 'model.trae', input: { endpoint: endpoint.input.value },
        projectRoot: state.projectRoot, wait: true });
      const receipt = result.data?.receipt;
      if (receipt?.exitCode !== 0) {
        throw new Error(receipt?.data?.message ?? receipt?.data?.code ?? result.data?.state ?? '模型发现未完成');
      }
      toast(`发现 ${receipt.data.models.length} 个公开模型。请选择模型后使用。`);
      await models(state, changed);
    } finally { submit.disabled = false; }
  }));
  modal('发现 TRAE 模型', [node('p', { class: 'muted' }, ['仅发现宿主公开的模型，不自动选择或发送模型请求。TRAE 未开放的模型无法通过此入口使用。']), form]);
}
function addModel(state, changed) {
  const fields = [
    field('配置名称（英文小写）', 'id', { required: true, maxlength: 64 }),
    field('API 协议', 'api', { choices: ['openai-completions', 'anthropic-messages', 'google-generative-ai'] }),
    field('模型标识', 'model', { required: true, maxlength: 200 }),
    field('API 地址', 'endpoint', { required: true, type: 'url', hint: 'HTTPS，或本机 loopback HTTP；不包含凭据。' }),
    field('凭据环境变量名称', 'credentialEnv', { required: true, maxlength: 128, hint: '例如 OHMATE_MODEL_KEY。设置后重新启动工作台，确保新进程继承变量。' }),
  ];
  const form = node('form', {}, fields.map((item) => item.view));
  const submit = node('button', { class: 'btn primary', type: 'submit' }, ['保存配置']);
  form.append(node('div', { class: 'modal-actions' }, [submit]));
  form.addEventListener('submit', guarded(async (event) => {
    event.preventDefault(); if (submit.disabled) { return; } submit.disabled = true;
    try { await execute('model.add', Object.fromEntries(fields.map((item) => [item.input.name, item.input.value]))); await models(state, changed); }
    finally { submit.disabled = false; }
  }));
  modal('添加模型 API', form);
}
export function files(state, changed = () => {}) {
  const selected = { read: new Set(state.files), write: new Set(state.writePaths ?? []) };
  let mode = 'read', current = '';
  const paths = field('读取范围（每行一个）', 'context-files', {
    multiline: true, value: state.files.join('\n'), maxlength: 32768,
    hint: '高级方式：仅公开文本，单文件不超过 128 KiB。',
  });
  const writePaths = field('允许提出修改（每行一个）', 'write-paths', {
    multiline: true, value: (state.writePaths ?? []).join('\n'), maxlength: 20480,
    hint: '高级方式：最多 20 个精确相对路径；每次写入仍需确认 Diff。',
  });
  const tree = node('div', { class: 'file-tree', role: 'list', 'aria-label': '工程文件' });
  const status = node('p', { class: 'tree-status muted', role: 'status', 'aria-live': 'polite' });
  const selectedView = node('div', { class: 'scope-list', 'aria-label': '已选择范围' });
  const breadcrumb = node('nav', { class: 'tree-breadcrumb', 'aria-label': '当前文件夹' });
  const readMode = button('发送给模型', () => setMode('read'), 'scope-mode active');
  const writeMode = button('允许提出修改', () => setMode('write'), 'scope-mode');
  const search = field('筛选当前文件夹', 'file-search');
  search.input.placeholder = '输入文件名';
  let entries = [];

  const advancedInput = (mode) => mode === 'read' ? paths.input : writePaths.input;
  const renderSelected = () => {
    const rows = [
      ...[...selected.read].map((path) => ({ path, mode: 'read', label: '只读' })),
      ...[...selected.write].map((path) => ({ path, mode: 'write', label: '可修改' })),
    ];
    selectedView.replaceChildren(...rows.map((item) => node('span', { class: `scope-chip ${item.mode}` }, [
      statusBadge(item.label, item.mode === 'write' ? 'warning' : 'neutral'),
      node('span', { title: item.path }, [item.path]),
      button('移除', () => {
        const input = advancedInput(item.mode);
        selected[item.mode].delete(item.path);
        input.value = removeScopePath(input.value, item.path);
        renderSelected();
      }, 'chip-remove'),
    ])));
    if (!rows.length) { selectedView.append(node('p', { class: 'muted' }, ['尚未选择文件范围。'])); }
  };
  function setMode(next) {
    mode = next;
    readMode.classList.toggle('active', mode === 'read'); readMode.setAttribute('aria-pressed', String(mode === 'read'));
    writeMode.classList.toggle('active', mode === 'write'); writeMode.setAttribute('aria-pressed', String(mode === 'write'));
    renderTree();
  }
  const choose = (entry) => {
    if (entry.type === 'directory') { current = entry.path; search.input.value = ''; void load(); return; }
    const target = selected[mode], input = advancedInput(mode);
    if (target.has(entry.path)) {
      target.delete(entry.path);
      input.value = removeScopePath(input.value, entry.path);
    } else {
      target.add(entry.path);
      input.value = appendScopePath(input.value, entry.path);
    }
    renderSelected(); renderTree();
  };
  const renderTree = () => {
    const query = search.input.value.trim().toLowerCase();
    const shown = entries.filter((entry) => !query || entry.name.toLowerCase().includes(query));
    tree.replaceChildren(...shown.map((entry) => button(node('span', { class: 'file-row-copy' }, [
      icon(entry.type === 'directory' ? 'folder' : 'file-text'),
      node('span', {}, [entry.name]),
      entry.type === 'file' ? node('small', {}, [formatBytes(entry.bytes)]) : null,
      entry.type === 'file' && selected[mode].has(entry.path) ? icon('check') :
        entry.type === 'directory' ? icon('chevron-right') : icon('plus'),
    ]), () => choose(entry), `file-row ${entry.type} ${selected[mode].has(entry.path) ? 'selected' : ''}`)));
    if (!shown.length) { tree.append(empty('当前文件夹没有可选文件', query ? '清除筛选后重试。' : '私有、敏感和生成目录不会显示。')); }
  };
  const renderBreadcrumb = () => {
    const parts = current ? current.split('/') : [];
    breadcrumb.replaceChildren(button('工程根', () => { current = ''; void load(); }, 'breadcrumb-item'));
    parts.forEach((part, index) => breadcrumb.append(icon('chevron-right', 14),
      button(part, () => { current = parts.slice(0, index + 1).join('/'); void load(); }, 'breadcrumb-item')));
  };
  const load = async () => {
    renderBreadcrumb(); status.textContent = '正在读取公开工程目录…';
    try {
      const result = await request('workspace/tree', { projectRoot: state.projectRoot, path: current, limit: 200 });
      entries = result.entries; status.textContent = result.truncated ? `显示前 ${result.limit} 项，请进入目录或筛选。` :
        `${result.entries.length} 项 · 私有、敏感和生成目录已排除`;
      renderTree();
    } catch (error) {
      entries = []; tree.replaceChildren(empty('工程目录读取未完成', error.message)); status.textContent = '';
    }
  };
  search.input.addEventListener('input', renderTree);
  const advanced = node('details', { class: 'advanced-paths' }, [
    node('summary', {}, ['高级路径输入']), paths.view, writePaths.view,
  ]);
  const content = [
    node('p', { class: 'muted' }, ['选择发送给模型的只读文件，或允许助手提出修改的精确路径。写入仍需单独确认 Diff。']),
    node('div', { class: 'scope-mode-switch', role: 'group', 'aria-label': '文件范围类型' }, [readMode, writeMode]),
    selectedView,
    ...(state.projectRoot ? [search.view, breadcrumb, status, tree] : [
      empty('尚未选择应用', '选择应用后可浏览工程文件；也可使用下方高级路径输入。'),
    ]),
    advanced,
  ];
  modal('文件与修改范围', content, [button('保存范围', () => {
    const files = splitScopePaths(paths.input.value);
    const writeScopes = splitScopePaths(writePaths.input.value);
    if (files.length > 32) { throw new Error('最多选择 32 个文件。'); }
    if (writeScopes.length > 20) { throw new Error('最多允许 20 个修改路径。'); }
    state.files = files; state.writePaths = writeScopes;
    $('dialog').close(); changed();
    toast(`已选择 ${state.files.length} 个引用文件、${state.writePaths.length} 个修改路径。`);
  }, 'btn primary')], { kind: 'file-scope-modal' });
  renderSelected(); setMode('read');
  if (state.projectRoot) { void load(); }
}
function formatBytes(bytes) {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.ceil(bytes / 1024)} KiB`; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
export function previewInput(state) {
  return { prompt: $('prompt').value, files: state.files, writePaths: state.writePaths ?? [], allowedTools: state.allowedTools,
    ...(state.modelId ? { modelId: state.modelId } : {}), ...(state.sessionId ? { sessionId: state.sessionId } : {}) };
}
export async function contextPreview(state, onSend, supplied = null) {
  const input = supplied ?? previewInput(state);
  const preview = (await execute('context.preview', input, state.projectRoot)).data;
  const content = [
    node('p', { class: 'muted' }, [
      `${preview.bytes.toLocaleString()} 字节 · ${preview.materials.length} 个文件或规则 · ${preview.tools.length} 个可调用工具`,
    ]),
    node('p', { class: 'muted' }, [`模型：${preview.model?.id ?? '未选择'}。费用尚不能精确估算。`]),
    details('文件来源与哈希', preview.materials.map(({ text, ...item }) => item)),
    details('允许提出修改的路径与旧内容哈希', preview.writeScope),
    details('查看完整发送内容与工具合同', preview.text),
  ];
  const actions = [button('导出预览', () => download(preview, 'ohmate-context-preview.json'))];
  if (onSend && preview.model) {
    actions.push(button('确认发送范围并开始', async () => { $('dialog').close(); await onSend({ ...input, previewHash: preview.hash }); }, 'btn primary'));
  }
  modal('模型发送范围预览', content, actions);
}
function riskLabel(risk) {
  return ({
    R0: { label: '只读', tone: 'success', copy: '读取公开信息，不修改工程。' },
    R1: { label: '本地产物', tone: 'neutral', copy: '生成本地结果或报告。' },
    R2: { label: '修改工程', tone: 'warning', copy: '执行前会展示计划或 Diff。' },
    R3: { label: '设备或外部影响', tone: 'danger', copy: '需要明确审批，并可能影响设备或外部系统。' },
  })[risk] ?? { label: risk, tone: 'neutral', copy: '风险范围以执行计划为准。' };
}
function toolDescription(spec) {
  const command = spec.command.join(' ');
  return ({
    doctor: '检查本机 Node.js、平台、当前工程和工具链是否可用。',
    'project inspect': '识别工程模块、产品、设备类型和依赖证据。',
    build: '构建选定产品或模块，并保存构建与质量证据。',
    run: '构建应用并运行到明确选择的连接设备。',
    scan: '扫描工程、ArkTS 与依赖问题，并保留报告。',
    'test local': '运行无需设备的本地单元测试。',
    'test instrument': '在明确选择的设备上运行 Instrument Test。',
    'release verify': '核对 Release 产物、输入闭包与证据门状态。',
    'workspace read': '读取已纳入发送范围的公开文本文件。',
    'context preview': '预览将发送给模型的文件、规则、记忆和工具合同。',
  })[command] ?? spec.description;
}
function toolRank(spec, state) {
  const approved = state.allowedTools.includes(spec.id) ? -20 : 0;
  const common = ({ doctor: -10, 'project.inspect': -9, 'context.preview': -8, 'workspace.read': -7 })[spec.id] ?? 0;
  return approved + common + ({ R0: 0, R1: 10, R2: 20, R3: 30 })[spec.risk];
}
function schemaFields(spec, initial) {
  const schema = spec.inputSchema;
  if (schema?.type !== 'object' || !schema.properties || schema.additionalProperties !== false) { return null; }
  const required = new Set(schema.required ?? []), items = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!property || typeof property !== 'object' || property.anyOf || property.oneOf ||
      !['string', 'number', 'integer', 'boolean'].includes(property.type)) { return null; }
    const value = initial[name] ?? property.default ?? '';
    const options = {
      required: required.has(name), value: String(value),
      ...(Array.isArray(property.enum) ? { choices: property.enum.map(String) } : {}),
      ...(property.type === 'boolean' ? { choices: ['false', 'true'] } : {}),
      ...(property.type === 'number' || property.type === 'integer' ? { type: 'number' } : {}),
      hint: property.description,
    };
    items.push({ name, type: property.type, field: field(property.title ?? name, `tool-${name}`, options) });
  }
  return {
    view: node('div', { class: 'schema-form' }, items.map((item) => item.field.view)),
    value: () => Object.fromEntries(items.map((item) => {
      const value = item.field.input.value;
      return [item.name, item.type === 'boolean' ? value === 'true' :
        item.type === 'number' || item.type === 'integer' ? Number(value) : value];
    })),
  };
}
export function tools(state, catalog) {
  const search = field('搜索命令或用途', 'tool-search');
  search.input.placeholder = '例如：构建、检测、设备、报告';
  const results = node('div', { class: 'search-results' });
  const render = () => {
    const query = search.input.value.toLowerCase();
    const matches = catalog.filter((spec) => toolMatches(spec, query, toolDescription(spec)))
      .sort((left, right) => toolRank(left, state) - toolRank(right, state) || left.id.localeCompare(right.id));
    results.replaceChildren(...matches.map((spec) => {
      const risk = riskLabel(spec.risk);
      return button(node('span', { class: 'command-row-copy' }, [
        node('span', { class: 'command-row-heading' }, [
          icon(spec.protocol ? 'terminal' : 'activity'), node('strong', {}, [spec.command.join(' ')]),
          statusBadge(risk.label, risk.tone),
        ]),
        node('span', { class: 'command-description' }, [toolDescription(spec)]),
        node('small', {}, [spec.protocol ? '终端入口 · ' : '', risk.copy]),
      ]), () => command(state, spec), 'command-row');
    }));
    if (!matches.length) { results.append(empty('没有匹配的工具', '尝试搜索命令、用途或领域名称。')); }
  };
  search.input.addEventListener('input', render); render();
  modal('本地工具', [
    node('p', { class: 'muted' }, ['所有工具来自同一注册表。只读、产物、工程修改和设备影响会分别标识；写操作仍需计划审批。']),
    search.view, results,
  ], [], { kind: 'tool-catalog-modal' });
}
function command(state, spec) {
  if (spec.protocol || /^(task|ui|debug|devtools)\./.test(spec.id) &&
    !['debug.problem.plan', 'debug.problem.export', 'debug.inspect', 'debug.inspectors'].includes(spec.id)) {
    modal('在终端使用此入口', [node('p', {}, [spec.description]), pre(`ohmatecli ${spec.command.join(' ')} --help`)]); return;
  }
  const initial = spec.adapter === 'legacy-child' ? { argv: [] } : {};
  const generated = schemaFields(spec, initial);
  const payload = field('命令参数 JSON', 'tool-input', {
    multiline: true, value: JSON.stringify(initial, null, 2), maxlength: 256 * 1024,
  });
  const advanced = node('input', { type: 'checkbox', id: 'tool-use-json' });
  const advancedView = node('details', { class: 'advanced-parameters' }, [
    node('summary', {}, ['高级 JSON 参数']),
    node('label', { class: 'checkbox-row', for: 'tool-use-json' }, [advanced, '使用 JSON 覆盖结构化表单']),
    payload.view,
  ]);
  const risk = riskLabel(spec.risk);
  modal(spec.command.join(' '), [
    node('div', { class: 'command-detail-heading' }, [statusBadge(risk.label, risk.tone), node('p', {}, [toolDescription(spec)])]),
    node('p', { class: 'muted' }, [risk.copy]),
    generated?.view ?? node('p', { class: 'notice' }, ['此工具参数较复杂，请使用高级 JSON 参数。']),
    advancedView, details('参数合同与技术等级', { risk: spec.risk, requirements: spec.requirements, schema: spec.inputSchema }),
  ],
    [button('加入助手可调用工具', () => {
      if (state.allowedTools.length >= 32) { throw new Error('最多允许 32 个工具。'); }
      state.allowedTools = [...new Set([...state.allowedTools, spec.id])];
      $('dialog').close(); toast(`已加入 ${spec.command.join(' ')}，发送预览将包含其权限与参数合同。`);
    }), button('选择此本地任务', () => {
      state.command = { toolId: spec.id, input: advanced.checked || !generated ? JSON.parse(payload.input.value) : generated.value() };
      $('prompt').value = `执行本地工具：${spec.command.join(' ')}`;
      $('composer-caption').textContent = '本地工具运行不调用模型，发送后可查看计划与执行记录。';
      $('dialog').close(); $('prompt').focus();
    }, 'btn primary')], { kind: 'tool-detail-modal' });
}
export async function settings(state, changed = () => {}) {
  const content = node('section', { id: 'settings-content', class: 'settings-content', role: 'tabpanel', tabindex: '0' });
  const navigation = node('nav', { class: 'settings-navigation', role: 'tablist', 'aria-label': '设置分类' });
  const categories = [
    ['模型', 'cpu'], ['规则', 'file-text'], ['长期记忆', 'layers'], ['MCP 与扩展', 'terminal'], ['工作空间', 'folder'],
  ];
  let selected = '模型';
  const activate = async (name) => {
    selected = name;
    [...navigation.children].forEach((item) => {
      const active = item.dataset.setting === name;
      item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
      if (active) { content.setAttribute('aria-labelledby', item.id); }
    });
    content.replaceChildren(node('p', { class: 'muted settings-loading' }, ['正在读取本地设置…']));
    if (name === '模型') {
      const result = (await execute('model.list')).data;
      content.replaceChildren(
        node('div', { class: 'settings-section-heading' }, [
          node('div', {}, [node('h3', {}, ['模型连接']), node('p', { class: 'muted' }, ['模型按需启用；密钥只通过宿主进程环境变量引用。'])]),
          button('管理模型连接', () => models(state, changed), 'btn'),
        ]),
        ...(!result.models.length ? [empty('尚未配置模型', '本地确定性工具无需模型；自然语言任务需要先添加模型连接。')] :
          result.models.map((model) => node('div', { class: 'setting-row semantic-row' }, [
            node('div', {}, [node('strong', {}, [model.model]), node('small', {}, [model.api === 'trae-cli' ? 'TRAE CLI 已登录账号' : model.api])]),
            statusBadge(result.selected?.id === model.id ? '当前模型' : '已保存', result.selected?.id === model.id ? 'success' : 'neutral'),
          ]))),
      );
    } else if (name === '规则') {
      const result = await execute('rules.list', { files: state.files }, state.projectRoot);
      content.replaceChildren(
        node('div', { class: 'settings-section-heading' }, [
          node('div', {}, [node('h3', {}, ['适用规则']), node('p', { class: 'muted' }, ['按路径和作用域展示；原文与哈希按需展开。'])]),
          statusBadge(`${result.data.length} 条`, 'neutral'),
        ]),
        ...(result.data.length ? result.data.map((rule) => node('article', { class: 'rule-row' }, [
          node('div', { class: 'semantic-row-main' }, [
            node('strong', {}, [rule.path]),
            node('small', {}, [`${rule.source === 'rule' ? '工程规则' : '文件'} · ${rule.bytes.toLocaleString()} 字节${rule.redacted ? ' · 已脱敏' : ''}`]),
          ]),
          node('code', {}, [rule.sha256.slice(0, 12)]),
          details('查看规则原文与完整哈希', { text: rule.text, sha256: rule.sha256 }),
        ])) : [empty('暂无适用规则', '应用内 AGENTS.md 和 .ohmate/rules 会自动显示。')]),
      );
    } else if (name === '长期记忆') {
      const memories = (await execute('memory.list', {}, state.projectRoot)).data;
      const note = field('添加人工确认的长期记忆', 'memory-text', { multiline: true, maxlength: 8192,
        hint: '只保存稳定偏好、约束和可复用决策；当前任务过程不应写入长期记忆。' });
      content.replaceChildren(
        node('div', { class: 'settings-section-heading' }, [
          node('div', {}, [node('h3', {}, ['长期记忆']), node('p', { class: 'muted' }, ['仅显示当前工作空间内已明确批准的内容。'])]),
          statusBadge(`${memories.length} 条`, 'neutral'),
        ]),
        ...memories.map((memory) => node('div', { class: 'setting-row semantic-row' }, [
          node('p', {}, [memory.text]),
          button('删除', async () => { await execute('memory.remove', { id: memory.id }, state.projectRoot); await activate(name); }),
        ])),
        ...(!memories.length ? [empty('暂无长期记忆', '只有人工确认保存的稳定信息才会出现在这里。')] : []),
        node('div', { class: 'memory-editor' }, [note.view, button('确认保存', async () => {
          await execute('memory.add', { text: note.input.value }, state.projectRoot); await activate(name);
        }, 'btn primary')]),
      );
    } else if (name === 'MCP 与扩展') {
      const extensions = (await execute('extensions.list')).data;
      content.replaceChildren(
        node('div', { class: 'settings-section-heading' }, [
          node('div', {}, [node('h3', {}, ['MCP 与扩展']), node('p', { class: 'muted' }, ['不可用能力显示原因，不伪造启用状态。'])]),
        ]),
        node('p', { class: 'notice' }, ['可执行扩展尚未通过验证，当前保持禁用。MCP Server 可在终端启动。']),
        ...(extensions.length ? extensions.map((extension) => {
          const state = extensionState(extension);
          return node('div', { class: 'setting-row semantic-row' }, [
            node('div', {}, [node('strong', {}, [extension.id]), node('small', {}, ['本地扩展'])]),
            statusBadge(state.label, state.tone),
          ]);
        }) : [empty('没有已登记扩展', '当前不会自动安装或启用第三方扩展。')]),
        node('div', { class: 'command-reference' }, [
          node('span', {}, ['MCP 终端入口']), node('code', {}, ['ohmatecli serve mcp --help']),
        ]),
      );
    } else {
      const rows = [
        ['当前目录', state.bootstrap.cwd],
        ['当前应用', state.projectRoot ?? '未选择'],
        ['本地服务', location.origin],
        ['停止服务', 'ohmatecli ui stop'],
      ];
      content.replaceChildren(
        node('div', { class: 'settings-section-heading' }, [
          node('div', {}, [node('h3', {}, ['工作空间']), node('p', { class: 'muted' }, ['任务保存在产品私有目录；关闭页面不会取消任务。'])]),
        ]),
        node('dl', { class: 'workspace-settings' }, rows.map(([label, value]) => node('div', {}, [
          node('dt', {}, [label]), node('dd', {}, [value]),
        ]))),
      );
    }
  };
  categories.forEach(([name, iconName], index) => {
    const item = button(node('span', {}, [icon(iconName), name]), () => activate(name),
      `settings-nav-item ${name === selected ? 'active' : ''}`);
    item.id = `settings-tab-${index}`; item.dataset.setting = name; item.setAttribute('role', 'tab');
    item.setAttribute('aria-controls', 'settings-content'); item.tabIndex = name === selected ? 0 : -1;
    navigation.append(item);
  });
  navigation.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
    const items = [...navigation.children], index = items.indexOf(document.activeElement);
    if (index < 0) { return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? (index + 1) % items.length :
        (index - 1 + items.length) % items.length;
    event.preventDefault(); items[next].focus();
    void activate(categories[next][0]).then(() => {
      if (items[next].isConnected) { items[next].focus({ preventScroll: true }); }
    });
  });
  modal('设置', node('div', { class: 'settings-layout' }, [navigation, content]), [], { kind: 'settings-modal' });
  await activate(selected);
}
