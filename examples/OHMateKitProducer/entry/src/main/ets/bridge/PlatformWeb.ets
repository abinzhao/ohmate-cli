/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { webview } from '@kit.ArkWeb';
import { systemDateTime } from '@kit.BasicServicesKit';
import { requireWire, match } from './Wire';
import { ConsoleResult, ConsoleWaitTimeout } from './WebConsoleSession';
import { StorageSnapshot, StorageWaitTimeout } from './WebStorageCapture';
import { ControlledStorageAccess, ControlledStorageKey, storageKeys, storageScript } from './ControlledStorage';

export interface WebNodeMetadata {
  nodeId: string;
  parentId: string | null;
  role: string;
  childCount: number;
}
interface PendingWebNode { value: Object; parentId: string | null; depth: number; }
interface DomParams { wants: string[]; }
interface DomCommand { method: string; params: DomParams; }
export interface WebObservation {
  channel: string;
  payload: Record<string, Object>;
  monotonicNs: string;
  wallTimeUtc: string;
}
export const WEB_DOM_API: string = 'WebviewController.executeAIPageCommand';
const tags: string[] = ['html', 'head', 'body', 'main', 'section', 'article', 'nav', 'header', 'footer',
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'input', 'label', 'select',
  'option', 'textarea', 'a', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'form', 'fieldset', 'legend', 'details', 'summary', 'iframe', 'canvas', 'video', 'audio', 'br'];

