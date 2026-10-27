/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { UiTestHost } from './host.js';
import { Selector } from './selector.js';
import { Point, Rect, type SelectorJson } from './types.js';

export class Component {
  constructor(
    private readonly host: UiTestHost,
    private readonly selector: Selector,
    private readonly index: number = 0,
  ) {}

  /** Get component reference within a controlled session and execute fn, auto-cleanup on exit */
  private use<T>(fn: (ref: string) => Promise<T>): Promise<T> {
    return this.host.withComponentRef(this.selector, this.index, (ref) => fn(ref));
  }

  async click(): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.click', r, []));
  }
  async doubleClick(): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.doubleClick', r, []));
  }
  async longClick(): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.longClick', r, []));
  }
  async inputText(text: string): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.inputText', r, [text]));
  }
  async clearText(): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.clearText', r, []));
  }

  async getId(): Promise<string> {
    return String(await this.use((r) => this.host.rpc.call('Component.getId', r, [])));
  }
  async getText(): Promise<string> {
    return String(await this.use((r) => this.host.rpc.call('Component.getText', r, [])));
  }
  async getType(): Promise<string> {
    return String(await this.use((r) => this.host.rpc.call('Component.getType', r, [])));
  }
  async getHint(): Promise<string> {
    return String(await this.use((r) => this.host.rpc.call('Component.getHint', r, [])));
  }

  async isClickable(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('Component.isClickable', r, [])));
  }
  async isScrollable(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('Component.isScrollable', r, [])));
  }
  async isEnabled(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('Component.isEnabled', r, [])));
  }
  async isFocused(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('Component.isFocused', r, [])));
  }
  async isSelected(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('Component.isSelected', r, [])));
  }

  async getBounds(): Promise<Rect> {
    const rect = await this.use((r) => this.host.rpc.call('Component.getBounds', r, []));
    return rect as Rect;
  }

  async getBoundsCenter(): Promise<Point> {
    const p = await this.use((r) => this.host.rpc.call('Component.getBoundsCenter', r, []));
    return p as Point;
  }

  /** Search for target component within a scrollable component, returns a new Component on hit (does not hold remote reference) */
  async scrollSearch(sel: Selector | SelectorJson): Promise<Component | null> {
    const target = sel instanceof Selector ? sel : Selector.from(sel);
    const hit = await this.host.withComponentRef(this.selector, this.index, async (r, session) => {
      const on = await target.buildOn(session);
      const res = await session.call('Component.scrollSearch', r, [on]);
      if (!res) {
        return false;
      }
      session.track(String(res));
      return true;
    });
    return hit ? new Component(this.host, target) : null;
  }

  /** Drag to target component (device-side Component.dragTo accepts target UiComponent reference, not coordinates) */
  async dragTo(target: Selector | SelectorJson | Component): Promise<void> {
    const targetSel = target instanceof Component ? target.selector
      : target instanceof Selector ? target : Selector.from(target);
    await this.host.withComponentRef(this.selector, this.index, async (srcRef, session, dref) => {
      const on = await targetSel.buildOn(session);
      const arr = await session.call('Driver.findComponents', dref, [on]);
      const refs = ((arr as string[] | null) ?? []).map(String);
      session.trackAll(refs);
      if (refs.length === 0) {
        throw new Error('dragTo target component not found (0 returned)');
      }
      await session.call('Component.dragTo', srcRef, [refs[0]]);
    });
  }

  /** Two-finger zoom out (pinchOut, scale range 1~2, larger means more zoom in) */
  async pinchOut(scale: number): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.pinchOut', r, [scale]));
  }

  /** Two-finger zoom in (pinchIn, scale range 0~1, smaller means more zoom out) */
  async pinchIn(scale: number): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.pinchIn', r, [scale]));
  }

  /** Scroll to top (scrollable component) */
  async scrollToTop(speed = 600): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.scrollToTop', r, [speed]));
  }

  /** Scroll to bottom (scrollable component) */
  async scrollToBottom(speed = 600): Promise<void> {
    await this.use((r) => this.host.rpc.call('Component.scrollToBottom', r, [speed]));
  }
}