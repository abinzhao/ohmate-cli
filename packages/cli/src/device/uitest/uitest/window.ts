/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { UiTestHost } from './host.js';
import { Rect, WindowFilterSpec } from './types.js';

export class Window {
  constructor(
    private readonly host: UiTestHost,
    private readonly filter: WindowFilterSpec,
    private readonly index: number = 0,
  ) {}

  private use<T>(fn: (ref: string) => Promise<T>): Promise<T> {
    return this.host.withWindowRef(this.filter, this.index, (ref) => fn(ref));
  }

  async getBundleName(): Promise<string> {
    return String(await this.use((r) => this.host.rpc.call('UiWindow.getBundleName', r, [])));
  }
  async isActive(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('UiWindow.isActive', r, [])));
  }
  async isFocused(): Promise<boolean> {
    return Boolean(await this.use((r) => this.host.rpc.call('UiWindow.isFocused', r, [])));
  }
  async getBounds(): Promise<Rect> {
    const r = await this.use((ref) => this.host.rpc.call('UiWindow.getBounds', ref, []));
    return r as Rect;
  }
}
