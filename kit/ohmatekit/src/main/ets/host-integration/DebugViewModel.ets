/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import {
  FloatingPosition, FloatingPositionStore, PositionBucket, positionBucket, positionScopeValid, positionValid
} from './FloatingPosition';
import { ProblemPanelModel } from './ProblemPanelModel';

export class FloatingRect {
  left: number = 0;
  top: number = 0;
  width: number = 0;
  height: number = 0;
}
export function floatingRectValid(rect: FloatingRect): boolean {
  return [rect.left, rect.top, rect.width, rect.height].every((value: number): boolean =>
    Number.isFinite(value) && value >= 0 && value <= 1000000);
}
function clamp(value: number, maximum: number): number { return Math.max(8, Math.min(value, maximum)); }

// V2 observes only bounded presentation values, never native handles or raw data.
@ObservedV2
export class DebugViewModel {
  @Trace visible: boolean = false;
  @Trace placeable: boolean = false;
  @Trace buttonX: number = 0;
  @Trace buttonY: number = 0;
  @Trace panelBusy: boolean = false;
  @Trace quickMenuShown: boolean = false;
  @Trace sessionState: string = 'inactive';
  @Trace problemIds: string[] = [];
  @Trace storedBytes: number = 0;
  @Trace dropped: number = 0;
  @Trace resultCode: string = '';
  @Trace positionState: string = 'memory-only';
  @Trace problems: ProblemPanelModel | undefined = undefined;
  open: () => void = (): void => {};
  close: () => void = (): void => {};
  pause: () => void = (): void => {};
  resume: () => void = (): void => {};
  mark: () => void = (): void => {};
  refresh: () => void = (): void => {};
  hide: () => void = (): void => {};
  private viewportWidth: number = 0;
  private viewportHeight: number = 0;
  private rects: FloatingRect[] = [];
  private rightSide: boolean = true;
  private edgeRatio: number = 0.65;
  private dragX: number = 0;
  private dragY: number = 0;
  private dragging: boolean = false;
  private invalidDrag: boolean = false;
  private suppressClick: boolean = false;
  private menuOwned: boolean = false;
  private pendingHide: boolean = false;
  private buckets: PositionBucket[] = [];
  private bucket: string = '';
  private positionStore: FloatingPositionStore | undefined = undefined;
  private positionScope: string = '';
  private positionActive: boolean = true;
  private positionReleased: boolean = false;
  private positionBusy: boolean = false;
  private positionEpoch: number = 0;
  private positionAttempts: number = 0;
  configurePosition(store: FloatingPositionStore, scope: string): boolean {
    if (this.positionReleased || this.positionStore !== undefined || !positionScopeValid(scope)) { return false; }
    this.positionStore = store; this.positionScope = scope; this.positionState = 'ready'; return true;
  }
  suspendPosition(): void {
    this.cancelDrag(); this.positionActive = false; this.positionEpoch++;
  }
  resumePosition(): void {
    if (this.positionReleased) { return; }
    if (!this.positionActive) { this.positionActive = true; this.positionEpoch++; }
    this.readPosition().then((): void => {});
  }
  releasePosition(): void {
    this.suspendPosition(); this.positionReleased = true; this.positionStore = undefined; this.positionScope = '';
  }
  async retryPosition(): Promise<boolean> {
    if (!this.positionActive || this.positionReleased || this.positionBusy || this.dragging) { return false; }
    const epoch: number = this.positionEpoch;
    const store: FloatingPositionStore | undefined = this.positionStore;
    if (store?.getState?.() === 'save-uncertain') {
      if (store.retry === undefined || this.positionAttempts >= 256) { return false; }
      this.positionBusy = true; this.positionAttempts++;
      let retried: boolean = false;
      try { retried = await store.retry(); } catch (_) {}
      this.positionBusy = false;
      if (!retried || this.positionReleased || !this.positionActive || this.positionEpoch !== epoch) { return false; }
    }
    const entry: PositionBucket | undefined = this.currentBucket();
    return entry?.dirty ? this.savePosition(entry) : this.readPosition();
  }
  layout(width: number, height: number, rects: FloatingRect[]): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64 ||
      width > 1000000 || height > 1000000 || rects.length > 40 ||
      !rects.every((rect: FloatingRect): boolean => floatingRectValid(rect))) {
      this.cancelDrag(); this.positionEpoch++;
      this.placeable = false; this.visible = false; this.closeQuickMenu(); return;
    }
    if (width !== this.viewportWidth || height !== this.viewportHeight) { this.cancelDrag(); this.positionEpoch++; }
    const bucket: string = positionBucket(width, height);
    if (bucket !== this.bucket) {
      this.bucket = bucket;
      let entry: PositionBucket | undefined = this.currentBucket();
      if (entry === undefined) { entry = new PositionBucket(bucket); this.buckets.push(entry); }
      this.rightSide = entry.value.rightSide; this.edgeRatio = entry.value.edgeRatio;
    }
    this.viewportWidth = width; this.viewportHeight = height;
    this.rects = rects.map((rect: FloatingRect): FloatingRect => {
      const copy = new FloatingRect(); copy.left = rect.left; copy.top = rect.top;
      copy.width = rect.width; copy.height = rect.height; return copy;
    });
    this.fit(this.rightSide ? width - 56 : 8, 8 + this.edgeRatio * (height - 64), true);
    this.readPosition().then((): void => {});
  }
  beginInteraction(): void { this.suppressClick = false; }
  beginDrag(): void {
    this.closeQuickMenu();
    this.positionEpoch++;
    this.dragging = this.placeable; this.invalidDrag = false; this.suppressClick = false;
    this.dragX = this.buttonX; this.dragY = this.buttonY;
  }
  dragBy(offsetX: number, offsetY: number): void {
    if (!this.dragging) { return; }
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      this.invalidDrag = true; this.placeable = false; this.visible = false;
      this.suppressClick = true; return;
    }
    if (Math.abs(offsetX) >= 8 || Math.abs(offsetY) >= 8) { this.suppressClick = true; }
    if (this.suppressClick && !this.invalidDrag) {
      this.fit(clamp(this.dragX + offsetX, this.viewportWidth - 56),
        clamp(this.dragY + offsetY, this.viewportHeight - 56), false);
    }
  }
  endDrag(): void {
    const dragged: boolean = this.dragging && this.suppressClick;
    this.dragging = false;
    if (!dragged || !this.placeable || this.invalidDrag) { return; }
    this.rightSide = this.buttonX + 24 >= this.viewportWidth / 2;
    this.fit(this.rightSide ? this.viewportWidth - 56 : 8, this.buttonY, true);
    if (this.placeable) {
      this.edgeRatio = this.viewportHeight > 64 ? (this.buttonY - 8) / (this.viewportHeight - 64) : 0;
      const entry: PositionBucket | undefined = this.currentBucket();
      if (entry !== undefined) {
        entry.value = { rightSide: this.rightSide, edgeRatio: this.edgeRatio };
        entry.revision++; entry.loaded = true; entry.dirty = true;
        if (this.positionStore !== undefined && this.positionActive && !this.positionReleased) {
          if (this.positionBusy) { this.positionState = 'save-uncertain'; }
          else { this.savePosition(entry).then((): void => {}); }
        }
      }
    }
  }
  cancelDrag(): void {
    if (!this.dragging) { return; }
    this.dragging = false; this.suppressClick = true;
    if (!this.invalidDrag) {
      this.fit(this.rightSide ? this.viewportWidth - 56 : 8,
        8 + this.edgeRatio * (this.viewportHeight - 64), true);
    }
  }
  requestQuickMenu(): boolean {
    if (!this.visible || !this.placeable || this.panelBusy || this.dragging) { return false; }
    if (this.menuOwned) { return false; }
    this.positionEpoch++;
    this.menuOwned = true; this.quickMenuShown = true; this.suppressClick = true; return true;
  }
  menuAppearing(): void {
    // A late native menu still belongs to this node until its disappearance.
    this.menuOwned = true; this.suppressClick = true;
    if (!this.visible || !this.placeable || this.panelBusy || this.dragging) { this.quickMenuShown = false; }
  }
  menuClosed(): void {
    this.menuOwned = false; this.quickMenuShown = false;
    const hide: boolean = this.pendingHide; this.pendingHide = false;
    if (hide && this.visible && this.placeable && !this.panelBusy && !this.dragging) { this.hide(); }
  }
  closeQuickMenu(): boolean {
    this.quickMenuShown = false; this.pendingHide = false; return !this.menuOwned;
  }
  keyAction(code: number, down: boolean): boolean {
    if (!down) { return false; }
    // API26 keyCode: MENU, ESCAPE, SPACE and ENTER. No global input listener.
    if (code === 2067) { return this.requestQuickMenu(); }
    if (code === 2070 && (this.quickMenuShown || this.dragging)) {
      this.cancelDrag(); this.closeQuickMenu(); return true;
    }
    if (code === 2050 || code === 2054) { this.beginInteraction(); }
    return false;
  }
  quickAction(action: string): boolean {
    if (!this.quickMenuShown || !this.visible || !this.placeable || this.panelBusy || this.dragging) { return false; }
    if (!['pause', 'resume', 'mark', 'hide'].includes(action)) { return false; }
    this.quickMenuShown = false;
    if (action === 'pause') { this.pause(); }
    else if (action === 'resume') { this.resume(); }
    else if (action === 'mark') { this.mark(); }
    else { this.pendingHide = true; }
    return true;
  }
  activate(): void {
    if (this.suppressClick) { this.suppressClick = false; return; }
    if (this.placeable) { this.open(); }
  }
  clearActions(): void {
    this.releasePosition(); this.closeQuickMenu(); this.problems?.dispose();
    this.open = (): void => {}; this.close = (): void => {};
    this.pause = (): void => {}; this.resume = (): void => {}; this.mark = (): void => {};
    this.refresh = (): void => {}; this.hide = (): void => {};
  }
  private currentBucket(): PositionBucket | undefined {
    return this.buckets.find((entry: PositionBucket): boolean => entry.bucket === this.bucket);
  }
  private async readPosition(): Promise<boolean> {
    const store: FloatingPositionStore | undefined = this.positionStore;
    const entry: PositionBucket | undefined = this.currentBucket();
    if (store === undefined || entry === undefined || entry.loaded || entry.dirty ||
      this.positionReleased || !this.positionActive || this.positionBusy || this.dragging || !this.placeable) {
      return false;
    }
    if (this.positionAttempts >= 256) { this.positionState = 'quota'; return false; }
    this.positionAttempts++;
    this.positionBusy = true; this.positionState = 'restoring';
    const epoch: number = this.positionEpoch, revision: number = entry.revision;
    try {
      const value: FloatingPosition | undefined = await store.read(this.positionScope, entry.bucket);
      if (this.positionReleased || !this.positionActive || epoch !== this.positionEpoch ||
        revision !== entry.revision || this.bucket !== entry.bucket) { return false; }
      if (value !== undefined && !positionValid(value)) { this.positionState = 'unavailable'; return false; }
      const state: string = store.getState?.() ?? 'ready';
      if (state !== 'ready') { this.positionState = state; return false; }
      entry.loaded = true;
      if (value !== undefined) {
        entry.value = { rightSide: value.rightSide, edgeRatio: value.edgeRatio };
        this.rightSide = value.rightSide; this.edgeRatio = value.edgeRatio;
        this.fit(this.rightSide ? this.viewportWidth - 56 : 8,
          8 + this.edgeRatio * (this.viewportHeight - 64), true);
      }
      this.positionState = value === undefined ? 'ready' : 'restored'; return true;
    } catch (_) {
      if (!this.positionReleased && this.positionActive && epoch === this.positionEpoch) {
        this.positionState = 'unavailable';
      }
      return false;
    } finally { this.positionBusy = false; }
  }
  private async savePosition(entry: PositionBucket): Promise<boolean> {
    const store: FloatingPositionStore | undefined = this.positionStore;
    if (store === undefined || this.positionBusy || this.positionReleased || !this.positionActive) { return false; }
    if (this.positionAttempts >= 256) { this.positionState = 'quota'; return false; }
    this.positionAttempts++;
    this.positionBusy = true; this.positionState = 'saving';
    const revision: number = entry.revision, epoch: number = this.positionEpoch;
    const selected: FloatingPosition = { rightSide: entry.value.rightSide, edgeRatio: entry.value.edgeRatio };
    let saved: boolean = false;
    try { saved = await store.write(this.positionScope, entry.bucket, selected); } catch (_) {}
    if (saved && revision === entry.revision) { entry.dirty = false; }
    if (!this.positionReleased && this.positionActive && epoch === this.positionEpoch && this.bucket === entry.bucket) {
      this.positionState = saved && !entry.dirty ? 'saved' : 'save-uncertain';
    }
    this.positionBusy = false; return saved && !entry.dirty;
  }
  private fit(x: number, y: number, edge: boolean): void {
    const choices: number[] = [clamp(y, this.viewportHeight - 56), 8, this.viewportHeight - 56];
    for (const rect of this.rects) {
      choices.push(clamp(rect.top - 56, this.viewportHeight - 56));
      choices.push(clamp(rect.top + rect.height + 8, this.viewportHeight - 56));
    }
    choices.sort((a: number, b: number): number => Math.abs(a - y) - Math.abs(b - y));
    const sides: number[] = edge ? [x, x === 8 ? this.viewportWidth - 56 : 8] : [x];
    for (const side of sides) {
      for (const candidate of choices) {
        if (!this.rects.some((rect: FloatingRect): boolean => rect.width > 0 && rect.height > 0 &&
          side < rect.left + rect.width + 8 && side + 48 > rect.left - 8 &&
          candidate < rect.top + rect.height + 8 && candidate + 48 > rect.top - 8)) {
          this.buttonX = side; this.buttonY = candidate; this.placeable = true; return;
        }
      }
    }
    this.placeable = false; this.visible = false; this.closeQuickMenu();
  }
}
