/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { webSocket, http } from '@kit.NetworkKit';
import { bundleManager, common } from '@kit.AbilityKit';
import { process, taskpool } from '@kit.ArkTS';
import { BusinessError, systemDateTime } from '@kit.BasicServicesKit';
import { UIContext } from '@kit.ArkUI';
import { PlatformCrypto } from './PlatformCrypto';
import { PairingSession } from './PairingSession';
import { PairingPackage, parsePairing, keysOf, uuidOf, requireWire, hex, Identity, match } from './Wire';
import { makeMetricEvent, makeUiEvent, makeNetworkEvent, makeClockReply, readAck } from './ReadonlyCollector';
import { readPssBytes, readCpuPercent, PSS_SOURCE_API, CPU_SOURCE_API } from './PlatformMetrics';
import { KitMemoryFile, makeMemoryFile } from './KitMemorySample';
import { makeMemoryProblem } from './KitProblemArchive';
import { PlatformProblemExport } from './PlatformProblemExport';
import { readUiTree } from './PlatformUi';
import { KitUiFile, makeUiFile } from './KitUiSample';
import { PlatformNetwork, NetworkObservation } from './PlatformNetwork';
import { KitNetworkFile, makeNetworkFile } from './KitNetworkSample';
import { webview } from '@kit.ArkWeb';
import { PlatformWeb, WebObservation } from './PlatformWeb';
import { KitWebFile, makeWebFile } from './KitWebSample';
import { makeWebEvent } from './ReadonlyCollector';
import { WebExportSelection } from './KitWebExport';
import { PlatformDfx } from './PlatformDfx';
import { makeDfxFile } from './KitDfxSample';
import { makeDfxEvent } from './ReadonlyCollector';
import { PlatformScreenshot } from './PlatformScreenshot';
import { NetworkBodyCapture, BodyReview, BodyPreview } from './NetworkBodyCapture';
import { canonical } from './Wire';
import { NetworkMock, MockReview, MockStatus } from './NetworkMock';
import { WebResourceOverride, ResourceEntry, ResourceMetadata, ResourceReview, ResourceStatus } from './WebResourceOverride';
import { resourceManager } from '@kit.LocalizationKit';
import { WebResourceFiles, ResourceFileEntry } from './WebResourceFiles';
import { WebResourceStream } from './WebResourceStream';
import { WebConsoleSession, ConsoleReview, ConsoleStatus, ConsoleResult } from './WebConsoleSession';
import { WebStorageCapture, StorageSnapshot, StorageStatus } from './WebStorageCapture';
import { ControlledStorageAccess } from './ControlledStorage';
import { StorageWriteSession, StorageWriteReview, StorageWriteStatus, StorageWriteExecutor } from './StorageWriteSession';
import { KIT_STORAGE_SUMMARY } from './GeneratedContract';
import { UiHighlightSession, UiHighlightHost, UiHighlightSource, UiHighlightReview, UiHighlightStatus } from './UiHighlightSession';
import { readUiHighlightSource } from './PlatformUiHighlight';
import { SemanticReplaySession, SemanticReplayStep, ReplayAdapter, ReplaySource, ReplayReview, ReplayStatus } from './SemanticReplaySession';

@ObservedV2
export class ProducerState {
  @Trace phase: string = 'idle';
  @Trace reason: string = '';
  @Trace fingerprint: string = '';
  @Trace scope: string = '';
  @Trace connectionTarget: string = '';
  @Trace ackThrough: number = 0;
  @Trace pssBytes: number = 0;
  @Trace unacknowledged: number = 0;
  @Trace localTarget: string = '';
  @Trace exportPhase: string = 'idle';
  @Trace exportReason: string = '';
  @Trace exportSequence: number = 0;
  @Trace exportDropped: number = 0;
  @Trace exportBytes: number = 0;
  @Trace exportUiNodes: number = 0;
  @Trace uiReason: string = '';
  @Trace uiNodes: number = 0;
  @Trace uiAvailable: boolean = false;
  @Trace networkAvailable: boolean = false;
  @Trace networkSequence: number = 0;
  @Trace networkDiscarded: number = 0;
  @Trace exportNetworkSequence: number = 0;
  @Trace webAvailable: boolean = false;
  @Trace webNodes: number = 0;
  @Trace webReason: string = '';
  @Trace webPhase: string = 'idle';
  @Trace exportWebNodes: number = 0;
  @Trace exportWebConsole: boolean = false;
  @Trace exportWebNetwork: boolean = false;
  @Trace exportWebStorage: boolean = false;
  @Trace dfxAvailable: boolean = false;
  @Trace dfxPhase: string = 'idle';
  @Trace dfxSequence: number = 0;
  @Trace dfxDropped: number = 0;
  @Trace cpuPhase: string = 'idle';
  @Trace cpuReason: string = '';
  @Trace cpuPercent: number = 0;
  @Trace exportCpuSequence: number = 0;
  @Trace exportDfxSequence: number = 0;
  @Trace screenshotPhase: string = 'idle';
  @Trace screenshotData: string = '';
  @Trace networkBodyPhase: string = 'idle';
  @Trace networkBodyPlanHash: string = '';
  @Trace networkBodyPreviewText: string = '';
  @Trace networkMockPhase: string = 'idle';
  @Trace networkMockPlanHash: string = '';
  @Trace networkMockHits: number = 0;
  @Trace networkMockPending: number = 0;
  @Trace webResourcePhase: string = 'idle';
  @Trace webResourcePlanHash: string = '';
  @Trace webResourceHits: number = 0;
  @Trace consolePhase: string = 'idle';
  @Trace consolePlanHash: string = '';
  @Trace consoleCommandId: string = '';
  @Trace consoleResultType: string = '';
  @Trace consoleReason: string = '';
  @Trace consoleNativePending: boolean = false;
  @Trace storagePhase: string = 'idle';
  @Trace storageSource: string = 'cookie';
  @Trace storageLocalEntries: number = 0;
  @Trace storageSessionEntries: number = 0;
  @Trace storageReason: string = '';
  @Trace storageNativePending: boolean = false;
  @Trace storageCookieEntries: number = 0;
  @Trace storageAvailable: boolean = false;
  @Trace storagePublished: boolean = false;
  @Trace storageWritePhase: string = 'idle';
  @Trace storageWritePlanHash: string = '';
  @Trace storageWriteCommandId: string = '';
  @Trace storageWriteReason: string = '';
  @Trace storageWriteRevocation: string = 'not-needed';
  @Trace storageWritePending: boolean = false;
  @Trace storageWriteCleanup: number = 0;
  @Trace uiHighlightPhase: string = 'idle';
  @Trace uiHighlightReason: string = '';
  @Trace uiHighlightPlanHash: string = '';
  @Trace uiHighlightCommandId: string = '';
  @Trace uiHighlightRevocation: string = 'not-needed';
  @Trace uiHighlightCleanup: number = 0;
  @Trace replayPhase: string = 'idle';
  @Trace replayReason: string = '';
  @Trace replayPlanHash: string = '';
  @Trace replayCommandId: string = '';
  @Trace replayAssertion: string = 'not-run';
  @Trace replayRevocation: string = 'not-needed';
  @Trace replayPending: boolean = false;
  @Trace replayCleanup: number = 0;
}

interface Ready {
  type: string;
  sessionEpoch: string;
  clockSync: string;
  eventBatch: string;
  retention: string;
}

export class ProducerController {
  readonly state: ProducerState = new ProducerState();
  private crypto: PlatformCrypto = new PlatformCrypto();
  private pairing: PairingPackage | undefined = undefined;
  private session: PairingSession | undefined = undefined;
  private socket: webSocket.WebSocket | undefined = undefined;
  private identity: Identity | undefined = undefined;
  private generation: number = 0;
  private deadlineTimer: number = -1;
  private sampleTimer: number = -1;
  private ackTimer: number = -1;
  private epoch: string = '';
  private sequence: number = 0;
  private queueCount: number = 0;
  private receiveTail: Promise<void> = Promise.resolve();
  private closing: Promise<void> = Promise.resolve();
  private enabled: boolean = false;
  private clockProbes: string[] = [];
  private memorySample: string = '';
  private memoryDropped: number = 0;
  private exportBytes: Uint8Array = new Uint8Array(0);
  private exportGeneration: number = 0;
  private exporter: PlatformProblemExport = new PlatformProblemExport();
  private uiContext: UIContext | undefined = undefined;
  private uiRoot: string = '';
  private uiWindow: string = '';
  private uiSample: string = '';
  private uiDropped: number = 0;
  private uiHighlightHost: UiHighlightHost | undefined = undefined;
  private uiHighlight: UiHighlightSession | undefined = undefined;
  private replayHost: ReplayAdapter | undefined = undefined;
  private replay: SemanticReplaySession | undefined = undefined;
  private collecting: boolean = false;
  private network: PlatformNetwork | undefined = undefined;
  private networkPending: NetworkObservation[] = [];
  private networkSample: string = '';
  private networkDropped: number = 0;
  private networkRequests: number = 0;
  private networkTurn: boolean = true;
  private networkBody: NetworkBodyCapture | undefined = undefined;
  private networkBodyBinding: string = '';
  private networkBodyTimer: number = -1;
  private networkMock: NetworkMock | undefined = undefined;
  private networkMockBinding: string = '';
  private networkMockTimer: number = -1;
  private web: PlatformWeb | undefined = undefined;
  private webResources: WebResourceOverride | undefined = undefined;
  private webResourceFiles: WebResourceFiles | undefined = undefined;
  private webResourceStream: WebResourceStream | undefined = undefined;
  private webResourceBinding: string = '';
  private webResourceTimer: number = -1;
  private webConsole: WebConsoleSession | undefined = undefined;
  private consoleAllowed: boolean = false;
  private consoleBinding: string = '';
  private consoleTimer: number = -1;
  private webStorage: WebStorageCapture | undefined = undefined;
  private webStorageWrite: StorageWriteSession | undefined = undefined;
  private storageBinding: string = '';
  private storageTimer: number = -1;
  private storageSample: string = '';
  private storageSampleRead: number = 0;
  private storagePublishedRead: number = 0;
  private storageDropped: number = 0;
  private webPending: WebObservation[] = [];
  private webDomSample: string = '';
  private webConsoleSample: string = '';
  private webNetworkSample: string = '';
  private webDropped: number = 0;
  private webNavigationGeneration: number = -1;
  private dfx: PlatformDfx = new PlatformDfx();
  private dfxSample: string = '';
  private observerTurn: number = 0;
  private metricsPending: boolean = false;
  private cpuSample: string = '';
  private cpuDropped: number = 0;
  private screenshot: PlatformScreenshot = new PlatformScreenshot();
  private screenshotAllowed: boolean = false;
  private screenshotGeneration: number = 0;
  private screenshotTimer: number = -1;
  private screenshotExpiresAt: number = 0;

  screenshotPreview(): string {
    if (!this.screenshotAvailable() || Date.now() >= this.screenshotExpiresAt) {
      this.state.screenshotData = '';
      return '';
    }
    return this.state.screenshotData;
  }

