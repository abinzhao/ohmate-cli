/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { request } from './api.js';
import { node, empty, details, clockText } from './view.js';

export class InspectorView {
  generation = 0;
  closed = false;
  catalog = null;
  through = null;
  hash = null;
  cursor = 0;
  constructor() {
    this.open = node('button', { type: 'button', class: 'btn', disabled: true, onclick: () => this.reload() }, ['查看通道摘要']);
    this.channel = node('select', { id: 'inspector-channel', disabled: true, onchange: () => this.reload() });
    this.status = node('p', { class: 'inspector-status', role: 'status', 'aria-live': 'polite' });
    this.evidence = node('div');
    this.rows = node('div');
    this.next = node('button', { id: 'inspector-next', type: 'button', class: 'btn', disabled: true,
      onclick: () => { if (!this.next.disabled) { this.page(this.cursor, ++this.generation); } } }, ['下一页通道记录']);
    this.refresh = node('button', { type: 'button', class: 'btn', onclick: () => this.reload() }, ['刷新通道截点']);
    this.panel = node('div', { hidden: true }, [
      node('div', { class: 'field' }, [node('label', { for: 'inspector-channel' }, ['查看通道']), this.channel]),
      node('div', { class: 'task-actions' }, [this.refresh, this.next]), this.status, this.evidence, this.rows,
    ]);
    this.view = node('section', { class: 'debug-inspector', 'aria-labelledby': 'inspector-title' }, [
      node('h2', { id: 'inspector-title' }, ['通道摘要']),
      node('p', { class: 'muted' }, ['按通道查看已保存记录与采集范围。每页最多 100 条；刷新后读取新的提交截点。']),
      this.open, this.panel,
    ]);
  }
  close() { this.closed = true; this.generation++; }
  choose(session, stream) {
    this.generation++; this.session = session; this.stream = stream;
    this.through = null; this.hash = null; this.cursor = 0;
    this.open.disabled = !session || stream?.integrity !== 'verified';
    this.panel.hidden = true; this.next.disabled = true; this.status.textContent = '';
    this.rows.replaceChildren(); this.evidence.replaceChildren();
  }
  current(token) { return !this.closed && token === this.generation; }
  async reload() {
    if (this.closed || this.open.disabled) { return; }
    const token = ++this.generation;
    this.panel.hidden = false; this.next.disabled = true;
    this.through = null; this.hash = null; this.rows.replaceChildren(); this.evidence.replaceChildren();
    this.status.textContent = '正在读取通道与提交截点…';
    try {
      const catalog = this.catalog ?? await request('debug/inspectors');
      if (!this.current(token)) { return; }
      if (!this.catalog) {
        this.catalog = catalog;
        this.channel.replaceChildren(...catalog.inspectors.map((item) => node('option', { value: item.channel }, [item.title])));
        this.channel.value = catalog.inspectors.some((item) => item.channel === 'hidebug') ? 'hidebug' : catalog.inspectors[0]?.channel;
        this.channel.disabled = false;
      }
      await this.page(0, token);
    } catch (error) { this.failed(error, token); }
  }
  failed(error, token) {
    if (!this.current(token)) { return; }
    this.rows.replaceChildren(); this.evidence.replaceChildren(); this.next.disabled = true;
    this.status.textContent = `读取未完成：${error.message}。可刷新通道截点后重试。`;
  }
  async page(after, token) {
    this.next.disabled = true; this.status.textContent = '正在校验并读取通道摘要…';
    const channel = this.channel.value, cut = this.through === null ? '' : `&through=${this.through}`;
    try {
      const page = await request(`debug/sessions/${this.session.id}/streams/${this.stream.streamId}/inspect/${channel}?after=${after}&limit=100${cut}`);
      if (!this.current(token)) { return; }
      if (page.inspector.channel !== channel || (this.through !== null &&
        (page.through !== this.through || page.snapshotHash !== this.hash))) { throw new Error('通道或提交截点已变化'); }
      this.through = page.through; this.hash = page.snapshotHash; this.cursor = page.nextCursor;
      this.next.disabled = !page.hasMore; this.render(page);
    } catch (error) { this.failed(error, token); }
  }
  render(page) {
    const info = page.inspector, reference = info.reference;
    this.status.textContent = `${page.availability === 'recorded' ? `本通道 ${page.count} 条 · 本页 ${page.events.length} 条` :
      page.availability === 'not-negotiated' ? '本通道未协商采集' : '本通道未采集'} · 游标 ${page.nextCursor} / 截点 ${page.through}`;
    this.evidence.replaceChildren(
      node('p', { class: 'notice' }, [`摘要覆盖 · 对端上报，设备与构建未验证 · ${
        page.clockCalibration === 'per-record' ? '时钟测量见逐条记录' : '时钟未校准'} · 采样率未知。`]),
      node('p', { class: 'muted' }, [`未采集：${info.unavailableFields.join('、')}`]),
      node('p', { class: 'muted' }, [`${reference.kind === 'protocol' ? '协议来源' : '接口参考'}：${reference.module ?? reference.name} ${reference.symbols?.join('、') ?? ''}。参考不证明本次调用。`]),
      ...(info.officialTool ? [node('p', { class: 'muted' }, [`完整检查使用 ${info.officialTool}；当前未关联官方采集端点。`])] : []),
    );
    this.rows.replaceChildren(...page.events.map((record) => node('article', { class: 'inspector-event debug-event' }, [
      node('strong', {}, [`#${record.index} · ${info.title} · 时钟段 ${record.clock.segment} · ${clockText(record.clock)}`]),
      node('p', {}, [record.event.payload.summary ?? JSON.stringify(record.event.payload)]),
      details('已提交摘要依据', record),
    ])));
    if (!page.events.length) { this.rows.append(empty('暂无通道记录', '当前提交截点内没有此通道的已保存数据。')); }
  }
}
