/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { http } from '@kit.NetworkKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { requireWire } from './Wire';
import { NetworkBodyCapture, BodyTicket } from './NetworkBodyCapture';
import { NetworkMock } from './NetworkMock';

export interface NetworkObservation {
  requestId: string;
  method: string;
  status?: number;
  durationMs: number;
  wallTimeUtc: string;
  monotonicNs: string;
}
export const NETWORK_SOURCE_API: string = 'HttpRequest.request';

function uptime(): number {
  const value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  requireWire(Number.isSafeInteger(value) && value >= 0, 'CLOCK_SAMPLE_INVALID');
  return value;
}

export class PlatformNetwork {
  private requestSource: http.HttpRequest;
  constructor(request: http.HttpRequest) { this.requestSource = request; }

  // The application owns this instance, its options and destroy/cancellation.
  // Summary observation never changes the request, response, headers, body or chain.
  // An independently confirmed body owner may retain only its bounded projection.
  async request(url: string, options: http.HttpRequestOptions, requestId: string,
    active: () => boolean, complete: (value: NetworkObservation | undefined) => void,
    bodyCapture?: NetworkBodyCapture, classification: string = 'unknown',
    mock?: NetworkMock, resourceType: string = 'unknown'): Promise<http.HttpResponse> {
    if (active()) {
      const response = mock?.resolve(url, options, classification, resourceType);
      // Synthetic responses and failures stay outside native summaries/body
      // capture. Once selected, cancellation never falls back to the network.
      if (response !== undefined) { return await response; }
    }
    let started: number = -1;
    let method: string = '';
    let ticket: BodyTicket | undefined = undefined;
    if (active()) {
      try { started = uptime(); method = options.method ?? http.RequestMethod.GET; }
      catch { started = -1; }
      try { ticket = bodyCapture?.begin(requestId, url, options, classification); }
      catch { ticket = undefined; }
    }
    let response: http.HttpResponse;
    try { response = await this.requestSource.request(url, options); }
    catch (error) {
      this.report(requestId, method, started, undefined, active, complete);
      throw error as Error;
    }
    this.report(requestId, method, started, response, active, complete);
    if (ticket !== undefined && active()) {
      try {
        const current = bodyCapture?.begin(requestId, url, options, classification);
        if (current?.revision === ticket.revision) { bodyCapture?.complete(ticket, response); }
      } catch { /* Capture cannot change a business response. */ }
    }
    return response;
  }
  private report(requestId: string, method: string, started: number, response: http.HttpResponse | undefined,
    active: () => boolean, complete: (value: NetworkObservation | undefined) => void): void {
    if (!active()) { return; }
    let observation: NetworkObservation | undefined = undefined;
    try {
      const ended = uptime();
      requireWire(started >= 0 && ended >= started &&
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'].includes(method),
        'NETWORK_SAMPLE_INVALID');
      observation = {
        requestId: requestId, method: method, durationMs: ended - started,
        wallTimeUtc: new Date().toISOString(), monotonicNs: (BigInt(ended) * BigInt(1000000)).toString()
      };
      if (response !== undefined) {
        const status = response.responseCode;
        requireWire(Number.isInteger(status) && status >= 100 && status <= 599, 'NETWORK_SAMPLE_INVALID');
        observation.status = status;
      }
    } catch { observation = undefined; }
    complete(observation);
  }
}
