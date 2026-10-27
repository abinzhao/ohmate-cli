/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

class Element {
  value = ''; textContent = ''; disabled = false;
  children: (Element | string)[];
  listeners = new Map<string, () => Promise<void>>();
  constructor(_tag: string, attributes = {}, children: (Element | string)[] = []) { Object.assign(this, attributes); this.children = children; }
  addEventListener(event: string, handler: () => Promise<void>) { this.listeners.set(event, handler); }
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  text(): string { return this.textContent + this.children.map((child) => typeof child === 'string' ? child : child.text()).join(' '); }
}
const kit = { provenance: 'peer-reported', attachmentPolicy: 'user-reviewed',
  domains: [{ domain: 'memory', status: 'summary-only', count: 2 }, { domain: 'ui', status: 'not-captured', count: 0 },
    { domain: 'faultlog', status: 'captured', count: 1 }],
  files: [{ domain: 'memory', path: 'memory-clues.jsonl', representation: 'domain-summary', source: {
    kind: 'platform-api', api: 'hidebug.getPss', provenance: 'peer-reported' }, count: 2, dropped: 3, sampled: true },
    { domain: 'faultlog', path: 'faultlog/fault.txt', representation: 'attachment', count: 1 }],
};
async function viewWith(request: ReturnType<typeof vi.fn>) {
  const source = await readFile(new URL('../../../../apps/web/problem.js', import.meta.url), 'utf8');
  const node = (tag: string, attributes = {}, children: (Element | string)[] = []) => new Element(tag, attributes, children);
  const Constructor = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nProblemView;', {
    request, node, clockText: () => 'clock', field: () => ({ input: node('input'), view: node('div') }),
    empty: (title: string, detail: string) => node('div', {}, [title, detail]),
    details: (title: string, value: unknown) => node('details', {}, [title, JSON.stringify(value)]),
  });
  const view = new Constructor({}); view.input.value = 'sample.ohmate-problem.zip';
  return view;
}
const receipt = (data: object) => ({ data: { receipt: { exitCode: 0, data: { valid: true, manifest: {}, session: {},
  kit, count: 1, events: [], nextCursor: 1, through: 1, hasMore: false, ...data } } } });

it('offers actual Kit domains and files, renders bounded pages and advances the Kit cursor', async () => {
  const request = vi.fn().mockImplementation((_path, value) => Promise.resolve(value.input.domain ? receipt({
    kitPage: { domain: 'memory', count: 2, nextCursor: value.input.after + 1, hasMore: !value.input.after,
      records: [{ index: value.input.after + 1, path: 'memory-clues.jsonl', representation: 'domain-summary',
        record: { channel: 'hidebug', payload: { metric: 'pssBytes', value: 8192 } } }] },
  }) : receipt({})));
  const view = await viewWith(request); await view.read(0);
  expect(view.domain, 'the domain selector is missing').toBeDefined();
  expect(view.domain.text()).toContain('memory');
  expect(view.domain.text()).toContain('not-captured');
  expect(view.summary.text()).toContain('hidebug.getPss');
  view.domain.value = 'memory'; await view.domain.listeners.get('change')!();
  expect(request.mock.calls.at(-1)![1].input).toEqual({
    path: 'sample.ohmate-problem.zip', domain: 'memory', after: 0, limit: 100,
  });
  expect(view.file.text()).toContain('memory-clues.jsonl');
  expect(view.events.text()).toContain('pssBytes');
  expect(view.events.text()).not.toContain('TEST_ATTACHMENT_BODY');
  expect(view.status.textContent).toContain('1 / 2');
  expect(view.next.disabled).toBe(false);
  await view.read(view.cursor);
  expect(view.status.textContent).toContain('2 / 2'); expect(view.next.disabled).toBe(true);
  view.file.value = 'memory-clues.jsonl'; await view.file.listeners.get('change')!();
  expect(request.mock.calls.at(-1)![1].input).toMatchObject({ domain: 'memory', file: 'memory-clues.jsonl', after: 0 });
});

it('shows an explicit empty domain and metadata-only attachments', async () => {
  const request = vi.fn().mockResolvedValue(receipt({ kitPage: { domain: 'faultlog', count: 0,
    records: [], nextCursor: 0, hasMore: false } }));
  const view = await viewWith(request);
  expect(view.domain, 'the domain selector is missing').toBeDefined();
  view.domain.value = 'faultlog'; await view.read(0);
  expect(view.events.text()).toContain('附件仅显示元数据');
  expect(view.summary.text()).toContain('user-reviewed');
  expect(view.next.disabled).toBe(true);
  request.mockResolvedValue(receipt({ kitPage: { domain: 'ui', count: 0, records: [], nextCursor: 0, hasMore: false } }));
  view.domain.value = 'ui'; await view.read(0);
  expect(view.events.text()).toContain('not-captured');
});

it('discards an earlier domain response and clears Kit selections on a changed path', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  const request = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValue(receipt({ kitPage: { domain: 'ui', count: 0, records: [], nextCursor: 0, hasMore: false } }));
  const view = await viewWith(request);
  expect(view.domain, 'the domain selector is missing').toBeDefined();
  view.domain.value = 'memory'; const first = view.read(0);
  view.domain.value = 'ui'; await view.read(0);
  const displayed = view.status.textContent;
  resolveFirst(receipt({ kitPage: { domain: 'memory', count: 2, records: [], nextCursor: 1, hasMore: true } }));
  await first;
  expect(view.status.textContent).toBe(displayed);
  view.input.value = 'other.ohmate-problem.zip'; await view.input.listeners.get('input')!();
  expect(view.domain.value).toBe(''); expect(view.file.value).toBe('');
  expect(view.events.children).toHaveLength(0); expect(view.next.disabled).toBe(true);
});
