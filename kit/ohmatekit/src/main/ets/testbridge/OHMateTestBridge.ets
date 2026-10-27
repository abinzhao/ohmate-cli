/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreResult, CoreSchema } from '../api/CoreTypes';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProviderDescriptor, ProviderReadResult, ProviderStatus, SummaryProvider } from '../providers/ProviderTypes';
import { TestBridgeResult, TestObservationAdapter } from './TestTypes';

class TestReadProvider implements SummaryProvider {
  adapter: TestObservationAdapter;
  action: string = 'READY';
  assertionId: string = '';
  constructor(adapter: TestObservationAdapter) { this.adapter = adapter; }
  read(): Promise<Record<string, Object>> {
    // Snapshot the request before native dispatch; no later query may replace it.
    const operation: Promise<boolean> = this.action === 'READY' ? this.adapter.ready() :
      this.adapter.assert(this.assertionId);
    return operation.then((accepted: boolean): Record<string, Object> => {
      if (typeof accepted !== 'boolean') { return {}; }
      return { 'passed': accepted };
    });
  }
  close(): Promise<boolean> { return this.adapter.close(); }
}
function assertionsValid(ids: string[]): boolean {
  try {
    if (ids.length < 1 || ids.length > 32 || new Set<string>(ids).size !== ids.length) { return false; }
    const pattern = new RegExp('^test\\.assert\\.[A-Za-z0-9_-]{1,48}$');
    return ids.every((id: string): boolean => typeof id === 'string' && pattern.test(id));
  } catch (_) { return false; }
}
// Local readonly observations are not a Test HAP connection or replay admission.
export class OHMateTestBridge {
  private enabled: boolean;
  private disposed: boolean = false;
  private registry: ProviderRegistry;
  private provider: TestReadProvider | undefined = undefined;
  private assertions: string[] = [];
  constructor(profile: string, now: () => number) {
    this.enabled = profile === 'test';
    this.registry = new ProviderRegistry(this.enabled ? 'test' : 'release-none', now);
  }
  registerAdapter(adapter: TestObservationAdapter, assertionIds: string[]): CoreResult {
    if (!this.enabled) { return new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
    if (this.disposed) { return new CoreResult('DISPOSED'); }
    if (!assertionsValid(assertionIds)) { return new CoreResult('TEST_ASSERTIONS_INVALID'); }
    if (this.provider !== undefined) { return new CoreResult('TEST_ADAPTER_CONFLICT'); }
    const schema: CoreSchema = { name: 'test.bridge', fields: [{ key: 'passed', kind: 'boolean' }] };
    const descriptor: ProviderDescriptor = { id: 'test-bridge', schema: schema };
    const provider = new TestReadProvider(adapter);
    const result: CoreResult = this.registry.register(descriptor, provider);
    if (result.code === 'REGISTERED') { this.provider = provider; this.assertions = assertionIds.slice(); }
    return result;
  }
  ready(timeoutMs: number = 1000): Promise<TestBridgeResult> { return this.observe('READY', '', timeoutMs); }
  assert(id: string, timeoutMs: number = 1000): Promise<TestBridgeResult> {
    return this.observe('ASSERT', id, timeoutMs);
  }
  getStatus(): ProviderStatus[] { return this.registry.status(); }
  async dispose(): Promise<CoreResult> {
    this.disposed = true;
    const result: CoreResult = await this.registry.dispose();
    if (result.code === 'DISPOSED') { this.provider = undefined; this.assertions = []; }
    return result;
  }
  async retryCleanup(timeoutMs: number = 1000): Promise<CoreResult> {
    const result: CoreResult = await this.registry.retryCleanup('test-bridge', timeoutMs);
    if (result.code === 'UNREGISTERED') { this.provider = undefined; this.assertions = []; }
    return result;
  }
  private observe(event: string, id: string, timeoutMs: number): Promise<TestBridgeResult> {
    if (!this.enabled) { return this.result('CAPABILITY_NOT_AVAILABLE'); }
    if (this.disposed) { return this.result('DISPOSED'); }
    const provider: TestReadProvider | undefined = this.provider;
    if (provider === undefined) { return this.result('TEST_ADAPTER_UNAVAILABLE'); }
    if (event === 'ASSERT' && !this.assertions.includes(id)) { return this.result('TEST_ASSERTION_UNREGISTERED'); }
    if (this.registry.status().some((status: ProviderStatus): boolean => status.pending)) {
      return this.result('PROVIDER_BUSY');
    }
    provider.action = event; provider.assertionId = id;
    return this.registry.capture('test-bridge', timeoutMs).then((capture: ProviderReadResult): TestBridgeResult => {
      const result = new TestBridgeResult(capture.code);
      if (capture.code !== 'CAPTURED') { return result; }
      const passed: string | number | boolean = capture.fields['passed'];
      if (typeof passed !== 'boolean') { result.code = 'TEST_RESULT_INVALID'; return result; }
      result.code = event === 'READY' ? 'READY_REPORTED' : 'ASSERT_REPORTED';
      result.event = event; result.assertionId = id; result.passed = passed;
      return result;
    });
  }
  private result(code: string): Promise<TestBridgeResult> {
    return Promise.resolve<TestBridgeResult>(new TestBridgeResult(code));
  }
}
