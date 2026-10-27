/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

class Element {
  value = '';
  textContent = '';
  children: (Element | string)[];
  constructor(_tag: string, attributes = {}, children: (Element | string)[] = []) { Object.assign(this, attributes); this.children = children; }
  addEventListener() {}
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  text(): string { return this.textContent + this.children.map((child) => typeof child === 'string' ? child : child.text()).join(' '); }
}
it('shows offline retained count, exact quota loss and the clock for each absolute sequence', async () => {
  const source = await readFile(new URL('../../../../apps/web/problem.js', import.meta.url), 'utf8');
  const clockText = vi.fn((clock: { segment: number } | undefined) => `clock ${clock?.segment ?? '?'}`);
  const request = vi.fn().mockResolvedValue({ data: { receipt: { exitCode: 0, data: {
    valid: true, nextCursor: 5002, through: 5004, hasMore: true, count: 4, retainedFrom: 5001, retainedCount: 4,
    gap: { missingFrom: 1, missingThrough: 5000, reason: 'retention-quota' }, manifest: {},
    session: { history: { from: 5001, retainedCount: 4, gap: { missingFrom: 1, missingThrough: 5000 } },
      clockEvidence: [{ segment: 7 }, { segment: 8 }, { segment: 8 }, { segment: 8 }] },
    events: [5001, 5002].map((sequence) => ({ sequence, channel: 'hilog', payload: { summary: `event ${sequence}` } })),
  } } } });
  const node = (tag: string, attributes = {}, children = []) => new Element(tag, attributes, children);
  const api = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\n({ProblemView,problemReview});', {
    request, node, clockText, field: () => ({ input: node('input'), view: node('div') }),
    empty: () => node('div'), details: () => node('details'),
  });
  const view = new api.ProblemView({});
  view.input.value = 'example.ohmate-problem.zip'; await view.read(0);
  expect(clockText.mock.calls.map(([clock]) => clock?.segment)).toEqual([7, 8]);
  expect(view.summary.text()).toContain('保留事件 4 条');
  expect(view.summary.text()).toContain('1–5000');
  expect(view.status.textContent).toContain('5002 / 5004');
  const review = api.problemReview({ selection: { through: 5004 }, archiveBytes: 1000, retainedCount: 4, retainedFrom: 5001,
    gap: { missingFrom: 1, missingThrough: 5000 }, redaction: { fieldsRemoved: 0 }, files: [], fields: {}, coverage: [] });
  expect(review.text()).toContain('固定尾序号 5004');
  expect(review.text()).toContain('保留 4 条');
  expect(review.text()).toContain('1–5000');
});

it('indexes page-scoped clock evidence by its explicit absolute origin', async () => {
  const source = await readFile(new URL('../../../../apps/web/problem.js', import.meta.url), 'utf8');
  const clockText = vi.fn((clock: { segment: number } | undefined) => `clock ${clock?.segment ?? '?'}`);
  const request = vi.fn().mockResolvedValue({ data: { receipt: { exitCode: 0, data: {
    valid: true, nextCursor: 5004, through: 5004, hasMore: false, count: 4,
    manifest: {}, session: { history: { from: 5001, retainedCount: 4 }, clockEvidenceLocation: 'events.jsonl' },
    clockEvidenceFrom: 5003, clockEvidence: [{ segment: 8 }, { segment: 9 }],
    events: [5003, 5004].map((sequence) => ({ sequence, channel: 'hilog', payload: { summary: 'event' } })),
  } } } });
  const node = (tag: string, attributes = {}, children = []) => new Element(tag, attributes, children);
  const Constructor = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nProblemView;', {
    request, node, clockText, field: () => ({ input: node('input'), view: node('div') }),
    empty: () => node('div'), details: () => node('details'),
  });
  const view = new Constructor({});
  view.input.value = 'example.ohmate-problem.zip'; await view.read(0);
  expect(clockText.mock.calls.map(([clock]) => clock?.segment)).toEqual([8, 9]);
  expect(view.summary.text()).toContain('时钟测量已按逐条依据重算');
});
