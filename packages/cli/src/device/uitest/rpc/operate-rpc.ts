/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { BaseRpc } from './base-rpc.js';
import type { RpcOptions, RequestOptions } from './base-rpc.js';
import { OPERATE_ENDPOINT } from './rpc-endpoint.js';
import { createEnvelope, OPERATE_MODULE, OPERATE_METHOD } from './protocol.js';
import { requestId } from '../common/utils/id.js';

export class UiTestRpc extends BaseRpc {
  constructor(options: RpcOptions) {
    super({ ...options, endpoint: OPERATE_ENDPOINT });
  }

  /**
   * Operate RPC's managed resource: /data/local/tmp/agent.so
   */
  async _ensureManagedResources(): Promise<void> {
    if (this.config.get<boolean>('device.autoPushResources', true) === false) {
      return;
    }
    if (!this.device.resources || typeof this.device.resources.ensureAgent !== 'function') {
      return;
    }
    const state = await this.device.resources.ensureAgent();
    this.ctx.agentVersion = state.candidate.version;
  }

  /**
   * On process start failure, unconditionally re-push agent.so (suspected device-side corruption:
   * version probe still exists but code segment is broken).
   * After that, BaseRpc._ensureProcess retries the start.
   */
  async _onLaunchFailure(): Promise<void> {
    if (this.config.get<boolean>('device.autoPushResources', true) === false) {
      return;
    }
    if (!this.device.resources || typeof this.device.resources.repushAgent !== 'function') {
      return;
    }
    await this.device.resources.repushAgent();
  }

  buildProbePayload() {
    return createEnvelope({ module: OPERATE_MODULE, method: 'ping', params: {}, requestId: requestId() });
  }

  /**
   * Call device-side API
   */
  async call(api: string, thisRef: string = '', args: unknown[] = [], options: RequestOptions = {}): Promise<unknown> {
    const payload = createEnvelope({
      module: OPERATE_MODULE,
      method: OPERATE_METHOD,
      params: { api, this: thisRef, args, message_type: 'hypium' },
      requestId: requestId(),
    });
    if (this.dfx) {
      this.dfx.counter('rpc.call', 1, { api });
    }
    return this.request(payload, options);
  }

  /** Convenience method: ping (goes through full recovery chain) */
  async ping(options: RequestOptions = {}): Promise<unknown> {
    return this.request(this.buildProbePayload(), options);
  }
}
