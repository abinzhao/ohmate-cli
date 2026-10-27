/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreArchiveResult, CoreFault, CoreHealth, CoreOptions, CoreProblem, CoreResult } from '../api/CoreTypes';
import { OHMateCore } from '../core/OHMateCore';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProviderDescriptor, ProviderReadResult, ProviderStatus, SummaryProvider } from '../providers/ProviderTypes';
import { DebugWindowHost, DebugWindowStatus } from './DebugTypes';
import { DebugWindows } from './DebugWindows';

// Owns an explicit Core and application surface Adapters; construction is inert.
// A local Profile does not establish compiler evidence or remote admission.
export class OHMateDebug {
  private core: OHMateCore;
  private enabled: boolean;
  private providers: ProviderRegistry;
  private windows: DebugWindows;
  constructor(core: OHMateCore, profile: string, now: () => number) {
    this.core = core; this.enabled = profile === 'debug' || profile === 'test';
    this.providers = new ProviderRegistry(profile, now); this.windows = new DebugWindows(profile, now);
  }
  start(options: CoreOptions = new CoreOptions()): Promise<CoreResult> {
    return this.enabled ? this.core.start(options) : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  mark(name: string, fields: Record<string, Object>): CoreResult {
    return this.enabled ? this.core.mark(name, fields) : new CoreResult('CAPABILITY_NOT_AVAILABLE');
  }
  recordFault(fault: CoreFault): CoreResult {
    return this.enabled ? this.core.recordFault(fault) : new CoreResult('CAPABILITY_NOT_AVAILABLE');
  }
  pause(): CoreResult { return this.enabled ? this.core.pause() : new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
  resume(): CoreResult { return this.enabled ? this.core.resume() : new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
  flush(): Promise<CoreResult> {
    return this.enabled ? this.core.flush() : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  stopNormally(): Promise<CoreResult> {
    return this.enabled ? this.core.stopNormally() : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  getHealth(): CoreHealth { return this.core.getHealth(); }
  createProblem(): Promise<CoreResult> {
    return this.enabled ? this.core.createProblem() : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  listProblems(): CoreProblem[] { return this.enabled ? this.core.listProblems() : []; }
  getProblem(id: string): CoreProblem | undefined { return this.enabled ? this.core.getProblem(id) : undefined; }
  deleteProblem(id: string): Promise<CoreResult> {
    return this.enabled ? this.core.deleteProblem(id) : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  prune(): Promise<CoreResult> {
    return this.enabled ? this.core.prune() : Promise.resolve<CoreResult>(new CoreResult('CAPABILITY_NOT_AVAILABLE'));
  }
  reviewArchive(id: string): CoreResult {
    return this.enabled ? this.core.reviewArchive(id) : new CoreResult('CAPABILITY_NOT_AVAILABLE');
  }
  exportArchive(id: string, reviewHash: string = ''): CoreArchiveResult {
    return this.enabled ? this.core.exportArchive(id, reviewHash) : new CoreArchiveResult('CAPABILITY_NOT_AVAILABLE');
  }
  registerProvider(descriptor: ProviderDescriptor, provider: SummaryProvider): CoreResult {
    return this.providers.register(descriptor, provider);
  }
  captureProvider(id: string, timeoutMs: number = 1000): Promise<ProviderReadResult> {
    return this.providers.capture(id, timeoutMs);
  }
  unregisterProvider(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return this.providers.unregister(id, timeoutMs);
  }
  retryProviderCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return this.providers.retryCleanup(id, timeoutMs);
  }
  getProviders(): ProviderStatus[] { return this.providers.status(); }
  attachWindow(id: string, host: DebugWindowHost, timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.attach(id, host, timeoutMs);
  }
  detachWindow(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.detach(id, timeoutMs);
  }
  retryWindowCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.detach(id, timeoutMs, true);
  }
  openPanel(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.control('open', id, timeoutMs);
  }
  closePanel(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.control('close', id, timeoutMs);
  }
  showFloatingButton(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.control('show', id, timeoutMs);
  }
  hideFloatingButton(id: string = '', timeoutMs: number = 1000): Promise<CoreResult> {
    return this.windows.control('hide', id, timeoutMs);
  }
  updateConfiguration(id: string): CoreResult { return this.windows.updateConfiguration(id); }
  getWindows(): DebugWindowStatus[] { return this.windows.status(); }
  observeWindow(id: string, host: DebugWindowHost, event: string): void { this.windows.observe(id, host, event); }
  async dispose(disposeCore: boolean = true): Promise<CoreResult> {
    const results: CoreResult[] = await Promise.all<CoreResult>([
      this.windows.dispose(), this.providers.dispose(),
      this.enabled && disposeCore ? this.core.dispose() : Promise.resolve<CoreResult>(new CoreResult('DISPOSED')),
    ]);
    return results.find((result: CoreResult): boolean => result.code === 'WINDOW_CLEANUP_REQUIRED') ??
      results.find((result: CoreResult): boolean => result.code === 'PROVIDER_CLEANUP_REQUIRED') ?? results[2];
  }
}
