/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { request } from './api.js';
import { node, field, details, empty, clockText } from './view.js';

export function problemReview(review) {
  return node('section', { class: 'patch-review', 'aria-label': '问题包导出范围' }, [
    node('h3', {}, ['问题包导出范围']),
    node('p', {}, [`${'retainedCount' in review ? `固定尾序号 ${review.selection.through} · 保留 ${review.retainedCount} 条` :
      `固定截点 ${review.selection.through} 条`} · ${review.archiveBytes.toLocaleString()} 字节 · 附件：无`]),
    ...(review.gap ? [node('p', { class: 'notice' }, [
      `事件缺口：${review.gap.missingFrom}–${review.gap.missingThrough}（保留配额淘汰），不包含在导出包中。`,
    ])] : []),
    node('p', { class: 'notice' }, ['仅导出脱敏领域摘要。保留设备、构建和事件的标识与元数据；设备由对端声明，构建未验证，时钟测量以逐条依据为准。']),
    node('p', {}, [`移除字段累计 ${review.redaction.fieldsRemoved} 个；页面与 UI 文本不进入问题包。`]),
    node('ul', {}, review.files.map((file) => node('li', {}, [
      `${file.path} · ${file.size.toLocaleString()} 字节 · ${file.sensitivity === 'public-schema' ? '公开 Schema' : '脱敏摘要'}`,
    ]))),
    details('导出字段与标识', review.fields),
    details('采集覆盖范围', review.coverage),
    details('文件哈希、截点与保留风险', {
      files: review.files, snapshotHash: review.snapshotHash, archiveHash: review.archiveHash, retainedRisks: review.retainedRisks,
    }),
  ]);
}

