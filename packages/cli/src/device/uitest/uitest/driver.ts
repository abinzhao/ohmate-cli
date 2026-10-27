/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { UiTestRpc } from '../rpc/operate-rpc.js';
import { Component } from './component.js';
import type { UiTestHost } from './host.js';
import { buildRemotePointerMatrix } from './pointer-matrix.js';
import { RemoteRefSession, clearRefs, DRIVER_REF_API, type RpcLike } from './remote-ref.js';
import { Selector } from './selector.js';
import { GestureDsl, Point, SelectorJson, WindowFilterSpec } from './types.js';
import { Window } from './window.js';

/** Shell capability provider (screenCapture uses hdc shell + fileRecv, not RPC) */
export interface ShellProvider {
  shell(cmd: string): Promise<string>;
  fileRecv(remote: string, local: string): Promise<boolean>;
}

export class UiTestDriver implements UiTestHost {
  private driverRef: string | null = null;
  readonly rpc: RpcLike;

  constructor(rpc: UiTestRpc, private readonly shell?: ShellProvider) {
    this.rpc = rpc;
  }

  /** Get (create on demand) the persistent Driver remote reference */
  async ensureDriver(): Promise<string> {
    if (this.driverRef) {
      return this.driverRef;
    }
    this.driverRef = String(await this.rpc.call(DRIVER_REF_API, '', []));
    return this.driverRef;
  }

  /** Create an empty selector, or construct from a JSON object (both fluent and JSON usage) */
  selector(json?: SelectorJson): Selector {
    return json ? Selector.from(json) : new Selector();
  }

  /** Find component (accepts Selector or JSON; does not search immediately, only returns a Component storing construction data) */
  findComponent(sel: Selector | SelectorJson, index = 0): Component {
    const selector = sel instanceof Selector ? sel : Selector.from(sel);
    return new Component(this, selector, index);
  }

  async withComponentRef<T>(
    sel: Selector,
    index: number,
    fn: (ref: string, session: RemoteRefSession, dref: string) => Promise<T>,
  ): Promise<T> {
    const dref = await this.ensureDriver();
    const session = new RemoteRefSession(this.rpc);
    return session.run(async (s) => {
      const on = await sel.buildOn(s);
      // Device-side only has findComponents (returns all matches), take the index-th one; all refs registered for cleanup
      // Retry: after BackendObjectsCleaner the daemon may briefly refresh the component tree, need to wait for recovery
      let refs: string[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        const arr = await s.call('Driver.findComponents', dref, [on]);
        refs = ((arr as string[] | null) ?? []).map(String);
        if (refs.length > 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      s.trackAll(refs);
      if (index >= refs.length) {
        throw new Error(`findComponents: no component matched (returned ${refs.length}), index ${index} out of range`);
      }
      return fn(refs[index], s, dref);
    });
  }

  /** Find window (does not search immediately, only returns a Window wrapper storing filter conditions) */
  findWindow(filter: WindowFilterSpec, index = 0): Window {
    return new Window(this, filter, index);
  }

  async withWindowRef<T>(
    filter: WindowFilterSpec,
    index: number,
    fn: (ref: string, session: RemoteRefSession) => Promise<T>,
  ): Promise<T> {
    const dref = await this.ensureDriver();
    const session = new RemoteRefSession(this.rpc);
    return session.run(async (s) => {
      let winRef: string;
      if (index === 0) {
        // findWindow returns a single UiWindow#N or null (0 matches)
        const r = await s.call('Driver.findWindow', dref, [normalizeWindowFilter(filter)]);
        if (!r || r === 'null') {
          throw new Error('findWindow: no window matched');
        }
        winRef = s.track(String(r));
      } else {
        // Device-side has no findWindows (plural), index>0 not supported
        throw new Error(`findWindow: only returns a single window, index=${index} not supported`);
      }
      return fn(winRef, s);
    });
  }

  /** Gesture: build remote PointerMatrix from DSL and execute Driver.injectMultiPointerAction */
  async gesture(dsl: GestureDsl): Promise<void> {
    await this.swipe(dsl);
  }

  async swipe(dsl: GestureDsl): Promise<void> {
    const dref = await this.ensureDriver();
    await this.withPointerRef(dsl, async (mref, speed) => {
      await this.rpc.call('Driver.injectMultiPointerAction', dref, [mref, speed]);
    });
  }

  async withPointerRef<T>(
    dsl: GestureDsl,
    fn: (ref: string, speed: number, session: RemoteRefSession) => Promise<T>,
  ): Promise<T> {
    const session = new RemoteRefSession(this.rpc);
    return session.run(async (s) => {
      const { ref, speed } = await buildRemotePointerMatrix(s, dsl);
      return fn(ref, speed, s);
    });
  }

  /**
   * Screenshot: uses hdc shell (uitest screenCap / snapshot_display) + fileRecv to pull, not RPC.
   * Requires ShellProvider injected via device.uitest construction.
   */
  async screenCapture(savePath: string): Promise<void> {
    if (!this.shell) {
      throw new Error('screenCapture requires shell capability (provided via device.uitest)');
    }
    const ext = savePath.toLowerCase().endsWith('.png') ? '.png' : '.jpeg';
    const remote = `/data/local/tmp/hypium${ext}`;
    await this.shell.shell(`rm -f ${remote}`);
    if (ext === '.png') {
      await this.shell.shell(`uitest screenCap -p ${remote}`);
    } else {
      await this.shell.shell(`snapshot_display -f ${remote}`);
    }
    const ok = await this.shell.fileRecv(remote, savePath);
    if (!ok) {
      throw new Error(`screenCapture pull failed: ${remote} -> ${savePath}`);
    }
  }

  /**
   * Set screen rotation (RPC: Driver.setDisplayRotation).
   * @param rotation Angle: 0 (portrait), 90 (landscape right), 180 (portrait inverted), 270 (landscape left)
   */
  async setDisplayRotation(rotation: number): Promise<void> {
    const angleToEnum: Record<number, number> = { 0: 0, 90: 1, 180: 2, 270: 3 };
    if (!(rotation in angleToEnum)) {
      throw new Error(`rotation must be 0, 90, 180, or 270, got ${rotation}`);
    }
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.setDisplayRotation', dref, [angleToEnum[rotation]]);
  }

  /**
   * Get current screen rotation (RPC: Driver.getDisplayRotation).
   * @returns Rotation angle: 0, 90, 180, or 270
   */
  async getDisplayRotation(): Promise<number> {
    const dref = await this.ensureDriver();
    const result = await this.rpc.call('Driver.getDisplayRotation', dref, []);
    const enumToAngle: Record<number, number> = { 0: 0, 1: 90, 2: 180, 3: 270 };
    const val = typeof result === 'number' ? result : Number(result);
    return enumToAngle[val] ?? val;
  }

  /**
   * Enable/disable screen auto-rotation (RPC: Driver.setDisplayRotationEnabled).
   * @param enabled true=allow auto-rotation false=disable auto-rotation
   */
  async setDisplayRotationEnabled(enabled: boolean): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.setDisplayRotationEnabled', dref, [enabled]);
  }

  /** Client-side wait (does not make RPC call) */
  async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Back key (Navigation stack back) */
  async pressBack(): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.pressBack', dref, []);
  }

