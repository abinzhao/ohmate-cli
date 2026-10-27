/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { RemoteRefSession } from './remote-ref.js';
import {
  MatchPattern,
  SelectorAnchorJson,
  SelectorJson,
  SelectorSpec,
  TextInput,
  TextMatcher,
} from './types.js';

/** Normalize text input: string → {value} (default EQUALS); [value, pattern] → {value, pattern} */
function normalizeTextInput(v: TextInput | undefined): TextMatcher | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (Array.isArray(v)) {
    return { value: String(v[0]), pattern: v[1] };
  }
  return { value: String(v) };
}

/** Normalize flat anchor JSON to SelectorSpec (does not handle isBefore/isAfter, anchors cannot nest further) */
function normalizeAnchor(anchor: SelectorAnchorJson): SelectorSpec {
  return normalizeFlatSelector(anchor);
}

/** Normalize flat selector JSON (no relative positioning fields) to SelectorSpec */
function normalizeFlatSelector(json: SelectorAnchorJson): SelectorSpec {
  const spec: SelectorSpec = {};
  if (json.text !== undefined) {
    spec.text = normalizeTextInput(json.text);
  }
  if (json.key !== undefined) {
    spec.key = String(json.key);
  }
  if (json.id !== undefined) {
    spec.id = String(json.id);
  }
  if (json.type !== undefined) {
    spec.type = String(json.type);
  }
  if (json.clickable !== undefined) {
    spec.clickable = Boolean(json.clickable);
  }
  if (json.scrollable !== undefined) {
    spec.scrollable = Boolean(json.scrollable);
  }
  if (json.enabled !== undefined) {
    spec.enabled = Boolean(json.enabled);
  }
  if (json.focused !== undefined) {
    spec.focused = Boolean(json.focused);
  }
  if (json.selected !== undefined) {
    spec.selected = Boolean(json.selected);
  }
  return spec;
}

/** Normalize external SelectorJson to internal SelectorSpec */
export function normalizeSelectorJson(json: SelectorJson): SelectorSpec {
  const spec: SelectorSpec = normalizeFlatSelector(json);
  if (json.isBefore) {
    spec.isBefore = normalizeAnchor(json.isBefore);
  }
  if (json.isAfter) {
    spec.isAfter = normalizeAnchor(json.isAfter);
  }
  if (json.within) {
    spec.within = normalizeAnchor(json.within);
  }
  return spec;
}

/** Build remote On.* step array from a SelectorSpec */
function buildSelectorSteps(s: SelectorSpec): Array<[string, unknown[]]> {
  const steps: Array<[string, unknown[]]> = [];
  if (s.text) {
    steps.push(['On.text', [s.text.value, s.text.pattern ?? MatchPattern.Equals]]);
  }
  if (s.key !== undefined) {
    steps.push(['On.key', [s.key]]);
  }
  if (s.id !== undefined) {
    steps.push(['On.id', [s.id]]);
  }
  if (s.type !== undefined) {
    steps.push(['On.type', [s.type]]);
  }
  if (s.clickable !== undefined) {
    steps.push(['On.clickable', [s.clickable]]);
  }
  if (s.scrollable !== undefined) {
    steps.push(['On.scrollable', [s.scrollable]]);
  }
  if (s.enabled !== undefined) {
    steps.push(['On.enabled', [s.enabled]]);
  }
  if (s.focused !== undefined) {
    steps.push(['On.focused', [s.focused]]);
  }
  if (s.selected !== undefined) {
    steps.push(['On.selected', [s.selected]]);
  }
  return steps;
}

export class Selector {
  readonly spec: SelectorSpec;

  constructor(spec: SelectorSpec = {}) {
    this.spec = spec;
  }

  /** Construct from JSON object (externally pass lookup conditions directly, no fluent API needed) */
  static from(json: SelectorJson): Selector {
    return new Selector(normalizeSelectorJson(json));
  }

  text(value: string, pattern?: MatchPattern): this {
    this.spec.text = { value, pattern };
    return this;
  }
  key(k: string): this {
    this.spec.key = k;
    return this;
  }
  id(i: string): this {
    this.spec.id = i;
    return this;
  }
  type(t: string): this {
    this.spec.type = t;
    return this;
  }
  clickable(v = true): this {
    this.spec.clickable = v;
    return this;
  }
  scrollable(v = true): this {
    this.spec.scrollable = v;
    return this;
  }
  enabled(v = true): this {
    this.spec.enabled = v;
    return this;
  }
  focused(v = true): this {
    this.spec.focused = v;
    return this;
  }
  selected(v = true): this {
    this.spec.selected = v;
    return this;
  }
  /** Target is before the component matched by sel */
  isBefore(sel: Selector): this {
    this.spec.isBefore = sel.spec;
    return this;
  }
  /** Target is after the component matched by sel */
  isAfter(sel: Selector): this {
    this.spec.isAfter = sel.spec;
    return this;
  }
  /** Target is within the container matched by sel */
  within(sel: Selector): this {
    this.spec.within = sel.spec;
    return this;
  }

  /** Build the remote On object within a controlled session according to the condition chain, return On#N reference (registered for cleanup by session) */
  async buildOn(session: RemoteRefSession): Promise<string> {
    const s = this.spec;
    const steps = buildSelectorSteps(s);
    if (steps.length === 0) {
      throw new Error('Empty selector: at least one lookup condition required');
    }

    // First condition uses seed to create On, subsequent conditions chain on the same On
    const ref = await session.create(steps[0][0], steps[0][1]);
    for (let i = 1; i < steps.length; i++) {
      await session.call(steps[i][0], ref, steps[i][1]);
    }

    if (s.isBefore) {
      const other = await new Selector(s.isBefore).buildOn(session);
      await session.call('On.isBefore', ref, [other]);
    }
    if (s.isAfter) {
      const other = await new Selector(s.isAfter).buildOn(session);
      await session.call('On.isAfter', ref, [other]);
    }
    if (s.within) {
      const other = await new Selector(s.within).buildOn(session);
      await session.call('On.within', ref, [other]);
    }
    return ref;
  }
}
