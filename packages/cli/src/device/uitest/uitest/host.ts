/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { RpcLike } from './remote-ref.js';
import type { RemoteRefSession } from './remote-ref.js';
import type { Selector } from './selector.js';
import type { GestureDsl, WindowFilterSpec } from './types.js';

export interface UiTestHost {
  readonly rpc: RpcLike;

  /** Get (create on demand) the persistent Driver remote reference */
  ensureDriver(): Promise<string>;

  /** Within a controlled session: find component reference by selector, pass to fn for use, auto-cleanup on exit.
   *  fn's third parameter dref is the persistent Driver reference, for scenarios that need to call Driver.findComponents again */
  withComponentRef<T>(
    sel: Selector,
    index: number,
    fn: (ref: string, session: RemoteRefSession, dref: string) => Promise<T>,
  ): Promise<T>;

  /** Within a controlled session: find window reference by filter conditions, pass to fn for use, auto-cleanup on exit */
  withWindowRef<T>(
    filter: WindowFilterSpec,
    index: number,
    fn: (ref: string, session: RemoteRefSession) => Promise<T>,
  ): Promise<T>;

  /** Within a controlled session: build remote PointerMatrix from DSL, pass to fn for use, auto-cleanup on exit */
  withPointerRef<T>(
    dsl: GestureDsl,
    fn: (ref: string, speed: number, session: RemoteRefSession) => Promise<T>,
  ): Promise<T>;
}