function recordOf(value: Object, allowed: string[]): Record<string, Object> {
  requireWire(value !== null && typeof value === 'object' && !Array.isArray(value), 'WEB_DOM_INVALID');
  const record = value as Record<string, Object>;
  requireWire(Object.keys(record).every((key: string) => allowed.includes(key)), 'WEB_DOM_INVALID');
  return record;
}
function childrenOf(record: Record<string, Object>): Object[] {
  if (record['children_nodes'] === undefined) { return []; }
  requireWire(Array.isArray(record['children_nodes']), 'WEB_DOM_INVALID');
  return record['children_nodes'] as Object[];
}
function readStructure(text: string, url: string, document: number): WebNodeMetadata[] {
  // FullDom includes private defaults; retain only a bounded structural projection.
  requireWire(text.length > 0 && text.length <= 65536, 'WEB_DOM_LIMIT');
  const root = recordOf(JSON.parse(text) as Object, ['url', 'title', 'children_nodes']);
  requireWire(root['url'] === url && Array.isArray(root['children_nodes']), 'WEB_SOURCE_CHANGED');
  const pending: PendingWebNode[] = childrenOf(root).map((value: Object): PendingWebNode => {
    return { value: value, parentId: null, depth: 0 };
  });
  requireWire(pending.length > 0 && pending.length <= 256, 'WEB_DOM_LIMIT');
  const result: WebNodeMetadata[] = [];
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    requireWire(item.depth <= 32, 'WEB_DOM_LIMIT');
    const value = recordOf(item.value, ['tag', 'text', 'attributes', 'children_nodes']);
    requireWire(typeof value['tag'] === 'string', 'WEB_DOM_INVALID');
    const role = (value['tag'] as string).toLowerCase();
    const children = childrenOf(value);
    requireWire(pending.length + children.length <= 256, 'WEB_DOM_LIMIT');
    const nodeId = 'dom-' + document + '-' + index;
    const node: WebNodeMetadata = {
      nodeId: nodeId, parentId: item.parentId, role: tags.includes(role) ? role : 'Element', childCount: children.length
    };
    result.push(node);
    for (const child of children) {
      const next: PendingWebNode = { value: child, parentId: nodeId, depth: item.depth + 1 };
      pending.push(next);
    }
  }
  return result;
}
function uptime(): number {
  const value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  requireWire(Number.isSafeInteger(value) && value >= 0, 'CLOCK_SAMPLE_INVALID');
  return value;
}
export class PlatformWeb {
  readonly targetId: string;
  private controller: webview.WebviewController;
  private url: string;
  private document: number = 0;
  private snapshot: number = 0;
  private pending: boolean = false;
  private ready: boolean = false;
  private alive: boolean = true;
  private method: string = '';
  private begun: number = -1;
  private cancelEvaluationWait: (() => void) | undefined = undefined;
  private cancelStorageWait: (() => void) | undefined = undefined;
  private storageAccess: ControlledStorageAccess | undefined = undefined;
  private allowedKeys: ControlledStorageKey[] = [];
  constructor(controller: webview.WebviewController, targetId: string, url: string,
    storageAccess: ControlledStorageAccess | undefined = undefined) {
    requireWire(targetId === 'web-main' && match(url, '^http://127[.]0[.]0[.]1:[1-9][0-9]{0,4}/kit-readonly[.]html$'),
      'WEB_SCOPE_INVALID');
    this.controller = controller; this.targetId = targetId; this.url = url;
    this.allowedKeys = storageKeys(storageAccess);
    if (storageAccess !== undefined) {
      this.storageAccess = { enabled: storageAccess.enabled, entries: this.allowedKeys };
    }
  }
  busy(): boolean { return this.pending; }
  revision(): number { return this.document; }
  resourceReady(): boolean { return this.ready && this.controlled(); }
  storageReady(): boolean { return this.resourceReady() && this.controller.isIncognitoMode() === true; }
  cookieStorageReady(): boolean {
    try { return this.storageReady() && (this.storageAccess === undefined || this.storageAccess.enabled() === false); }
    catch { return false; }
  }
  controlledStorageReady(): boolean {
    try { return this.storageReady() && this.allowedKeys.length > 0 && this.storageAccess?.enabled() === true; }
    catch { return false; }
  }
  storageKeys(): ControlledStorageKey[] {
    return this.allowedKeys.map((item: ControlledStorageKey): ControlledStorageKey => {
      return { area: item.area, key: item.key, sensitivity: item.sensitivity };
    });
  }
  matchesSource(url: string): boolean { return this.url === url && this.alive; }
  controlled(): boolean { return this.alive && this.controller.getUrl() === this.url; }
  invalidate(): void {
    this.alive = false; this.ready = false; this.document++; this.begun = -1; this.method = '';
    this.cancelEvaluation(); this.cancelStorage();
  }
  request(url: string, method: string): void {
    this.method = url === this.url && ['GET', 'HEAD'].includes(method) ? method : '';
  }
  begin(url: string): void {
    this.document++; this.ready = false; this.begun = -1;
    if (!this.alive || url !== this.url) { this.method = ''; return; }
    this.begun = uptime();
  }
  end(url: string): WebObservation | undefined {
    if (!this.alive || url !== this.url || this.begun < 0 || !this.controlled()) { return undefined; }
    this.ready = true;
    const start = this.begun; this.begun = -1;
    if (!this.method) { return undefined; }
    const end = uptime();
    requireWire(end >= start, 'CLOCK_SAMPLE_INVALID');
    const payload: Record<string, Object> = {
      'requestId': 'web-navigation-' + this.document, 'method': this.method, 'durationMs': end - start
    };
    this.method = '';
    return { channel: 'arkweb.network', payload: payload,
      monotonicNs: (BigInt(end) * BigInt(1000000)).toString(), wallTimeUtc: new Date().toISOString() };
  }
  console(message: ConsoleMessage): WebObservation | undefined {
    if (!this.ready || !this.controlled()) { return undefined; }
    const document = this.document;
    const source = message.getSource();
    if (!Number.isInteger(source) || source < 0 || source > 12) { return undefined; }
    const sourceId = message.getSourceId();
    const sourceRole = sourceId === this.url ? 'page' :
      sourceId === this.url.replace('/kit-readonly.html', '/kit-readonly.js') ? 'script' : '';
    if (!sourceRole) { return undefined; }
    const line = message.getLineNumber();
    if (!Number.isSafeInteger(line) || line < 0 || line > 1000000) { return undefined; }
    const level = message.getMessageLevel();
    const levels: string[] = ['debug', 'info', 'warn', 'error', 'info'];
    if (!Number.isInteger(level) || level < 1 || level > 5 ||
      !this.ready || !this.controlled() || this.document !== document) { return undefined; }
    const payload: Record<string, Object> = {
      'level': levels[level - 1], 'summary': 'source-' + source + ';' + sourceRole + ';line-' + line +
        ';frame-column-unverified;[MEMORY_ONLY]'
    };
    return { channel: 'arkweb.console', payload: payload,
      monotonicNs: (BigInt(uptime()) * BigInt(1000000)).toString(), wallTimeUtc: new Date().toISOString() };
  }
  cancelEvaluation(): void { this.cancelEvaluationWait?.(); }
  async evaluate(code: string, active: () => boolean,
    project: (message: webview.JsMessageExt) => ConsoleResult, settled: () => void): Promise<ConsoleResult> {
    requireWire(!this.pending && this.resourceReady() && active(), 'WEB_NOT_READY');
    const document = this.document;
    let waiting = true;
    let timer: number = -1;
    this.pending = true;
    const cancelled = new Promise<ConsoleResult>((_resolve, reject) => {
      this.cancelEvaluationWait = (): void => { waiting = false; reject(new Error('WEB_CONSOLE_CANCELLED')); };
      timer = setTimeout(() => { waiting = false; reject(new ConsoleWaitTimeout()); }, 3000);
    });
    // A timeout/revoke ends waiting only. Native ownership ends on settlement.
    const operation = Promise.resolve().then((): Promise<webview.JsMessageExt> => {
      requireWire(waiting && this.resourceReady() && active() && document === this.document, 'WEB_SOURCE_CHANGED');
      return this.controller.runJavaScriptExt(code);
    }).then((message: webview.JsMessageExt): ConsoleResult => {
      requireWire(waiting && this.resourceReady() && active() && document === this.document, 'WEB_SOURCE_CHANGED');
      const result = project(message);
      requireWire(waiting && this.resourceReady() && active() && document === this.document, 'WEB_SOURCE_CHANGED');
      return result;
    }).finally(() => { this.pending = false; settled(); });
    try { return await Promise.race([operation, cancelled]); }
    finally { waiting = false; clearTimeout(timer); this.cancelEvaluationWait = undefined; }
  }
  cancelStorage(): void { this.cancelStorageWait?.(); }
  async readControlledStorage(active: () => boolean, project: (text: string) => StorageSnapshot,
    settled: () => void): Promise<StorageSnapshot> {
    requireWire(this.controlledStorageReady(), 'STORAGE_ACCESS_DENIED');
    const code = storageScript(this.url, this.allowedKeys);
    return this.readStorage(active, project, settled, true, (current: () => boolean): Promise<string> => {
      return this.controller.runJavaScriptExt(code).then((message: webview.JsMessageExt): string => {
        requireWire(current(), 'WEB_SOURCE_CHANGED');
        requireWire(message.getType() === webview.JsMessageType.STRING, 'STORAGE_RESULT_INVALID');
        requireWire(current(), 'WEB_SOURCE_CHANGED');
        return message.getString();
      });
    });
  }
  async readCookies(active: () => boolean, project: (text: string) => StorageSnapshot,
    settled: () => void): Promise<StorageSnapshot> {
    return this.readStorage(active, project, settled, false,
      (): Promise<string> => webview.WebCookieManager.fetchCookie(this.url, true, false));
  }
  async mutateControlledStorage(code: string, active: () => boolean, dispatched: () => void,
    settled: () => void): Promise<string> {
    requireWire(!this.pending && this.controlledStorageReady() && active(), 'STORAGE_WRITE_BUSY');
    const document = this.document;
    this.pending = true;
    const current = (): boolean => this.controlledStorageReady() && document === this.document && active();
    try {
      requireWire(current(), 'STORAGE_WRITE_UNAVAILABLE');
      // Recovery responsibility must exist before invoking the native effect.
      dispatched();
      requireWire(current(), 'STORAGE_WRITE_UNAVAILABLE');
      const native = this.controller.runJavaScriptExt(code);
      // The native engine owns its dispatched script. Do not retain another
      // application reference while waiting; this is not physical erasure.
      code = '';
      const message = await native;
      requireWire(current(), 'STORAGE_WRITE_UNAVAILABLE');
      requireWire(message.getType() === webview.JsMessageType.STRING, 'STORAGE_MUTATION_INVALID');
      requireWire(current(), 'STORAGE_WRITE_UNAVAILABLE');
      const result = message.getString();
      requireWire(current(), 'STORAGE_WRITE_UNAVAILABLE');
      return result;
    } finally { code = ''; this.pending = false; settled(); }
  }
  private async readStorage(active: () => boolean, project: (text: string) => StorageSnapshot,
    settled: () => void, controlled: boolean, operationSource: (current: () => boolean) => Promise<string>): Promise<StorageSnapshot> {
    requireWire(!this.pending && this.storageReady() && active() &&
      (controlled || this.cookieStorageReady()), 'WEB_NOT_READY');
    const document = this.document;
    let waiting = true;
    let timer: number = -1;
    this.pending = true;
    const cancelled = new Promise<StorageSnapshot>((_resolve, reject) => {
      this.cancelStorageWait = (): void => { waiting = false; reject(new Error('WEB_STORAGE_CANCELLED')); };
      timer = setTimeout(() => { waiting = false; reject(new StorageWaitTimeout()); }, 3000);
    });
    // Waiting can end early; the shared native owner stays until settlement.
    const operation = Promise.resolve().then((): Promise<string> => {
      requireWire(waiting && this.storageReady() && active() && document === this.document &&
        (!controlled || this.controlledStorageReady()), 'WEB_SOURCE_CHANGED');
      return operationSource((): boolean => waiting && this.storageReady() && active() &&
        document === this.document && (!controlled || this.controlledStorageReady()));
    }).then((text: string): StorageSnapshot => {
      requireWire(waiting && this.storageReady() && active() && document === this.document, 'WEB_SOURCE_CHANGED');
      const result = project(text);
      requireWire(waiting && this.storageReady() && active() && document === this.document, 'WEB_SOURCE_CHANGED');
      return result;
    }).finally(() => { this.pending = false; settled(); });
    try { return await Promise.race([operation, cancelled]); }
    finally { waiting = false; clearTimeout(timer); this.cancelStorageWait = undefined; }
  }
  async read(active: () => boolean, settled: () => void): Promise<WebNodeMetadata[]> {
    requireWire(!this.pending, 'WEB_CAPTURE_BUSY');
    requireWire(this.ready && this.controlled() && active(), 'WEB_NOT_READY');
    const document = this.document;
    const snapshot = ++this.snapshot;
    const command: DomCommand = { method: 'getFullDom', params: { wants: [] } };
    this.pending = true;
    let timer: number = -1;
    let waiting = true;
    // Timeout ends the wait, not the native operation. Keep ownership until settlement.
    const operation = Promise.resolve().then((): Promise<string> => {
      requireWire(waiting && active() && this.ready && this.controlled() && document === this.document, 'WEB_SOURCE_CHANGED');
      return this.controller.executeAIPageCommand(JSON.stringify(command));
    }).then((text: string): WebNodeMetadata[] => {
      if (!waiting || !active() || !this.ready || !this.controlled() || document !== this.document) {
        throw new Error('WEB_SOURCE_CHANGED');
      }
      return readStructure(text, this.url, snapshot);
    }).finally(() => { this.pending = false; settled(); });
    const timeout = new Promise<WebNodeMetadata[]>((_resolve, reject) => {
      timer = setTimeout(() => { waiting = false; reject(new Error('WEB_CAPTURE_TIMEOUT')); }, 3000);
    });
    try { return await Promise.race([operation, timeout]); }
    finally { waiting = false; clearTimeout(timer); }
  }
}
