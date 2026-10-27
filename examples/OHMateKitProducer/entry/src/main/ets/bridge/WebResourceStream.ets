/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { webview, WebNetErrorList } from '@kit.ArkWeb';
import { CryptoPort, requireWire } from './Wire';
import { WebResourceOverride, ResourceDispatch } from './WebResourceOverride';

interface ResourceStreamRequest {
  request: webview.WebSchemeHandlerRequest;
  handler: webview.WebResourceHandler;
  buffers: ArrayBuffer[];
  stopped: boolean;
  ended: boolean;
  abortAttempted: boolean;
  cancelled: boolean;
  nativeCalls: number;
}

// The host grants exclusive scheme ownership for this dedicated Web instance.
// didFinish/clear only return native calls; request-stop is the buffer lifetime signal.
export class WebResourceStream {
  private crypto: CryptoPort;
  private controller: webview.WebviewController;
  private resources: WebResourceOverride;
  private active: () => boolean;
  private scheme: webview.WebSchemeHandler | undefined = undefined;
  private requests: ResourceStreamRequest[] = [];
  private owned: boolean = false;
  private closing: boolean = false;
  private closeAttempted: boolean = false;

  constructor(crypto: CryptoPort, controller: webview.WebviewController,
    resources: WebResourceOverride, active: () => boolean) {
    this.crypto = crypto; this.controller = controller; this.resources = resources; this.active = active;
  }
  pending(): boolean { return this.requests.length > 0 || (this.closing && this.owned); }
  attach(): boolean {
    if (this.closing || !this.current()) { return false; }
    if (this.owned) { return true; }
    try {
      const scheme = new webview.WebSchemeHandler();
      scheme.onRequestStart((request: webview.WebSchemeHandlerRequest, handler: webview.WebResourceHandler): boolean => {
        return this.start(request, handler);
      });
      scheme.onRequestStop((request: webview.WebSchemeHandlerRequest): void => this.stopped(request));
      this.scheme = scheme;
      // Native registration may apply and then throw. Record ownership first.
      this.owned = true;
      this.controller.setWebSchemeHandler('http', scheme);
      requireWire(this.current(), 'RESOURCE_STREAM_UNAVAILABLE');
      return true;
    } catch { this.closing = true; return false; }
  }
  cancel(): void {
    this.resources.cancel();
    for (const item of this.requests.slice()) {
      item.cancelled = true;
      this.abort(item, false);
    }
  }
  close(explicit: boolean = true): boolean {
    if (this.closeAttempted && !explicit) { return !this.pending() && !this.owned; }
    this.closeAttempted = true; this.closing = true;
    this.resources.cancel();
    for (const item of this.requests) { item.cancelled = true; }
    for (const item of this.requests.slice()) { this.abort(item, explicit); }
    if (this.owned) {
      try { this.controller.clearWebSchemeHandler(); this.owned = false; }
      catch { return false; }
    }
    if (!this.pending()) { this.scheme = undefined; return true; }
    return false;
  }
  private current(): boolean {
    try { return this.active() === true; } catch { return false; }
  }
  private start(request: webview.WebSchemeHandlerRequest, handler: webview.WebResourceHandler): boolean {
    if (this.closing || !this.owned || !this.current()) { return false; }
    // Duplicate callback identities must never redispatch an owned native handler.
    if (this.requests.some((item: ResourceStreamRequest): boolean => item.request === request || item.handler === handler)) {
      return true;
    }
    let item: ResourceStreamRequest | undefined = undefined;
    try {
      return this.resources.dispatchScheme(request, (resource: ResourceDispatch, current: () => boolean): void => {
        item = this.claim(request, handler);
        const owner = item;
        requireWire(this.requests.length <= 4, 'RESOURCE_STREAM_QUOTA');
        const bytes = this.crypto.encode(resource.body);
        try {
          requireWire(bytes.length <= 65536 && current(), 'RESOURCE_STREAM_UNAVAILABLE');
          for (let offset = 0; offset < bytes.length; offset += 4096) {
            owner.buffers.push(bytes.slice(offset, Math.min(offset + 4096, bytes.length)).buffer as ArrayBuffer);
          }
        } finally { bytes.fill(0); resource.body = ''; }
        void this.pump(owner, resource, current);
      });
    } catch {
      if (item === undefined) { item = this.claim(request, handler); }
      item.cancelled = true; this.abort(item, false); this.resources.cancel();
      return true;
    }
  }
  private claim(request: webview.WebSchemeHandlerRequest, handler: webview.WebResourceHandler): ResourceStreamRequest {
    const item: ResourceStreamRequest = { request: request, handler: handler, buffers: [],
      stopped: false, ended: false, abortAttempted: false, cancelled: false, nativeCalls: 0 };
    this.requests.push(item);
    return item;
  }
  private async pump(item: ResourceStreamRequest, resource: ResourceDispatch, current: () => boolean): Promise<void> {
    const available = (): boolean => !item.stopped && !item.cancelled && !this.closing && this.current() && current();
    try {
      await Promise.resolve();
      requireWire(available(), 'RESOURCE_STREAM_CANCELLED');
      const response = new webview.WebSchemeHandlerResponse();
      response.setUrl(resource.url); response.setStatus(200); response.setStatusText('OK');
      response.setMimeType(resource.mimeType); response.setEncoding('UTF-8');
      response.setHeaderByName('Cache-Control', 'no-store', true);
      response.setHeaderByName('X-Content-Type-Options', 'nosniff', true);
      response.setHeaderByName('X-OHMate-Resource', resource.resourceId, true);
      requireWire(available(), 'RESOURCE_STREAM_CANCELLED');
      this.invoke(item, (): void => item.handler.didReceiveResponse(response));
      for (const buffer of item.buffers) {
        await Promise.resolve();
        requireWire(available(), 'RESOURCE_STREAM_CANCELLED');
        this.invoke(item, (): void => item.handler.didReceiveResponseBody(buffer));
      }
      requireWire(available(), 'RESOURCE_STREAM_CANCELLED');
      this.invoke(item, (): void => item.handler.didFinish()); item.ended = true;
    } catch { item.cancelled = true; this.resources.cancel(); this.abort(item, false); }
  }
  private abort(item: ResourceStreamRequest, retry: boolean): void {
    if (item.stopped || item.ended || item.nativeCalls > 0 || (item.abortAttempted && !retry)) { return; }
    item.abortAttempted = true;
    try { this.invoke(item, (): void => item.handler.didFail(WebNetErrorList.ERR_ABORTED, true)); item.ended = true; }
    catch { /* Retain the exact handler until native stop or explicit close retry. */ }
  }
  private stopped(request: webview.WebSchemeHandlerRequest): void {
    // URL equality cannot identify one of several native requests.
    const item = this.requests.find((value: ResourceStreamRequest): boolean => value.request === request);
    if (item === undefined) { return; }
    item.stopped = true; item.cancelled = true;
    this.release(item);
  }
  private invoke(item: ResourceStreamRequest, operation: () => void): void {
    item.nativeCalls++;
    try { operation(); }
    finally { item.nativeCalls--; this.release(item); }
  }
  private release(item: ResourceStreamRequest): void {
    if (!item.stopped || item.nativeCalls > 0) { return; }
    for (const buffer of item.buffers) { new Uint8Array(buffer).fill(0); }
    item.buffers = [];
    this.requests = this.requests.filter((value: ResourceStreamRequest): boolean => value !== item);
    if (this.closing && !this.pending()) { this.scheme = undefined; }
  }
}