  screenshotAvailable(): boolean {
    return this.screenshotAllowed && this.uiContext !== undefined && this.webActive(this.generation, 'ui') &&
      canIUse('SystemCapability.ArkUI.ArkUI.Full') && canIUse('SystemCapability.Multimedia.Image.Core') &&
      canIUse('SystemCapability.Multimedia.Image.ImagePacker');
  }
  reviewScreenshot(): void {
    requireWire(!this.screenshot.busy(), 'SCREENSHOT_CAPTURE_BUSY');
    requireWire(this.screenshotAvailable(), 'SCREENSHOT_UNAVAILABLE');
    this.cancelScreenshot();
    const generation = this.screenshotGeneration;
    this.screenshotExpiresAt = Date.now() + 30000;
    this.screenshotTimer = setTimeout(() => {
      if (generation === this.screenshotGeneration) { this.cancelScreenshot(); }
    }, 30000);
    this.state.screenshotPhase = 'review';
  }
  cancelScreenshot(): void {
    ++this.screenshotGeneration;
    this.screenshot.invalidate();
    clearTimeout(this.screenshotTimer); this.screenshotExpiresAt = 0;
    this.state.screenshotData = '';
    this.state.screenshotPhase = 'idle';
  }
  async confirmScreenshot(): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const context = this.uiContext;
    if (this.state.screenshotPhase !== 'review' || context === undefined || !this.screenshotAvailable() ||
      Date.now() >= this.screenshotExpiresAt || this.screenshot.busy() ||
      this.collecting || this.metricsPending || this.web?.busy() || this.state.unacknowledged > 0) { return false; }
    const generation = this.generation;
    const screenshotGeneration = this.screenshotGeneration;
    clearTimeout(this.screenshotTimer);
    const reviewExpiresAt = this.screenshotExpiresAt;
    this.state.screenshotPhase = 'capturing'; this.collecting = true;
    let bytes = new Uint8Array(0);
    try {
      bytes = await this.screenshot.capture(context, (): boolean =>
        screenshotGeneration === this.screenshotGeneration && Date.now() < reviewExpiresAt &&
        this.uiContext === context && this.screenshotAvailable(),
        (): void => {
          if (this.screenshot.needsClose()) {
            this.state.screenshotPhase = 'cleanup-failed';
            if (this.state.phase === 'stopped') {
              this.state.phase = 'cleanup-failed'; this.state.reason = 'SCREENSHOT_CLOSE_FAILED';
            }
          }
          if (generation === this.generation && this.state.phase === 'connected' &&
            !this.collecting && this.state.unacknowledged === 0) { this.scheduleSample(generation); }
        });
      if (generation !== this.generation || screenshotGeneration !== this.screenshotGeneration ||
        !this.screenshotAvailable()) { return false; }
      this.state.screenshotData = 'data:image/png;base64,' + this.crypto.base64(bytes);
      this.screenshotExpiresAt = Date.now() + 30000;
      this.screenshotTimer = setTimeout(() => {
        if (screenshotGeneration === this.screenshotGeneration) { this.cancelScreenshot(); }
      }, 30000);
      this.state.screenshotPhase = 'preview';
      return true;
    } catch {
      if (generation === this.generation && screenshotGeneration === this.screenshotGeneration) {
        this.state.screenshotPhase = this.screenshot.needsClose() ? 'cleanup-failed' : 'failed';
      }
      return false;
    } finally {
      bytes.fill(0);
      if (generation === this.generation) {
        this.collecting = false;
        if (this.state.phase === 'connected' && this.state.unacknowledged === 0) { this.scheduleSample(generation); }
      }
    }
  }

  startDfx(): boolean {
    if (!this.webActive(this.generation, 'hiappevent') || this.dfx.busy() ||
      !canIUse('SystemCapability.HiviewDFX.HiAppEvent')) { return false; }
    const generation = this.generation;
    try {
      this.dfx.start('ohmate' + hex(this.crypto.random(12)),
        (): boolean => this.webActive(generation, 'hiappevent'));
      this.state.dfxPhase = 'watching'; return true;
    } catch {
      this.state.dfxPhase = this.dfx.busy() ? 'cleanup-failed' : 'failed';
      return false;
    }
  }
  dfxFile(): KitMemoryFile | undefined {
    return this.webActive(this.generation, 'hiappevent') && this.dfxSample ?
      JSON.parse(this.dfxSample) as KitMemoryFile : undefined;
  }
  private async sampleDfx(generation: number): Promise<void> {
    const session = this.session;
    if (session === undefined || !this.webActive(generation, 'hiappevent')) { return; }
    const observation = this.dfx.take();
    if (observation === undefined) { return; }
    const event = makeDfxEvent(session.negotiated, this.epoch, ++this.sequence, observation.eventName,
      observation.monotonicNs, observation.wallTimeUtc);
    this.state.unacknowledged = this.sequence;
    this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
    await this.send(JSON.stringify(session.seal(event)), generation);
    if (!this.webActive(generation, 'hiappevent')) { return; }
    if (this.dfxSample) { this.dfx.replaced(); }
    this.dfxSample = JSON.stringify(makeDfxFile(event, this.dfx.dropped()));
    this.state.dfxSequence = event.sequence; this.state.dfxDropped = this.dfx.dropped();
  }
  async captureCpu(): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const session = this.session;
    if (session === undefined || !this.webActive(this.generation, 'hidebug') || this.collecting ||
      this.metricsPending || this.screenshot.busy() || this.state.unacknowledged > 0 ||
      !canIUse('SystemCapability.HiviewDFX.HiProfiler.HiDebug')) { return false; }
    const generation = this.generation;
    this.collecting = true; this.metricsPending = true; this.cpuSample = '';
    this.state.cpuPhase = 'reading'; this.state.cpuReason = '';
    try {
      const value = await taskpool.execute(readCpuPercent) as number;
      if (!this.webActive(generation, 'hidebug')) { return false; }
      const next = this.sequence + 1;
      const event = makeMetricEvent(session.negotiated, this.epoch, next,
        'run-' + session.negotiated.identity.sessionId, this.monotonicNs(), new Date().toISOString(), value, 'cpuPercent');
      this.sequence = next;
      clearTimeout(this.sampleTimer);
      this.state.unacknowledged = this.sequence;
      this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
      try { await this.send(JSON.stringify(session.seal(event)), generation); }
      catch { if (generation === this.generation) { await this.stop('CONNECTION_FAILED'); } return false; }
      if (!this.webActive(generation, 'hidebug')) { return false; }
      this.cpuSample = JSON.stringify(makeMemoryFile(event, CPU_SOURCE_API, this.cpuDropped));
      this.cpuDropped++; this.state.cpuPercent = value; this.state.cpuPhase = 'completed'; return true;
    } catch {
      if (generation === this.generation) {
        this.state.cpuPhase = 'failed'; this.state.cpuReason = 'CPU_CAPTURE_FAILED';
      }
      return false;
    } finally {
      this.metricsPending = false;
      if (generation === this.generation) {
        this.collecting = false;
        if (this.state.phase === 'connected' && this.state.unacknowledged === 0) { this.scheduleSample(generation); }
      }
    }
  }

  registerWeb(controller: webview.WebviewController, targetId: string, url: string,
    resources: ResourceEntry[] = [], consoleAllowed: boolean = false,
    storageAccess: ControlledStorageAccess | undefined = undefined, schemeOwned: boolean = false): void {
    requireWire(this.webResourceStream === undefined, 'RESOURCE_STREAM_CLOSE_REQUIRED');
    requireWire(!this.webResourceFilesPending(), 'RESOURCE_FILE_CLOSE_REQUIRED');
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(!this.web?.busy(), 'WEB_CAPTURE_BUSY');
    requireWire(this.storageWriteStatus().pendingCleanup === 0, 'STORAGE_CLEANUP_REQUIRED');
    requireWire(this.state.phase === 'idle' || this.state.phase === 'stopped' || this.state.phase === 'review', 'INVALID_STATE');
    const web = new PlatformWeb(controller, targetId, url, storageAccess);
    const owner = new WebResourceOverride(this.crypto, url, resources,
      (): boolean => this.webResourceActive() && this.resourceBinding() === this.webResourceBinding, schemeOwned);
    this.cancelConsole();
    this.cancelWebStorage();
    this.cancelWebResource(); this.webResources?.clear(); this.web?.invalidate();
    this.web = web; this.webResources = owner;
    if (schemeOwned) {
      this.webResourceStream = new WebResourceStream(this.crypto, controller, owner,
        (): boolean => this.web === web && web.matchesSource(url) &&
          !['closing', 'stopped', 'cleanup-failed'].includes(this.state.phase));
    }
    this.storageSampleRead = 0; this.storagePublishedRead = 0; this.storageDropped = 0;
    this.consoleAllowed = consoleAllowed === true;
    this.webConsole = new WebConsoleSession(this.crypto,
      (): boolean => this.consoleActive() && this.resourceBinding() === this.consoleBinding,
      (): boolean => web.busy(), (): void => web.cancelEvaluation());
    this.webStorageWrite?.dispose();
    this.webStorageWrite = new StorageWriteSession(this.crypto,
      (): string => this.storageActive() && this.web === web && web.controlledStorageReady() ?
        this.resourceBinding() : '',
      (): boolean => web.busy(), (): void => { this.storageWriteStatus(); });
    this.webStorage = new WebStorageCapture(this.crypto,
      (): boolean => this.storageActive() && this.web === web && this.resourceBinding() === this.storageBinding &&
        (this.webStorage?.usesControlled() ? web.controlledStorageReady() : web.cookieStorageReady()),
      (): boolean => web.busy(), (): void => web.cancelStorage(),
      (): void => { void this.cancelStorageWrite(); });
  }
  webResourceFilesPending(): boolean { return this.webResourceFiles?.needsClose() ?? false; }
  registerWebFiles(controller: webview.WebviewController, targetId: string, url: string,
    manager: resourceManager.ResourceManager, entries: ResourceFileEntry[], consoleAllowed: boolean = false,
    storageAccess: ControlledStorageAccess | undefined = undefined, schemeOwned: boolean = false): void {
    requireWire(this.webResourceStream === undefined, 'RESOURCE_STREAM_CLOSE_REQUIRED');
    requireWire(!this.webResourceFilesPending(), 'RESOURCE_FILE_CLOSE_REQUIRED');
    requireWire(this.state.phase === 'idle' || this.state.phase === 'stopped' || this.state.phase === 'review',
      'INVALID_STATE');
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(!this.web?.busy(), 'WEB_CAPTURE_BUSY');
    requireWire(this.storageWriteStatus().pendingCleanup === 0, 'STORAGE_CLEANUP_REQUIRED');
    requireWire(canIUse('SystemCapability.Global.ResourceManager') &&
      canIUse('SystemCapability.FileManagement.File.FileIO'), 'RESOURCE_FILE_UNAVAILABLE');
    // Validate the existing Web registration scope before acquiring any descriptor.
    new PlatformWeb(controller, targetId, url, storageAccess);
    const generation = this.generation;
    const phase = this.state.phase;
    const owner = new WebResourceFiles(this.crypto, manager, url, entries,
      (): boolean => this.generation === generation && this.state.phase === phase);
    this.webResourceFiles = owner;
    let resources: ResourceEntry[] = [];
    try {
      resources = owner.read();
      this.registerWeb(controller, targetId, url, resources, consoleAllowed, storageAccess, schemeOwned);
    } finally {
      for (const entry of resources) { entry.body = ''; }
      if (!owner.needsClose()) { this.webResourceFiles = undefined; }
    }
  }
  attachWebResourceStream(): boolean {
    const owner = this.webResourceStream;
    if (owner === undefined) { return false; }
    if (owner.attach()) { return true; }
    void this.stop('RESOURCE_STREAM_ATTACH_FAILED');
    return false;
  }
  webResourceStreamPending(): boolean { return this.webResourceStream?.pending() ?? false; }
  private storageActive(): boolean {
    try {
      return this.webActive(this.generation, 'arkweb.storage') && this.web?.storageReady() === true &&
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).appInfo.debug;
    } catch { return false; }
  }
  async captureWebStorage(): Promise<boolean> {
    if (!this.web?.cookieStorageReady()) { return false; }
    return this.captureStorage(false);
  }
  async captureControlledStorage(): Promise<boolean> {
    if (!this.web?.controlledStorageReady()) {
      if (this.webStorage?.usesControlled()) { this.cancelWebStorage(); }
      return false;
    }
    return this.captureStorage(true);
  }
  private async captureStorage(controlled: boolean): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const owner = this.webStorage;
    const web = this.web;
    const session = this.session;
    if (owner === undefined || web === undefined || session === undefined ||
      this.collecting || this.metricsPending || this.screenshot.busy() || web.busy() ||
      this.storageWriteStatus().pendingCleanup > 0) { return false; }
    if (!this.storageActive()) { this.cancelWebStorage(); return false; }
    const generation = this.generation;
    this.storageBinding = this.resourceBinding();
    const executor = (active: () => boolean,
      project: (text: string) => StorageSnapshot): Promise<StorageSnapshot> => {
      if (controlled) {
        return web.readControlledStorage(active, project, (): void => {
          this.storageStatus(); this.consoleStatus(); this.storageWriteStatus();
        });
      }
      return web.readCookies(active, project, (): void => {
        this.storageStatus(); this.consoleStatus(); this.storageWriteStatus();
      });
    };
    const operation = controlled ?
      owner.readControlled(session.expiresAt(), this.state.connectionTarget.replace('ws:', 'http:')
        .replace('/bridge/v1', '/kit-readonly.html'), web.storageKeys(), executor) :
      owner.read(session.expiresAt(), executor);
    if (owner.status().phase === 'reading') { this.clearStorageEvidence(); }
    this.storageStatus(); this.consoleStatus();
    try {
      const captured = await operation;
      if (captured && generation === this.generation) {
        clearTimeout(this.storageTimer);
        this.storageTimer = setTimeout(() => { this.webStorageSnapshot(); },
          Math.max(0, owner.status().expiresAt - Date.now()));
      }
      return captured;
    } finally { this.storageStatus(); this.storageWriteStatus(); }
  }
  cancelWebStorage(): void {
    clearTimeout(this.storageTimer); this.storageTimer = -1;
    this.webStorage?.cancel(); this.storageBinding = '';
    this.clearStorageEvidence();
    this.state.storagePhase = 'idle'; this.state.storageReason = ''; this.state.storageCookieEntries = 0;
    this.state.storageSource = 'cookie'; this.state.storageLocalEntries = 0; this.state.storageSessionEntries = 0;
    this.state.storageNativePending = this.web?.busy() ?? false;
    this.consoleStatus();
  }
  private clearStorageEvidence(): void {
    if (this.storageSample) { this.storageDropped++; }
    this.storageSample = ''; this.state.storagePublished = false;
    if (this.state.exportWebStorage) { this.cancelExport(); }
  }
  private storageStatus(): void {
    const snapshot = this.webStorage?.snapshot();
    const status: StorageStatus = this.webStorage?.status() ??
      { phase: 'idle', reason: '', nativePending: false, expiresAt: 0 };
    this.state.storagePhase = status.phase; this.state.storageReason = status.reason;
    this.state.storageNativePending = status.nativePending;
    this.state.storageCookieEntries = status.phase === 'completed' ? snapshot?.cookieEntryCount ?? 0 : 0;
    this.state.storageSource = this.webStorage?.usesControlled() ? 'controlled-page' : 'cookie';
    this.state.storageLocalEntries = status.phase === 'completed' ? snapshot?.localEntryCount ?? 0 : 0;
    this.state.storageSessionEntries = status.phase === 'completed' ? snapshot?.sessionEntryCount ?? 0 : 0;
    if (status.phase !== 'completed' || snapshot === undefined) { this.clearStorageEvidence(); }
    this.state.storagePublished = status.phase === 'completed' && this.webStorage?.captureId() === this.storagePublishedRead;
  }
  webStorageSnapshot(): StorageSnapshot | undefined {
    const snapshot = this.webStorage?.snapshot();
    this.storageStatus();
    return this.state.storagePhase === 'completed' ? snapshot : undefined;
  }
  async publishWebStorage(): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const owner = this.webStorage;
    const session = this.session;
    if (owner === undefined || session === undefined || this.collecting || this.metricsPending ||
      this.screenshot.busy() || this.web?.busy() || this.state.unacknowledged > 0) { return false; }
    const snapshot = this.webStorageSnapshot();
    const read = owner.captureId();
    if (snapshot === undefined || snapshot.cookieSource !== 'url-related-incognito-unpartitioned' ||
      read === this.storagePublishedRead) { return false; }
    const generation = this.generation;
    this.collecting = true;
    try {
      const payload: Record<string, Object> = {
        'targetId': snapshot.targetId, 'entryCount': snapshot.cookieEntryCount, 'summary': KIT_STORAGE_SUMMARY
      };
      const event = makeWebEvent(session.negotiated, this.epoch, this.sequence + 1, 'arkweb.storage',
        payload, this.monotonicNs(), new Date().toISOString());
      if (this.webStorageSnapshot() === undefined || owner.captureId() !== read) { return false; }
      this.storagePublishedRead = read; this.sequence = event.sequence;
      clearTimeout(this.sampleTimer);
      this.state.unacknowledged = this.sequence;
      this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
      await this.send(JSON.stringify(session.seal(event)), generation);
      if (generation !== this.generation || this.webStorageSnapshot() === undefined || owner.captureId() !== read) { return false; }
      this.storageSample = JSON.stringify(makeWebFile(event, [], this.storageDropped));
      this.storageSampleRead = read; this.state.storagePublished = true;
      return true;
    } catch {
      if (generation === this.generation) { await this.stop('CONNECTION_FAILED'); }
      return false;
    } finally {
      if (generation === this.generation) {
        this.collecting = false; this.storageStatus();
        if (this.state.phase === 'connected' && this.state.unacknowledged === 0) { this.scheduleSample(generation); }
      }
    }
  }
  webStorageFile(): KitWebFile | undefined {
    if (this.webStorageSnapshot() === undefined || !this.storageSample ||
      this.storageSampleRead !== this.webStorage?.captureId()) { return undefined; }
    return JSON.parse(this.storageSample) as KitWebFile;
  }
  reviewStorageWrite(area: string, key: string, value: string | null, ttlMs: number = 10000): StorageWriteReview {
    const capture = this.webStorage;
    const owner = this.webStorageWrite;
    const session = this.session;
    requireWire(capture !== undefined && owner !== undefined && session !== undefined &&
      this.storageActive() && this.web?.controlledStorageReady() === true, 'STORAGE_WRITE_UNAVAILABLE');
    if (capture === undefined || owner === undefined || session === undefined) { throw new Error('STORAGE_WRITE_UNAVAILABLE'); }
    const review = capture.reviewWrite(owner, area, key, value, this.state.connectionTarget.replace('ws:', 'http:')
      .replace('/bridge/v1', '/kit-readonly.html'), this.resourceBinding(), session.expiresAt(), ttlMs);
    this.state.storageWritePlanHash = review.planHash;
    this.storageWriteStatus();
    return review;
  }
  confirmStorageWrite(planHash: string): boolean {
    const confirmed = this.webStorageWrite?.confirm(planHash) ?? false;
    this.storageWriteStatus(); return confirmed;
  }
  private storageWriteExecutor(): StorageWriteExecutor | undefined {
    const web = this.web;
    if (web === undefined) { return undefined; }
    return { busy: (): boolean => web.busy(),
      execute: (code: string, active: () => boolean, dispatched: () => void): Promise<string> => {
        return web.mutateControlledStorage(code, active, (): void => {
          dispatched();
          this.webStorage?.cancel(false); this.storageBinding = '';
          this.clearStorageEvidence(); this.cancelExport(); this.webDomSample = ''; this.state.webNodes = 0;
        }, (): void => {
          this.storageWriteStatus(); this.storageStatus(); this.consoleStatus();
        });
      } };
  }
  async executeStorageWrite(planHash: string): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const executor = this.storageWriteExecutor();
    const owner = this.webStorageWrite;
    if (owner === undefined || executor === undefined || this.collecting || this.metricsPending ||
      this.screenshot.busy()) { return false; }
    const operation = owner.apply(planHash, executor);
    this.storageWriteStatus();
    try { return await operation; }
    finally { this.storageWriteStatus(); this.storageStatus(); this.consoleStatus(); }
  }
  async cancelStorageWrite(): Promise<void> {
    const operation = this.webStorageWrite?.cancel(this.storageWriteExecutor());
    this.storageWriteStatus();
    try { await operation; } finally { this.storageWriteStatus(); }
  }
  async retryStorageRestore(): Promise<boolean> {
    const executor = this.storageWriteExecutor();
    if (executor === undefined || this.webStorageWrite === undefined) { return false; }
    const operation = this.webStorageWrite.retryRestore(executor);
    this.storageWriteStatus();
    try { return await operation; } finally { this.storageWriteStatus(); }
  }
  storageWriteStatus(): StorageWriteStatus {
    const status: StorageWriteStatus = this.webStorageWrite?.status() ??
      { phase: 'idle', commandId: '', revocation: 'not-needed', reason: '', nativePending: false,
        pendingCleanup: 0, authentication: 'not-authenticated' };
    this.state.storageWritePhase = status.phase; this.state.storageWriteCommandId = status.commandId;
    this.state.storageWriteReason = status.reason; this.state.storageWriteRevocation = status.revocation;
    this.state.storageWritePending = status.nativePending; this.state.storageWriteCleanup = status.pendingCleanup;
    if (!['review', 'confirmed'].includes(status.phase)) { this.state.storageWritePlanHash = ''; }
    return status;
  }
  private consoleActive(): boolean {
    try {
      return this.consoleAllowed && this.webActive(this.generation, 'arkweb.console') &&
        this.web?.resourceReady() === true &&
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).appInfo.debug;
    } catch { return false; }
  }
  reviewConsole(code: string, ttlMs: number = 30000): ConsoleReview {
    const owner = this.webConsole;
    requireWire(!this.web?.busy(), 'CONSOLE_CAPTURE_BUSY');
    requireWire(this.storageWriteStatus().pendingCleanup === 0, 'STORAGE_CLEANUP_REQUIRED');
    this.cancelConsole();
    const session = this.session;
    requireWire(owner !== undefined && session !== undefined && this.consoleActive(), 'CONSOLE_UNAVAILABLE');
    if (owner === undefined || session === undefined) { throw new Error('CONSOLE_UNAVAILABLE'); }
    this.consoleBinding = this.resourceBinding();
    try {
      const review = owner.review(code, this.consoleBinding, session.expiresAt(), ttlMs);
      this.state.consolePlanHash = review.planHash; this.consoleStatus();
      this.consoleTimer = setTimeout(() => {
        if (this.state.consolePlanHash === review.planHash) { this.cancelConsole(); }
      }, Math.max(0, review.expiresAt - Date.now()));
      return review;
    } catch (error) {
      this.cancelConsole();
      throw new Error((error as Error).message === 'CONSOLE_UNAVAILABLE' ? 'CONSOLE_UNAVAILABLE' : 'CONSOLE_CODE_INVALID');
    }
  }
  confirmConsole(planHash: string): boolean {
    const confirmed = this.webConsole?.confirm(planHash) ?? false;
    this.consoleStatus(); return confirmed;
  }
  async executeConsole(planHash: string): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const owner = this.webConsole;
    const web = this.web;
    if (owner === undefined || web === undefined || this.collecting || this.screenshot.busy() ||
      this.storageWriteStatus().pendingCleanup > 0) { return false; }
    const operation = owner.execute(planHash, (code: string, active: () => boolean,
      project: (message: webview.JsMessageExt) => ConsoleResult): Promise<ConsoleResult> => {
      // Even a same-URL script may change DOM. Old frozen exports cannot describe
      // the page after this irreversible operation.
      this.cancelWebStorage(); this.cancelExport(); this.webDomSample = ''; this.state.webNodes = 0;
      return web.evaluate(code, active, project, (): void => { this.consoleStatus(); this.storageStatus(); });
    });
    this.consoleStatus(); this.storageStatus();
    try { return await operation; }
    finally { this.consoleStatus(); }
  }
  cancelConsole(): void {
    clearTimeout(this.consoleTimer); this.consoleTimer = -1;
    this.webConsole?.cancel(); this.consoleBinding = '';
    this.state.consolePhase = 'idle'; this.state.consolePlanHash = ''; this.state.consoleCommandId = '';
    this.state.consoleResultType = ''; this.state.consoleReason = ''; this.state.consoleNativePending = this.web?.busy() ?? false;
    this.storageStatus();
  }
  consoleStatus(): ConsoleStatus {
    const status: ConsoleStatus = this.webConsole?.status() ??
      { phase: 'idle', commandId: '', reason: '', nativePending: false,
        resultType: '', bytes: 0, summary: '', authentication: 'not-authenticated' };
    this.state.consolePhase = status.phase; this.state.consoleCommandId = status.commandId;
    this.state.consoleResultType = status.resultType; this.state.consoleReason = status.reason;
    this.state.consoleNativePending = status.nativePending;
    if (status.phase === 'idle') { this.state.consolePlanHash = ''; }
    return status;
  }
  private resourceBinding(): string {
    const binding: Record<string, Object> = {
      'connection': this.bodyBinding(), 'targetId': 'web-main', 'document': this.web?.revision() ?? -1
    };
    return canonical(binding);
  }
  private webResourceActive(): boolean {
    try { return this.webActive(this.generation, 'arkweb.network') && this.web?.resourceReady() === true; }
    catch { return false; }
  }
  webResourceCatalog(): ResourceMetadata[] { return this.webResources?.catalog() ?? []; }
  reviewWebResource(rule: string, samples: string, ttlMs: number = 30000): ResourceReview {
    this.cancelWebResource();
    requireWire(!this.webResourceStreamPending(), 'RESOURCE_STREAM_CLOSE_REQUIRED');
    const owner = this.webResources;
    const session = this.session;
    requireWire(owner !== undefined && session !== undefined && this.webResourceActive(), 'RESOURCE_UNAVAILABLE');
    if (owner === undefined || session === undefined) { throw new Error('RESOURCE_UNAVAILABLE'); }
    this.webResourceBinding = this.resourceBinding();
    try {
      const review = owner.review(rule, samples, this.webResourceBinding, session.expiresAt(), ttlMs);
      this.state.webResourcePhase = 'review'; this.state.webResourcePlanHash = review.planHash;
      this.webResourceTimer = setTimeout(() => {
        if (this.state.webResourcePlanHash === review.planHash) { this.cancelWebResource(); }
      }, Math.max(0, review.expiresAt - Date.now()));
      return review;
    } catch (error) {
      this.cancelWebResource();
      throw new Error((error as Error).message === 'RESOURCE_UNAVAILABLE' ? 'RESOURCE_UNAVAILABLE' : 'RESOURCE_RULE_INVALID');
    }
  }
  confirmWebResource(planHash: string): boolean {
    const confirmed = this.webResources?.confirm(planHash) ?? false;
    this.webResourceStatus(); return confirmed;
  }
  cancelWebResource(): void {
    clearTimeout(this.webResourceTimer); this.webResourceTimer = -1;
    this.webResources?.cancel(); this.webResourceBinding = '';
    this.webResourceStream?.cancel();
    this.state.webResourcePhase = 'idle'; this.state.webResourcePlanHash = ''; this.state.webResourceHits = 0;
  }
  webResourceStatus(): ResourceStatus {
    const status: ResourceStatus = this.webResources?.status() ??
      { phase: 'idle', hits: 0, bytes: 0, authentication: 'not-authenticated' };
    this.state.webResourcePhase = status.phase; this.state.webResourceHits = status.hits;
    if (status.phase === 'idle') { this.state.webResourcePlanHash = ''; }
    return status;
  }
  interceptWebResource(request: WebResourceRequest,
    original: () => WebResourceResponse | undefined = (): WebResourceResponse | undefined => undefined): WebResourceResponse | undefined {
    let response: WebResourceResponse | undefined = undefined;
    try { response = this.webResources?.resolve(request); }
    finally { this.webResourceStatus(); }
    // Only an unselected request reaches the original host callback. Its exact
    // response/error and the host-owned interceptor registration stay intact.
    return response === undefined ? original() : response;
  }
  webNavigationRequest(request: WebResourceRequest): void {
    try {
      if (request.isMainFrame()) { this.web?.request(request.getRequestUrl(), request.getRequestMethod()); }
    } catch { this.webDropped++; }
  }
  webPageBegin(url: string): void {
    this.cancelConsole();
    this.cancelWebStorage();
    this.cancelWebResource();
    this.webDomSample = ''; this.state.webNodes = 0;
    this.webConsoleSample = ''; this.webNetworkSample = ''; this.webPending = [];
    this.webNavigationGeneration = this.webActive(this.generation, 'arkweb.network') ? this.generation : -1;
    try { this.web?.begin(url); }
    catch { this.state.webReason = 'WEB_SOURCE_CHANGED'; }
  }
  webPageEnd(url: string): void {
    try {
      const observation = this.web?.end(url);
      if (this.webNavigationGeneration === this.generation) { this.queueWeb(observation); }
      this.webNavigationGeneration = -1;
    }
    catch { this.webDropped++; }
  }
  observeWebConsole(message: ConsoleMessage): void {
    if (!this.webActive(this.generation, 'arkweb.console')) { return; }
    try { this.queueWeb(this.web?.console(message)); }
    catch { this.webDropped++; }
  }
  private queueWeb(observation: WebObservation | undefined): void {
    if (observation === undefined || !this.webActive(this.generation, observation.channel)) { return; }
    if (this.webPending.length === 32) { this.webPending.shift(); this.webDropped++; }
    this.webPending.push(observation);
  }
  private webActive(generation: number, channel: string): boolean {
    const session = this.session;
    return generation === this.generation && this.state.phase === 'connected' && session !== undefined &&
      Date.now() < session.expiresAt() && session.negotiated.channels.some((offer) => offer.channel === channel);
  }
  async captureWebDom(): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    const web = this.web;
    const session = this.session;
    if (web === undefined || session === undefined || !this.webActive(this.generation, 'arkweb.dom') ||
      this.collecting || this.screenshot.busy() || this.state.unacknowledged > 0 || web.busy() ||
      this.storageWriteStatus().pendingCleanup > 0) { return false; }
    const generation = this.generation;
    const revision = web.revision();
    this.collecting = true; this.webDomSample = ''; this.state.webNodes = 0; this.state.webPhase = 'reading';
    try {
      const operation = web.read((): boolean => this.webActive(generation, 'arkweb.dom'),
        (): void => { this.storageStatus(); this.consoleStatus(); this.storageWriteStatus(); });
      this.storageStatus(); this.consoleStatus(); this.storageWriteStatus();
      const nodes = await operation;
      if (!this.webActive(generation, 'arkweb.dom')) { return false; }
      const payload: Record<string, Object> = {
        'targetId': web.targetId, 'nodeCount': nodes.length, 'summary': 'registered-web;structure-only;bounded-full-dom'
      };
      const event = makeWebEvent(session.negotiated, this.epoch, ++this.sequence, 'arkweb.dom',
        payload, this.monotonicNs(), new Date().toISOString());
      clearTimeout(this.sampleTimer);
      this.state.unacknowledged = this.sequence;
      this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
      try { await this.send(JSON.stringify(session.seal(event)), generation); }
      catch { if (generation === this.generation) { await this.stop('CONNECTION_FAILED'); } return false; }
      if (!this.webActive(generation, 'arkweb.dom') || revision !== web.revision() || !web.controlled()) { return false; }
      this.webDomSample = JSON.stringify(makeWebFile(event, nodes, this.webDropped));
      this.webDropped += nodes.length; this.state.webNodes = nodes.length;
      this.state.webReason = ''; this.state.webPhase = 'completed';
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.state.webReason = (error as Error).message === 'WEB_CAPTURE_TIMEOUT' ? 'WEB_CAPTURE_TIMEOUT' : 'WEB_CAPTURE_FAILED';
        this.state.webPhase = 'failed';
      }
      return false;
    } finally {
      if (generation === this.generation) {
        this.collecting = false;
        if (this.state.phase === 'connected' && this.state.unacknowledged === 0) { this.scheduleSample(generation); }
      }
    }
  }
  private webSourceCurrent(): boolean {
    try { return this.web?.controlled() === true; }
    catch { return false; }
  }
  webDomFile(): KitWebFile | undefined {
    return this.webActive(this.generation, 'arkweb.dom') && this.webSourceCurrent() && this.webDomSample ?
      JSON.parse(this.webDomSample) as KitWebFile : undefined;
  }
  webConsoleFile(): KitWebFile | undefined {
    return this.webActive(this.generation, 'arkweb.console') && this.webSourceCurrent() && this.webConsoleSample ?
      JSON.parse(this.webConsoleSample) as KitWebFile : undefined;
  }
  webNetworkFile(): KitWebFile | undefined {
    return this.webActive(this.generation, 'arkweb.network') && this.webSourceCurrent() && this.webNetworkSample ?
      JSON.parse(this.webNetworkSample) as KitWebFile : undefined;
  }
  registerNetwork(request: http.HttpRequest): void {
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(this.state.phase === 'idle' || this.state.phase === 'stopped', 'INVALID_STATE');
    this.network = new PlatformNetwork(request);
    this.networkBody = new NetworkBodyCapture(this.crypto, 'network-main',
      (): boolean => this.networkActive(this.generation) && this.bodyBinding() === this.networkBodyBinding);
    this.networkMock = new NetworkMock(this.crypto, 'network-main',
      (): boolean => this.networkActive(this.generation) && this.bodyBinding() === this.networkMockBinding);
  }
  unregisterNetwork(): Promise<void> { return this.stop('NETWORK_SOURCE_REMOVED'); }
  private bodyBinding(): string {
    const session = this.session;
    if (session === undefined) { return ''; }
    const binding: Record<string, Object> = {
      'identity': session.negotiated.identity, 'sessionEpoch': this.epoch, 'generation': this.generation
    };
    return canonical(binding);
  }
  reviewNetworkBody(rule: string): BodyReview {
    const body = this.networkBody;
    const session = this.session;
    requireWire(body !== undefined && session !== undefined && this.networkActive(this.generation),
      'BODY_CAPTURE_UNAVAILABLE');
    if (body === undefined || session === undefined) { throw new Error('BODY_CAPTURE_UNAVAILABLE'); }
    this.cancelNetworkBody();
    this.networkBodyBinding = this.bodyBinding();
    try {
      const review = body.review(rule, this.networkBodyBinding, session.expiresAt());
      this.state.networkBodyPlanHash = review.planHash;
      this.state.networkBodyPhase = 'review';
      this.networkBodyTimer = setTimeout(() => {
        if (this.state.networkBodyPlanHash === review.planHash) { this.cancelNetworkBody(); }
      }, Math.max(0, review.expiresAt - Date.now()));
      return review;
    } catch (error) {
      this.cancelNetworkBody();
      if ((error as Error).message === 'BODY_CAPTURE_UNAVAILABLE') { throw new Error('BODY_CAPTURE_UNAVAILABLE'); }
      throw new Error('BODY_RULE_INVALID');
    }
  }
  confirmNetworkBody(planHash: string): boolean {
    const result = this.networkBody?.confirm(planHash) ?? false;
    this.syncNetworkBody();
    return result;
  }
  cancelNetworkBody(): void {
    clearTimeout(this.networkBodyTimer); this.networkBodyTimer = -1;
    this.networkBody?.cancel(); this.networkBodyBinding = '';
    this.state.networkBodyPhase = 'idle'; this.state.networkBodyPlanHash = '';
    this.state.networkBodyPreviewText = '';
  }
  networkBodyPreview(): BodyPreview | undefined {
    const preview = this.networkBody?.preview();
    this.syncNetworkBody();
    return preview;
  }
  private syncNetworkBody(): void {
    this.state.networkBodyPhase = this.networkBody?.status() ?? 'idle';
    this.state.networkBodyPreviewText = this.networkBody?.preview()?.body ?? '';
    if (this.state.networkBodyPhase === 'idle') { this.state.networkBodyPlanHash = ''; }
  }
  reviewNetworkMock(rulesJson: string, samplesJson: string, ttlMs: number = 30000): MockReview {
    const mock = this.networkMock;
    const session = this.session;
    this.cancelNetworkMock();
    requireWire(mock !== undefined && session !== undefined && this.networkActive(this.generation), 'MOCK_UNAVAILABLE');
    if (mock === undefined || session === undefined) { throw new Error('MOCK_UNAVAILABLE'); }
    this.networkMockBinding = this.bodyBinding();
    try {
      const review = mock.review(rulesJson, samplesJson, this.networkMockBinding, session.expiresAt(), ttlMs);
      this.state.networkMockPlanHash = review.planHash;
      this.state.networkMockPhase = 'review';
      this.networkMockTimer = setTimeout(() => {
        if (this.state.networkMockPlanHash === review.planHash) { this.cancelNetworkMock(); }
      }, Math.max(0, review.expiresAt - Date.now()));
      return review;
    } catch (error) {
      this.cancelNetworkMock();
      throw new Error((error as Error).message === 'MOCK_UNAVAILABLE' ? 'MOCK_UNAVAILABLE' : 'MOCK_RULE_INVALID');
    }
  }
  confirmNetworkMock(planHash: string): boolean {
    const confirmed = this.networkMock?.confirm(planHash) ?? false;
    this.networkMockStatus();
    return confirmed;
  }
  cancelNetworkMock(): void {
    clearTimeout(this.networkMockTimer); this.networkMockTimer = -1;
    this.networkMock?.cancel(); this.networkMockBinding = '';
    this.state.networkMockPhase = 'idle'; this.state.networkMockPlanHash = '';
    this.state.networkMockHits = 0; this.state.networkMockPending = 0;
  }
  networkMockStatus(): MockStatus {
    const status: MockStatus = this.networkMock?.status() ??
      { phase: 'idle', hits: 0, pending: 0, authentication: 'not-authenticated' };
    this.state.networkMockPhase = status.phase;
    this.state.networkMockHits = status.hits; this.state.networkMockPending = status.pending;
    if (status.phase === 'idle') { this.state.networkMockPlanHash = ''; }
    return status;
  }
  async requestNetwork(url: string, options: http.HttpRequestOptions, classification: string = 'unknown',
    resourceType: string = 'unknown'): Promise<http.HttpResponse> {
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    const network = this.network;
    requireWire(network !== undefined, 'NETWORK_SOURCE_REQUIRED');
    if (network === undefined) { throw new Error('NETWORK_SOURCE_REQUIRED'); }
    const generation = this.generation;
    const session = this.session;
    const capturing = this.networkActive(generation) && session !== undefined;
    const requestId = 'request-' + (++this.networkRequests);
    try {
      const pending = network.request(url, options, requestId,
        (): boolean => capturing && this.networkActive(generation),
        (observation: NetworkObservation | undefined): void => {
          if (observation === undefined) { this.networkDropped++; return; }
          if (this.networkPending.length === 32) { this.networkPending.shift(); this.networkDropped++; }
          this.networkPending.push(observation);
        }, this.networkBody, classification, this.networkMock, resourceType);
      this.networkMockStatus();
      return await pending;
    } finally {
      if (generation === this.generation) { this.syncNetworkBody(); this.networkMockStatus(); }
    }
  }
  private networkActive(generation: number): boolean {
    const session = this.session;
    return generation === this.generation && this.state.phase === 'connected' && session !== undefined &&
      Date.now() < session.expiresAt() && session.negotiated.channels.some((offer) => offer.channel === 'app.network');
  }
  networkFile(): KitNetworkFile | undefined {
    if (!this.networkActive(this.generation) || !this.networkSample) { return undefined; }
    return JSON.parse(this.networkSample) as KitNetworkFile;
  }
  registerReplay(host: ReplayAdapter): void {
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(this.state.phase === 'idle' || this.state.phase === 'stopped', 'INVALID_STATE');
    this.replay?.dispose(); this.replayHost = host;
    this.replay = new SemanticReplaySession(this.crypto, (): ReplaySource | undefined => this.replaySource(), host,
      (): void => { this.replayStatus(); });
  }
  private replaySource(): ReplaySource | undefined {
    const source = this.uiHighlightSource(), session = this.session;
    if (source === undefined || session === undefined) { return undefined; }
    // The current Producer has no compiled build attestation. This field stays
    // unverified even when a desktop invitation repeats its claimed build ID.
    const result: ReplaySource = { buildId: session.negotiated.identity.buildId, buildBinding: 'unverified',
      sourceHash: source.sourceHash, binding: source.binding, windowId: source.windowId, deadline: source.deadline };
    return result;
  }
  replayAvailable(): boolean {
    return this.replay !== undefined && this.replayHost !== undefined && !this.replayBusy() &&
      this.replaySource()?.buildBinding === 'local-artifact';
  }
  replayBuildId(): string { return this.session?.negotiated.identity.buildId ?? ''; }
  private replayBusy(): boolean {
    const status = this.replay?.status();
    return status !== undefined && (status.nativePending || status.pendingCleanup > 0);
  }
  reviewReplay(step: SemanticReplayStep, buildId: string): ReplayReview {
    requireWire(this.replayAvailable() && !this.collecting && !this.metricsPending && !this.screenshot.busy() &&
      !this.web?.busy() && this.uiHighlightStatus().pendingCleanup === 0 &&
      this.storageWriteStatus().pendingCleanup === 0 && this.state.unacknowledged === 0, 'REPLAY_LOCAL_BUILD_REQUIRED');
    const owner = this.replay;
    if (owner === undefined) { throw new Error('REPLAY_UNAVAILABLE'); }
    try { return owner.review(step, buildId); } finally { this.replayStatus(); }
  }
  confirmReplay(planHash: string): boolean {
    const confirmed = this.replay?.confirm(planHash) ?? false; this.replayStatus(); return confirmed;
  }
  async executeReplay(planHash: string): Promise<boolean> {
    const owner = this.replay;
    if (owner === undefined || this.collecting || this.metricsPending || this.screenshot.busy() || this.web?.busy() ||
      this.uiHighlightStatus().pendingCleanup > 0 || this.storageWriteStatus().pendingCleanup > 0 ||
      this.state.unacknowledged > 0) { return false; }
    const status = owner.status();
    if (status.phase !== 'confirmed' || status.planHash !== planHash) { return false; }
    this.uiSample = ''; this.state.uiNodes = 0; this.state.uiReason = '';
    this.webDomSample = ''; this.state.webNodes = 0; this.cancelWebStorage();
    this.cancelScreenshot(); this.cancelExport();
    try { return await owner.apply(planHash); } finally { this.replayStatus(); }
  }
  cancelReplay(): void { this.replay?.cancel(); this.replayStatus(); }
  async retryReplayRestore(): Promise<boolean> {
    const restored = await this.replay?.retryRestore() ?? false;
    this.replayStatus();
    if (restored && this.state.phase === 'cleanup-failed' && this.state.reason === 'REPLAY_RESTORE_REQUIRED' &&
      this.socket === undefined && !this.screenshot.busy() && !this.dfx.busy() && !this.exporter.busy() &&
      !this.web?.busy() && this.uiHighlightStatus().pendingCleanup === 0) {
      this.state.phase = 'stopped'; this.state.reason = '';
    }
    return restored;
  }
  replayStatus(): ReplayStatus {
    const status: ReplayStatus = this.replay?.status() ?? { phase: 'idle', reason: '', commandId: '', planHash: '',
      assertion: 'not-run', nativePending: false, pendingCleanup: 0, revocation: 'not-needed', authentication: 'unverified' };
    this.state.replayPhase = status.phase; this.state.replayReason = status.reason; this.state.replayPlanHash = status.planHash;
    this.state.replayCommandId = status.commandId; this.state.replayAssertion = status.assertion;
    this.state.replayPending = status.nativePending; this.state.replayCleanup = status.pendingCleanup;
    this.state.replayRevocation = status.revocation;
    return status;
  }
  uiHighlightAvailable(): boolean {
    return this.uiHighlight !== undefined && this.uiHighlightHost !== undefined &&
      this.uiHighlightStatus().pendingCleanup === 0 && this.uiHighlightSource() !== undefined;
  }
  private uiHighlightSource(): UiHighlightSource | undefined {
    const session = this.session;
    const context = this.uiContext;
    try {
      const bundle = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      if (!bundle.appInfo.debug || context === undefined || session === undefined || !this.webActive(this.generation, 'ui') ||
        !canIUse('SystemCapability.ArkUI.ArkUI.Full') || this.uiRoot !== 'bridge_capture_root') { return undefined; }
      const binding: Record<string, Object> = { 'identity': session.negotiated.identity,
        'epoch': this.epoch, 'generation': this.generation, 'root': this.uiRoot, 'window': this.uiWindow };
      const source: UiHighlightSource = { targetId: 'bridge_snapshot_target', windowId: this.uiWindow,
        sourceHash: readUiHighlightSource(context, this.crypto), binding: this.crypto.hash(canonical(binding)),
        deadline: session.expiresAt() };
      return source;
    } catch { return undefined; }
  }
  reviewUiHighlight(): UiHighlightReview {
    requireWire(this.uiHighlightAvailable() && !this.screenshot.busy() && !this.collecting,
      'UI_HIGHLIGHT_UNAVAILABLE');
    const owner = this.uiHighlight;
    if (owner === undefined) { throw new Error('UI_HIGHLIGHT_UNAVAILABLE'); }
    try { return owner.review(); } finally { this.uiHighlightStatus(); }
  }
  confirmUiHighlight(planHash: string): boolean {
    const confirmed = this.uiHighlight?.confirm(planHash) ?? false;
    this.uiHighlightStatus(); return confirmed;
  }
  executeUiHighlight(planHash: string): boolean {
    if (this.replayBusy()) { return false; }
    const owner = this.uiHighlight;
    if (owner === undefined || this.screenshot.busy() || this.collecting) { return false; }
    const status = owner.status();
    if (status.phase !== 'confirmed' || status.planHash !== planHash) { this.uiHighlightStatus(); return false; }
    // Revoke old snapshots and pending export selection before host state effects.
    this.uiSample = ''; this.state.uiNodes = 0; this.state.uiReason = '';
    this.cancelScreenshot(); this.cancelExport();
    try { return owner.apply(planHash); } finally { this.uiHighlightStatus(); }
  }
  cancelUiHighlight(): void {
    this.uiHighlight?.cancel(); this.uiHighlightStatus();
  }
  retryUiHighlightCleanup(): boolean {
    const cleared = this.uiHighlight?.retryClear() ?? false;
    this.uiHighlightStatus();
    if (cleared && this.state.phase === 'cleanup-failed' && this.state.reason === 'UI_HIGHLIGHT_CLEAR_FAILED' &&
      this.socket === undefined && !this.screenshot.busy() && !this.dfx.busy() &&
      !this.exporter.busy() && !this.web?.busy()) {
      this.state.phase = 'stopped'; this.state.reason = '';
    }
    return cleared;
  }
  uiHighlightStatus(): UiHighlightStatus {
    const status: UiHighlightStatus = this.uiHighlight?.status() ?? {
      phase: 'idle', reason: '', commandId: '', planHash: '', revocation: 'not-needed',
      pendingCleanup: 0, displayExpiresAt: 0, authentication: 'unverified'
    };
    this.state.uiHighlightPhase = status.phase; this.state.uiHighlightReason = status.reason;
    this.state.uiHighlightPlanHash = status.planHash; this.state.uiHighlightCommandId = status.commandId;
    this.state.uiHighlightRevocation = status.revocation; this.state.uiHighlightCleanup = status.pendingCleanup;
    return status;
  }
  registerUi(context: UIContext, rootId: string, windowId: string, screenshotAllowed: boolean = false,
    highlightHost: UiHighlightHost | undefined = undefined): void {
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(!this.screenshot.busy(), 'SCREENSHOT_CAPTURE_BUSY');
    requireWire(this.uiHighlightStatus().pendingCleanup === 0, 'UI_HIGHLIGHT_CLEANUP_REQUIRED');
    requireWire(this.state.phase === 'idle' || this.state.phase === 'stopped', 'INVALID_STATE');
    requireWire(rootId === 'bridge_capture_root' && match(windowId, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'), 'UI_SCOPE_INVALID');
    this.uiContext = context;
    this.uiRoot = rootId;
    this.uiWindow = windowId;
    this.screenshotAllowed = screenshotAllowed;
    this.uiHighlightHost = highlightHost;
  }
  unregisterUi(): Promise<void> {
    return this.stop('UI_SOURCE_REMOVED');
  }
  initialize(): void {
    if (this.identity !== undefined) { return; }
    try {
      const capabilities: string[] = [
        'SystemCapability.Security.CryptoFramework',
        'SystemCapability.Communication.NetStack', 'SystemCapability.HiviewDFX.HiProfiler.HiDebug',
        'SystemCapability.MiscServices.Time'
      ];
      if (!capabilities.every((name: string) => canIUse(name))) {
        this.state.phase = 'unavailable';
        this.state.reason = 'CAPABILITY_UNAVAILABLE';
        return;
      }
      const bundle = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      requireWire(bundle.appInfo.debug, 'DEBUG_BUILD_REQUIRED');
      const sessionId = hex(this.crypto.random(16));
      this.identity = {
        project: 'pending', buildId: 'unverified:' + bundle.name + ':' + bundle.versionCode,
        device: 'ephemeral-' + hex(this.crypto.random(8)), process: 'pid-' + process.pid,
        sessionId: sessionId, fingerprint: ''
      };
      this.state.localTarget = '--buildId ' + this.identity.buildId + '\n--device ' + this.identity.device +
        '\n--process ' + this.identity.process + '\n--sessionId ' + this.identity.sessionId;
      this.enabled = true;
    } catch {
      this.state.phase = 'unavailable';
      this.state.reason = 'DEBUG_BUILD_REQUIRED';
    }
  }
  /**
   * Development-only invitation fetch. The workbench must be started with
   * --dev-auto-pair on a fixed loopback port; production workbenches never
   * expose this endpoint.
   */
  async devInvitation(): Promise<string> {
    const identity = this.identity;
    requireWire(this.enabled && identity !== undefined && this.state.phase !== 'closing', 'INVALID_STATE');
    if (identity === undefined) { throw new Error('INVALID_STATE'); }
    const request = http.createHttp();
    try {
      const query = '?buildId=' + encodeURIComponent(identity.buildId) +
        '&device=' + encodeURIComponent(identity.device) +
        '&process=' + encodeURIComponent(identity.process) +
        '&sessionId=' + encodeURIComponent(identity.sessionId);
      const response = await request.request('http://127.0.0.1:50838/dev-invitation' + query, {
        method: http.RequestMethod.GET, expectDataType: http.HttpDataType.STRING, usingProxy: false,
        connectTimeout: 3000, readTimeout: 5000, maxLimit: 16384
      });
      const text = response.result;
      requireWire(response.responseCode === 200 && typeof text === 'string' && text.length > 0 && text.length <= 16384,
        'DEV_PAIR_UNAVAILABLE');
      return text as string;
    } finally {
      request.destroy();
    }
  }

  review(text: string): void {
    requireWire(!this.webResourceStreamPending(), 'RESOURCE_STREAM_CLOSE_REQUIRED');
    requireWire(!this.webResourceFilesPending(), 'RESOURCE_FILE_CLOSE_REQUIRED');
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(!this.screenshot.busy(), 'SCREENSHOT_CAPTURE_BUSY');
    requireWire(!this.dfx.busy(), 'DFX_CAPTURE_BUSY');
    requireWire(!this.metricsPending, 'METRICS_CAPTURE_BUSY');
    requireWire(!this.web?.busy(), 'WEB_CAPTURE_BUSY');
    requireWire(this.storageWriteStatus().pendingCleanup === 0, 'STORAGE_CLEANUP_REQUIRED');
    requireWire(this.uiHighlightStatus().pendingCleanup === 0, 'UI_HIGHLIGHT_CLEANUP_REQUIRED');
    requireWire(this.enabled && this.state.phase !== 'closing', 'INVALID_STATE');
    requireWire(this.socket === undefined && !this.exporter.busy(), 'INVALID_STATE');
    this.cancelWebStorage();
    this.cancelNetworkMock();
    this.cancelNetworkBody();
    this.session?.close();
    this.session = undefined;
    if (this.pairing !== undefined) { this.pairing.invitation.oneTimeCode = ''; }
    this.pairing = undefined;
    clearTimeout(this.deadlineTimer);
    try {
      const pairing = parsePairing(text, this.crypto, Date.now());
      const expected = this.identity;
      const scope = pairing.invitation.handshake.identity;
      requireWire(expected !== undefined, 'INVALID_STATE');
      if (expected === undefined) { throw new Error('INVALID_STATE'); }
      requireWire(scope.buildId === expected.buildId && scope.device === expected.device &&
        scope.process === expected.process && scope.sessionId === expected.sessionId, 'IDENTITY_MISMATCH');
      this.pairing = pairing;
      this.state.fingerprint = pairing.invitation.fingerprint;
      this.state.scope = JSON.stringify(scope, null, 2);
      this.state.connectionTarget = pairing.endpoint;
      this.state.reason = '';
      this.state.phase = 'review';
      this.deadlineTimer = setTimeout(() => { void this.stop('INVITATION_EXPIRED'); },
        Math.max(0, pairing.invitation.expiresAt - Date.now()));
    } catch {
      this.state.phase = 'idle';
      this.state.reason = 'INVITATION_REJECTED';
      throw new Error('INVITATION_REJECTED');
    }
  }
  async confirm(): Promise<void> {
    if (this.state.phase !== 'review') { return; }
    try { await this.startConnection(); }
    catch { await this.stop('CONNECTION_FAILED'); }
  }
  private async startConnection(): Promise<void> {
    requireWire(!this.webResourceStreamPending(), 'RESOURCE_STREAM_CLOSE_REQUIRED');
    requireWire(!this.webResourceFilesPending(), 'RESOURCE_FILE_CLOSE_REQUIRED');
    const pairing = this.pairing;
    requireWire(this.state.phase === 'review' && pairing !== undefined && this.socket === undefined, 'INVALID_STATE');
    if (pairing === undefined) { throw new Error('INVALID_STATE'); }
    requireWire(this.web === undefined || this.web.matchesSource(
      pairing.endpoint.replace('ws:', 'http:').replace('/bridge/v1', '/kit-readonly.html')), 'WEB_SCOPE_INVALID');
    const generation = ++this.generation;
    clearTimeout(this.deadlineTimer);
    this.state.phase = 'pairing';
    this.state.ackThrough = 0;
    this.state.unacknowledged = 0;
    this.sequence = 0;
    this.epoch = '';
    this.queueCount = 0;
    this.receiveTail = Promise.resolve();
    this.clockProbes = [];
    this.memorySample = '';
    this.memoryDropped = 0;
    this.uiSample = '';
    this.uiDropped = 0;
    this.cancelScreenshot();
    this.state.uiNodes = 0;
    this.state.uiReason = '';
    this.networkPending = [];
    this.networkSample = '';
    this.networkDropped = 0;
    this.networkRequests = 0;
    this.networkTurn = true;
    this.cancelNetworkBody();
    this.cpuSample = ''; this.cpuDropped = 0;
    this.dfxSample = ''; this.observerTurn = 0;
    this.state.dfxPhase = 'idle'; this.state.dfxSequence = 0; this.state.dfxDropped = 0;
    this.state.cpuPhase = 'idle'; this.state.cpuReason = '';
    const supported: string[] = this.uiContext !== undefined && canIUse('SystemCapability.ArkUI.ArkUI.Full') ?
      ['hidebug', 'ui'] : ['hidebug'];
    if (this.network !== undefined) { supported.push('app.network'); }
    if (this.web !== undefined && canIUse('SystemCapability.Web.Webview.Core')) {
      supported.push('arkweb.dom', 'arkweb.console', 'arkweb.network', 'arkweb.storage');
    }
    if (canIUse('SystemCapability.HiviewDFX.HiAppEvent')) { supported.push('hiappevent'); }
    const session = new PairingSession(pairing, this.crypto, () => Date.now(), '1.1', supported);
    this.state.uiAvailable = session.negotiated.channels.some((offer) => offer.channel === 'ui');
    this.state.networkAvailable = session.negotiated.channels.some((offer) => offer.channel === 'app.network');
    this.state.webAvailable = session.negotiated.channels.some((offer) => offer.channel === 'arkweb.dom');
    this.state.storageAvailable = session.negotiated.channels.some((offer) => offer.channel === 'arkweb.storage');
    this.state.dfxAvailable = session.negotiated.channels.some((offer) => offer.channel === 'hiappevent');
    this.session = session;
    this.uiHighlight?.dispose();
    this.uiHighlight = new UiHighlightSession(this.crypto, (): UiHighlightSource | undefined =>
      this.uiHighlightSource(), this.uiHighlightHost, (): void => { this.uiHighlightStatus(); });
    const socket = webSocket.createWebSocket();
    this.socket = socket;
    socket.on('message', (error: BusinessError, data: string | ArrayBuffer) => {
      if (generation !== this.generation) { return; }
      if ((error && error.code !== 0) || typeof data !== 'string' || this.crypto.encode(data).length > 100000 || ++this.queueCount > 8) {
        void this.stop('FRAME_REJECTED');
        return;
      }
      let receivedNs: string;
      try { receivedNs = this.monotonicNs(); }
      catch { void this.stop('CLOCK_SAMPLE_INVALID'); return; }
      this.receiveTail = this.receiveTail.then(async (): Promise<void> => {
        if (generation === this.generation) { await this.receive(data, generation, receivedNs); }
      }).catch(() => {
        if (generation === this.generation) { void this.stop('FRAME_REJECTED'); }
      }).finally(() => {
        if (generation === this.generation) { this.queueCount--; }
      });
    });
    socket.on('error', () => {
      if (generation === this.generation) { void this.stop('CONNECTION_FAILED'); }
    });
    socket.on('close', () => {
      if (generation === this.generation) { void this.stop('CONNECTION_CLOSED'); }
    });
    socket.on('open', () => {
      if (generation !== this.generation) { void socket.close().catch(() => {}); return; }
      try {
        const request = session.request(true);
        void this.send(JSON.stringify(request), generation).catch(() => {
          if (generation === this.generation) { void this.stop('CONNECTION_FAILED'); }
        });
      } catch { void this.stop('PAIRING_REJECTED'); }
    });
    this.deadlineTimer = setTimeout(() => { void this.stop('PAIRING_TIMEOUT'); }, 10000);
    const headers: Record<string, string> = { 'Origin': pairing.endpoint.replace('ws:', 'http:').replace('/bridge/v1', '') };
    const options: webSocket.WebSocketRequestOptions = {
      header: headers, protocol: 'ohmate-readonly-v1', proxy: 'no-proxy'
    };
    try {
      const connected = await socket.connect(pairing.endpoint, options);
      if (generation === this.generation && !connected) { await this.stop('CONNECTION_FAILED'); }
    } catch {
      if (generation === this.generation) { await this.stop('CONNECTION_FAILED'); }
    }
  }
  private async receive(text: string, generation: number, receivedNs: string): Promise<void> {
    const session = this.session;
    if (session === undefined) { throw new Error('INVALID_STATE'); }
    if (this.state.phase === 'pairing') {
      session.finish(JSON.parse(text));
      this.state.phase = 'securing';
      return;
    }
    const value = session.open(JSON.parse(text));
    if (this.state.phase === 'securing') {
      const ready = keysOf(value, ['type', 'sessionEpoch']);
      requireWire(ready['type'] === 'ready');
      this.epoch = uuidOf(ready, 'sessionEpoch');
      this.state.phase = 'confirming';
      const response: Ready = {
        type: 'ready', sessionEpoch: this.epoch, clockSync: 'four-timestamp-v1',
        eventBatch: 'events-v1', retention: 'rolling-v1'
      };
      await this.send(JSON.stringify(session.seal(response)), generation);
      return;
    }
    if (this.state.phase === 'confirming') {
      const connected = keysOf(value, ['type', 'sessionEpoch', 'eventBatch', 'retention']);
      requireWire(connected['type'] === 'connected' && connected['sessionEpoch'] === this.epoch &&
        connected['eventBatch'] === 'events-v1' && connected['retention'] === 'rolling-v1');
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = setTimeout(() => { void this.stop('KEY_EXPIRED'); }, Math.max(0, session.expiresAt() - Date.now()));
      this.state.phase = 'connected';
      this.scheduleSample(generation);
      return;
    }
    const incoming = value as Record<string, Object>;
    if (this.state.phase === 'connected' && incoming['type'] === 'clock-probe') {
      const reply = makeClockReply(value, this.epoch, 'run-' + session.negotiated.identity.sessionId,
        receivedNs, this.monotonicNs());
      requireWire(this.clockProbes.length < 128 && !this.clockProbes.includes(reply.probeId), 'CLOCK_SAMPLE_INVALID');
      this.clockProbes.push(reply.probeId);
      await this.send(JSON.stringify(session.seal(reply)), generation);
      return;
    }
    requireWire(this.state.phase === 'connected' && this.state.unacknowledged === this.sequence && this.sequence > 0);
    this.state.ackThrough = readAck(value, session.negotiated, this.epoch, this.sequence);
    this.state.unacknowledged = 0;
    clearTimeout(this.ackTimer);
    this.scheduleSample(generation);
  }
  private scheduleSample(generation: number): void {
    clearTimeout(this.sampleTimer);
    this.sampleTimer = setTimeout(() => {
      void this.sample(generation).catch(() => {
        if (generation === this.generation) { void this.stop('COLLECTION_FAILED'); }
      });
    }, 1000);
  }
  private async sample(generation: number): Promise<void> {
    if (this.replayBusy()) { this.scheduleSample(generation); return; }
    if (this.collecting || this.metricsPending || this.screenshot.busy() ||
      this.state.unacknowledged > 0 || generation !== this.generation) { return; }
    this.collecting = true;
    try {
      if ((this.networkPending.length > 0 || this.webPending.length > 0 || this.dfx.count() > 0) && this.networkTurn) {
        this.networkTurn = false;
        for (let index = 0; index < 3; index++) {
          const selected = (this.observerTurn + index) % 3;
          if (selected === 0 && this.webPending.length > 0) {
            this.observerTurn = 1; await this.sampleWeb(generation); return;
          }
          if (selected === 1 && this.networkPending.length > 0) {
            this.observerTurn = 2; await this.sampleNetwork(generation); return;
          }
          if (selected === 2 && this.dfx.count() > 0) {
            this.observerTurn = 0; await this.sampleDfx(generation); return;
          }
        }
      }
      this.networkTurn = true;
      this.metricsPending = true;
      let pssBytes: number;
      try { pssBytes = await taskpool.execute(readPssBytes) as number; }
      finally { this.metricsPending = false; }
      const session = this.session;
      if (session === undefined || !this.webActive(generation, 'hidebug')) { return; }
      const event = makeMetricEvent(session.negotiated, this.epoch, ++this.sequence, 'run-' + session.negotiated.identity.sessionId,
        this.monotonicNs(), new Date().toISOString(), pssBytes);
      this.state.pssBytes = pssBytes;
      this.state.unacknowledged = this.sequence;
      this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
      await this.send(JSON.stringify(session.seal(event)), generation);
      if (this.webActive(generation, 'hidebug')) {
        // Keep only the latest successfully sent sample; revocation erases it.
        this.memorySample = JSON.stringify(makeMemoryFile(event, PSS_SOURCE_API, this.memoryDropped));
        this.memoryDropped++;
      }
    } finally {
      if (generation === this.generation) { this.collecting = false; }
    }
  }
  private async sampleNetwork(generation: number): Promise<void> {
    const session = this.session;
    if (!this.networkActive(generation) || session === undefined) {
      if (generation === this.generation) { await this.stop('KEY_EXPIRED'); }
      return;
    }
    const observation = this.networkPending.shift();
    if (observation === undefined) { return; }
    const event = makeNetworkEvent(session.negotiated, this.epoch, ++this.sequence, observation);
    this.state.unacknowledged = this.sequence;
    this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
    await this.send(JSON.stringify(session.seal(event)), generation);
    if (!this.networkActive(generation)) {
      if (generation === this.generation) { await this.stop('KEY_EXPIRED'); }
      return;
    }
    if (this.networkSample) { this.networkDropped++; }
    this.networkSample = JSON.stringify(makeNetworkFile(event, this.networkDropped));
    this.state.networkSequence = event.sequence;
    this.state.networkDiscarded = this.networkDropped;
  }
  private async sampleWeb(generation: number): Promise<void> {
    const observation = this.webPending.shift();
    const session = this.session;
    if (observation === undefined || session === undefined || !this.webActive(generation, observation.channel)) { return; }
    const event = makeWebEvent(session.negotiated, this.epoch, ++this.sequence, observation.channel,
      observation.payload, observation.monotonicNs, observation.wallTimeUtc);
    const revision = this.web?.revision();
    this.state.unacknowledged = this.sequence;
    this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
    await this.send(JSON.stringify(session.seal(event)), generation);
    if (!this.webActive(generation, observation.channel) || revision !== this.web?.revision()) { return; }
    if (observation.channel === 'arkweb.console') {
      if (this.webConsoleSample) { this.webDropped++; }
      this.webConsoleSample = JSON.stringify(makeWebFile(event, [], this.webDropped));
    } else {
      if (this.webNetworkSample) { this.webDropped++; }
      this.webNetworkSample = JSON.stringify(makeWebFile(event, [], this.webDropped));
    }
  }
  async captureUi(): Promise<boolean> {
    if (this.replayBusy()) { return false; }
    this.cancelUiHighlight();
    if (this.uiHighlightStatus().pendingCleanup > 0) { return false; }
    const context = this.uiContext;
    const session = this.session;
    if (this.state.phase !== 'connected' || context === undefined || session === undefined ||
      Date.now() >= session.expiresAt() || this.collecting || this.screenshot.busy() || this.state.unacknowledged > 0 ||
      !session.negotiated.channels.some((offer) => offer.channel === 'ui')) { return false; }
    const generation = this.generation;
    this.collecting = true;
    this.uiSample = '';
    this.state.uiNodes = 0;
    try {
      const nodes = readUiTree(context, this.uiRoot);
      if (!this.webActive(generation, 'ui')) { return false; }
      const next = this.sequence + 1;
      const event = makeUiEvent(session.negotiated, this.epoch, next,
        'run-' + session.negotiated.identity.sessionId, this.monotonicNs(), new Date().toISOString(), this.uiWindow, nodes.length);
      const file = makeUiFile(event, nodes, this.uiDropped);
      this.sequence = next;
      clearTimeout(this.sampleTimer);
      this.state.unacknowledged = this.sequence;
      this.ackTimer = setTimeout(() => { void this.stop('ACK_TIMEOUT'); }, 10000);
      try { await this.send(JSON.stringify(session.seal(event)), generation); }
      catch { if (generation === this.generation) { await this.stop('CONNECTION_FAILED'); } return false; }
      if (generation !== this.generation || this.state.phase !== 'connected') { return false; }
      if (Date.now() >= session.expiresAt()) { await this.stop('KEY_EXPIRED'); return false; }
      this.uiSample = JSON.stringify(file);
      this.uiDropped += nodes.length;
      this.state.uiNodes = nodes.length;
      this.state.uiReason = '';
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.state.uiReason = 'UI_CAPTURE_FAILED'; this.state.uiNodes = 0;
        // Error code only; never node text or user data.
        console.error('OHMATE_UI_CAPTURE_FAILED ' + (error as Error).message);
      }
      return false;
    } finally {
      if (generation === this.generation) { this.collecting = false; }
    }
  }
  uiFile(): KitUiFile | undefined {
    const session = this.session;
    if (this.state.phase !== 'connected' || session === undefined || Date.now() >= session.expiresAt() ||
      !this.uiSample) { return undefined; }
    return JSON.parse(this.uiSample) as KitUiFile;
  }
  memoryFile(): KitMemoryFile | undefined {
    const session = this.session;
    if (this.state.phase !== 'connected' || session === undefined || Date.now() >= session.expiresAt() ||
      (!this.memorySample && !this.cpuSample)) { return undefined; }
    const pss = this.memorySample ? JSON.parse(this.memorySample) as KitMemoryFile : undefined;
    const cpu = this.cpuSample ? JSON.parse(this.cpuSample) as KitMemoryFile : undefined;
    if (pss === undefined) { return cpu; }
    if (cpu === undefined) { return pss; }
    pss.records.push(cpu.records[0]);
    pss.records.sort((left: Record<string, Object>, right: Record<string, Object>): number =>
      (left['sequence'] as number) - (right['sequence'] as number));
    pss.source.id = 'process-pss-and-cpu'; pss.source.api = 'hidebug.getPss.getCpuUsage';
    pss.dropped += cpu.dropped;
    return pss;
  }
  reviewExport(): void {
    requireWire(!this.replayBusy(), 'REPLAY_CLEANUP_REQUIRED');
    requireWire(!this.exporter.busy(), 'EXPORT_BUSY');
    const file = this.memoryFile();
    requireWire(file !== undefined, 'EXPORT_SAMPLE_REQUIRED');
    if (file === undefined) { throw new Error('EXPORT_SAMPLE_REQUIRED'); }
    requireWire(canIUse('SystemCapability.FileManagement.File.FileIO') &&
      canIUse('SystemCapability.FileManagement.UserFileService') &&
      canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection'), 'EXPORT_CAPABILITY_UNAVAILABLE');
    this.cancelExport();
    const ui = this.uiFile();
    const network = this.networkFile();
    const web: WebExportSelection = {
      dom: this.webDomFile(), console: this.webConsoleFile(), navigation: this.webNetworkFile(),
      storage: this.webStorageFile()
    };
    const dfx = this.dfxFile();
    this.exportBytes = makeMemoryProblem(file, this.crypto, ui, network, web, dfx);
    this.state.exportDfxSequence = dfx?.records[0]['sequence'] as number ?? 0;
    const cpu = file.records.find((record: Record<string, Object>) =>
      (record['payload'] as Record<string, Object>)['metric'] === 'cpuPercent');
    this.state.exportCpuSequence = cpu?.['sequence'] as number ?? 0;
    this.state.exportWebNodes = web.dom?.records.length ?? 0;
    this.state.exportWebConsole = web.console !== undefined;
    this.state.exportWebNetwork = web.navigation !== undefined;
    this.state.exportWebStorage = web.storage !== undefined;
    this.state.exportNetworkSequence = network?.records[0]['sequence'] as number ?? 0;
    this.state.exportUiNodes = ui?.records.length ?? 0;
    this.state.exportSequence = file.records[file.records.length - 1]['sequence'] as number;
    this.state.exportDropped = file.dropped;
    this.state.exportBytes = this.exportBytes.length;
    this.state.exportPhase = 'review';
  }
  cancelExport(): void {
    ++this.exportGeneration;
    this.exportBytes.fill(0);
    this.exportBytes = new Uint8Array(0);
    this.state.exportPhase = 'idle';
    this.state.exportReason = '';
    this.state.exportSequence = 0;
    this.state.exportDropped = 0;
    this.state.exportBytes = 0;
    this.state.exportUiNodes = 0;
    this.state.exportNetworkSequence = 0;
    this.state.exportWebNodes = 0; this.state.exportWebConsole = false; this.state.exportWebNetwork = false;
    this.state.exportWebStorage = false;
    this.state.exportCpuSequence = 0; this.state.exportDfxSequence = 0;
  }
  async confirmExport(context: common.Context): Promise<void> {
    if (this.replayBusy()) { return; }
    if (this.state.phase !== 'connected' || this.state.exportPhase !== 'review' || this.exporter.busy()) { return; }
    const generation = this.exportGeneration;
    this.state.exportPhase = 'saving';
    try {
      const saved = await this.exporter.save(context, this.exportBytes, (): boolean => {
        const session = this.session;
        const storageValid = !this.state.exportWebStorage || this.webStorageFile() !== undefined;
        return generation === this.exportGeneration && this.state.phase === 'connected' &&
          session !== undefined && Date.now() < session.expiresAt() && storageValid;
      });
      if (generation === this.exportGeneration) { this.state.exportPhase = saved ? 'saved' : 'cancelled'; }
    } catch {
      if (generation === this.exportGeneration) {
        this.state.exportPhase = this.exporter.busy() ? 'cleanup-failed' : 'failed';
        this.state.exportReason = 'EXPORT_FAILED';
      }
    } finally {
      if (generation === this.exportGeneration) {
        this.exportBytes.fill(0);
        this.exportBytes = new Uint8Array(0);
      }
    }
  }
  private monotonicNs(): string {
    // Read milliseconds to preserve Number precision; declare 1ms quantization.
    const milliseconds = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
    requireWire(Number.isSafeInteger(milliseconds) && milliseconds >= 0, 'CLOCK_SAMPLE_INVALID');
    return (BigInt(milliseconds) * BigInt(1000000)).toString();
  }
  private async send(text: string, generation: number): Promise<void> {
    const socket = this.socket;
    if (generation !== this.generation || socket === undefined) { return; }
    requireWire(await socket.send(text), 'CONNECTION_FAILED');
  }
  stop(reason: string = 'USER_REVOKED'): Promise<void> {
    if (this.state.phase === 'closing') { return this.closing; }
    // Stop destroys the bound source; keep unresolved responsibility without dispatching into it.
    this.webStorageWrite?.dispose(); this.storageWriteStatus();
    this.replay?.dispose(); this.replayStatus(); this.replayHost = undefined;
    this.uiHighlight?.dispose(); this.uiHighlightStatus(); this.uiHighlightHost = undefined;
    ++this.generation;
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.sampleTimer);
    clearTimeout(this.ackTimer);
    this.clockProbes = [];
    this.memorySample = '';
    this.memoryDropped = 0;
    this.cpuSample = ''; this.cpuDropped = 0;
    this.state.cpuPhase = 'idle'; this.state.cpuReason = ''; this.state.cpuPercent = 0;
    this.dfx.invalidate(); this.dfxSample = '';
    this.state.dfxAvailable = false; this.state.dfxSequence = 0; this.state.dfxDropped = 0;
    this.uiSample = '';
    this.uiContext = undefined;
    this.uiRoot = '';
    this.uiWindow = '';
    this.uiDropped = 0;
    this.screenshotAllowed = false;
    this.cancelScreenshot();
    this.cancelNetworkBody();
    this.networkBody = undefined;
    this.cancelNetworkMock();
    this.networkMock = undefined;
    this.network = undefined;
    this.networkPending = [];
    this.networkSample = '';
    this.networkDropped = 0;
    this.networkRequests = 0;
    this.cancelWebStorage();
    this.cancelConsole(); this.consoleAllowed = false;
    this.cancelWebResource(); this.webResources?.clear(); this.webResources = undefined;
    if (this.webResourceStream !== undefined) {
      if (this.webResourceStream.close(reason === 'USER_REVOKED')) { this.webResourceStream = undefined; }
    }
    this.web?.invalidate();
    if (!this.web?.busy()) { this.web = undefined; }
    this.webPending = []; this.webDomSample = ''; this.webConsoleSample = ''; this.webNetworkSample = '';
    this.webDropped = 0; this.state.webAvailable = false; this.state.webNodes = 0;
    this.state.storageAvailable = false;
    this.webNavigationGeneration = -1;
    this.state.webReason = ''; this.state.webPhase = 'idle';
    this.state.networkAvailable = false;
    this.state.networkSequence = 0;
    this.state.networkDiscarded = 0;
    this.collecting = false;
    this.state.uiNodes = 0;
    this.state.uiReason = '';
    this.state.uiAvailable = false;
    this.cancelExport();
    this.session?.close();
    this.session = undefined;
    this.crypto.clear();
    if (this.pairing !== undefined) { this.pairing.invitation.oneTimeCode = ''; }
    this.pairing = undefined;
    this.state.reason = reason;
    // A transport that failed after being connected, or reported a close event,
    // is already terminal. Retry close best-effort so a dead native socket cannot
    // permanently block a fresh pairing with a new invitation.
    const terminalTransport = reason === 'CONNECTION_CLOSED' ||
      (reason === 'CONNECTION_FAILED' && this.state.phase === 'connected');
    const socket = this.socket;
    let retainedSocket = socket;
    this.socket = undefined;
    this.state.phase = 'closing';
    this.closing = Promise.resolve().then(async (): Promise<void> => {
      if (reason === 'USER_REVOKED') {
        try { this.webResourceFiles?.retryClose(); } catch { /* Exact owner remains for another explicit retry. */ }
        if (!this.webResourceFilesPending()) { this.webResourceFiles = undefined; }
      }
      let screenshotCloseFailed = false;
      try { await this.screenshot.close(); } catch { screenshotCloseFailed = true; }
      let dfxCloseFailed = false;
      try { this.dfx.close(); } catch { dfxCloseFailed = true; }
      this.state.dfxPhase = dfxCloseFailed ? 'cleanup-failed' : 'idle';
      let exportCloseFailed = false;
      try { this.exporter.close(); } catch { exportCloseFailed = true; }
      if (socket !== undefined) {
        // Attempt every detach and close even when the native layer throws.
        let detachFailed = false;
        try { socket.off('open'); } catch { detachFailed = true; }
        try { socket.off('message'); } catch { detachFailed = true; }
        try { socket.off('error'); } catch { detachFailed = true; }
        try { socket.off('close'); } catch { detachFailed = true; }
        if (terminalTransport) {
          try { await socket.close(); } catch { /* Transport is already dead. */ }
        } else {
          requireWire(await socket.close(), 'SOCKET_CLOSE_FAILED');
          requireWire(!detachFailed, 'SOCKET_CLOSE_FAILED');
        }
        retainedSocket = undefined;
      }
      requireWire(!dfxCloseFailed, 'DFX_CLOSE_FAILED');
      requireWire(!exportCloseFailed, 'EXPORT_CLOSE_FAILED');
      requireWire(!screenshotCloseFailed, 'SCREENSHOT_CLOSE_FAILED');
      requireWire(this.uiHighlightStatus().pendingCleanup === 0, 'UI_HIGHLIGHT_CLEAR_FAILED');
      requireWire(!this.replayBusy(), 'REPLAY_RESTORE_REQUIRED');
      requireWire(this.storageWriteStatus().pendingCleanup === 0, 'STORAGE_RESTORE_REQUIRED');
      requireWire(!this.webResourceFilesPending(), 'RESOURCE_FILE_CLOSE_REQUIRED');
      requireWire(this.webResourceStream === undefined, 'RESOURCE_STREAM_CLOSE_REQUIRED');
    }).then(() => {
      this.state.phase = 'stopped';
    }).catch(() => {
      this.socket = retainedSocket;
      this.state.phase = 'cleanup-failed';
      this.state.reason = 'SOCKET_CLOSE_FAILED';
      if (this.screenshot.needsClose()) {
        this.state.screenshotPhase = 'cleanup-failed';
        if (retainedSocket === undefined) { this.state.reason = 'SCREENSHOT_CLOSE_FAILED'; }
      }
      if (this.dfx.busy() && retainedSocket === undefined) { this.state.reason = 'DFX_CLOSE_FAILED'; }
      if (this.exporter.needsClose()) {
        this.state.exportPhase = 'cleanup-failed';
        this.state.exportReason = 'EXPORT_CLOSE_FAILED';
        if (retainedSocket === undefined) { this.state.reason = 'EXPORT_CLOSE_FAILED'; }
      }
      if (this.uiHighlightStatus().pendingCleanup > 0 && retainedSocket === undefined &&
        !this.screenshot.needsClose() && !this.dfx.busy() && !this.exporter.needsClose()) {
        this.state.reason = 'UI_HIGHLIGHT_CLEAR_FAILED';
      }
      if (this.replayBusy() && retainedSocket === undefined && !this.screenshot.needsClose() &&
        !this.dfx.busy() && !this.exporter.needsClose() && this.uiHighlightStatus().pendingCleanup === 0) {
        this.state.reason = 'REPLAY_RESTORE_REQUIRED';
      }
      if (this.storageWriteStatus().pendingCleanup > 0 && retainedSocket === undefined &&
        !this.screenshot.needsClose() && !this.dfx.busy() && !this.exporter.needsClose() &&
        this.uiHighlightStatus().pendingCleanup === 0 && !this.replayBusy()) {
        this.state.reason = 'STORAGE_RESTORE_REQUIRED';
      }
      if (this.webResourceFilesPending() && retainedSocket === undefined) {
        this.state.reason = 'RESOURCE_FILE_CLOSE_REQUIRED';
      }
      if (this.webResourceStream !== undefined && retainedSocket === undefined) {
        this.state.reason = 'RESOURCE_STREAM_CLOSE_REQUIRED';
      }
    });
    return this.closing;
  }
}

// Ability and page share the same owner so background/destroy cannot leave capture active.
export const producer: ProducerController = new ProducerController();