  /** Home key */
  async pressHome(): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.pressHome', dref, []);
  }

  /** Coordinate click */
  async clickXY(x: number, y: number): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.click', dref, [x, y]);
  }

  /** Coordinate double-click */
  async doubleClick(x: number, y: number): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.doubleClick', dref, [x, y]);
  }

  /** Coordinate-level text input (for components like TextInput not in the UI tree) */
  async inputText(point: Point, text: string): Promise<void> {
    const dref = await this.ensureDriver();
    await this.rpc.call('Driver.inputText', dref, [point, text]);
  }

  /** Screen size {width,height} */
  async getDisplaySize(): Promise<{ width: number; height: number }> {
    const dref = await this.ensureDriver();
    const r = await this.rpc.call('Driver.getDisplaySize', dref, []);
    const p = r as { x?: number; y?: number; width?: number; height?: number };
    return { width: p.width ?? p.x ?? 0, height: p.height ?? p.y ?? 0 };
  }

  /** Assert component exists/does not exist (device-side has no dedicated api, uses findComponents result) */
  async assertComponentExist(sel: Selector | SelectorJson, exists = true): Promise<boolean> {
    const selector = sel instanceof Selector ? sel : Selector.from(sel);
    const dref = await this.ensureDriver();
    const session = new RemoteRefSession(this.rpc);
    return session.run(async (s) => {
      const on = await selector.buildOn(s);
      const arr = await s.call('Driver.findComponents', dref, [on]);
      // When 0 matches, daemon returns null
      const found = (((arr as string[] | null) ?? []).length) > 0;
      return exists ? found : !found;
    });
  }

  /** Release persistent Driver reference (RPC connection managed by underlying uitestRpc) */
  async release(): Promise<void> {
    if (this.driverRef) {
      await clearRefs(this.rpc, [this.driverRef]);
      this.driverRef = null;
    }
  }
}

/** Normalize WindowFilterSpec to the flat object expected by daemon (title must be string) */
function normalizeWindowFilter(filter: WindowFilterSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filter.title !== undefined) {
    out.title = typeof filter.title === 'string' ? filter.title : filter.title.value;
  }
  if (filter.bundleName !== undefined) {
    out.bundleName = filter.bundleName;
  }
  if (filter.active !== undefined) {
    out.active = filter.active;
  }
  return out;
}
