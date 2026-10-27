/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { HdsNavigation, HdsNavigationTitleMode } from '@kit.UIDesignKit';
import { http } from '@kit.NetworkKit';
import { webview } from '@kit.ArkWeb';
import { producer, ProducerState } from '../bridge/ProducerController';
import { BodyRule } from '../bridge/NetworkBodyCapture';
import { MockRules, MockRule, MockResponseRule, MockSample, MockMatch, MockHttpResponse } from '../bridge/NetworkMock';
import { ResourceRule, ResourceSample } from '../bridge/WebResourceOverride';
import { ResourceFileEntry } from '../bridge/WebResourceFiles';
import { ControlledStorageAccess } from '../bridge/ControlledStorage';
import { StorageWriteReview } from '../bridge/StorageWriteSession';
import { UiHighlightHost, UiHighlightReview } from '../bridge/UiHighlightSession';
import { ReplayAdapter, ReplayDescriptor, SemanticReplayStep, ReplayReview } from '../bridge/SemanticReplaySession';

// Development-only Producer: fetch the local workbench invitation without a paste.
// Production workbenches never expose /dev-invitation, so this attempt simply fails.
const DEV_AUTO_PAIR: boolean = true;

@Entry
@ComponentV2
struct Index {
  @Local private state: ProducerState = producer.state;
  @Local private invitationText: string = '';
  @Local private networkPhase: string = 'idle';
  @Local private webLoadPhase: string = 'idle';
  @Local private mockMatches: number = 0;
  @Local private mockResult: string = 'idle';
  @Local private resourceExpectedHits: number = 0;
  @Local private resourceFailed: boolean = false;
  @Local private consoleCode: string = '';
  @Local private consoleFailed: boolean = false;
  @Local private domStorageAllowed: boolean = false;
  @Local private storageArea: number = 0;
  @Local private storageOperation: number = 0;
  @Local private storageReview: StorageWriteReview | undefined = undefined;
  @Local private storageWriteFailed: boolean = false;
  @Local private highlightCommand: string = '';
  @Local private highlightReview: UiHighlightReview | undefined = undefined;
  @Local private highlightFailed: boolean = false;
  @Local private replayMarker: boolean = false;
  @Local private replayReview: ReplayReview | undefined = undefined;
  @Local private replayFailed: boolean = false;
  private replayCommand: string = '';
  private replayOriginal: boolean = false;
  private paths: NavPathStack = new NavPathStack();
  private networkRequest: http.HttpRequest | undefined = undefined;
  private webController: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    producer.initialize();
    if (DEV_AUTO_PAIR) { setTimeout(() => { void this.autoPairDev(); }, 800); }
  }
  aboutToDisappear(): void {
    this.invitationText = ''; this.consoleCode = '';
    void producer.stop();
    this.closeNetwork();
  }
  @Monitor('state.phase')
  onPhaseChanged(): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped') { this.invitationText = ''; }
    if (this.state.phase === 'closing' || this.state.phase === 'stopped' || this.state.phase === 'cleanup-failed') {
      this.consoleCode = ''; this.consoleFailed = false;
      this.domStorageAllowed = false;
      this.closeNetwork();
    }
  }
  private closeNetwork(): boolean {
    try {
      this.networkRequest?.destroy(); this.networkRequest = undefined;
      this.networkPhase = 'idle'; this.mockMatches = 0; this.mockResult = 'idle';
      this.resourceFailed = false; this.resourceExpectedHits = 0; return true;
    }
    catch { this.networkPhase = 'cleanup-failed'; return false; }
  }
  private async autoPairDev(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped') { return; }
    try {
      const text = await producer.devInvitation();
      this.prepareWith(text);
      await producer.confirm();
    } catch {
      // The manual invitation field stays available when the dev workbench is absent.
    }
  }
  private prepare(): void { this.prepareWith(this.invitationText); }
  private prepareWith(text: string): void {
    try {
      if (!this.closeNetwork()) { return; }
      this.networkRequest = http.createHttp();
      producer.registerNetwork(this.networkRequest);
      const highlightHost: UiHighlightHost = {
        apply: (commandId: string): boolean => this.applyUiHighlight(commandId),
        clear: (commandId: string): boolean => this.clearUiHighlight(commandId)
      };
      producer.registerUi(this.getUIContext(), 'bridge_capture_root', 'page-main', true, highlightHost);
      producer.registerReplay(this.replayAdapter());
      producer.review(text);
      if (canIUse('SystemCapability.Web.Webview.Core')) {
        this.webController = new webview.WebviewController();
        const resource: ResourceFileEntry = { url: this.bodyOrigin() + '/kit-readonly.css',
          mimeType: 'text/css', sensitivity: 'ordinary', name: 'ohmate-resources/readonly.css',
          bytes: 28, sha256: '437faf21ac9c64146bfdcd9c8950ebc585b6da21b074f9664620bbe357aa2142' };
        const storageAccess: ControlledStorageAccess = {
          enabled: (): boolean => this.domStorageAllowed,
          entries: [
            { area: 'local', key: 'ohmate-test-local', sensitivity: 'ordinary' },
            { area: 'session', key: 'ohmate-test-session', sensitivity: 'ordinary' }
          ]
        };
        const context = this.getUIContext().getHostContext();
        if (context === undefined) { throw new Error('RESOURCE_FILE_UNAVAILABLE'); }
        producer.registerWebFiles(this.webController, 'web-main',
          this.state.connectionTarget.replace('ws:', 'http:').replace('/bridge/v1', '/kit-readonly.html'),
          context.resourceManager, [resource], true, storageAccess, true);
      }
    }
    catch {
      this.resourceFailed = true;
      void producer.stop('RESOURCE_PREPARE_FAILED');
    }
    finally { this.invitationText = ''; }
  }
  private async probeNetwork(): Promise<void> {
    if (this.state.phase !== 'connected' || !this.state.networkAvailable || this.networkPhase !== 'idle' ||
      this.state.networkBodyPhase !== 'idle' || this.state.networkMockPhase !== 'idle') { return; }
    const owner = this.networkRequest;
    this.networkPhase = 'requesting';
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.HEAD, usingProxy: false, connectTimeout: 3000, readTimeout: 3000, maxLimit: 1024
    };
    try {
      // The confirmed loopback workbench returns 405 for HEAD; this is a real
      // status sample, without parsing or copying a response body.
      await producer.requestNetwork(this.state.connectionTarget.replace('ws:', 'http:').replace('/bridge/v1', '/'), options);
      if (this.state.phase === 'connected' && this.networkRequest === owner) { this.networkPhase = 'completed'; }
    } catch {
      if (this.state.phase === 'connected' && this.networkRequest === owner) { this.networkPhase = 'failed'; }
    }
  }
  private bodyOrigin(): string {
    return this.state.connectionTarget.replace('ws:', 'http:').replace('/bridge/v1', '');
  }
  private reviewBody(): void {
    if (this.networkPhase !== 'idle' || this.state.networkMockPhase !== 'idle') { return; }
    const rule: BodyRule = {
      version: '1', targetId: 'network-main', origin: this.bodyOrigin(), path: '/ohmate-body-sample',
      contentTypes: ['application/json', 'text/plain'], maxBytes: 1024, maxTotalBytes: 1024, ttlMs: 30000
    };
    try { producer.reviewNetworkBody(JSON.stringify(rule)); }
    catch { this.state.networkBodyPhase = 'failed'; }
  }
  private async probeBody(): Promise<void> {
    if (this.networkPhase !== 'idle' || !producer.confirmNetworkBody(this.state.networkBodyPlanHash)) { return; }
    const owner = this.networkRequest;
    this.networkPhase = 'requesting';
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET, usingProxy: false, connectTimeout: 3000, readTimeout: 3000,
      maxLimit: 1024, maxRedirects: 0, usingCache: false, expectDataType: http.HttpDataType.STRING
    };
    try {
      // An absent static asset returns the workbench's fixed JSON 404 error.
      // This request uses no user account or private application endpoint.
      await producer.requestNetwork(this.bodyOrigin() + '/ohmate-body-sample', options, 'ordinary');
      if (this.state.phase === 'connected' && this.networkRequest === owner) { this.networkPhase = 'completed'; }
    } catch {
      if (this.state.phase === 'connected' && this.networkRequest === owner) { this.networkPhase = 'failed'; }
    }
  }
  private bodyLabel(): Resource {
    if (this.state.networkBodyPhase === 'review') { return $r('app.string.bridge_body_review'); }
    if (this.state.networkBodyPhase === 'active') { return $r('app.string.bridge_body_active'); }
    if (this.state.networkBodyPhase === 'failed') { return $r('app.string.bridge_body_failed'); }
    return $r('app.string.bridge_body_idle');
  }
  private reviewMock(): void {
    if (this.networkPhase !== 'idle' || this.state.networkBodyPhase !== 'idle') { return; }
    this.mockResult = 'idle'; this.mockMatches = 0;
    const response: MockResponseRule = { kind: 'template', status: 202,
      headers: { 'content-type': 'application/json' }, template: '{"scenario":"{{test.scenario}}"}',
      variables: { 'test.scenario': 'ohmate-local-demo' }, delayMs: 0 };
    const rule: MockRule = { ruleId: 'local-demo', priority: 1, origin: this.bodyOrigin(),
      method: 'GET', path: '/ohmate-mock-sample', headers: { 'x-ohmate-scenario': 'local-demo' },
      resourceType: 'fetch', response: response };
    const rules: MockRules = { version: '1', targetId: 'network-main', rules: [rule] };
    const sample: MockSample = { requestId: 'sample-1', targetId: 'network-main', origin: this.bodyOrigin(),
      method: 'GET', path: '/ohmate-mock-sample', headers: { 'x-ohmate-scenario': 'local-demo' },
      resourceType: 'fetch', sensitivity: 'ordinary' };
    try {
      const review = producer.reviewNetworkMock(JSON.stringify(rules), JSON.stringify([sample]));
      this.mockMatches = review.matches.filter((value: MockMatch): boolean => value.decision === 'mock').length;
    } catch { this.mockResult = 'failed'; }
  }
  private confirmMock(): void {
    if (!producer.confirmNetworkMock(this.state.networkMockPlanHash)) { this.mockResult = 'failed'; }
  }
  private cancelMock(): void {
    producer.cancelNetworkMock(); this.mockMatches = 0; this.mockResult = 'idle';
  }
  private async probeMock(): Promise<void> {
    if (this.networkPhase !== 'idle' || producer.networkMockStatus().phase !== 'active') { return; }
    const owner = this.networkRequest;
    this.networkPhase = 'requesting';
    const options: http.HttpRequestOptions = { method: http.RequestMethod.GET, usingProxy: false,
      connectTimeout: 3000, readTimeout: 3000, maxLimit: 1024, maxRedirects: 0, usingCache: false,
      expectDataType: http.HttpDataType.STRING, header: { 'x-ohmate-scenario': 'local-demo' } };
    try {
      const response = await producer.requestNetwork(this.bodyOrigin() + '/ohmate-mock-sample',
        options, 'ordinary', 'fetch') as MockHttpResponse;
      if (this.state.phase === 'connected' && this.networkRequest === owner) {
        this.mockResult = response.mock === true && response.source === 'application-local-mock' &&
          response.ruleId === 'local-demo' && response.responseCode === 202 &&
          response.resultType === http.HttpDataType.STRING &&
          response.result === '{"scenario":"ohmate-local-demo"}' ? 'completed' : 'failed';
        this.networkPhase = this.mockResult;
      }
    } catch {
      if (this.state.phase === 'connected' && this.networkRequest === owner) {
        this.mockResult = 'failed'; this.networkPhase = 'failed';
      }
    }
  }
  private mockLabel(): Resource {
    if (this.mockResult === 'failed') { return $r('app.string.bridge_mock_failed'); }
    if (this.state.networkMockPhase === 'review') { return $r('app.string.bridge_mock_review', this.mockMatches); }
    if (this.state.networkMockPhase === 'active') { return $r('app.string.bridge_mock_active'); }
    return $r('app.string.bridge_mock_idle');
  }
  private networkLabel(): Resource {
    switch (this.networkPhase) {
      case 'requesting': return $r('app.string.bridge_network_requesting');
      case 'completed': return $r('app.string.bridge_network_completed');
      case 'cleanup-failed': return $r('app.string.bridge_network_cleanup');
      default: return $r('app.string.bridge_network_failed');
    }
  }
  private webLabel(): Resource {
    if (!this.state.webAvailable) { return $r('app.string.bridge_web_unavailable'); }
    if (this.state.webPhase === 'reading') { return $r('app.string.bridge_web_reading'); }
    if (this.state.webPhase === 'failed') { return $r('app.string.bridge_web_failed'); }
    if (this.webLoadPhase === 'failed') { return $r('app.string.bridge_web_load_failed'); }
    if (this.webLoadPhase !== 'ready') { return $r('app.string.bridge_web_loading'); }
    return $r('app.string.bridge_web_ready');
  }
  private reviewResource(): void {
    this.resourceFailed = false; this.resourceExpectedHits = 0;
    const resource = producer.webResourceCatalog()[0];
    if (resource === undefined) { this.resourceFailed = true; return; }
    const rule: ResourceRule = { version: '1', targetId: 'web-main',
      resourceId: resource.resourceId, url: resource.url, method: 'GET' };
    const sample: ResourceSample = { requestId: 'resource-sample', url: resource.url,
      method: 'GET', mainFrame: false, redirect: false };
    try {
      const review = producer.reviewWebResource(JSON.stringify(rule), JSON.stringify([sample]), 30000);
      this.resourceExpectedHits = review.expectedHits;
    } catch { this.resourceFailed = true; }
  }
  private resourceLabel(): Resource {
    if (this.resourceFailed) { return $r('app.string.bridge_resource_failed'); }
    if (this.state.webResourcePhase === 'review') {
      return $r('app.string.bridge_resource_review', this.resourceExpectedHits);
    }
    if (this.state.webResourcePhase === 'active') { return $r('app.string.bridge_resource_active'); }
    return $r('app.string.bridge_resource_idle');
  }
  private reviewConsole(): void {
    this.consoleFailed = false;
    try { producer.reviewConsole(this.consoleCode); }
    catch { this.consoleFailed = true; }
  }
  private consoleLabel(): Resource {
    if (this.consoleFailed || this.state.consolePhase === 'failed') { return $r('app.string.bridge_console_failed'); }
    if (this.state.consolePhase === 'review') { return $r('app.string.bridge_console_review'); }
    if (this.state.consolePhase === 'confirmed') { return $r('app.string.bridge_console_confirmed'); }
    if (this.state.consolePhase === 'running') { return $r('app.string.bridge_console_running'); }
    if (this.state.consolePhase === 'timeout') { return $r('app.string.bridge_console_timeout'); }
    if (this.state.consolePhase === 'completed') { return $r('app.string.bridge_console_completed'); }
    return $r('app.string.bridge_console_idle');
  }
  private storageLabel(): Resource {
    if (!this.state.storageAvailable) { return $r('app.string.bridge_storage_unavailable'); }
    if (this.state.storagePhase === 'reading') {
      if (this.state.storageSource === 'controlled-page') { return $r('app.string.bridge_storage_controlled_reading'); }
      return $r('app.string.bridge_storage_reading');
    }
    if (this.state.storagePhase === 'completed') {
      if (this.state.storageSource === 'controlled-page') {
        return $r('app.string.bridge_storage_controlled_completed',
          this.state.storageLocalEntries, this.state.storageSessionEntries);
      }
      return $r('app.string.bridge_storage_completed', this.state.storageCookieEntries);
    }
    if (this.state.storagePhase === 'timeout') { return $r('app.string.bridge_storage_timeout'); }
    if (this.state.storagePhase === 'failed') { return $r('app.string.bridge_storage_failed'); }
    return $r('app.string.bridge_storage_idle');
  }
  private selectStorageWrite(area: number, operation: number): void {
    if (this.state.storageWritePending || this.state.storageWriteCleanup > 0 ||
      ![0, 1].includes(area) || ![0, 1, 2].includes(operation)) { return; }
    void producer.cancelStorageWrite();
    this.storageReview = undefined; this.storageWriteFailed = false;
    this.storageArea = area; this.storageOperation = operation;
  }
  private reviewStorageWrite(): void {
    this.storageReview = undefined; this.storageWriteFailed = false;
    try {
      const value: string | null = this.storageOperation === 2 ? null :
        this.storageOperation === 1 ? '' : 'ohmate-local-test';
      this.storageReview = producer.reviewStorageWrite(this.storageArea === 0 ? 'local' : 'session',
        this.storageArea === 0 ? 'ohmate-test-local' : 'ohmate-test-session', value);
    } catch { this.storageWriteFailed = true; }
  }
  private confirmStorageWrite(): void {
    const review = this.storageReview;
    this.storageWriteFailed = review === undefined || !producer.confirmStorageWrite(review.planHash);
  }
  private async executeStorageWrite(): Promise<void> {
    const review = this.storageReview;
    this.storageWriteFailed = review === undefined || !await producer.executeStorageWrite(review.planHash);
  }
  private storageWriteLabel(): Resource {
    if (this.state.storageWriteCleanup > 0) {
      if (['STORAGE_RECOVERY_EXPIRED', 'STORAGE_RECOVERY_SOURCE_CHANGED', 'STORAGE_WRITE_CLOCK_INVALID',
        'STORAGE_RECOVERY_DISPOSED'].includes(this.state.storageWriteReason)) {
        return $r('app.string.bridge_storage_write_unrecoverable');
      }
      if (this.state.storageWriteRevocation === 'cleanup-failed') { return $r('app.string.bridge_storage_write_cleanup'); }
      if (this.state.storageWritePhase === 'applied') { return $r('app.string.bridge_storage_write_applied'); }
      return $r('app.string.bridge_storage_write_pending');
    }
    if (this.state.storageWriteRevocation === 'revoked') { return $r('app.string.bridge_storage_write_restored'); }
    if (this.storageWriteFailed || this.state.storageWritePhase === 'failed') { return $r('app.string.bridge_storage_write_failed'); }
    if (this.state.storageWritePhase === 'review') { return $r('app.string.bridge_storage_write_review'); }
    if (this.state.storageWritePhase === 'confirmed') { return $r('app.string.bridge_storage_write_confirmed'); }
    if (this.state.storageWritePhase === 'cancelled') { return $r('app.string.bridge_storage_write_cancelled'); }
    return $r('app.string.bridge_storage_write_idle');
  }
  private dfxLabel(): Resource {
    if (!this.state.dfxAvailable) { return $r('app.string.bridge_dfx_unavailable'); }
    switch (this.state.dfxPhase) {
      case 'watching': return $r('app.string.bridge_dfx_watching');
      case 'cleanup-failed': return $r('app.string.bridge_dfx_cleanup');
      case 'failed': return $r('app.string.bridge_dfx_failed');
      default: return $r('app.string.bridge_dfx_idle');
    }
  }
  private cpuLabel(): Resource {
    switch (this.state.cpuPhase) {
      case 'reading': return $r('app.string.bridge_cpu_reading');
      case 'completed': return $r('app.string.bridge_cpu_value', this.state.cpuPercent.toFixed(2) + '%');
      default: return $r('app.string.bridge_cpu_failed');
    }
  }
  private screenshotLabel(): Resource {
    if (this.state.screenshotPhase === 'capturing') { return $r('app.string.bridge_snapshot_capturing'); }
    if (this.state.screenshotPhase === 'cleanup-failed') { return $r('app.string.bridge_snapshot_cleanup'); }
    return $r('app.string.bridge_snapshot_failed');
  }
  private reviewScreenshot(): void {
    try { producer.reviewScreenshot(); } catch { this.state.screenshotPhase = 'failed'; }
  }
  private applyUiHighlight(commandId: string): boolean {
    if (this.state.phase !== 'connected' || !this.state.uiAvailable || !commandId ||
      (this.highlightCommand.length > 0 && this.highlightCommand !== commandId)) { return false; }
    this.highlightCommand = commandId; return true;
  }
  private clearUiHighlight(commandId: string): boolean {
    if (this.highlightCommand.length > 0 && this.highlightCommand !== commandId) { return false; }
    this.highlightCommand = ''; return true;
  }
  private reviewUiHighlight(): void {
    this.highlightReview = undefined; this.highlightFailed = false;
    try { this.highlightReview = producer.reviewUiHighlight(); } catch { this.highlightFailed = true; }
  }
  private confirmUiHighlight(): void {
    const review = this.highlightReview;
    this.highlightFailed = review === undefined || !producer.confirmUiHighlight(review.planHash);
  }
  private executeUiHighlight(): void {
    const review = this.highlightReview;
    this.highlightFailed = review === undefined || !producer.executeUiHighlight(review.planHash);
  }
  private cancelUiHighlight(): void {
    producer.cancelUiHighlight(); this.highlightReview = undefined; this.highlightFailed = false;
  }
  private uiHighlightLabel(): Resource {
    if (this.state.uiHighlightCleanup > 0 && this.state.uiHighlightRevocation === 'cleanup-failed') {
      return $r('app.string.bridge_highlight_cleanup');
    }
    if (this.state.uiHighlightPhase === 'applied') { return $r('app.string.bridge_highlight_applied'); }
    if (this.state.uiHighlightRevocation === 'revoked') { return $r('app.string.bridge_highlight_cleared'); }
    if (this.highlightFailed || this.state.uiHighlightPhase === 'failed') { return $r('app.string.bridge_highlight_failed'); }
    if (this.state.uiHighlightPhase === 'review') { return $r('app.string.bridge_highlight_review'); }
    if (this.state.uiHighlightPhase === 'confirmed') { return $r('app.string.bridge_highlight_confirmed'); }
    if (this.state.uiHighlightPhase === 'expired' || this.state.uiHighlightPhase === 'cancelled') {
      return $r('app.string.bridge_highlight_cancelled');
    }
    return $r('app.string.bridge_highlight_idle');
  }
  private replayAdapter(): ReplayAdapter {
    const descriptor: ReplayDescriptor = { kind: 'action', actionId: 'test.marker', dataRefs: ['test:marker'],
      assertionId: 'test.marker-present', expectations: ['test:present'] };
    const adapter: ReplayAdapter = {
      descriptors: (): ReplayDescriptor[] => [descriptor],
      prepare: (commandId: string): boolean => {
        if (this.state.phase !== 'connected' || this.replayCommand.length > 0) { return false; }
        this.replayOriginal = this.replayMarker; this.replayCommand = commandId; return true;
      },
      execute: async (commandId: string, step: SemanticReplayStep): Promise<boolean> => {
        if (this.state.phase !== 'connected' || this.replayCommand !== commandId || step.kind !== 'action' ||
          step.actionId !== descriptor.actionId || step.dataRef !== 'test:marker' ||
          step.assertionId !== descriptor.assertionId || step.expected !== 'test:present') { return false; }
        this.replayMarker = true; return true;
      },
      assert: async (commandId: string, assertionId: string, expected: string): Promise<boolean> =>
        this.replayCommand === commandId && assertionId === descriptor.assertionId &&
          expected === 'test:present' && this.replayMarker,
      restore: async (commandId: string): Promise<boolean> => {
        if (this.replayCommand !== commandId) { return false; }
        this.replayMarker = this.replayOriginal; this.replayCommand = ''; return true;
      }
    };
    return adapter;
  }
  private reviewReplay(): void {
    this.replayReview = undefined; this.replayFailed = false;
    const step: SemanticReplayStep = { kind: 'action', actionId: 'test.marker', dataRef: 'test:marker',
      assertionId: 'test.marker-present', expected: 'test:present', waitMs: 1000 };
    try { this.replayReview = producer.reviewReplay(step, producer.replayBuildId()); }
    catch { this.replayFailed = true; }
  }
  private confirmReplay(): void {
    const review = this.replayReview;
    this.replayFailed = review === undefined || !producer.confirmReplay(review.planHash);
  }
  private async executeReplay(): Promise<void> {
    const review = this.replayReview;
    this.replayFailed = review === undefined || !await producer.executeReplay(review.planHash);
  }
  private cancelReplay(): void {
    producer.cancelReplay(); this.replayReview = undefined; this.replayFailed = false;
  }
  private prepareExport(): void {
    try { producer.reviewExport(); }
    catch {
      this.state.exportPhase = 'failed';
      this.state.exportReason = 'EXPORT_UNAVAILABLE';
    }
  }
  private saveExport(): void {
    const context = this.getUIContext().getHostContext();
    if (context !== undefined) { void producer.confirmExport(context); }
    else {
      producer.cancelExport();
      this.state.exportPhase = 'failed';
      this.state.exportReason = 'EXPORT_CONTEXT_UNAVAILABLE';
    }
  }
  private exportLabel(): Resource {
    switch (this.state.exportPhase) {
      case 'saving': return $r('app.string.bridge_export_saving');
      case 'saved': return $r('app.string.bridge_export_saved');
      case 'cancelled': return $r('app.string.bridge_export_cancelled');
      case 'cleanup-failed': return $r('app.string.bridge_export_cleanup');
      default: return $r('app.string.bridge_export_failed');
    }
  }
  private phaseLabel(): Resource {
    switch (this.state.phase) {
      case 'idle': return $r('app.string.bridge_idle');
      case 'review': return $r('app.string.bridge_review');
      case 'connected': return $r('app.string.bridge_connected');
      case 'closing': return $r('app.string.bridge_closing');
      case 'cleanup-failed': return $r('app.string.bridge_cleanup_failed');
      case 'stopped': return $r('app.string.bridge_stopped');
      case 'unavailable': return $r('app.string.bridge_unavailable');
      default: return $r('app.string.bridge_pairing');
    }
  }
  @Builder
  sectionTitle(label: Resource) {
    Text(label)
      .fontSize($r('sys.float.Subtitle_L'))
      .fontWeight(FontWeight.Medium)
      .fontColor($r('sys.color.font_primary'))
      .width('100%')
  }
  @Builder
  storageWritePanel() {
    this.sectionTitle($r('app.string.bridge_storage_write_title'))
    Text($r('app.string.bridge_storage_write_scope'))
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_secondary'))
      .width('100%')
    Text(this.storageWriteLabel())
      .id('bridge_storage_write_state')
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_primary'))
      .width('100%')
    if (this.state.storageWritePending) {
      Text($r('app.string.bridge_storage_write_pending'))
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')
    }
    if (this.state.phase === 'connected') {
      Text($r('app.string.bridge_storage_write_key'))
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_primary'))
        .width('100%')
      Select([{ value: 'localStorage / ohmate-test-local' }, { value: 'sessionStorage / ohmate-test-session' }])
        .id('bridge_storage_write_key')
        .selected(this.storageArea)
        .value(this.storageArea === 0 ? 'localStorage / ohmate-test-local' : 'sessionStorage / ohmate-test-session')
        .accessibilityText($r('app.string.bridge_storage_write_key'))
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(!this.state.storageWritePending && this.state.storageWriteCleanup === 0)
        .onSelect((index: number) => { this.selectStorageWrite(index, this.storageOperation); })
      Text($r('app.string.bridge_storage_write_operation'))
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_primary'))
        .width('100%')
      Select([{ value: $r('app.string.bridge_storage_write_marker') },
        { value: $r('app.string.bridge_storage_write_empty') }, { value: $r('app.string.bridge_storage_write_remove') }])
        .id('bridge_storage_write_operation')
        .selected(this.storageOperation)
        .value(this.storageOperation === 0 ? $r('app.string.bridge_storage_write_marker') :
          this.storageOperation === 1 ? $r('app.string.bridge_storage_write_empty') : $r('app.string.bridge_storage_write_remove'))
        .accessibilityText($r('app.string.bridge_storage_write_operation'))
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(!this.state.storageWritePending && this.state.storageWriteCleanup === 0)
        .onSelect((index: number) => { this.selectStorageWrite(this.storageArea, index); })
      Button($r('app.string.bridge_storage_write_prepare'))
        .id('bridge_storage_write_prepare')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(this.domStorageAllowed && this.state.storagePhase === 'completed' &&
          this.state.storageSource === 'controlled-page' && !this.state.storageWritePending && this.state.storageWriteCleanup === 0)
        .onClick(() => { this.reviewStorageWrite(); })
      if (this.storageReview !== undefined && ['review', 'confirmed'].includes(this.state.storageWritePhase)) {
        Text($r('app.string.bridge_storage_write_plan', this.storageReview.area, this.storageReview.key,
          this.storageReview.operation, this.storageReview.commandId, this.storageReview.expiresAt,
          this.storageReview.originalHash, this.storageReview.payloadHash, this.storageReview.planHash))
          .id('bridge_storage_write_plan')
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('sys.color.font_primary'))
          .copyOption(CopyOptions.None)
          .width('100%')
      }
      if (this.state.storageWritePhase === 'review') {
        Button($r('app.string.bridge_storage_write_confirm'))
          .id('bridge_storage_write_confirm')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .onClick(() => { this.confirmStorageWrite(); })
      }
      if (this.state.storageWritePhase === 'confirmed') {
        Button($r('app.string.bridge_storage_write_execute'))
          .id('bridge_storage_write_execute')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .enabled(!this.state.storageWritePending)
          .onClick(() => { void this.executeStorageWrite(); })
      }
    }
    if (this.state.storageWriteCommandId.length > 0) {
      Button($r('app.string.bridge_storage_write_cancel'))
        .id('bridge_storage_write_cancel')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .onClick(() => { void producer.cancelStorageWrite(); this.storageWriteFailed = false; })
    }
    if (this.state.storageWriteCleanup > 0) {
      Button($r('app.string.bridge_storage_write_retry'))
        .id('bridge_storage_write_retry')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(this.state.phase === 'connected' && this.domStorageAllowed && !this.state.storageWritePending &&
          !['STORAGE_RECOVERY_EXPIRED', 'STORAGE_RECOVERY_SOURCE_CHANGED', 'STORAGE_WRITE_CLOCK_INVALID',
            'STORAGE_RECOVERY_DISPOSED'].includes(this.state.storageWriteReason))
        .onClick(() => { void producer.retryStorageRestore(); })
    }
  }
  @Builder
  uiHighlightPanel() {
    this.sectionTitle($r('app.string.bridge_highlight_title'))
    Text($r('app.string.bridge_highlight_scope'))
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_secondary'))
      .width('100%')
    Text(this.uiHighlightLabel())
      .id('bridge_highlight_status')
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_primary'))
      .width('100%')
    if (this.state.phase === 'connected' && this.state.uiAvailable) {
      Button($r('app.string.bridge_highlight_review_action'))
        .id('bridge_highlight_review')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(producer.uiHighlightAvailable())
        .onClick(() => { this.reviewUiHighlight(); })
      if (this.highlightReview !== undefined && ['review', 'confirmed'].includes(this.state.uiHighlightPhase)) {
        Text($r('app.string.bridge_highlight_plan', this.highlightReview.planHash))
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
      }
      if (this.state.uiHighlightPhase === 'review') {
        Button($r('app.string.bridge_highlight_confirm'))
          .id('bridge_highlight_confirm')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .onClick(() => { this.confirmUiHighlight(); })
      }
      if (this.state.uiHighlightPhase === 'confirmed') {
        Button($r('app.string.bridge_highlight_execute'))
          .id('bridge_highlight_execute')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .onClick(() => { this.executeUiHighlight(); })
      }
    }
    if (this.state.uiHighlightCommandId.length > 0) {
      Button($r('app.string.bridge_highlight_cancel'))
        .id('bridge_highlight_cancel')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .onClick(() => { this.cancelUiHighlight(); })
    }
    if (this.state.uiHighlightCleanup > 0 && this.state.uiHighlightRevocation === 'cleanup-failed') {
      Button($r('app.string.bridge_highlight_retry'))
        .id('bridge_highlight_retry')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .onClick(() => { this.highlightFailed = !producer.retryUiHighlightCleanup(); })
    }
  }
  @Builder
  replayPanel() {
    this.sectionTitle($r('app.string.bridge_replay_title'))
    Text($r('app.string.bridge_replay_scope'))
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_secondary'))
      .width('100%')
    Text($r('app.string.bridge_replay_manual'))
      .id('bridge_replay_status')
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_primary'))
      .width('100%')
    Text(this.replayMarker ? $r('app.string.bridge_replay_marker_present') : $r('app.string.bridge_replay_marker_absent'))
      .id('bridge_replay_marker')
      .fontSize($r('sys.float.Body_M'))
      .fontColor($r('sys.color.font_secondary'))
      .width('100%')
    if (this.state.phase === 'connected') {
      Button($r('app.string.bridge_replay_review'))
        .id('bridge_replay_review')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(producer.replayAvailable())
        .onClick(() => { this.reviewReplay(); })
      if (this.replayReview !== undefined && ['review', 'confirmed'].includes(this.state.replayPhase)) {
        Text($r('app.string.bridge_replay_plan', this.replayReview.planHash))
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
      }
      if (this.state.replayPhase === 'review') {
        Button($r('app.string.bridge_replay_confirm'))
          .id('bridge_replay_confirm')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .onClick(() => { this.confirmReplay(); })
      }
      if (this.state.replayPhase === 'confirmed') {
        Button($r('app.string.bridge_replay_execute'))
          .id('bridge_replay_execute')
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .enabled(!this.state.replayPending)
          .onClick(() => { void this.executeReplay(); })
      }
    }
    if (this.state.replayCommandId.length > 0) {
      Button($r('app.string.bridge_replay_cancel'))
        .id('bridge_replay_cancel')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .onClick(() => { this.cancelReplay(); })
    }
    if (this.state.replayPending || this.state.replayCleanup > 0) {
      Text($r('app.string.bridge_replay_pending'))
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')
    }
    if (this.state.replayCleanup > 0 && this.state.replayRevocation === 'cleanup-failed') {
      Button($r('app.string.bridge_replay_retry'))
        .id('bridge_replay_retry')
        .width('100%')
        .constraintSize({ minHeight: 48 })
        .enabled(!this.state.replayPending)
        .onClick(() => { void producer.retryReplayRestore(); })
    }
  }
  build() {
    Column() {
    HdsNavigation(this.paths) {
      Scroll() {
        Column({ space: 16 }) {
          Text(this.phaseLabel())
            .id('bridge_phase')
            .fontSize($r('sys.float.Title_M'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.font_primary'))
            .width('100%')
          Text($r('app.string.bridge_intro'))
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')
          this.sectionTitle($r('app.string.bridge_local_target'))
          Text(this.state.localTarget)
            .id('bridge_local_target')
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('sys.color.font_primary'))
            .copyOption(CopyOptions.LocalDevice)
            .width('100%')
          Text($r('app.string.bridge_identity_note'))
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')
          if (this.state.phase === 'idle' || this.state.phase === 'stopped') {
            Text($r('app.string.bridge_storage_controlled_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            if (!this.domStorageAllowed) {
              Button($r('app.string.bridge_storage_allow'))
                .id('bridge_storage_allow')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.domStorageAllowed = true; })
            } else {
              Button($r('app.string.bridge_storage_deny'))
                .id('bridge_storage_deny_before_pair')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.domStorageAllowed = false; producer.cancelWebStorage(); })
            }
            this.sectionTitle($r('app.string.bridge_invitation_label'))
            TextInput({ text: this.invitationText, placeholder: $r('app.string.bridge_invitation_hint') })
              .id('bridge_invitation')
              .type(InputType.Password)
              .showPasswordIcon(false)
              .enableAutoFill(false)
              .copyOption(CopyOptions.None)
              .maxLength(16384)
              .accessibilityText($r('app.string.bridge_invitation_label'))
              .onChange((value: string) => { this.invitationText = value; })
            Button($r('app.string.bridge_review_action'))
              .id('bridge_review_action')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.invitationText.length > 0)
              .onClick(() => { this.prepare(); })
            Button($r('app.string.bridge_dev_auto_pair'))
              .id('bridge_dev_auto_pair')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.phase === 'idle' || this.state.phase === 'stopped')
              .onClick(() => { void this.autoPairDev(); })
          }
          if (this.state.phase === 'review') {
            this.sectionTitle($r('app.string.bridge_fingerprint'))
            Text(this.state.fingerprint)
              .id('bridge_fingerprint')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            Text(this.state.connectionTarget)
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.state.scope)
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            Text($r('app.string.bridge_confirm_scope'))
              .fontSize($r('sys.float.Body_L'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            Button($r('app.string.bridge_confirm_action'))
              .id('bridge_confirm_action')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .onClick(() => { void producer.confirm(); })
          }
          if (this.state.phase === 'connected') {
            Text($r('app.string.bridge_metric', this.state.pssBytes))
              .id('bridge_metric')
              .fontSize($r('sys.float.Title_M'))
              .fontColor($r('sys.color.font_primary'))
            Text($r('app.string.bridge_ack', this.state.ackThrough, this.state.unacknowledged))
              .id('bridge_ack')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
            this.sectionTitle($r('app.string.bridge_dfx_title'))
            Text($r('app.string.bridge_dfx_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.dfxLabel())
              .id('bridge_dfx_result')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Button($r('app.string.bridge_dfx_start'))
              .id('bridge_dfx_start')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.dfxAvailable &&
                (this.state.dfxPhase === 'idle' || this.state.dfxPhase === 'failed'))
              .onClick(() => { producer.startDfx(); })
            if (this.state.dfxSequence > 0) {
              Text($r('app.string.bridge_dfx_sent', this.state.dfxSequence, this.state.dfxDropped))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
            }
            Button($r('app.string.bridge_cpu_capture'))
              .id('bridge_cpu_capture')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.cpuPhase !== 'reading' && this.state.unacknowledged === 0)
              .onClick(() => { void producer.captureCpu(); })
            if (this.state.cpuPhase !== 'idle') {
              Text(this.cpuLabel())
                .id('bridge_cpu_result')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
            }
            this.sectionTitle($r('app.string.bridge_ui_title'))
            Text($r('app.string.bridge_ui_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            if (this.state.uiNodes > 0) {
              Text($r('app.string.bridge_ui_nodes', this.state.uiNodes))
                .id('bridge_ui_nodes')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
            }
            if (this.state.uiReason.length > 0) {
              Text($r('app.string.bridge_ui_failed'))
                .id('bridge_ui_result')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
            }
            Button($r('app.string.bridge_ui_capture'))
              .id('bridge_ui_capture')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.uiAvailable && this.state.unacknowledged === 0)
              .onClick(() => { void producer.captureUi(); })
            if (this.state.uiAvailable) {
              Column() {
                Text($r('app.string.bridge_snapshot_target'))
                  .fontSize($r('sys.float.Body_L'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              .id('bridge_snapshot_target')
              .padding(16)
              .width('100%')
              .borderWidth(2)
              .borderColor(this.highlightCommand.length > 0 ? $r('sys.color.ohos_id_color_emphasize') : Color.Transparent)
            }
            if (producer.screenshotAvailable()) {
              this.sectionTitle($r('app.string.bridge_snapshot_title'))
              Text($r('app.string.bridge_snapshot_scope'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
              if (this.state.screenshotPhase === 'review') {
                Text($r('app.string.bridge_snapshot_review'))
                  .id('bridge_snapshot_scope')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
                Button($r('app.string.bridge_snapshot_confirm'))
                  .id('bridge_snapshot_confirm')
                  .width('100%')
                  .constraintSize({ minHeight: 48 })
                  .enabled(this.state.unacknowledged === 0)
                  .onClick(() => { void producer.confirmScreenshot(); })
              } else {
                Button($r('app.string.bridge_snapshot_review_action'))
                  .id('bridge_snapshot_review_action')
                  .width('100%')
                  .constraintSize({ minHeight: 48 })
                  .enabled(this.state.screenshotPhase !== 'capturing' && this.state.screenshotPhase !== 'cleanup-failed')
                  .onClick(() => { this.reviewScreenshot(); })
              }
              if (this.state.screenshotData.length > 0) {
                Image(this.state.screenshotData)
                  .id('bridge_snapshot_preview')
                  .objectFit(ImageFit.Contain)
                  .width('100%')
                  .height(160)
                  .draggable(false)
                  .copyOption(CopyOptions.None)
                  .accessibilityText($r('app.string.bridge_snapshot_preview_label'))
              } else if (this.state.screenshotPhase !== 'idle' && this.state.screenshotPhase !== 'review') {
                Text(this.screenshotLabel())
                  .id('bridge_snapshot_result')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_secondary'))
                  .width('100%')
              }
              if (this.state.screenshotPhase !== 'idle') {
                Button($r('app.string.bridge_snapshot_cancel'))
                  .id('bridge_snapshot_cancel')
                  .width('100%')
                  .constraintSize({ minHeight: 48 })
                  .onClick(() => { producer.cancelScreenshot(); })
              }
            }
            this.sectionTitle($r('app.string.bridge_network_title'))
            Text($r('app.string.bridge_network_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Button($r('app.string.bridge_network_probe'))
              .id('bridge_network_probe')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.networkAvailable && this.networkPhase === 'idle' &&
                this.state.networkBodyPhase === 'idle' && this.state.networkMockPhase === 'idle')
              .onClick(() => { void this.probeNetwork(); })
            if (this.networkPhase !== 'idle') {
              Text(this.networkLabel())
                .id('bridge_network_result')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }
            if (this.state.networkSequence > 0) {
              Text($r('app.string.bridge_network_sent', this.state.networkSequence, this.state.networkDiscarded))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
            }
            this.sectionTitle($r('app.string.bridge_body_title'))
            Text($r('app.string.bridge_body_scope', this.bodyOrigin()))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.bodyLabel())
              .id('bridge_body_status')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            if (this.state.networkBodyPhase === 'review') {
              Button($r('app.string.bridge_body_confirm'))
                .id('bridge_body_confirm')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.networkPhase === 'idle')
                .onClick(() => { void this.probeBody(); })
            } else {
              Button($r('app.string.bridge_body_review_action'))
                .id('bridge_body_review_action')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.state.networkAvailable && this.networkPhase === 'idle' &&
                  this.state.networkBodyPhase !== 'active' && this.state.networkMockPhase === 'idle')
                .onClick(() => { this.reviewBody(); })
            }
            if (this.state.networkBodyPreviewText.length > 0) {
              Text(this.state.networkBodyPreviewText)
                .id('bridge_body_preview')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .copyOption(CopyOptions.None)
                .width('100%')
            }
            if (this.state.networkBodyPhase !== 'idle') {
              Button($r('app.string.bridge_body_cancel'))
                .id('bridge_body_cancel')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { producer.cancelNetworkBody(); })
            }
            this.sectionTitle($r('app.string.bridge_mock_title'))
            Text($r('app.string.bridge_mock_scope', this.bodyOrigin()))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.mockLabel())
              .id('bridge_mock_status')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            Text($r('app.string.bridge_mock_hits', this.state.networkMockHits, this.state.networkMockPending))
              .id('bridge_mock_hits')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            if (this.state.networkMockPhase === 'review') {
              Button($r('app.string.bridge_mock_confirm'))
                .id('bridge_mock_confirm')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.networkPhase === 'idle')
                .onClick(() => { this.confirmMock(); })
            } else if (this.state.networkMockPhase === 'active') {
              Button($r('app.string.bridge_mock_probe'))
                .id('bridge_mock_probe')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.state.networkAvailable && this.networkPhase === 'idle')
                .onClick(() => { void this.probeMock(); })
            } else {
              Button($r('app.string.bridge_mock_review_action'))
                .id('bridge_mock_review_action')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.state.networkAvailable && this.networkPhase === 'idle' && this.state.networkBodyPhase === 'idle')
                .onClick(() => { this.reviewMock(); })
            }
            if (this.mockResult === 'completed' && this.state.networkMockPhase === 'active') {
              Text($r('app.string.bridge_mock_completed'))
                .id('bridge_mock_result')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
            }
            if (this.state.networkMockPhase !== 'idle' || this.mockResult === 'failed') {
              Button($r('app.string.bridge_mock_cancel'))
                .id('bridge_mock_cancel')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.cancelMock(); })
            }
            this.sectionTitle($r('app.string.bridge_web_title'))
            Text($r('app.string.bridge_web_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.webLabel())
              .id('bridge_web_result')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            if (this.state.webAvailable) {
              Web({
                src: this.state.connectionTarget.replace('ws:', 'http:').replace('/bridge/v1', '/kit-readonly.html'),
                controller: this.webController, incognitoMode: true
              })
                .id('bridge_web_reference')
                .width('100%')
                .height(280)
                .domStorageAccess(this.domStorageAllowed)
                .onControllerAttached(() => {
                  if (!producer.attachWebResourceStream()) { this.resourceFailed = true; }
                })
                .onInterceptRequest((event: OnInterceptRequestEvent): WebResourceResponse | undefined => {
                  return producer.interceptWebResource(event.request);
                })
                .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
                  const url = event.data.getRequestUrl();
                  const allowed = url === this.state.connectionTarget.replace('ws:', 'http:').replace('/bridge/v1', '/kit-readonly.html');
                  if (allowed) { producer.webNavigationRequest(event.data); }
                  return !allowed;
                })
                .onPageBegin((event: OnPageBeginEvent) => {
                  this.consoleCode = ''; this.consoleFailed = false;
                  this.webLoadPhase = 'loading'; producer.webPageBegin(event.url);
                })
                .onPageEnd((event: OnPageEndEvent) => {
                  producer.webPageEnd(event.url); this.webLoadPhase = 'ready';
                })
                .onConsole((event: OnConsoleEvent): boolean => { producer.observeWebConsole(event.message); return false; })
                .onErrorReceive((event: OnErrorReceiveEvent) => {
                  if (event.request.isMainFrame()) { this.webLoadPhase = 'failed'; producer.webPageBegin(''); }
                })
                .onRenderExited(() => { this.webLoadPhase = 'failed'; producer.webPageBegin(''); })
              Button($r('app.string.bridge_web_capture'))
                .id('bridge_web_capture')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.webLoadPhase === 'ready' && this.state.webPhase !== 'reading' && this.state.unacknowledged === 0)
                .onClick(() => { void producer.captureWebDom(); })
              if (this.state.webNodes > 0) {
                Text($r('app.string.bridge_web_nodes', this.state.webNodes))
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
            }
            this.sectionTitle($r('app.string.bridge_storage_title'))
            Text($r('app.string.bridge_storage_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text($r('app.string.bridge_storage_controlled_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            if (this.domStorageAllowed) {
              Button($r('app.string.bridge_storage_deny'))
                .id('bridge_storage_deny')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.domStorageAllowed = false; producer.cancelWebStorage(); })
            }
            Text(this.storageLabel())
              .id('bridge_storage_state')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            if (this.state.storageNativePending) {
              Text($r('app.string.bridge_storage_pending'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }
            Button($r('app.string.bridge_storage_read'))
              .id('bridge_storage_read')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(!this.domStorageAllowed && this.state.storageAvailable && this.webLoadPhase === 'ready' &&
                this.state.storagePhase !== 'reading' && !this.state.storageNativePending)
              .onClick(() => { void producer.captureWebStorage(); })
            Button($r('app.string.bridge_storage_controlled_read'))
              .id('bridge_storage_controlled_read')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.domStorageAllowed && this.state.storageAvailable && this.webLoadPhase === 'ready' &&
                this.state.storagePhase !== 'reading' && !this.state.storageNativePending)
              .onClick(() => { void producer.captureControlledStorage(); })
            Button($r('app.string.bridge_storage_publish'))
              .id('bridge_storage_publish')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.storagePhase === 'completed' && !this.state.storagePublished &&
                !this.domStorageAllowed && this.state.storageSource === 'cookie' &&
                !this.state.storageNativePending && this.state.unacknowledged === 0)
              .onClick(() => { void producer.publishWebStorage(); })
            if (this.state.storagePublished) {
              Text($r('app.string.bridge_storage_published'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }
            Button($r('app.string.bridge_storage_cancel'))
              .id('bridge_storage_cancel')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .onClick(() => { producer.cancelWebStorage(); })
            this.sectionTitle($r('app.string.bridge_resource_title'))
            Text($r('app.string.bridge_resource_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .copyOption(CopyOptions.None)
              .width('100%')
            Text(this.resourceLabel())
              .id('bridge_resource_state')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            Text($r('app.string.bridge_resource_hits', this.state.webResourceHits))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Button($r('app.string.bridge_resource_prepare'))
              .id('bridge_resource_prepare')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.webAvailable && this.webLoadPhase === 'ready' && this.state.webResourcePhase !== 'active')
              .onClick(() => { this.reviewResource(); })
            if (this.state.webResourcePhase === 'review') {
              Button($r('app.string.bridge_resource_confirm'))
                .id('bridge_resource_confirm')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => {
                  this.resourceFailed = !producer.confirmWebResource(this.state.webResourcePlanHash);
                })
            }
            if (this.state.webResourcePhase !== 'idle' || this.resourceFailed) {
              Button($r('app.string.bridge_resource_cancel'))
                .id('bridge_resource_cancel')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => {
                  producer.cancelWebResource(); this.resourceFailed = false; this.resourceExpectedHits = 0;
                })
            }
            this.sectionTitle($r('app.string.bridge_console_title'))
            Text($r('app.string.bridge_console_scope'))
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            Text(this.consoleLabel())
              .id('bridge_console_state')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_primary'))
              .width('100%')
            if (this.state.consoleNativePending) {
              Text($r('app.string.bridge_console_pending'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }
            TextArea({ text: this.consoleCode, placeholder: $r('app.string.bridge_console_input') })
              .id('bridge_console_input')
              .accessibilityText($r('app.string.bridge_console_input'))
              .maxLength(4096)
              .copyOption(CopyOptions.None)
              .fontSize($r('sys.float.Body_M'))
              .width('100%')
              .constraintSize({ minHeight: 96 })
              .enabled(this.state.webAvailable && this.webLoadPhase === 'ready' && !this.state.consoleNativePending)
              .onChange((value: string) => {
                if (value === this.consoleCode) { return; }
                producer.cancelConsole(); this.consoleCode = value; this.consoleFailed = false;
              })
            Button($r('app.string.bridge_console_prepare'))
              .id('bridge_console_prepare')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.webAvailable && this.webLoadPhase === 'ready' &&
                this.consoleCode.trim().length > 0 && !this.state.consoleNativePending)
              .onClick(() => { this.reviewConsole(); })
            if (this.state.consolePhase === 'review') {
              Text($r('app.string.bridge_console_command', this.state.consoleCommandId))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .copyOption(CopyOptions.None)
                .width('100%')
              Button($r('app.string.bridge_console_confirm'))
                .id('bridge_console_confirm')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.consoleFailed = !producer.confirmConsole(this.state.consolePlanHash); })
            }
            if (this.state.consolePhase === 'confirmed') {
              Button($r('app.string.bridge_console_execute'))
                .id('bridge_console_execute')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { void producer.executeConsole(this.state.consolePlanHash); this.consoleCode = ''; })
            }
            if (this.state.consolePhase === 'completed') {
              Text($r('app.string.bridge_console_result', this.state.consoleResultType))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
            }
            Button($r('app.string.bridge_console_cancel'))
              .id('bridge_console_cancel')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .onClick(() => { producer.cancelConsole(); this.consoleCode = ''; this.consoleFailed = false; })
            this.sectionTitle($r('app.string.bridge_export_title'))
            if (this.state.exportPhase === 'review') {
              Text($r('app.string.bridge_export_scope', this.state.exportSequence,
                this.state.exportDropped, this.state.exportBytes))
                .id('bridge_export_scope')
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_primary'))
                .width('100%')
              if (this.state.exportCpuSequence > 0) {
                Text($r('app.string.bridge_export_cpu_scope', this.state.exportCpuSequence))
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              if (this.state.exportDfxSequence > 0) {
                Text($r('app.string.bridge_export_dfx_scope', this.state.exportDfxSequence))
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              if (this.state.exportUiNodes > 0) {
                Text($r('app.string.bridge_export_ui_scope', this.state.exportUiNodes))
                  .id('bridge_export_ui_scope')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              if (this.state.exportNetworkSequence > 0) {
                Text($r('app.string.bridge_export_network_scope', this.state.exportNetworkSequence))
                  .id('bridge_export_network_scope')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              if (this.state.exportWebNodes > 0 || this.state.exportWebConsole || this.state.exportWebNetwork) {
                Text($r('app.string.bridge_export_web_scope', this.state.exportWebNodes,
                  this.state.exportWebConsole ? 1 : 0, this.state.exportWebNetwork ? 1 : 0))
                  .id('bridge_export_web_scope')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              if (this.state.exportWebStorage) {
                Text($r('app.string.bridge_export_storage_scope'))
                  .id('bridge_export_storage_scope')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_primary'))
                  .width('100%')
              }
              Text($r('app.string.bridge_export_risk'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
              Button($r('app.string.bridge_export_confirm'))
                .id('bridge_export_confirm')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { this.saveExport(); })
              Button($r('app.string.bridge_export_cancel'))
                .id('bridge_export_cancel')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .onClick(() => { producer.cancelExport(); })
            } else {
              if (this.state.exportPhase !== 'idle') {
                Text(this.exportLabel())
                  .id('bridge_export_result')
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_secondary'))
                  .width('100%')
              }
              Button($r('app.string.bridge_export_review'))
                .id('bridge_export_review')
                .width('100%')
                .constraintSize({ minHeight: 48 })
                .enabled(this.state.unacknowledged > 0 || this.state.ackThrough > 0)
                .visibility(this.state.exportPhase === 'saving' || this.state.exportPhase === 'cleanup-failed' ?
                  Visibility.None : Visibility.Visible)
                .onClick(() => { this.prepareExport(); })
            }
          }
          if (this.state.phase === 'connected' || this.state.storageWriteCommandId.length > 0 || this.storageWriteFailed) {
            this.storageWritePanel()
          }
          if (this.state.phase === 'connected' || this.state.uiHighlightCommandId.length > 0 || this.highlightFailed) {
            this.uiHighlightPanel()
          }
          if (this.state.phase === 'connected' || this.state.replayCommandId.length > 0 || this.replayFailed) {
            this.replayPanel()
          }
          if (this.state.phase !== 'idle' && this.state.phase !== 'stopped' && this.state.phase !== 'unavailable') {
            Button($r('app.string.bridge_revoke'))
              .id('bridge_revoke')
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .enabled(this.state.phase !== 'closing')
              .onClick(() => { void producer.stop(); })
          }
          if (this.state.reason.length > 0) {
            Text($r('app.string.bridge_result', this.state.reason))
              .id('bridge_result')
              .fontSize($r('sys.float.Body_M'))
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .padding(16)
        .width('100%')
        .constraintSize({ maxWidth: 640 })
      }
      .width('100%')
      .height('100%')
    }
    .titleBar({ content: { title: { mainTitle: $r('app.string.bridge_title') } } })
    .titleMode(HdsNavigationTitleMode.MINI)
    .backgroundColor($r('sys.color.background_primary'))
    .height('100%')
    .width('100%')
    }
    .id('bridge_capture_root')
    .height('100%')
    .width('100%')
  }
}
