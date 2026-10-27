/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { UIContext } from '@kit.ArkUI';
import { CoreArchiveResult, CoreFault, CoreHealth, CoreOptions, CoreProblem, CoreResult, CoreSchema } from '../api/CoreTypes';
import { OHMateKit } from '../api/OHMateKit';
import { ContextCoreOwner } from '../core/ContextCoreOwner';
import { OHMateCore, optionsValid } from '../core/OHMateCore';
import { OHMateDebug } from '../debug/OHMateDebug';
import { DebugWindowStatus } from '../debug/DebugTypes';
import { ProviderDescriptor, ProviderReadResult, ProviderStatus, SummaryProvider } from '../providers/ProviderTypes';
import { OHMateTestBridge } from '../testbridge/OHMateTestBridge';
import { TestBridgeResult, TestObservationAdapter } from '../testbridge/TestTypes';
import { DebugViewModel, FloatingRect } from './DebugViewModel';
import { positionScopeValid } from './FloatingPosition';
import { HarmonyDebugWindowHost } from './HarmonyDebugWindowHost';
import { HarmonyPositionPreferences } from './HarmonyPositionPreferences';

class RuntimeWindow {
  id: string;
  context: UIContext | undefined;
  model: DebugViewModel = new DebugViewModel();
  host: HarmonyDebugWindowHost;
  positionKey: string;
  bound: boolean = true;
  constructor(id: string, context: UIContext, positions: HarmonyPositionPreferences | undefined, positionKey: string,
    core: OHMateCore, abilityContext: common.Context) {
    this.id = id; this.context = context; this.positionKey = positionKey;
    if (positions !== undefined && positionKey !== '') { this.model.configurePosition(positions, positionKey); }
    this.host = new HarmonyDebugWindowHost(context, this.model, (event: string): void => {
      if (event === 'destroyed') { this.unbind(); }
      if (event === 'detached') { this.release(); }
      OHMateRuntime.observeWindow(this.id, this.host, event);
    });
    this.host.configureProblems(core, abilityContext,
      (): number => systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false));
  }
  unbind(): void {
    this.bound = false; this.model.clearActions(); this.model.visible = false; this.model.panelBusy = false;
  }
  release(): void { this.unbind(); this.context = undefined; this.model.problemIds = []; }
}

