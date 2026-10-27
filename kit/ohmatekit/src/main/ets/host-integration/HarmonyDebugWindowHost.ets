/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ComponentContent, promptAction, UIContext, window } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { OHMateCore } from '../core/OHMateCore';
import { DebugWindowHost } from '../debug/DebugTypes';
import { DebugViewModel, FloatingRect, floatingRectValid } from './DebugViewModel';
import { makeFloating, makePanel } from './DebugViews';
import { ArchiveSaveOwner } from './ArchiveSaveOwner';
import { HarmonyArchiveSaveHost } from './HarmonyArchiveSaveHost';
import { ProblemPanelModel } from './ProblemPanelModel';
export { DebugViewModel, FloatingRect } from './DebugViewModel';

// SDK UIContext.getWindowId/getWindowName and window.findWindow bind only the
// explicit current window. All cleanup retains that exact native object.
export class HarmonyDebugWindowHost implements DebugWindowHost {
  private context: UIContext | undefined;
  private model: DebugViewModel;
  private bound: window.Window | undefined = undefined;
  private windowId: number = -1;
  private windowName: string = '';
  private active: boolean = false;
  private revoked: boolean = false;
  private failed: boolean = false;
  private foreground: boolean = false;
  private sizeOwned: boolean = false;
  private avoidOwned: boolean = false;
  private lifecycleOwned: boolean = false;
  private floating: ComponentContent<DebugViewModel> | undefined = undefined;
  private overlayOwned: boolean = false;
  private panel: ComponentContent<DebugViewModel> | undefined = undefined;
  private dialogOwned: boolean = false;
  private dialogPending: boolean = false;
  private businessRects: FloatingRect[] = [];
  private businessValid: boolean = true;
  private problemCore: OHMateCore | undefined = undefined;
  private abilityContext: common.Context | undefined = undefined;
  private problemNow: () => number = (): number => -1;
  private onLifecycle: (event: string) => void;
  private sizeCallback: (size: window.Size) => void = (_: window.Size): void => { this.refreshLayout(); };
  private avoidCallback: (area: window.AvoidAreaOptions) => void =
    (_: window.AvoidAreaOptions): void => { this.refreshLayout(); };
  private lifecycleCallback: (event: window.WindowEventType) => void = (event: window.WindowEventType): void => {
    if (!this.active) { return; }
    if (event === window.WindowEventType.WINDOW_DESTROYED) { this.revoke(); }
    else if (event === window.WindowEventType.WINDOW_HIDDEN) {
      this.foreground = false; this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend();
      this.model.closeQuickMenu(); this.notify('hidden');
    } else if (event === window.WindowEventType.WINDOW_SHOWN) {
      this.foreground = true; this.notify('shown'); this.refreshLayout();
    }
  };
  constructor(context: UIContext, model: DebugViewModel,
    onLifecycle: (event: string) => void = (_: string): void => {}) {
    this.context = context; this.model = model; this.onLifecycle = onLifecycle;
  }
  configureProblems(core: OHMateCore, context: common.Context, now: () => number): boolean {
    if (this.active || this.revoked || this.failed || this.problemCore !== undefined) { return false; }
    this.problemCore = core; this.abilityContext = context; this.problemNow = now; return true;
  }
  async attach(): Promise<boolean> {
    if (this.revoked || this.failed || this.context === undefined) { return false; }
    if (this.active) { return this.alive(); }
    try {
      const id: number | undefined = this.context.getWindowId();
      const name: string | undefined = this.context.getWindowName();
      if (id === undefined || !Number.isSafeInteger(id) || id < 0 || name === undefined || name === '') { return false; }
      const bound: window.Window | undefined = window.findWindow(name);
      if (bound === undefined || bound.getWindowProperties().id !== id) { return false; }
      this.bound = bound; this.windowId = id; this.windowName = name;
      this.foreground = bound.isWindowShowing();
      // Register ownership first: on() can partially subscribe before throwing.
      this.sizeOwned = true; bound.on('windowSizeChange', this.sizeCallback);
      this.avoidOwned = true; bound.on('avoidAreaChange', this.avoidCallback);
      this.lifecycleOwned = true; bound.on('windowEvent', this.lifecycleCallback);
      this.active = true;
      if (this.problemCore !== undefined && this.abilityContext !== undefined) {
        const save = new ArchiveSaveOwner(new HarmonyArchiveSaveHost(this.abilityContext, bound), this.problemNow);
        this.model.problems = new ProblemPanelModel(this.problemCore, save, this.problemNow,
          (): boolean => this.alive() && this.foreground && this.dialogOwned && !this.dialogPending);
        this.model.problems.suspend();
      }
      if (!this.foreground) { this.model.suspendPosition(); }
      this.refreshLayout();
      if (!this.foreground) { this.notify('hidden'); }
      return this.alive();
    } catch (_) { this.failed = true; this.revoke(); return false; }
  }
  async showFloatingButton(): Promise<boolean> {
    if (!this.alive() || !this.foreground || !this.businessValid) { return false; }
    this.refreshLayout();
    if (!this.model.placeable || this.context === undefined) { return false; }
    this.model.resumePosition();
    try {
      const context: UIContext = this.context;
      context.runScopedTask((): void => {
        if (this.floating === undefined) {
          this.floating = makeFloating(context, this.model);
          this.overlayOwned = true;
          context.getOverlayManager().addComponentContent(this.floating);
        } else { context.getOverlayManager().showComponentContent(this.floating); }
        this.model.visible = true;
      });
      return this.alive();
    } catch (_) {
      this.failed = true; this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend(); return false;
    }
  }
  async hideFloatingButton(): Promise<boolean> {
    this.model.visible = false;
    this.model.suspendPosition(); this.model.problems?.suspend();
    if (!this.model.closeQuickMenu()) { return false; }
    if (!this.alive() || this.context === undefined) { return false; }
    try {
      const content: ComponentContent<DebugViewModel> | undefined = this.floating;
      if (content !== undefined) {
        const context: UIContext = this.context;
        context.runScopedTask((): void => { context.getOverlayManager().hideComponentContent(content); });
      }
      return true;
    } catch (_) { this.failed = true; this.model.suspendPosition(); return false; }
  }
  async openPanel(): Promise<boolean> {
    if (!this.alive() || !this.foreground || this.context === undefined || this.dialogPending) { return false; }
    if (this.dialogOwned) { return true; }
    this.dialogPending = true;
    try {
      const context: UIContext = this.context;
      let opening: Promise<void> = Promise.resolve<void>(undefined);
      context.runScopedTask((): void => {
        this.panel = makePanel(context, this.model);
        this.dialogOwned = true;
        const options: promptAction.BaseDialogOptions = {
          autoCancel: false,
          onWillDismiss: (): void => { this.model.close(); },
        };
        opening = context.getPromptAction().openCustomDialog<DebugViewModel>(this.panel, options);
      });
      await opening;
      if (!this.alive() || !this.foreground) { return false; }
      this.model.problems?.resume(); return true;
    } catch (_) { this.failed = true; this.model.suspendPosition(); this.model.problems?.suspend(); return false; }
    finally { this.dialogPending = false; }
  }
  async closePanel(): Promise<boolean> {
    this.model.problems?.suspend();
    if (this.dialogPending) { return false; }
    return this.releasePanel();
  }
  updateConfiguration(): boolean {
    if (!this.alive() || this.context === undefined) { return false; }
    this.model.problems?.cancel();
    try {
      const context: UIContext = this.context;
      context.runScopedTask((): void => {
        for (const node of [this.floating, this.panel]) {
          if (node !== undefined && !node.isDisposed()) { node.updateConfiguration(); }
        }
      });
      this.model.cancelDrag(); this.model.closeQuickMenu(); this.refreshLayout(); return true;
    } catch (_) {
      this.failed = true; this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend();
      this.model.closeQuickMenu(); return false;
    }
  }
  setAvoidRects(rects: FloatingRect[]): boolean {
    if (this.revoked) { return false; }
    this.businessValid = rects.length <= 16 &&
      rects.every((rect: FloatingRect): boolean => floatingRectValid(rect));
    if (!this.businessValid) {
      this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend();
      this.model.closeQuickMenu(); this.notify('floating-hidden'); return false;
    }
    this.businessRects = rects.map((rect: FloatingRect): FloatingRect => {
      const copy = new FloatingRect(); copy.left = rect.left; copy.top = rect.top;
      copy.width = rect.width; copy.height = rect.height; return copy;
    });
    this.refreshLayout(); return true;
  }
  async detach(): Promise<boolean> {
    this.revoke();
    let complete: boolean = true;
    // Lifecycle-triggered detach may inspect responsibility, never retry an
    // already failed file close. Archive cleanup has its own explicit entry.
    if (this.model.problems !== undefined && this.model.problems.getState() !== 'idle') { complete = false; }
    if (this.dialogPending) { complete = false; }
    else if (!await this.releasePanel()) { complete = false; }
    const context: UIContext | undefined = this.context;
    const floating: ComponentContent<DebugViewModel> | undefined = this.floating;
    const menuClosed: boolean = this.model.closeQuickMenu();
    if (!menuClosed) { complete = false; }
    if (menuClosed && floating !== undefined && context !== undefined) {
      try {
        context.runScopedTask((): void => {
          if (this.overlayOwned) {
            context.getOverlayManager().removeComponentContent(floating); this.overlayOwned = false;
          }
          floating.dispose(); this.floating = undefined;
        });
      } catch (_) { complete = false; }
    }
    const bound: window.Window | undefined = this.bound;
    if (bound !== undefined) {
      if (this.sizeOwned) {
        try { bound.off('windowSizeChange', this.sizeCallback); this.sizeOwned = false; } catch (_) { complete = false; }
      }
      if (this.avoidOwned) {
        try { bound.off('avoidAreaChange', this.avoidCallback); this.avoidOwned = false; } catch (_) { complete = false; }
      }
      if (this.lifecycleOwned) {
        try { bound.off('windowEvent', this.lifecycleCallback); this.lifecycleOwned = false; } catch (_) { complete = false; }
      }
    }
    if (complete) {
      this.bound = undefined; this.context = undefined; this.businessRects = [];
      this.model.clearActions(); this.model.problemIds = [];
      this.model.problems = undefined; this.problemCore = undefined; this.abilityContext = undefined;
      this.problemNow = (): number => -1;
      this.notify('detached');
      this.onLifecycle = (_: string): void => {};
    }
    return complete;
  }
  private async releasePanel(): Promise<boolean> {
    const panel: ComponentContent<DebugViewModel> | undefined = this.panel;
    const context: UIContext | undefined = this.context;
    if (panel === undefined) { return true; }
    if (context === undefined || this.dialogPending) { return false; }
    this.dialogPending = true;
    try {
      if (this.dialogOwned) {
        let closing: Promise<void> = Promise.resolve<void>(undefined);
        context.runScopedTask((): void => {
          closing = context.getPromptAction().closeCustomDialog<DebugViewModel>(panel);
        });
        await closing; this.dialogOwned = false;
      }
      context.runScopedTask((): void => { panel.dispose(); });
      this.panel = undefined; return true;
    } catch (_) {
      this.failed = true; this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend(); return false;
    }
    finally { this.dialogPending = false; }
  }
  private alive(): boolean {
    if (!this.active || this.revoked || this.failed || this.context === undefined || this.bound === undefined) { return false; }
    try {
      if (this.context.getWindowId() === this.windowId && this.context.getWindowName() === this.windowName &&
        this.bound.getWindowProperties().id === this.windowId) { return true; }
    } catch (_) {}
    this.revoke(); return false;
  }
  private revoke(): void {
    const first: boolean = !this.revoked;
    this.revoked = true; this.active = false; this.model.visible = false; this.model.clearActions();
    if (first) { this.notify('destroyed'); }
  }
  private notify(event: string): void {
    try { this.onLifecycle(event); } catch (_) {
      this.failed = true; this.model.visible = false; this.model.suspendPosition(); this.model.problems?.suspend();
    }
  }
  private refreshLayout(): void {
    if (!this.alive() || this.context === undefined || this.bound === undefined || !this.businessValid) { return; }
    try {
      const context: UIContext = this.context;
      const rect: window.Rect = this.bound.getWindowProperties().windowRect;
      const excludes: FloatingRect[] = this.businessRects.slice();
      const types: window.AvoidAreaType[] = [
        window.AvoidAreaType.TYPE_SYSTEM, window.AvoidAreaType.TYPE_CUTOUT,
        window.AvoidAreaType.TYPE_SYSTEM_GESTURE, window.AvoidAreaType.TYPE_KEYBOARD,
        window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR, window.AvoidAreaType.TYPE_FLOAT_NAVIGATION,
      ];
      for (const type of types) {
        const area: window.AvoidArea = this.bound.getWindowAvoidArea(type);
        for (const avoid of [area.leftRect, area.topRect, area.rightRect, area.bottomRect]) {
          const item = new FloatingRect(); item.left = context.px2vp(avoid.left); item.top = context.px2vp(avoid.top);
          item.width = context.px2vp(avoid.width); item.height = context.px2vp(avoid.height); excludes.push(item);
        }
      }
      this.model.layout(context.px2vp(rect.width), context.px2vp(rect.height), excludes);
    } catch (_) {
      this.model.placeable = false; this.model.visible = false; this.model.suspendPosition();
      this.model.problems?.suspend(); this.model.closeQuickMenu();
    }
    if (!this.model.placeable) { this.notify('floating-hidden'); }
  }
}
