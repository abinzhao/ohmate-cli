/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { request } from './api.js';
import { $, node, button, empty, details, clockText } from './view.js';
import { ProblemView } from './problem.js';
import { InspectorView } from './inspector.js';
import { closeResult } from './tasks.js';

const states = { 'waiting-pairing': '未配对', pairing: '等待设备确认', connected: '已配对', disconnected: '已断开',
  revoked: '已撤销', expired: '配对已过期', degraded: '连接降级', unavailable: '采集不可用' };
let active;
export function stopDebugView() { active?.close(); active = undefined; }
function value(receipt) {
  if (receipt.exitCode !== 0) { throw new Error(receipt.data?.message ?? receipt.data?.code ?? '调试记录读取失败'); }
  return receipt.data;
}
function retentionRange(data) {
  const { retainedFrom: from, retainedCount: count, through } = data;
  if (![from, count, through].every(Number.isSafeInteger) || from < 1 || count < 0 || count > 4096 ||
    through < 0 || from - 1 + count !== through) { throw new Error('保留窗口无效'); }
  return { retainedFrom: from, retainedCount: count, through };
}
function gapCursor(gap, range, after) {
  if (![gap.missingFrom, gap.missingThrough].every(Number.isSafeInteger) || gap.missingFrom < 1 ||
    gap.missingFrom > gap.missingThrough || gap.missingThrough !== range.retainedFrom - 1 ||
    gap.reason !== 'retention-quota') { throw new Error('事件缺口无效'); }
  if (gap.missingThrough <= after) { return after; }
  if (gap.missingFrom !== after + 1) { throw new Error('事件缺口不连续'); }
  return gap.missingThrough;
}
function streamCount(stream) {
  return 'retainedCount' in stream ? `保留 ${stream.retainedCount} 条 · 尾序号 ${stream.through}` : `${stream.through} 条`;
}
class DebugView {
  generation = 0;
  indexGeneration = 0;
  closed = false;
  source = null;
  renderFrame = null;
  renderedThrough = 0;
  sessions = [];
  session = null;
  streams = [];
  stream = null;
  streamsCursor = null;
  rows = [];
  cursor = 0;
  more = false;
  constructor(bootstrap, openTask) {
    this.bootstrap = bootstrap;
    this.problem = new ProblemView(bootstrap);
    this.inspector = new InspectorView();
    this.export = node('button', { type: 'button', class: 'btn', disabled: true, onclick: async () => {
      if (this.export.disabled || !openTask) { return; }
      this.export.disabled = true;
      const token = this.generation;
      try {
        const result = await request('tasks', { toolId: 'debug.problem.export',
          input: { id: this.session.id, stream: this.stream.streamId, through: this.stream.through },
          projectRoot: this.bootstrap.projectRoot });
        if (!this.closed && token === this.generation) { await openTask(result.data); }
      } catch (error) { if (!this.closed && token === this.generation) { this.failed(error); } }
      finally { if (!this.closed && token === this.generation) { this.export.disabled = false; } }
    } }, ['导出选定事件流']);
    this.openTask = openTask;
    this.select = node('select', { id: 'debug-session', onchange: () => this.choose(this.select.value).catch((error) => this.failed(error)) });
    this.streamSelect = node('select', { id: 'debug-stream', disabled: true,
      onchange: () => this.chooseStream(this.streamSelect.value) });
    this.moreStreams = node('button', { type: 'button', class: 'btn', disabled: true, onclick: async () => {
      if (this.moreStreams.disabled) { return; }
      this.moreStreams.disabled = true;
      await this.loadStreams(this.streamsCursor);
    } }, ['更多事件流']);
    this.summary = node('div', { class: 'debug-summary' });
    this.counter = node('p', { class: 'muted' });
    this.message = node('p', { class: 'debug-stream-status', role: 'status', 'aria-live': 'polite' });
    this.retentionNotice = node('p', { class: 'notice', hidden: true, role: 'status' });
    this.events = node('div', { class: 'debug-event-list' });
    this.next = node('button', { type: 'button', class: 'btn', onclick: async () => {
      if (this.next.disabled) { return; }
      this.next.disabled = true; await this.page(this.cursor);
    } }, ['下一页']);
    this.follow = button('跟随新事件', () => this.toggleStream());
    this.overviewSection = node('section', { class: 'debug-section', 'data-debug-section': '概览' }, [
      node('p', { class: 'notice' }, ['只读 · 设备与构建尚未验证。真实 Kit 采集尚未验证；页面与 UI 文本仅保留元数据。']),
      node('div', { class: 'field' }, [node('label', { for: 'debug-session' }, ['调试会话']), this.select]),
      this.summary,
    ]);
    this.eventsSection = node('section', { class: 'debug-section', 'data-debug-section': '事件', 'aria-labelledby': 'debug-events-title', hidden: true }, [
      node('h2', { id: 'debug-events-title' }, ['已保存事件']),
      node('p', { class: 'muted' }, ['选择本会话的事件流。事件每页 100 条，实时跟随最多保留最近 100 条。']),
      node('div', { class: 'field' }, [node('label', { for: 'debug-stream' }, ['事件流']), this.streamSelect]),
      this.moreStreams,
      node('div', { class: 'task-actions' }, [this.next, this.follow, this.export]), this.message, this.retentionNotice, this.events,
    ]);
    this.inspector.view.className = 'debug-section';
    if (this.inspector.view.setAttribute) { this.inspector.view.setAttribute('data-debug-section', '检查器'); }
    else { this.inspector.view.dataset = { debugSection: '检查器' }; }
    this.inspector.view.hidden = true;
    this.problem.view.className = 'debug-section';
    if (this.problem.view.setAttribute) { this.problem.view.setAttribute('data-debug-section', '离线问题包'); }
    else { this.problem.view.dataset = { debugSection: '离线问题包' }; }
    this.problem.view.hidden = true;
    this.sections = [this.overviewSection, this.eventsSection, this.inspector.view, this.problem.view];
    const sectionNames = ['概览', '事件', '检查器', '离线问题包'];
    this.sectionNames = sectionNames;
    this.sections.forEach((section, index) => {
      section.id = `debug-section-${index}`;
      if (typeof section.setAttribute === 'function') { section.setAttribute('role', 'tabpanel'); }
    });
    this.sectionNav = node('div', { class: 'debug-section-nav', role: 'tablist', 'aria-label': '调试工作区视图' },
      sectionNames.map((name, index) => {
        const item = button(name, () => this.showSection(name), `debug-section-tab ${name === '概览' ? 'active' : ''}`);
        item.id = `debug-tab-${index}`; item.tabIndex = name === '概览' ? 0 : -1;
        if (typeof item.setAttribute === 'function') {
          item.setAttribute('data-debug-tab', name); item.setAttribute('role', 'tab');
          item.setAttribute('aria-selected', String(name === '概览'));
          item.setAttribute('aria-controls', `debug-section-${index}`);
        } else { item.dataset = { debugTab: name }; }
        return item;
      }));
    if (typeof this.sectionNav.addEventListener === 'function') {
      this.sectionNav.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
        const items = [...this.sectionNav.children], index = items.indexOf(document.activeElement);
        if (index < 0) { return; }
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? (index + 1) % items.length :
            (index - 1 + items.length) % items.length;
        event.preventDefault(); items[next].focus(); this.showSection(sectionNames[next]);
      });
    }
    this.view = node('div', { class: 'collection debug-workbench' }, [
      node('div', { class: 'collection-header' }, [
        node('div', {}, [node('h1', {}, ['调试工作区']), node('p', { class: 'collection-intro' }, ['查看当前应用的会话、事件、检查器和离线问题包。'])]),
        node('div', { class: 'task-actions' }, [button('返回应用', () => { location.hash = 'apps'; }), button('刷新状态', () => this.refresh())]),
      ]),
      this.sectionNav, ...this.sections,
    ]);
  }
  showSection(name) {
    this.sections.forEach((section) => { section.hidden = section.dataset.debugSection !== name; });
    [...this.sectionNav.children].forEach((item, index) => {
      const selected = item.dataset.debugTab === name;
      if (item.classList?.toggle) { item.classList.toggle('active', selected); }
      if (typeof item.setAttribute === 'function') { item.setAttribute('aria-selected', String(selected)); }
      item.tabIndex = selected ? 0 : -1;
      if (selected && typeof this.sections[index].setAttribute === 'function') {
        this.sections[index].setAttribute('aria-labelledby', item.id);
      }
    });
  }
  close() { this.finishRender(); this.closed = true; this.generation++; this.indexGeneration++; this.source?.close(); this.source = null; this.problem.close(); this.inspector.close(); }
  failed(error) {
    if (this.closed) { return; }
    this.finishRender(true);
    this.source?.close(); this.source = null; this.follow.textContent = '跟随新事件';
    this.message.textContent = `读取未完成：${error.message}。可刷新状态后重试。`;
  }
  async refresh() {
    this.finishRender();
    this.generation++; this.indexGeneration++; this.source?.close(); this.source = null;
    const token = this.generation;
    this.message.textContent = '正在读取本地调试会话…';
    try {
      const status = value(await request('debug/status')), all = value(await request('debug/sessions'));
      if (this.closed || token !== this.generation) { return; }
      this.sessions = all.filter((item) => item.cwd === this.bootstrap.cwd && item.projectRoot === this.bootstrap.projectRoot);
      this.select.replaceChildren(...this.sessions.map((item) => node('option', { value: item.id },
        [`${new Date(item.startedAt).toLocaleString('zh-CN')} · ${item.state === 'stopped' ? '已停止' : item.state === 'disconnected' ? '服务断开' : '运行中'} · ${item.id.slice(0, 8)}`])));
      this.select.disabled = !this.sessions.length;
      await this.choose(this.session?.id ?? status.debugSession?.id ?? this.sessions[0]?.id);
    } catch (error) { this.failed(error); }
  }
  async choose(id) {
    this.finishRender();
    this.generation++; this.indexGeneration++; this.source?.close(); this.source = null;
    const previous = this.session?.id === id ? this.stream?.streamId : null;
    this.session = this.sessions.find((item) => item.id === id) ?? this.sessions[0] ?? null;
    this.streams = []; this.stream = null; this.streamsCursor = null;
    this.retentionNotice.hidden = true; this.retentionNotice.textContent = '';
    this.inspector.choose(this.session, null);
    this.streamSelect.replaceChildren(); this.streamSelect.disabled = true; this.moreStreams.disabled = true;
    this.rows = []; this.cursor = 0; this.more = false; this.follow.textContent = '跟随新事件';
    this.next.disabled = true; this.follow.disabled = true; this.events.replaceChildren();
    this.export.disabled = true;
    if (!this.session) {
      this.summary.replaceChildren(empty('暂无调试会话', '在终端运行 ohmatecli debug start，再刷新状态。'));
      this.message.textContent = ''; return;
    }
    this.select.value = this.session.id;
    const bridge = this.session.bridge, target = this.session.target;
    this.count(bridge.ackThrough ?? 0);
    this.summary.replaceChildren(...[
      node('h3', {}, [`${states[bridge.state] ?? bridge.state}${this.session.state === 'stopped' ? ' · 服务已停止' : ''}`]),
      this.counter,
      target ? details('设备、构建与会话身份', target) : node('p', { class: 'muted' }, ['尚无设备身份。请在交互终端使用 ohmatecli debug pair --help 获取配对方式。']),
      bridge.reason ? node('p', { class: 'muted' }, [`连接原因：${bridge.reason}`]) : null,
      bridge.gap ? node('p', { class: 'notice' }, [`事件缺口：${bridge.gap.missingFrom}–${bridge.gap.missingThrough}，未计为已保存事件。`]) : null,
    ].filter(Boolean));
    await this.loadStreams(null, previous ?? bridge.streamId);
  }
  async loadStreams(after, preferred) {
    const token = this.indexGeneration, selection = this.generation;
    this.message.textContent = '正在校验历史事件流…';
    try {
      const page = await request(`debug/sessions/${this.session.id}/streams?limit=20${after ? `&after=${after}` : ''}`);
      if (this.closed || token !== this.indexGeneration) { return; }
      this.streams = [...new Map([...this.streams, ...page.streams].map((item) => [item.streamId, item])).values()];
      this.streamsCursor = page.nextCursor;
      this.moreStreams.disabled = !page.hasMore;
      this.streamSelect.replaceChildren(...this.streams.map((item) => node('option', { value: item.streamId }, [
        `${item.streamId.slice(0, 8)} · ${item.integrity === 'verified' ? `${streamCount(item)}${item.active ? ' · 采集中' : ' · 历史'}` : '校验失败'}`,
      ])));
      this.streamSelect.disabled = !this.streams.length;
      if (selection === this.generation && preferred && !this.streams.some((item) => item.streamId === preferred) && page.hasMore) {
        this.moreStreams.disabled = true; await this.loadStreams(this.streamsCursor, preferred); return;
      }
      if (selection === this.generation && (!after || preferred)) { await this.chooseStream(preferred ?? this.streams.find((item) => item.active)?.streamId); }
      else {
        this.streamSelect.value = this.stream?.streamId ?? '';
        if (selection === this.generation) { this.message.textContent = `已列出 ${this.streams.length} 个事件流`; }
      }
    } catch (error) { if (token === this.indexGeneration) { this.failed(error); } }
  }
  async chooseStream(id) {
    this.finishRender();
    this.generation++; this.source?.close(); this.source = null;
    this.stream = this.streams.find((item) => item.streamId === id) ?? this.streams[0] ?? null;
    this.retentionNotice.hidden = true; this.retentionNotice.textContent = '';
    this.inspector.choose(this.session, this.stream);
    this.rows = []; this.cursor = 0; this.more = false; this.follow.textContent = '跟随新事件';
    this.next.disabled = true; this.follow.disabled = true; this.events.replaceChildren();
    this.export.disabled = true;
    if (!this.stream) {
      this.events.replaceChildren(empty('暂无已保存事件', '设备完成配对并发送事件后，可在这里查看已校验的脱敏记录。'));
      this.message.textContent = ''; return;
    }
    this.streamSelect.value = this.stream.streamId;
    if (this.stream.integrity !== 'verified') {
      this.count(0);
      this.events.replaceChildren(empty('事件流校验失败', '档案可能损坏或未完成提交。可选择其它事件流；原档案保留。'));
      this.message.textContent = `未读取未校验记录：${this.stream.code}`; return;
    }
    await this.page(0);
  }
  count(through) {
    const rolling = this.stream && 'retainedCount' in this.stream;
    this.counter.textContent = `构建未验证 · 设备信息由对端声明 · ${rolling ?
      `保留事件 ${this.stream.retainedCount} 条 · 已提交尾序号 ${through}` : `已提交事件 ${through} 条`}`;
    if (this.stream?.integrity === 'verified') {
      this.stream.through = through;
      this.export.disabled = !this.openTask;
      const option = this.streamSelect.selectedOptions[0];
      if (option?.value === this.stream.streamId) {
        option.textContent = `${this.stream.streamId.slice(0, 8)} · ${streamCount(this.stream)}${this.stream.active ? ' · 采集中' : ' · 历史'}`;
      }
    }
  }
  retain(range) {
    Object.assign(this.stream, range);
    if (this.rows.some((record) => record.index > this.renderedThrough && record.index < range.retainedFrom)) {
      this.finishRender(true);
    }
    this.rows = this.rows.filter((record) => record.index >= range.retainedFrom);
    if (range.retainedFrom > 1) {
      this.retentionNotice.textContent = `事件缺口：1–${range.retainedFrom - 1}（保留配额淘汰）。当前档案不包含这些事件。`;
      this.retentionNotice.hidden = false;
    }
  }
  path() { return `debug/sessions/${this.session.id}/streams/${this.stream.streamId}`; }
  async page(after) {
    const token = this.generation;
    this.finishRender();
    this.source?.close(); this.source = null; this.follow.textContent = '跟随新事件';
    this.message.textContent = '正在校验并读取事件…';
    try {
      const page = await request(`${this.path()}/events?after=${after}&limit=100`);
      if (this.closed || token !== this.generation) { return; }
      if ('retainedFrom' in page) {
        const range = retentionRange(page);
        let cursor = page.gap ? gapCursor(page.gap, range, after) : after;
        if (cursor < range.retainedFrom - 1) { throw new Error('事件缺口未声明'); }
        for (const record of page.events) {
          if (!Number.isSafeInteger(record.index) || record.index !== cursor + 1 || record.index > range.through) {
            throw new Error('事件序列不连续');
          }
          cursor = record.index;
        }
        if (page.nextCursor !== cursor || page.hasMore !== (cursor < range.through)) { throw new Error('事件分页游标无效'); }
        this.retain(range);
      }
      this.rows = page.events; this.cursor = page.nextCursor; this.more = page.hasMore;
      this.count(page.through);
      this.next.disabled = !page.hasMore;
      this.follow.disabled = !this.stream.active;
      this.message.textContent = `已读取 ${this.rows.length} 条 · 游标 ${this.cursor} / ${page.through} · 日志校验通过`;
      this.renderEvents();
    } catch (error) { if (token === this.generation) { this.failed(error); } }
  }
  renderEvents() {
    this.events.replaceChildren(...this.rows.map((record) => node('article', { class: 'debug-event' }, [
      node('div', { class: 'debug-event-heading' }, [node('strong', {}, [`#${record.index} · ${record.event.channel}`]),
        node('span', { class: 'muted' }, [`时钟段 ${record.clock.segment} · ${clockText(record.clock)}`])]),
      node('p', {}, [record.event.payload.summary ?? JSON.stringify(record.event.payload)]),
      details('事件依据', record),
    ])));
    if (!this.rows.length) { this.events.append(empty('暂无已保存事件', '事件提交到本地日志后才会出现在这里。')); }
    this.renderedThrough = this.rows.at(-1)?.index ?? 0;
  }
  renderLive() {
    this.renderEvents(); this.count('retainedCount' in this.stream ? this.stream.through : this.cursor);
    this.message.textContent = `实时跟随 · 已保存游标 ${this.cursor} · 显示最近 ${this.rows.length} 条`;
  }
  finishRender(flush = false) {
    if (this.renderFrame === null) { return; }
    cancelAnimationFrame(this.renderFrame); this.renderFrame = null;
    if (flush) { this.renderLive(); }
  }
  scheduleRender() {
    if (this.renderFrame !== null) { return; }
    const token = this.generation, source = this.source;
    const frame = requestAnimationFrame(() => {
      if (this.closed || token !== this.generation || source !== this.source || this.renderFrame !== frame) { return; }
      this.renderFrame = null; this.renderLive();
    });
    this.renderFrame = frame;
  }
  toggleStream() {
    if (this.source) {
      this.finishRender(true);
      this.source.close(); this.source = null; this.follow.textContent = '跟随新事件';
      this.message.textContent = '已暂停实时跟随，已保存事件仍可分页读取。'; return;
    }
    const source = new EventSource(`/api/v1/${this.path()}/live?after=${this.cursor}&limit=100`), token = this.generation;
    this.source = source; this.follow.textContent = '暂停跟随'; this.next.disabled = true;
    this.message.textContent = '正在跟随新事件…';
    source.onmessage = (message) => {
      if (this.closed || token !== this.generation || source !== this.source) { return; }
      try {
        const record = JSON.parse(message.data);
        if (!Number.isSafeInteger(record.index) || record.index < 1) { throw new Error('事件序列无效'); }
        if (record.index <= this.cursor) { return; }
        if (record.index !== this.cursor + 1) { throw new Error('事件序列不连续'); }
        if ('retainedCount' in this.stream && (record.index < this.stream.retainedFrom || record.index > this.stream.through)) {
          throw new Error('事件超出保留窗口');
        }
        // Flush accepted rows before the bounded suffix can evict an unseen event.
        if (this.rows.length === 100 && this.rows[0].index > this.renderedThrough) { this.finishRender(true); }
        this.cursor = record.index; this.rows = [...this.rows, record].slice(-100);
        if (!('retainedCount' in this.stream)) { this.stream.through = this.cursor; }
        this.scheduleRender();
      } catch (error) { this.failed(error); }
    };
    source.addEventListener('retention', (message) => {
      if (this.closed || token !== this.generation || source !== this.source) { return; }
      try {
        const range = retentionRange(JSON.parse(message.data));
        if (range.through < this.cursor) { throw new Error('保留窗口已回退'); }
        this.retain(range); this.scheduleRender();
      } catch (error) { this.failed(error); }
    });
    source.addEventListener('gap', (message) => {
      if (this.closed || token !== this.generation || source !== this.source) { return; }
      try {
        const gap = JSON.parse(message.data), range = retentionRange(gap);
        if (message.lastEventId !== String(gap.missingThrough)) { throw new Error('事件缺口游标无效'); }
        const cursor = gapCursor(gap, range, this.cursor);
        if (cursor === this.cursor) { return; }
        this.finishRender(true);
        this.retain(range); this.cursor = cursor; this.rows = []; this.scheduleRender();
      } catch (error) { this.failed(error); }
    });
    source.addEventListener('end', () => {
      if (source !== this.source) { return; }
      this.finishRender(true);
      source.close(); this.source = null; this.follow.disabled = true;
      this.follow.textContent = '跟随新事件'; this.message.textContent = '事件流已结束，可刷新状态或查看历史记录。';
    });
    source.addEventListener('fault', (message) => { if (source === this.source) { this.failed(new Error(JSON.parse(message.data).code)); } });
    source.onerror = () => { if (source === this.source) { this.failed(new Error('连接中断或认证过期')); } };
  }
}
export async function debugView(bootstrap, openTask) {
  stopDebugView(); const view = new DebugView(bootstrap, openTask); active = view;
  $('page-title').textContent = '调试工作区'; $('page-context').textContent = '当前应用的会话与证据';
  $('composer-dock').hidden = true; closeResult(false);
  $('canvas').replaceChildren(view.view); await view.refresh();
}
