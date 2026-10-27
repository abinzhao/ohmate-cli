/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const $ = (id) => document.getElementById(id);
export function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') { element.className = value; }
    else if (key.startsWith('on')) { element.addEventListener(key.slice(2), value); }
    else if (value !== undefined && value !== false) { element.setAttribute(key, value === true ? '' : value); }
  }
  for (const child of [].concat(children)) {
    if (child !== undefined && child !== null) { element.append(child instanceof Node ? child : document.createTextNode(String(child))); }
  }
  return element;
}
const iconPaths = {
  x: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  menu: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
  'layout-grid': [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1' }],
  ],
  'file-text': [
    ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6' }],
    ['path', { d: 'M8 13h8M8 17h8M8 9h2' }],
  ],
  cpu: [
    ['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2' }],
    ['path', { d: 'M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3M9 9h6v6H9z' }],
  ],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.37.37.7.6 1 .28.3.67.47 1.1.5h.1v4h-.1a1.7 1.7 0 0 0-1.7.5z' }],
  ],
  activity: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
  smartphone: [
    ['rect', { x: '5', y: '2', width: '14', height: '20', rx: '2' }],
    ['path', { d: 'M12 18h.01' }],
  ],
  'file-plus': [
    ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15h6' }],
  ],
  terminal: [
    ['path', { d: 'm4 17 6-5-6-5M12 19h8' }],
  ],
  layers: [
    ['path', { d: 'm12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5' }],
  ],
  'arrow-up': [['path', { d: 'm5 12 7-7 7 7M12 19V5' }]],
  search: [
    ['circle', { cx: '11', cy: '11', r: '8' }],
    ['path', { d: 'm21 21-4.35-4.35' }],
  ],
  folder: [
    ['path', { d: 'M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  ],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  check: [['path', { d: 'm5 12 4 4L19 6' }]],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 7v5l3 2' }],
  ],
  'alert-triangle': [
    ['path', { d: 'M10.3 3.7 2.4 18a2 2 0 0 0 1.75 3h15.7a2 2 0 0 0 1.75-3L13.7 3.7a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01' }],
  ],
  download: [['path', { d: 'M12 3v12M7 10l5 5 5-5M5 21h14' }]],
  refresh: [['path', { d: 'M20 6v5h-5M4 18v-5h5M18.5 9a7 7 0 0 0-12-2.5L4 11M5.5 15a7 7 0 0 0 12 2.5L20 13' }]],
};
export function icon(name, size = 18) {
  const paths = iconPaths[name];
  if (!paths) { throw new Error(`Unknown icon: ${name}`); }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attributes = {
    viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  };
  for (const [key, value] of Object.entries(attributes)) { svg.setAttribute(key, value); }
  for (const [tag, values] of paths) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(values)) { child.setAttribute(key, value); }
    svg.append(child);
  }
  return svg;
}
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((slot) => {
    slot.replaceChildren(icon(slot.dataset.icon, Number(slot.dataset.iconSize ?? 18)));
  });
}
export const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function clockText(clock) {
  const measured = clock?.alignment;
  if (measured?.status === 'calibrated') {
    return `往返测量 · ±${Number(measured.uncertaintyNs) / 1000000} ms（漂移上限假设）`;
  }
  const states = { 'not-calibrated': '未校准', 'clock-changed': '时钟已变化', 'before-sample': '采样早于校准',
    expired: '校准已过期', drift: '时钟漂移', 'over-budget': '误差超预算' };
  return `${states[measured?.status] ?? '未校准'} · 分段`;
}
export const pre = (value) => node('pre', {}, [text(value)]);
export function button(label, action, style = 'btn') {
  return node('button', { type: 'button', class: style, onclick: guarded(action) }, [label]);
}
export function iconButton(label, name, action, style = 'icon-btn') {
  return node('button', { type: 'button', class: style, 'aria-label': label, title: label, onclick: guarded(action) }, [icon(name)]);
}
export function statusBadge(label, tone = 'neutral') {
  return node('span', { class: `status-badge ${tone}` }, [label]);
}
export function guarded(action) {
  return async (event) => {
    const target = event?.currentTarget;
    if (target?.disabled) { return; }
    const focused = target instanceof HTMLButtonElement && document.activeElement === target;
    if (target instanceof HTMLButtonElement) {
      target.disabled = true; target.setAttribute('aria-busy', 'true');
    }
    try { await action(event); }
    catch (error) { toast(error.message, 'error'); }
    finally {
      if (target instanceof HTMLButtonElement) {
        target.disabled = false; target.removeAttribute('aria-busy');
        if (focused && target.isConnected && document.activeElement === document.body) {
          target.focus({ preventScroll: true });
        }
      }
    }
  };
}
export function toast(message, tone = 'status') {
  const root = tone === 'error' ? $('alert-root') : $('toast-root');
  clearTimeout(toast.timer);
  if (tone === 'error') {
    root.replaceChildren(node('div', { class: 'toast error' }, [
      node('span', {}, [message]),
      button('关闭', () => root.replaceChildren(), 'toast-close'),
    ]));
    return;
  }
  root.replaceChildren(node('div', { class: `toast ${tone}` }, [message]));
  toast.timer = setTimeout(() => root.replaceChildren(), 6000);
}
export function details(title, value) {
  return node('details', { class: 'details' }, [node('summary', {}, [title]), pre(value)]);
}
let dialogTrigger;
export function modal(title, content, actions = [], options = {}) {
  const dialog = $('dialog');
  if (dialog.open) { dialog.close(); }
  dialogTrigger = document.activeElement;
  dialog.className = options.kind ? `modal ${options.kind}` : 'modal';
  dialog.replaceChildren(
    node('div', { class: 'modal-head' }, [
      node('h2', { id: 'dialog-title' }, [title]),
      iconButton(`关闭${title}`, 'x', () => dialog.close()),
    ]),
    node('div', { class: 'modal-body' }, [].concat(content)),
    ...(actions.length ? [node('div', { class: 'modal-actions' }, actions)] : []),
  );
  dialog.addEventListener('close', () => {
    if (dialogTrigger instanceof HTMLElement && dialogTrigger.isConnected) { dialogTrigger.focus(); }
  }, { once: true });
  dialog.showModal();
  return dialog;
}
let openPopover;
export function closePopover() {
  if (!openPopover) { return; }
  if (typeof openPopover.hidePopover === 'function' && openPopover.matches(':popover-open')) {
    openPopover.hidePopover();
  }
  openPopover.remove(); openPopover = undefined;
}
export function popover(anchor, content, options = {}) {
  closePopover();
  const panel = node('div', {
    id: 'floating-popover', class: `popover-surface ${options.className ?? ''}`.trim(),
    popover: 'auto', role: options.role ?? 'dialog', 'aria-label': options.label ?? '选项',
  }, [].concat(content));
  document.body.append(panel); openPopover = panel;
  if (typeof panel.showPopover !== 'function') {
    panel.remove(); openPopover = undefined;
    return modal(options.label ?? '选项', content, [], { kind: 'compact' });
  }
  const position = () => {
    const anchorBox = anchor.getBoundingClientRect(), panelBox = panel.getBoundingClientRect();
    const left = Math.min(Math.max(12, anchorBox.right - panelBox.width), innerWidth - panelBox.width - 12);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(12, anchorBox.top - panelBox.height - 8)}px`;
  };
  panel.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') { panel.remove(); if (openPopover === panel) { openPopover = undefined; } }
  });
  panel.showPopover(); requestAnimationFrame(position);
  panel.querySelector('button,input,select,textarea')?.focus();
  return panel;
}
export function field(label, name, options = {}) {
  const input = node(options.multiline ? 'textarea' : options.choices ? 'select' : 'input', {
    id: name, name, ...(options.multiline ? { rows: '4' } : { type: 'text' }),
    required: options.required ?? false, maxlength: options.maxlength ?? 1024,
    ...(options.type ? { type: options.type } : {}),
  });
  if (options.choices) { input.replaceChildren(...options.choices.map((value) => node('option', { value }, [value]))); }
  if (options.value !== undefined) { input.value = options.value; }
  const hintId = options.hint ? `${name}-hint` : undefined;
  if (hintId) { input.setAttribute('aria-describedby', hintId); }
  return { input, view: node('div', { class: 'field' }, [
    node('label', { for: name }, [label]), input, options.hint ? node('small', { id: hintId }, [options.hint]) : null,
  ]) };
}
export function empty(title, copy, action) {
  return node('div', { class: 'empty-state' }, [node('h3', {}, [title]), node('p', {}, [copy]), action]);
}
export function setDrawerState({ body, sidebar, main, backdrop, trigger, skip }, open, compact = true) {
  body.classList.toggle('sidebar-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  main.inert = open;
  if (open) { main.setAttribute('aria-hidden', 'true'); } else { main.removeAttribute('aria-hidden'); }
  skip.inert = open;
  if (open) { skip.setAttribute('aria-hidden', 'true'); } else { skip.removeAttribute('aria-hidden'); }
  backdrop.hidden = !open;
  if (compact) {
    sidebar.setAttribute('aria-hidden', String(!open));
    if (open) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
    } else {
      sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal');
    }
  } else {
    sidebar.removeAttribute('aria-hidden'); sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal');
  }
}
export function trapFocus(event, region) {
  if (event.key !== 'Tab') { return; }
  const controls = [...region.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
    .filter((item) => !item.hidden && item.getAttribute('aria-hidden') !== 'true');
  if (!controls.length) { event.preventDefault(); return; }
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