export class ProblemView {
  generation = 0;
  closed = false;
  path = null;
  cursor = 0;
  constructor(bootstrap) {
    this.bootstrap = bootstrap;
    const path = field('问题包本机路径', 'problem-path', { required: true,
      hint: '输入本机已有 .ohmate-problem.zip 的路径。每页最多 100 条；Kit 记录另受字节预算限制。' });
    this.input = path.input;
    this.domain = node('select', { id: 'problem-domain', 'aria-label': '问题包领域' });
    this.file = node('select', { id: 'problem-file', 'aria-label': '问题包文件' });
    this.selectFiles();
    this.domain.addEventListener('change', async () => { this.file.value = ''; await this.read(0); });
    this.file.addEventListener('change', async () => { await this.read(0); });
    this.status = node('p', { class: 'problem-status', role: 'status', 'aria-live': 'polite' });
    this.summary = node('div');
    this.events = node('div', { class: 'debug-event-list' });
    this.next = node('button', { type: 'button', class: 'btn', onclick: async () => {
      if (this.next.disabled) { return; }
      this.next.disabled = true; await this.read(this.cursor);
    } }, ['下一页离线记录']);
    this.next.disabled = true;
    const submit = node('button', { type: 'submit', class: 'btn' }, ['校验并查看问题包']);
    const form = node('form', {}, [path.view, node('label', { for: 'problem-domain' }, ['领域', this.domain]),
      node('label', { for: 'problem-file' }, ['文件', this.file]), submit]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) { return; }
      submit.disabled = true;
      try { await this.read(0); } finally { submit.disabled = false; }
    });
    this.input.addEventListener('input', () => {
      this.generation++; this.path = null; this.next.disabled = true; this.summary.replaceChildren(); this.events.replaceChildren();
      this.selectFiles();
      this.status.textContent = '';
    });
    this.view = node('section', { 'aria-labelledby': 'problem-title' }, [
      node('h2', { id: 'problem-title' }, ['离线问题包']),
      node('p', { class: 'muted' }, ['查看公开 Schema、结构元数据与脱敏摘要；附件仅显示元数据。文件哈希证明内容一致性，导入未恢复认证，也未执行重放。']),
      form, this.status, this.summary, this.next, this.events,
    ]);
  }
  close() { this.closed = true; this.generation++; }
  selectFiles(kit, domain = '', file = '') {
    this.domain.replaceChildren(node('option', { value: '' }, ['桌面事件摘要']),
      ...(kit?.domains ?? []).map((item) => node('option', { value: item.domain }, [
        `${item.domain} · ${item.status} · ${item.count} 条`,
      ])));
    this.domain.value = domain; this.domain.disabled = !kit;
    const files = (kit?.files ?? []).filter((item) => item.domain === domain);
    this.file.replaceChildren(node('option', { value: '' }, ['领域内全部记录']),
      ...files.map((item) => node('option', { value: item.path }, [
        `${item.path} · ${item.representation === 'attachment' ? '附件仅元数据' : item.count + ' 条'}`,
      ])));
    this.file.value = file; this.file.disabled = !domain || !files.length;
  }
  showKitPage(page, kit) {
    this.cursor = page.nextCursor; this.next.disabled = !page.hasMore;
    this.status.textContent = `Kit ${page.domain} 游标 ${this.cursor} / ${page.count} · 哈希与 Schema 校验通过 · 未恢复认证 · 未执行重放`;
    this.events.replaceChildren(...page.records.map((item) => node('article', { class: 'debug-event problem-event' }, [
      node('strong', {}, [`#${item.index} · ${item.path} · ${item.representation}`]),
      node('p', {}, [item.record.payload?.summary ?? JSON.stringify(item.record.payload)]),
      details('记录依据', item.record),
    ])));
    if (!page.records.length) {
      const files = kit.files.filter((item) => item.domain === page.domain && (!page.file || page.file === item.path));
      this.events.append(empty('此选择暂无结构或摘要记录', files.some((item) => item.representation === 'attachment') ?
        '附件仅显示元数据；文件清单包含类型、来源和哈希，不读取或显示正文。' :
        `领域状态：${kit.domains.find((item) => item.domain === page.domain)?.status ?? 'not-captured'}。未采集不表示没有问题。`));
    }
  }
  async read(after) {
    const path = after ? this.path : this.input.value.trim(), token = ++this.generation;
    const domain = this.domain.value, file = this.file.value;
    this.next.disabled = true; this.events.replaceChildren(); this.summary.replaceChildren();
    this.status.textContent = '正在校验问题包…';
    try {
      const result = await request('tasks', { toolId: 'replay.show',
        input: { path, after, limit: 100, ...(domain ? { domain, ...(file ? { file } : {}) } : {}) },
        projectRoot: this.bootstrap.projectRoot, wait: true });
      if (this.closed || token !== this.generation) { return; }
      const receipt = result.data?.receipt;
      // Another major permits only a safe manifest. It cannot be paged.
      if (receipt?.exitCode === 3 && receipt.data?.compatibility === 'manifest-only') {
        this.path = null;
        this.status.textContent = '主版本不兼容：仅查看安全 manifest，内容哈希未校验。未恢复认证，未执行重放。';
        this.summary.replaceChildren(details('安全 manifest', receipt.data.manifest)); return;
      }
      if (receipt?.exitCode !== 0 || !receipt.data?.valid) {
        throw new Error(receipt?.data?.message ?? receipt?.data?.code ?? result.data?.state ?? '校验未完成');
      }
      const data = receipt.data;
      this.selectFiles(data.kit, domain, file);
      this.path = path; this.cursor = data.nextCursor;
      this.status.textContent = `离线游标 ${this.cursor} / ${data.through} · 哈希与 Schema 校验通过 · 未恢复认证 · 未执行重放`;
      this.summary.replaceChildren(
        ...(data.session?.history ? [node('p', {}, [`保留事件 ${data.count} 条 · 固定尾序号 ${data.through}`]),
          ...(data.session.history.gap ? [node('p', { class: 'notice' }, [
            `事件缺口：${data.session.history.gap.missingFrom}–${data.session.history.gap.missingThrough}（保留配额淘汰）。`,
          ])] : [])] : []),
        node('p', { class: 'notice' }, [`设备由对端声明 · 构建未验证 · ${
          data.clockEvidence || data.session?.clockEvidence ? '时钟测量已按逐条依据重算' : '时钟未校准'} · 仅领域摘要，未采集的通道不表示没有问题。`]),
        ...(data.ignoredFields ? [node('p', { class: 'notice' }, [
          `此 minor 含 ${data.ignoredFields} 个新字段。仅显示当前规范已知字段，新字段未展示或执行。`,
        ])] : []),
        details('构建、设备、脱敏与覆盖范围', data.session),
        details('文件清单与哈希', data.manifest),
        ...(data.kit ? [details('Kit 来源、采样、丢弃与缺失领域', data.kit)] : []));
      if (data.kitPage) { this.showKitPage(data.kitPage, data.kit); return; }
      this.next.disabled = !data.hasMore;
      this.events.replaceChildren(...data.events.map((event) => node('article', { class: 'debug-event problem-event' }, [
        node('strong', {}, [`#${event.sequence} · ${event.channel} · ${
          clockText(data.clockEvidence ? data.clockEvidence[event.sequence - data.clockEvidenceFrom] :
            data.session?.clockEvidence?.[event.sequence - (data.session?.history?.from ?? 1)])}`]),
        node('p', {}, [event.payload.summary ?? JSON.stringify(event.payload)]), details('事件依据', event),
      ])));
      if (!data.events.length) { this.events.append(empty('问题包暂无事件', '本截点没有领域事件；覆盖范围见上方会话信息。')); }
    } catch (error) {
      if (this.closed || token !== this.generation) { return; }
      this.path = null; this.events.replaceChildren(); this.summary.replaceChildren();
      this.selectFiles();
      this.status.textContent = `问题包读取未完成：${error.message}。核对文件路径与内容后可重试。`;
    }
  }
}