// Explicit Debug/Test application entry. Profiles remain application declarations.
// Default/Core imports never point into this composition.
export class OHMateRuntime {
  private static debug: OHMateDebug | undefined = undefined;
  private static testBridge: OHMateTestBridge | undefined = undefined;
  private static profile: string = '';
  private static disposed: boolean = false;
  private static windows: RuntimeWindow[] = [];
  private static positions: HarmonyPositionPreferences | undefined = undefined;
  private static abilityContext: common.Context | undefined = undefined;
  static registerSchema(schema: CoreSchema): CoreResult { return OHMateKit.registerSchema(schema); }
  static async start(context: common.Context, profile: string = 'debug',
    options: CoreOptions = new CoreOptions()): Promise<CoreResult> {
    if (OHMateRuntime.disposed) { return new CoreResult('DISPOSED'); }
    if (profile !== 'debug' && profile !== 'test') { return new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
    try {
      if (!optionsValid(options)) { return new CoreResult('OPTIONS_INVALID'); }
      if (typeof context.filesDir !== 'string' || context.filesDir === '') { return new CoreResult('START_CONTEXT_INVALID'); }
      if (OHMateRuntime.profile !== '' && OHMateRuntime.profile !== profile) { return new CoreResult('START_PROFILE_CONFLICT'); }
      const operation: Promise<CoreResult> = OHMateKit.start(context, options);
      // Reserve the Profile before yielding; another concurrent start cannot replace it.
      const core: OHMateCore | undefined = ContextCoreOwner.getCore();
      if (core !== undefined && ContextCoreOwner.ownsContext(context.filesDir) && ContextCoreOwner.ownsOptions(options)) {
        OHMateRuntime.profile = profile;
      }
      const result: CoreResult = await operation;
      if (OHMateRuntime.disposed) { return new CoreResult('START_CANCELLED'); }
      if (core !== undefined && OHMateRuntime.debug === undefined &&
        ['STARTED', 'START_DEGRADED', 'ALREADY_STARTED'].includes(result.code)) {
        const now: () => number = (): number => systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
        OHMateRuntime.debug = new OHMateDebug(core, profile, now);
        OHMateRuntime.testBridge = new OHMateTestBridge(profile, now);
        OHMateRuntime.positions = new HarmonyPositionPreferences(context);
        OHMateRuntime.abilityContext = context;
      }
      return result;
    } catch (_) { return new CoreResult('START_DEGRADED'); }
  }
  static mark(name: string, fields: Record<string, Object>): CoreResult {
    return OHMateRuntime.debug?.mark(name, fields) ?? new CoreResult(OHMateRuntime.gate());
  }
  static recordFault(fault: CoreFault): CoreResult {
    return OHMateRuntime.debug?.recordFault(fault) ?? new CoreResult(OHMateRuntime.gate());
  }
  static pause(): CoreResult { return OHMateRuntime.debug?.pause() ?? new CoreResult(OHMateRuntime.gate()); }
  static resume(): CoreResult { return OHMateRuntime.debug?.resume() ?? new CoreResult(OHMateRuntime.gate()); }
  static flush(): Promise<CoreResult> {
    return OHMateRuntime.debug?.flush() ?? Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static stopNormally(): Promise<CoreResult> {
    return OHMateRuntime.debug?.stopNormally() ?? Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static getHealth(): CoreHealth { return OHMateKit.getHealth(); }
  static createProblem(): Promise<CoreResult> {
    return OHMateRuntime.debug?.createProblem() ?? Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static listProblems(): CoreProblem[] { return OHMateRuntime.debug?.listProblems() ?? []; }
  static getProblem(id: string): CoreProblem | undefined { return OHMateRuntime.debug?.getProblem(id); }
  static reviewArchive(id: string): CoreResult {
    return OHMateRuntime.debug?.reviewArchive(id) ?? new CoreResult(OHMateRuntime.gate());
  }
  static exportArchive(id: string, reviewHash: string = ''): CoreArchiveResult {
    return OHMateRuntime.debug?.exportArchive(id, reviewHash) ?? new CoreArchiveResult(OHMateRuntime.gate());
  }
  static deleteProblem(id: string): Promise<CoreResult> {
    return OHMateRuntime.debug?.deleteProblem(id) ?? Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static prune(): Promise<CoreResult> {
    return OHMateRuntime.debug?.prune() ?? Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static registerProvider(descriptor: ProviderDescriptor, provider: SummaryProvider): CoreResult {
    return OHMateRuntime.debug?.registerProvider(descriptor, provider) ?? new CoreResult(OHMateRuntime.gate());
  }
  static captureProvider(id: string, timeoutMs: number = 1000): Promise<ProviderReadResult> {
    return OHMateRuntime.debug?.captureProvider(id, timeoutMs) ??
      Promise.resolve<ProviderReadResult>(new ProviderReadResult(OHMateRuntime.gate()));
  }
  static getProviders(): ProviderStatus[] { return OHMateRuntime.debug?.getProviders() ?? []; }
  static unregisterProvider(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.debug?.unregisterProvider(id, timeoutMs) ??
      Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static retryProviderCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.debug?.retryProviderCleanup(id, timeoutMs) ??
      Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static registerTestAdapter(adapter: TestObservationAdapter, assertionIds: string[]): CoreResult {
    return OHMateRuntime.testBridge?.registerAdapter(adapter, assertionIds) ?? new CoreResult(OHMateRuntime.gate());
  }
  static ready(timeoutMs: number = 1000): Promise<TestBridgeResult> {
    return OHMateRuntime.testBridge?.ready(timeoutMs) ??
      Promise.resolve<TestBridgeResult>(new TestBridgeResult(OHMateRuntime.gate()));
  }
  static assert(id: string, timeoutMs: number = 1000): Promise<TestBridgeResult> {
    return OHMateRuntime.testBridge?.assert(id, timeoutMs) ??
      Promise.resolve<TestBridgeResult>(new TestBridgeResult(OHMateRuntime.gate()));
  }
  static retryTestCleanup(timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.testBridge?.retryCleanup(timeoutMs) ??
      Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
  }
  static async attachWindow(context: UIContext, timeoutMs: number = 1000, positionKey: string = ''): Promise<CoreResult> {
    const debug: OHMateDebug | undefined = OHMateRuntime.debug;
    if (OHMateRuntime.disposed || debug === undefined) { return new CoreResult(OHMateRuntime.gate()); }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) {
      return new CoreResult('WINDOW_TIMEOUT_INVALID');
    }
    if (positionKey !== '' && !positionScopeValid(positionKey)) { return new CoreResult('POSITION_KEY_INVALID'); }
    try {
      const id: number | undefined = context.getWindowId();
      if (id === undefined || !Number.isSafeInteger(id) || id < 0) { return new CoreResult('WINDOW_ID_INVALID'); }
      const key: string = 'window-' + id;
      let slot: RuntimeWindow | undefined = OHMateRuntime.find(key);
      if (slot !== undefined && slot.context !== context) { return new CoreResult('WINDOW_CONFLICT'); }
      if (slot !== undefined && slot.positionKey !== positionKey) { return new CoreResult('POSITION_KEY_CONFLICT'); }
      if (slot === undefined) {
        if (OHMateRuntime.windows.length >= 32) { return new CoreResult('WINDOW_QUOTA'); }
        if (positionKey !== '' && OHMateRuntime.windows.some((entry: RuntimeWindow): boolean =>
          entry.context !== undefined && entry.positionKey === positionKey)) {
          return new CoreResult('POSITION_KEY_CONFLICT');
        }
        const core: OHMateCore | undefined = ContextCoreOwner.getCore();
        const abilityContext: common.Context | undefined = OHMateRuntime.abilityContext;
        if (core === undefined || abilityContext === undefined) { return new CoreResult('WINDOW_UNAVAILABLE'); }
        slot = new RuntimeWindow(key, context, OHMateRuntime.positions, positionKey, core, abilityContext);
        OHMateRuntime.windows.push(slot); OHMateRuntime.bind(slot);
      }
      const result: CoreResult = await debug.attachWindow(key, slot.host, timeoutMs);
      if (result.code !== 'WINDOW_ATTACHED' || !slot.bound || OHMateRuntime.disposed) { return result; }
      OHMateRuntime.refresh(slot, result);
      const shown: CoreResult = await OHMateRuntime.showFloatingButton(key, timeoutMs);
      // A window can become hidden between attach and show; attachment still has its exact owner.
      return ['FLOATING_VISIBLE', 'WINDOW_HIDDEN', 'WINDOW_BUSY'].includes(shown.code) ? result : shown;
    } catch (_) { return new CoreResult('WINDOW_UNAVAILABLE'); }
  }
  static async detachWindow(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id); slot?.unbind();
    const result: CoreResult = await (OHMateRuntime.debug?.detachWindow(id, timeoutMs) ??
      Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate())));
    if (result.code === 'WINDOW_DETACHED') { slot?.release(); }
    return result;
  }
  static async retryWindowCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id); slot?.unbind();
    const result: CoreResult = await (OHMateRuntime.debug?.retryWindowCleanup(id, timeoutMs) ??
      Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate())));
    if (result.code === 'WINDOW_DETACHED') { slot?.release(); }
    return result;
  }
  static getWindows(): DebugWindowStatus[] { return OHMateRuntime.debug?.getWindows() ?? []; }
  static async retryArchiveSaveCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id);
    if (slot?.model.problems === undefined) { return new CoreResult('SAVE_UNAVAILABLE'); }
    const cleaned: boolean = await slot.model.problems.retryCleanup(timeoutMs);
    return new CoreResult(cleaned ? 'SAVE_CLEANED' : 'SAVE_CLEANUP_REQUIRED');
  }
  static getPositionState(id: string): string {
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id);
    return slot !== undefined && slot.bound && !OHMateRuntime.disposed ? slot.model.positionState : 'unavailable';
  }
  static async retryPosition(id: string): Promise<CoreResult> {
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id);
    if (slot === undefined || !slot.bound || OHMateRuntime.disposed) { return new CoreResult('POSITION_UNAVAILABLE'); }
    if (slot.model.panelBusy) { return new CoreResult('WINDOW_BUSY'); }
    const restored: boolean = await slot.model.retryPosition();
    return new CoreResult(!slot.bound || OHMateRuntime.disposed ? 'POSITION_UNAVAILABLE' :
      restored ? 'POSITION_UPDATED' : 'POSITION_UNAVAILABLE');
  }
  static openPanel(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.windowAction('open', id, timeoutMs);
  }
  static closePanel(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.windowAction('close', id, timeoutMs);
  }
  static showFloatingButton(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.windowAction('show', id, timeoutMs);
  }
  static hideFloatingButton(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return OHMateRuntime.windowAction('hide', id, timeoutMs);
  }
  static setAvoidRects(id: string, rects: FloatingRect[]): CoreResult {
    if (OHMateRuntime.disposed) { return new CoreResult('DISPOSED'); }
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id);
    return new CoreResult(slot === undefined || !slot.bound ? 'WINDOW_UNAVAILABLE' :
      slot.host.setAvoidRects(rects) ? 'AVOID_RECTS_UPDATED' : 'AVOID_RECTS_INVALID');
  }
  static updateConfiguration(id: string): CoreResult {
    const debug: OHMateDebug | undefined = OHMateRuntime.debug;
    if (OHMateRuntime.disposed || debug === undefined) { return new CoreResult(OHMateRuntime.gate()); }
    const slot: RuntimeWindow | undefined = OHMateRuntime.find(id);
    if (slot === undefined || !slot.bound) { return new CoreResult('WINDOW_UNAVAILABLE'); }
    if (slot.model.panelBusy) { return new CoreResult('WINDOW_BUSY'); }
    const result: CoreResult = debug.updateConfiguration(id);
    OHMateRuntime.refresh(slot, result); return result;
  }
  static observeWindow(id: string, host: HarmonyDebugWindowHost, event: string): void {
    OHMateRuntime.debug?.observeWindow(id, host, event);
  }
  static async dispose(): Promise<CoreResult> {
    OHMateRuntime.disposed = true;
    for (const slot of OHMateRuntime.windows) { slot.unbind(); }
    const debug: CoreResult = await (OHMateRuntime.debug?.dispose(false) ??
      Promise.resolve<CoreResult>(new CoreResult('DISPOSED')));
    const testBridge: CoreResult = await (OHMateRuntime.testBridge?.dispose() ??
      Promise.resolve<CoreResult>(new CoreResult('DISPOSED')));
    const positions: boolean = await (OHMateRuntime.positions?.close() ?? Promise.resolve<boolean>(true));
    const core: CoreResult = await OHMateKit.dispose();
    for (const status of OHMateRuntime.getWindows()) {
      if (status.state === 'detached') { OHMateRuntime.find(status.windowId)?.release(); }
    }
    return debug.code !== 'DISPOSED' ? debug : testBridge.code !== 'DISPOSED' ? testBridge :
      !positions ? new CoreResult('POSITION_CLEANUP_REQUIRED') : core;
  }
  private static bind(slot: RuntimeWindow): void {
    slot.model.open = (): void => {
      if (slot.bound) { OHMateRuntime.openPanel(slot.id).then((): void => {}); }
    };
    slot.model.close = (): void => {
      if (slot.bound) { OHMateRuntime.closePanel(slot.id).then((): void => {}); }
    };
    slot.model.hide = (): void => {
      if (slot.bound) { OHMateRuntime.hideFloatingButton(slot.id).then((): void => {}); }
    };
    slot.model.pause = (): void => { OHMateRuntime.run(slot, (): Promise<CoreResult> =>
      Promise.resolve<CoreResult>(OHMateRuntime.pause())).then((): void => {}); };
    slot.model.resume = (): void => { OHMateRuntime.run(slot, (): Promise<CoreResult> =>
      Promise.resolve<CoreResult>(OHMateRuntime.resume())).then((): void => {}); };
    slot.model.mark = (): void => { OHMateRuntime.run(slot, (): Promise<CoreResult> =>
      OHMateRuntime.createProblem()).then((): void => {}); };
    slot.model.refresh = (): void => { OHMateRuntime.refresh(slot, new CoreResult('REFRESHED')); };
  }
  private static async run(slot: RuntimeWindow, operation: () => Promise<CoreResult>,
    closing: boolean = false): Promise<CoreResult> {
    if (!slot.bound || OHMateRuntime.disposed) { return new CoreResult(OHMateRuntime.gate()); }
    if (slot.model.panelBusy) { return new CoreResult('WINDOW_BUSY'); }
    if (!closing && slot.model.problems?.busy) { return new CoreResult('WINDOW_BUSY'); }
    slot.model.panelBusy = true;
    let result = new CoreResult('ACTION_UNAVAILABLE');
    try { result = await operation(); } catch (_) {}
    if (slot.bound && !OHMateRuntime.disposed) {
      slot.model.panelBusy = false; OHMateRuntime.refresh(slot, result);
    }
    return result;
  }
  private static windowAction(action: string, id: string, timeoutMs: number): Promise<CoreResult> {
    const debug: OHMateDebug | undefined = OHMateRuntime.debug;
    if (OHMateRuntime.disposed || debug === undefined) {
      return Promise.resolve<CoreResult>(new CoreResult(OHMateRuntime.gate()));
    }
    const candidates: RuntimeWindow[] = OHMateRuntime.windows.filter((slot: RuntimeWindow): boolean =>
      slot.context !== undefined);
    if (id === '' && candidates.length > 1) {
      return Promise.resolve<CoreResult>(new CoreResult('WINDOW_AMBIGUOUS'));
    }
    const slot: RuntimeWindow | undefined = id === '' ? candidates[0] : OHMateRuntime.find(id);
    if (slot === undefined || slot.context === undefined) {
      return Promise.resolve<CoreResult>(new CoreResult('WINDOW_UNAVAILABLE'));
    }
    // Closing and hiding revoke saves before the general busy gate; neither
    // releases its original Picker/file owner or waits for it to finish.
    if (action === 'close' || action === 'hide') {
      slot.model.problems?.suspend();
      return OHMateRuntime.run(slot, (): Promise<CoreResult> => action === 'close' ?
        debug.closePanel(slot.id, timeoutMs) : debug.hideFloatingButton(slot.id, timeoutMs), true);
    }
    return OHMateRuntime.run(slot, (): Promise<CoreResult> => {
      if (action === 'open') { return debug.openPanel(slot.id, timeoutMs); }
      if (action === 'close') { return debug.closePanel(slot.id, timeoutMs); }
      if (action === 'show') { return debug.showFloatingButton(slot.id, timeoutMs); }
      return debug.hideFloatingButton(slot.id, timeoutMs);
    });
  }
  private static refresh(slot: RuntimeWindow, result: CoreResult): void {
    if (!slot.bound || OHMateRuntime.disposed) { return; }
    const health: CoreHealth = OHMateRuntime.getHealth();
    slot.model.sessionState = health.state; slot.model.storedBytes = health.storageAccountedBytes >= 0 ?
      health.storageAccountedBytes : health.storageBytes + health.problemBytes;
    slot.model.dropped = health.dropped; slot.model.resultCode = result.code;
    slot.model.problemIds = OHMateRuntime.listProblems().map((problem: CoreProblem): string => problem.problemId);
    if (slot.model.problems?.selectedId !== '') { slot.model.problems?.refresh(); }
  }
  private static find(id: string): RuntimeWindow | undefined {
    for (let index: number = OHMateRuntime.windows.length - 1; index >= 0; index--) {
      if (OHMateRuntime.windows[index].id === id && OHMateRuntime.windows[index].context !== undefined) {
        return OHMateRuntime.windows[index];
      }
    }
    return undefined;
  }
  private static gate(): string { return OHMateRuntime.disposed ? 'DISPOSED' : 'NOT_ACTIVE'; }
}
