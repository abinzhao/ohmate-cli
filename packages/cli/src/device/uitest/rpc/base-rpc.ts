/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { RpcTransport, ConcurrencyMode } from './rpc-transport.js';
import { hasRemoteException, unwrapResult } from './protocol.js';
import { Mutex, SingleFlight, sleep, waitUntil } from '../common/utils/async.js';
import { compareVersions, extractVersion } from '../common/utils/version.js';
import { shellJoin, shellQuote } from '../common/utils/shell-escape.js';
import { isRecoverableRpcError } from '../common/errors.js';
import {
  RpcDisposedError,
  RpcError,
  RpcLifecycleError,
  RpcRemoteError,
  RpcTransportError,
  RpcTimeoutError,
} from '../common/errors.js';
import type { RpcEndpoint } from './rpc-endpoint.js';
import type { HMDevice } from '../device/device.js';
import type { Config } from '../common/config.js';
import type { Logger } from '../common/logger.js';
import type { Dfx } from '../common/dfx.js';

export interface BaseRpcOptions {
  device: HMDevice;
  endpoint: RpcEndpoint;
  config: Config;
  logger?: Logger | null;
  dfx?: Dfx | null;
  mode?: string;
}

export interface RpcContext {
  hostPort: number | null;
  deviceEndpoint: string | null;
  pids: number[];
  owned: boolean;
  resourcesPushed: boolean;
  style: 'unix' | 'tcp' | null;
  startedAt: number;
  startCount: number;
  resetCount: number;
  agentVersion?: string | null;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface ResetOptions {
  reason?: string;
  code?: string;
}

export interface ConnectProbeOptions {
  probe?: boolean;
  timeoutMs?: number;
}

/** Subclass constructor input (endpoint is injected by subclass, not in caller params) */
export type RpcOptions = Omit<BaseRpcOptions, 'endpoint'>;

interface DeclaredResource {
  name?: string;
  localPath: string;
  remotePath: string;
  version?: string;
  versionProbe?: string;
}

interface FastStateRecord {
  hostPort: number;
  deviceEndpoint: string;
  style: 'unix' | 'tcp';
  agentVersion?: string | null;
  uitestVersion?: string | null;
}

export const RpcState = {
  IDLE: 'IDLE',
  BOOTING: 'BOOTING',
  RESOURCES_READY: 'RESOURCES_READY',
  PROCESS_RUNNING: 'PROCESS_RUNNING',
  FORWARDED: 'FORWARDED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  READY: 'READY',
  WARM: 'WARM',
  RESETTING: 'RESETTING',
  ERROR: 'ERROR',
  DISPOSED: 'DISPOSED',
} as const;

export type RpcStateValue = (typeof RpcState)[keyof typeof RpcState];

export class BaseRpc {
  device: HMDevice;
  endpoint: RpcEndpoint;
  config: Config;
  name: string;
  displayName: string;
  logger: Logger | null;
  dfx: Dfx | null;
  mode: string;
  state: string;
  transport: RpcTransport | null;
  _mutex: Mutex;
  _epoch: number;
  _readyFlight: SingleFlight;
  _resetFlight: SingleFlight;
  _disposed: boolean;
  ctx: RpcContext;

  constructor({ device, endpoint, config, logger, dfx, mode }: BaseRpcOptions) {
    this.device = device;
    this.endpoint = endpoint;
    this.config = config;
    this.name = endpoint.name;
    this.displayName = endpoint.displayName || endpoint.name;
    this.logger = logger ? logger.child(`Rpc:${this.displayName}`) : null;
    this.dfx = dfx ? dfx.child({ endpoint: this.name }) : null;
    this.mode = mode || config.get('rpc.mode', 'stable');

    this.state = RpcState.IDLE;
    this.transport = null;
    this._mutex = new Mutex();

    /**
     * Epoch number: increments on each "connection generation" — reset, release, dispose, unexpected disconnection.
     * Purpose: concurrent requests use it to determine "when I failed, has the fault already been handled by someone else".
     *   Epoch unchanged → I am the first to discover the fault, I execute the reset;
     *   Epoch changed → someone else already reset, I just retry, no need to kill the process again.
     */
    this._epoch = 0;
    /** Concurrent initialization merge: N concurrent calls trigger only one complete preparation flow */
    this._readyFlight = new SingleFlight();
    /** Concurrent reset merge: N concurrent calls discovering the fault simultaneously, only reset once */
    this._resetFlight = new SingleFlight();
    /** Terminal state flag: after dispose, launching the process again is forbidden */
    this._disposed = false;

    this.ctx = this._freshContext();
  }

  /** Epoch number increment (connection generation) */
  _bumpEpoch(): number {
    this._epoch += 1;
    return this._epoch;
  }

  _freshContext(): RpcContext {
    return {
      hostPort: null,
      deviceEndpoint: null,
      pids: [],
      owned: false,
      resourcesPushed: false,
      style: null,
      startedAt: 0,
      startCount: 0,
      resetCount: 0,
    };
  }

  /** The endpoint's config node: rpc.operate / rpc.record */
  get endpointConfig(): Record<string, unknown> {
    return this.config.get(`rpc.${this.name}`, {});
  }

  get resources(): DeclaredResource[] {
    return (this.endpointConfig.resources as DeclaredResource[]) || [];
  }

  get isReady(): boolean {
    return this.state === RpcState.READY && !!this.transport && this.transport.isConnected;
  }

  /* ================================================================ */
  /* Lifecycle                                                         */
  /* ================================================================ */

  /**
   * Idempotent ready (concurrency-safe)
   *
   * Two layers of protection:
   *   1. SingleFlight: concurrent calls share **the same** preparation flow, no duplicate process launch
   *   2. If a reset is in progress at this moment, wait for it to finish first, to avoid "reset killing process"
   *      and "initialization launching process" crossing and tearing
   */
  async ensureReady(): Promise<RpcContext> {
    if (this._disposed) {
      throw new RpcDisposedError(`${this.name} rpc is disposed`, { details: { endpoint: this.name } });
    }
    if (this.isReady) {
      return this.ctx;
    }

    const resetting = this._resetFlight.pending('reset');
    if (resetting) {
      await resetting.catch(() => {});
      if (this._disposed) {
        throw new RpcDisposedError(`${this.name} rpc is disposed`, { details: { endpoint: this.name } });
      }
      if (this.isReady) {
        return this.ctx;
      }
    }

    return this._readyFlight.run('ready', () => this._ensureReadyOnce());
  }

  async _ensureReadyOnce(): Promise<RpcContext> {
    if (this._disposed) {
      throw new RpcDisposedError(`${this.name} rpc is disposed`, { details: { endpoint: this.name } });
    }
    if (this.isReady) {
      return this.ctx;
    }

    if (this.mode === 'fast') {
      const hit = await this._tryFastConnect();
      if (hit) {
        return this.ctx;
      }
    }
    await this._stableFlow();
    return this.ctx;
  }

  /**
   * Stable mode full flow: check → push → start → forward → connect → probe
   */
  async _stableFlow(): Promise<RpcContext> {
    const end = this.dfx ? this.dfx.timer('rpc.lifecycle.prepare', { mode: 'stable' }) : null;
    try {
      const style = await this.device.getEndpointStyle();
      const deviceEndpoint = this.endpoint.buildDeviceEndpoint(style);
      this.ctx.style = style;
      this.ctx.deviceEndpoint = deviceEndpoint;

      await this._ensureResources();
      this.state = RpcState.RESOURCES_READY;

      await this._ensureProcess(style);
      this.state = RpcState.PROCESS_RUNNING;

      let hostPort = await this._selectStableHostPort(style);
      if (!(await this._tryForward(hostPort, deviceEndpoint))) {
        // Preferred port (fixed/cached) is already occupied by another forwarding or binding failed:
        // probe for a free port and retry
        hostPort = await this.device.getFreeHostPort({ exclude: [hostPort] });
        await this._ensureForward(hostPort, deviceEndpoint);
      }
      this.ctx.hostPort = hostPort;
      this.state = RpcState.FORWARDED;

      await this._connectAndProbe(hostPort, { probe: true });
      this.state = RpcState.READY;
      await this._onStableReady(hostPort, deviceEndpoint, style, end);
      return this.ctx;
    } catch (err) {
      return this._onStableFlowError(err, end);
    }
  }

  async _onStableReady(hostPort: number, deviceEndpoint: string, style: 'unix' | 'tcp', end: ((extraFields?: Record<string, unknown>) => number) | null): Promise<void> {
    if (this.mode === 'fast') {
      await this._persistFastState({ hostPort, deviceEndpoint, style });
    }
    if (end) {
      end({ ok: 1 });
    }
    if (this.dfx) {
      this.dfx.counter('rpc.lifecycle.ready', 1, { mode: this.mode });
    }
    if (this.logger) {
      this.logger.info(
        `ready: tcp:${hostPort} -> ${deviceEndpoint} (mode=${this.mode}, owned=${this.ctx.owned})`,
      );
    }
  }

  _onStableFlowError(err: unknown, end: ((extraFields?: Record<string, unknown>) => number) | null): never {
    this.state = RpcState.ERROR;
    if (end) {
      end({ ok: 0 });
    }
    if (this.dfx) {
      this.dfx.counter('rpc.lifecycle.error', 1, { code: (err as Error & { code?: string })?.code || (err as Error)?.name });
    }
    const wrapped =
      err instanceof RpcError
        ? err
        : new RpcLifecycleError(`${this.name} rpc prepare failed: ${(err as Error).message}`, {
            cause: err as Error,
            details: { endpoint: this.name },
          });
    if (this.logger) {
      this.logger.error(`prepare failed: ${wrapped.message}`);
    }
    throw wrapped;
  }

  /**
   * Fast mode: direct connect to reuse port
   *
   * Port source priority:
   *   1. Cache persisted by SN in user directory (port/endpoint/style from last successful connection)
   *   2. Configured fixed port rpc.<endpoint>.fastHostPort
   * If connect + probe succeeds, reuse (no rebuild of forwarding, no restart of process);
   * on failure, delete cache and degrade to stable flow.
   */
  async _tryFastConnect(): Promise<boolean> {
    const cached = await this._readFastStateUnchecked();
    const style = cached?.style || await this.device.getEndpointStyle();
    const deviceEndpoint = this.endpoint.buildDeviceEndpoint(style);
    const fastCfg = this.config.get('rpc.fast', {}) as {
      connectTimeoutMs?: number;
      probeOnReuse?: boolean;
      forceRestartOnProbeFailure?: boolean;
    };
    const timeoutMs = fastCfg.connectTimeoutMs ?? 1500;
    const probe = fastCfg.probeOnReuse !== false;

    const candidates = await this._fastPortCandidates(style);
    for (const hostPort of candidates) {
      try {
        await this._connectAndProbe(hostPort, { probe, timeoutMs });
        return await this._onFastConnectSuccess(hostPort, deviceEndpoint, style);
      } catch (err) {
        await this._onFastConnectMiss(err, hostPort);
      }
    }

    // All candidates failed: clean up stale fports, clear cache, optionally restart
    await this._cleanupStaleFports(candidates, cached, deviceEndpoint);
    await this._clearFastState();
    if (fastCfg.forceRestartOnProbeFailure !== false) {
      await this._killEndpointProcesses();
    }
    return false;
  }

  async _onFastConnectSuccess(hostPort: number, deviceEndpoint: string, style: 'unix' | 'tcp'): Promise<boolean> {
    this.ctx.hostPort = hostPort;
    this.ctx.deviceEndpoint = deviceEndpoint;
    this.ctx.style = style;
    this.ctx.owned = false;
    this.state = RpcState.READY;
    await this._persistFastState({ hostPort, deviceEndpoint, style });
    if (this.dfx) {
      this.dfx.counter('rpc.fast.hit', 1, { hostPort });
    }
    if (this.logger) {
      this.logger.info(`fast mode hit: reused tcp:${hostPort}`);
    }
    return true;
  }

  async _onFastConnectMiss(err: unknown, hostPort: number): Promise<void> {
    if (this.dfx) {
      this.dfx.counter('rpc.fast.miss', 1, { reason: (err as Error & { code?: string })?.code || (err as Error).name, hostPort });
    }
    if (this.logger) {
      this.logger.info(`fast mode miss on tcp:${hostPort} (${(err as Error).message}), try next/fallback`);
    }
    await this._safeCloseTransport('fast miss');
  }

  /**
   * Remove stale fport forwarding for cached ports.
   * Uses ONLY the cached deviceEndpoint — never look up from fportListAll(),
   * because the port might be used by another application with a different endpoint.
   */
  async _cleanupStaleFports(candidates: number[], cached: FastStateRecord | null, deviceEndpoint: string): Promise<void> {
    const portsToClean = new Set<number>(candidates);
    if (cached && Number.isInteger(cached.hostPort)) {
      portsToClean.add(cached.hostPort);
    }
    for (const hostPort of portsToClean) {
      await this._removeStaleFport(hostPort, cached, deviceEndpoint);
    }
  }

  async _removeStaleFport(hostPort: number, cached: FastStateRecord | null, deviceEndpoint: string): Promise<void> {
    try {
      const ep = cached?.deviceEndpoint || deviceEndpoint;
      const removed = await this.device.fportRemove(hostPort, ep);
      this._logFportRemoval(hostPort, ep, removed);
    } catch (err) {
      if (this.logger) {
        this.logger.debug(`fast mode fallback: remove stale fport tcp:${hostPort} failed: ${(err as Error).message}`);
      }
    }
  }

  _logFportRemoval(hostPort: number, ep: string, removed: boolean): void {
    if (!this.logger) {
      return;
    }
    if (removed) {
      this.logger.info(`fast mode fallback: removed stale fport tcp:${hostPort} -> ${ep}`);
    } else {
      this.logger.debug(`fast mode fallback: fport rm tcp:${hostPort} -> ${ep} returned false (may not exist or different endpoint)`);
    }
  }

  /**
   * Fast mode candidate host ports (deduplicated, order-preserving): cached port first, then configured fixed port
   */
  async _fastPortCandidates(style: 'unix' | 'tcp'): Promise<number[]> {
    const ports = [];
    const cached = await this._readFastState(style);
    if (cached && Number.isInteger(cached.hostPort)) {
      ports.push(cached.hostPort);
    }
    const configured = this.endpointConfig.fastHostPort;
    if (Number.isInteger(configured)) {
      ports.push(configured);
    }
    return [...new Set(ports)] as number[];
  }

  /** Read cache directly (without validating style), used for fast mode priority check */
  async _readFastStateUnchecked(): Promise<FastStateRecord | null> {
    try {
      const store = this.device.fastStore;
      if (!store) {
        return null;
      }
      const rec = await store.get(this.device.serial, this.name);
      if (!rec) {
        return null;
      }
      return rec as FastStateRecord;
    } catch {
      return null;
    }
  }

  /** Read this endpoint's fast mode cache, and validate hdc server and endpoint style consistency */
  async _readFastState(style: 'unix' | 'tcp'): Promise<FastStateRecord | null> {
    try {
      const store = this.device.fastStore;
      if (!store) {
        return null;
      }
      const rec = await store.get(this.device.serial, this.name);
      if (!rec) {
        return null;
      }
      const r = rec as FastStateRecord;
      if (r.style && r.style !== style) {
        return null;
      }
      return r;
    } catch {
      return null;
    }
  }

  /** Persist fast connection info to user directory (by SN) */
  async _persistFastState({ hostPort, deviceEndpoint, style }: { hostPort: number; deviceEndpoint: string; style: 'unix' | 'tcp' }): Promise<void> {
    try {
      const store = this.device.fastStore;
      if (!store) {
        return;
      }
      const info = this.device._uitestInfo || null;
      // fast-hit direct reuse does not go through resource push, ctx.agentVersion may be empty;
      // in this case, inherit the agentVersion recorded in the old cache, to avoid overwriting valid info with null.
      let agentVersion = this.ctx.agentVersion || null;
      if (!agentVersion) {
        const prev = await store.get(this.device.serial, this.name).catch(() => null);
        if (prev && prev.agentVersion) {
          agentVersion = prev.agentVersion;
        }
      }
      await store.save(this.device.serial, {
        endpoint: this.name,
        hostPort,
        deviceEndpoint,
        style,
        agentVersion,
        uitestVersion: info ? info.version : null,
        hdcServer: this.device.hdcServer,
      });
    } catch (err) {
      if (this.logger) {
        this.logger.debug(`persist fast state failed: ${(err as Error).message}`);
      }
    }
  }

  /** Delete this endpoint's invalid cache */
  async _clearFastState(): Promise<void> {
    try {
      const store = this.device.fastStore;
      if (store) {
        await store.forgetEndpoint(this.device.serial, this.name);
      }
    } catch {
      /* noop */
    }
  }

  /* ---------------------- Stage implementations ---------------------- */

  /** Push resources on demand */
  async _ensureResources(): Promise<void> {
    // 1) Managed resources (agent.so / scrcpy server, selected by arch + uitest version)
    await this._ensureManagedResources();

    // 2) Additional resources explicitly declared by the caller in rpc.<endpoint>.resources
    const resources = this.resources;
    for (const resource of resources) {
      const exists = await this.device.fileExists(resource.remotePath);
      if (!exists) {
        await this._pushResource(resource, 'missing');
        continue;
      }
      if (!resource.version || !resource.versionProbe) {
        continue;
      }

      const remoteVersion = await this._probeRemoteVersion(resource);
      if (!remoteVersion || compareVersions(resource.version, remoteVersion) > 0) {
        // Version outdated: stop self first (only stop self, do not affect the other RPC), then delete and re-push
        await this._killEndpointProcesses();
        await this.device.rm(resource.remotePath);
        await this._pushResource(resource, 'version');
      }
    }
    this.ctx.resourcesPushed = true;
  }

  /**
   * Managed resources hook: default no-op.
   * Operate RPC overrides to ensureAgent(); record RPC overrides to scrcpy candidate selection (push and start linked).
   */
  async _ensureManagedResources(): Promise<void> {
    /* no-op by default */
  }

  async _pushResource(resource: DeclaredResource, reason: string): Promise<void> {
    const end = this.dfx ? this.dfx.timer('rpc.lifecycle.push', { reason }) : null;
    await this.device.fileSend(resource.localPath, resource.remotePath);
    if (end) {
      end({ ok: 1 });
    }
    if (this.dfx) {
      this.dfx.counter('rpc.lifecycle.push', 1, { reason });
    }
    if (this.logger) {
      this.logger.info(`push resource ${resource.name || resource.remotePath} (${reason})`);
    }
  }

  /**
   * Extract device-side resource version: cat <remote> | grep -a <probe>
   * e.g. `UITEST_AGENT_LIBRARY#1.2.3`
   */
  async _probeRemoteVersion(resource: DeclaredResource): Promise<string | null> {
    try {
      const out = await this.device.shell(
        `cat ${shellQuote(resource.remotePath)} | ${shellJoin(['grep', '-a', resource.versionProbe as string])}`,
      );
      if (!out) {
        return null;
      }
      const parts = out.split('#');
      const tail = parts.length > 1 ? parts[parts.length - 1] : out;
      return extractVersion(tail);
    } catch {
      return null;
    }
  }

  /** Detect whether endpoint processes are available (process exists + optional listening check) */
  async _detectProcesses(style: 'unix' | 'tcp'): Promise<Array<{ pid: number; cmd: string; user?: string }>> {
    const list = await this.device.findProcesses();
    const matched = list.filter((p) => this.endpoint.matchProcess(p));
    if (!matched.length) {
      return [];
    }
    if (this.endpointConfig.checkListening) {
      const listening = await this.endpoint.isListening(this.device, style);
      if (!listening) {
        return [];
      }
    }
    return matched;
  }

  /** Ensure device-side process exists and is available */
  async _ensureProcess(style: 'unix' | 'tcp'): Promise<void> {
    const running = await this._detectProcesses(style);
    if (running.length) {
      this.ctx.pids = running.map((p) => p.pid);
      this.ctx.owned = false;
      return;
    }

    await this._killStaleProcesses();

    // Start and wait for ready (hook; record RPC overrides to try candidates one by one)
    let found;
    try {
      found = await this._launchAndWaitReady(style);
    } catch (err) {
      // Start failed: possibly device-side so is corrupted (version probe still exists but code segment is broken).
      // Give subclass a chance to "force re-push managed resources", then clean up stale processes and retry once.
      const error = err as Error;
      if (this.logger) {
        this.logger.warn(`${this.name} launch failed, try re-push managed resources: ${error.message}`);
      }
      try {
        await this._onLaunchFailure();
      } catch (hookErr) {
        if (this.logger) {
          this.logger.warn(`${this.name} onLaunchFailure hook error: ${(hookErr as Error).message}`);
        }
      }
      await this._killStaleProcesses();
      found = await this._launchAndWaitReady(style);
    }
    this.ctx.pids = found.map((p) => p.pid);
    this.ctx.owned = true;
    this.ctx.startedAt = Date.now();
  }

  /** Kill zombie processes of this endpoint (present but not listening) */
  async _killStaleProcesses(): Promise<void> {
    const stale = (await this.device.findProcesses()).filter((p) => this.endpoint.matchProcess(p));
    for (const p of stale) {
      await this.device.killProcess(p.pid);
    }
  }

  /**
   * Hook on process start failure (default no-op).
   *
   * Operate RPC overrides: unconditionally delete and re-push device-side agent.so (suspected corruption),
   * then BaseRpc._ensureProcess retries the start. Record RPC has its own multi-candidate fallback, does not override.
   */
  async _onLaunchFailure(): Promise<void> {
    /* no-op by default */
  }


  /**
   * Send start command and wait for endpoint process to be ready (overridable).
   * Default behavior: buildStartCommand sent once, poll _detectProcesses.
   */
  async _launchAndWaitReady(style: 'unix' | 'tcp'): Promise<Array<{ pid: number; cmd: string }>> {
    const startCmd = this.endpoint.buildStartCommand({ style });
    if (this.logger) {
      this.logger.info(`start device process: ${startCmd}`);
    }
    await this.device.shell(startCmd);
    this.ctx.startCount += 1;
    if (this.dfx) {
      this.dfx.counter('rpc.lifecycle.start', 1);
    }

    const cfg = this.endpointConfig as {
      processWaitTimeoutMs?: number;
      processCheckIntervalMs?: number;
      startWaitMs?: number;
    };
    try {
      return await waitUntil(
        async () => {
          const matched = await this._detectProcesses(style);
          return matched.length ? matched : null;
        },
        {
          timeoutMs: cfg.processWaitTimeoutMs ?? 15000,
          intervalMs: cfg.processCheckIntervalMs ?? 200,
          firstDelayMs: cfg.startWaitMs ?? 500,
          description: `${this.name} process ready`,
        },
      );
    } catch (err) {
      throw new RpcLifecycleError(`${this.name} process did not become ready: ${(err as Error).message}`, {
        cause: err as Error,
        details: { endpoint: this.name, startCmd },
      });
    }
  }

  /** Establish port forwarding (idempotent: existing same mapping is considered success); throws on failure */
  async _ensureForward(hostPort: number, deviceEndpoint: string): Promise<void> {
    const ok = await this._tryForward(hostPort, deviceEndpoint);
    if (ok) {
      return;
    }
    throw new RpcLifecycleError(`create fport failed: tcp:${hostPort} -> ${deviceEndpoint}`, {
      details: { endpoint: this.name, hostPort, deviceEndpoint },
    });
  }

  /**
   * Attempt to establish forwarding, returns true on success (or existing same mapping), false otherwise (does not throw)
   */
  async _tryForward(hostPort: number, deviceEndpoint: string): Promise<boolean> {
    const ok = await this.device.fportAdd(hostPort, deviceEndpoint);
    if (ok) {
      return true;
    }
    const list = await this.device.fportListAll();
    const same = list.find((e) => e.hostPort === hostPort && e.deviceEndpoint === deviceEndpoint);
    return !!same;
  }

  /**
   * Stable flow selects host-side forwarding port (fast mode degradation tries to reuse fixed/cached port):
   *   1. Fast mode: configured fixed port (use if available, for cross-session reuse of the same forwarding)
   *   2. Otherwise: local/remote free port probe
   */
  async _selectStableHostPort(style: 'unix' | 'tcp'): Promise<number> {
    if (this.mode === 'fast') {
      const cached = await this._readFastState(style);
      const configured = this.endpointConfig.fastHostPort as number | undefined;
      const preferred: number | null | undefined =
        (cached && Number.isInteger(cached.hostPort) && cached.hostPort) || configured;
      if (preferred != null && Number.isInteger(preferred)) {
        const inUse = this.device.fportList.some((e) => e.hostPort === preferred);
        if (!inUse) {
          return preferred;
        }
      }
    }
    return this.device.getFreeHostPort();
  }

  /** Connect and (optionally) probe */
  async _connectAndProbe(hostPort: number, { probe = true, timeoutMs }: ConnectProbeOptions = {}): Promise<void> {
    const transport = new RpcTransport({
      host: this.device.hdcHost,
      port: hostPort,
      name: this.name,
      framing: this.config.get('rpc.framing', 'auto'),
      concurrency: this.config.get('rpc.concurrency', ConcurrencyMode.AUTO),
      maxInFlight: this.config.get('rpc.maxInFlight', 16),
      strictPairing: this.config.get('rpc.strictPairing', false),
      timeoutKillsConnection: this.config.get('rpc.timeoutKillsConnection', false),
      connectTimeoutMs: timeoutMs ?? this.config.get('rpc.connectTimeoutMs', 5000),
      requestTimeoutMs: this.config.get('rpc.requestTimeoutMs', 30000),
      socketIdleTimeoutMs: this.config.get('rpc.socketIdleTimeoutMs', 30000),
      logger: this.logger,
      dfx: this.dfx,
    });
    await this._safeCloseTransport('reconnect');
    await transport.connect();
    // Connection generation change: all in-flight requests' epoch numbers are now expired
    this._bumpEpoch();
    transport.onClose = (err: Error | null) => {
      this._onTransportClose(transport, err);
    };
    this.transport = transport;
    this.state = RpcState.CONNECTED;

    if (probe) {
      await this._probe();
    }
  }

  _onTransportClose(transport: RpcTransport, err: Error | null): void {
    if (this.transport !== transport) {
      return;
    }
    this._bumpEpoch();
    if (this.state === RpcState.READY || this.state === RpcState.CONNECTED) {
      this.state = this.mode === 'fast' ? RpcState.WARM : RpcState.IDLE;
      if (this.logger) {
        this.logger.warn(`connection lost: ${err ? err.message : 'closed'}`);
      }
      if (this.dfx) {
        this.dfx.counter('rpc.connection.lost', 1, { reason: (err as Error & { code?: string })?.code || 'close' });
      }
    }
  }

  /**
   * Probe: the purpose is to confirm "this port is our RPC service and the link can send/receive".
   *
   * Judgment principle:
   *   - Can connect + received a parseable JSON response (even with business exception) → link is healthy
   *     (when the official agent doesn't recognize 'ping' as an api, it returns an exception,
   *     which exactly proves the protocol link is working)
   *   - Only transport/protocol layer failures (cannot connect, timeout, unparseable) throw an error
   * Business exceptions only appear in debug logs, do not block readiness.
   */
  async _probe() {
    const timeoutMs = this.config.get('rpc.connectTimeoutMs', 5000);
    const payload = this.buildProbePayload();
    const response = await this.transport!.send(payload, { timeoutMs });
    if (hasRemoteException(response) && this.logger) {
      const exc = (response as { exception: unknown }).exception;
      this.logger.debug(`probe got business exception (link is healthy): ${typeof exc === 'string' ? exc : JSON.stringify(exc)}`);
    }
    return unwrapResult(response);
  }

  /* ================================================================ */
  /* Request and recovery                                               */
  /* ================================================================ */

  /**
   * Send a request (with concurrency-safe recovery and retry)
   *
   * ── Concurrent fault reset merge ────────────────────────────────────────────
   * When the device-side process crashes, 10 concurrent requests will **simultaneously** get transport errors.
   * If each one resets independently, it would kill the process 10 times, push resources 10 times, restart 10 times.
   * Here we use "epoch number + SingleFlight" to merge:
   *   - Epoch unchanged → I am the first to discover the fault, execute reset (other concurrent callers hang on the same SingleFlight)
   *   - Epoch changed → someone else already reset, just retry, no duplicate reset
   *
   */
  async request(payload: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    const { timeoutMs } = options;
    const recovery = this.config.get('rpc.recovery', {}) as {
      enabled?: boolean;
      maxAttempts?: number;
      delayMs?: number;
    };
    const enabled = recovery.enabled !== false;
    const maxAttempts = Math.max(0, recovery.maxAttempts ?? 1);

    let lastErr = null;
    let ownRecoveries = 0;
    let borrowedRecoveries = 0;

    for (let loop = 0; loop <= maxAttempts + 1; loop++) {
      if (this._disposed) {
        throw new RpcDisposedError(`${this.name} rpc is disposed, request rejected`, {
          details: { endpoint: this.name },
        });
      }

      let epoch = this._epoch;
      try {
        await this.ensureReady();
        // Re-read after ready: first initialization itself also changes generation, should not be counted as "fault"
        epoch = this._epoch;
        const result = await this._sendOnce(payload, { timeoutMs });
        this._logRecovered(ownRecoveries + borrowedRecoveries);
        return result;
      } catch (err) {
        lastErr = err;
        const updated = await this._handleRequestError(
          err, enabled, maxAttempts, epoch, ownRecoveries, borrowedRecoveries, recovery.delayMs,
        );
        ownRecoveries = updated.ownRecoveries;
        borrowedRecoveries = updated.borrowedRecoveries;
      }
    }
    throw lastErr || new RpcLifecycleError(`${this.name} rpc request failed`);
  }

  _logRecovered(totalRecoveries: number): void {
    if (totalRecoveries > 0 && this.dfx) {
      this.dfx.counter('rpc.request.recovered', 1, { endpoint: this.name });
    }
  }

  async _handleRequestError(
    err: unknown,
    enabled: boolean,
    maxAttempts: number,
    epoch: number,
    ownRecoveries: number,
    borrowedRecoveries: number,
    delayMs?: number,
  ): Promise<{ ownRecoveries: number; borrowedRecoveries: number }> {
    if (this._disposed) {
      throw err;
    }
    if (!enabled || !isRecoverableRpcError(err)) {
      throw err;
    }
    if (this._epoch === epoch) {
      ownRecoveries = await this._attemptOwnRecovery(err as Error, maxAttempts, ownRecoveries);
    } else {
      borrowedRecoveries = this._attemptBorrowedRecovery(err as Error, maxAttempts, borrowedRecoveries);
    }
    if (delayMs) {
      await sleep(delayMs);
    }
    return { ownRecoveries, borrowedRecoveries };
  }

  async _attemptOwnRecovery(err: Error, maxAttempts: number, ownRecoveries: number): Promise<number> {
    if (ownRecoveries >= maxAttempts) {
      throw err;
    }
    const attempt = ownRecoveries + 1;
    if (this.dfx) {
      this.dfx.counter('rpc.request.retry', 1, { code: (err as Error & { code?: string }).code, attempt });
    }
    if (this.logger) {
      this.logger.warn(
        `recover from ${(err as Error & { code?: string }).code || err.name}: ${err.message} (retry ${attempt}/${maxAttempts})`,
      );
    }
    // SingleFlight: other concurrent failed requests will share this one reset
    await this.reset({ reason: err.message, code: (err as Error & { code?: string }).code });
    return attempt;
  }

  _attemptBorrowedRecovery(err: Error, maxAttempts: number, borrowedRecoveries: number): number {
    const count = borrowedRecoveries + 1;
    if (count > maxAttempts) {
      throw err;
    }
    if (this.dfx) {
      this.dfx.counter('rpc.request.retry.borrowed', 1, { code: (err as Error & { code?: string }).code });
    }
    if (this.logger) {
      this.logger.debug(`retry after another caller reset (${(err as Error & { code?: string }).code || err.name})`);
    }
    return count;
  }

  /** Single send (no recovery) */
  async _sendOnce(payload: Record<string, unknown>, { timeoutMs }: RequestOptions = {}): Promise<unknown> {
    if (!this.transport || !this.transport.isConnected) {
      throw new RpcTransportError('rpc transport is not connected', { details: { endpoint: this.name } });
    }
    const response = await this.transport.send(payload, {
      timeoutMs: timeoutMs ?? this.config.get('rpc.requestTimeoutMs', 30000),
    });
    return this.interpret(response);
  }

  /**
   * Interpret response: business exception → RpcRemoteError (no reset)
   */
  interpret(response: unknown): unknown {
    if (hasRemoteException(response)) {
      const exc = (response as { exception: unknown }).exception;
      let excStr: string;
      if (exc instanceof Error) {
        excStr = exc.message;
      } else if (typeof exc === 'string') {
        excStr = exc;
      } else if (exc && typeof exc === 'object') {
        try {
          excStr = JSON.stringify(exc);
        } catch {
          excStr = String(exc);
        }
      } else {
        excStr = String(exc);
      }
      const err = new RpcRemoteError(`remote exception: ${excStr}`, {
        details: { endpoint: this.name, remote: exc },
      });
      if (this.dfx) {
        this.dfx.counter('rpc.request.remoteError', 1, { endpoint: this.name });
      }
      throw err;
    }
    return unwrapResult(response);
  }

  /**
   * Reset: stop own process + remove forwarding + close connection, back to IDLE
   *
   * Concurrency-safe (SingleFlight): only one reset is allowed to run at a time,
   * other concurrent calls share the result of this one reset, instead of each killing their own.
   *
   */
  reset({ reason = 'manual', code = 'MANUAL' }: ResetOptions = {}): Promise<void> {
    return this._resetFlight.run('reset', () => this._resetOnce({ reason, code }));
  }

  async _resetOnce({ reason = 'manual', code = 'MANUAL' }: ResetOptions = {}): Promise<void> {
    if (this._disposed) {
      return;
    }
    // If initialization is in progress, wait for it to finish before resetting, to avoid "just launched then killed / killed then launched again"
    const readying = this._readyFlight.pending('ready');
    if (readying) {
      await readying.catch(() => {});
    }
    if (this._disposed) {
      return;
    }

    this._bumpEpoch();
    if (this.dfx) {
      this.dfx.counter('rpc.lifecycle.reset', 1, { reason: code });
    }
    if (this.logger) {
      this.logger.warn(`reset: ${reason}`);
    }
    try {
      await this._killEndpointProcesses();
    } catch (err) {
      if (this.logger) {
        this.logger.warn(`kill process failed during reset: ${(err as Error).message}`);
      }
    }
    await this._safeCloseTransport('reset');
    try {
      if (this.ctx.hostPort && this.ctx.deviceEndpoint) {
        await this.device.fportRemove(this.ctx.hostPort, this.ctx.deviceEndpoint);
      }
    } catch (err) {
      if (this.logger) {
        this.logger.warn(`remove fport failed during reset: ${(err as Error).message}`);
      }
    }
    const resetCount = this.ctx.resetCount + 1;
    const startCount = this.ctx.startCount;
    this.ctx = this._freshContext();
    this.ctx.resetCount = resetCount;
    this.ctx.startCount = startCount;
    this.state = RpcState.IDLE;
  }

  /**
   * Release:
   *   - fast mode (keepOnRelease=true): only close connection, keep process and port forwarding → WARM
   *   - stable mode: close connection + remove forwarding + stop process → IDLE
   */
  async release(): Promise<void> {
    await this._safeCloseTransport('release');
    if (this.mode === 'fast' && this.config.get('rpc.fast.keepOnRelease', true)) {
      this.state = RpcState.WARM;
      if (this.dfx) {
        this.dfx.counter('rpc.release', 1, { keep: 1 });
      }
      if (this.logger) {
        this.logger.info(`released (keep process & fport on tcp:${this.ctx.hostPort})`);
      }
      return;
    }
    await this._removeForward();
    await this._killEndpointProcesses();
    if (this.dfx) {
      this.dfx.counter('rpc.release', 1, { keep: 0 });
    }
    if (this.logger) {
      this.logger.info('released (process & fport cleaned)');
    }
    this.ctx = this._freshContext();
    this.state = RpcState.IDLE;
  }

  /**
   * Full dispose: close connection + clean up forwarding + kill this endpoint's process
   *
   * Terminal state: after setting _disposed, all in-flight/subsequent requests fail immediately,
   * and will never re-launch the just-destroyed process due to "recoverable error retry".
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    this._bumpEpoch();
    // Wait for in-progress initialization/reset to finish, to avoid dispose and them concurrently operating on the process
    const readying = this._readyFlight.pending('ready');
    if (readying) {
      await readying.catch(() => {});
    }
    const resetting = this._resetFlight.pending('reset');
    if (resetting) {
      await resetting.catch(() => {});
    }

    await this._safeCloseTransport('dispose');
    await this._removeForward();
    await this._killEndpointProcesses();
    this.ctx = this._freshContext();
    this.state = RpcState.DISPOSED;
  }

  /* ---------------------- Internal utilities ---------------------- */

  /**
   * Clean up port forwarding
   *
   * In addition to ctx.hostPort, fast mode also cleans up the configured fixed port:
   * the fixed port may have been established by a **previous session** (this instance's ctx is empty),
   * not cleaning up will leave it lingering.
   */
  async _removeForward(): Promise<void> {
    const ports = new Set<number>();
    if (this.ctx.hostPort) {
      ports.add(this.ctx.hostPort);
    }
    if (this.mode === 'fast' && this.endpointConfig.fastHostPort) {
      ports.add(this.endpointConfig.fastHostPort as number);
    }
    const deviceEndpoint = this.ctx.deviceEndpoint || undefined;
    for (const port of ports) {
      try {
        const removed = await this.device.fportRemove(port, deviceEndpoint);
        if (this.logger && !removed) {
          this.logger.warn(`remove fport tcp:${port} -> ${deviceEndpoint} returned false`);
        }
      } catch (err) {
        if (this.logger) {
          this.logger.debug(`remove fport tcp:${port} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Only kill processes claimed by this endpoint (by pid, never use killall by name) */
  async _killEndpointProcesses(): Promise<number> {
    const list = await this.device.findProcesses();
    const matched = list.filter((p) => this.endpoint.matchProcess(p));
    for (const p of matched) {
      await this.device.killProcess(p.pid);
    }
    if (matched.length && this.logger) {
      this.logger.info(`killed ${this.name} processes: [${matched.map((p) => p.pid).join(', ')}]`);
    }
    return matched.length;
  }

  async _safeCloseTransport(reason: string): Promise<void> {
    if (!this.transport) {
      return;
    }
    try {
      await this.transport.close(reason);
    } catch {
      /* noop */
    }
    this.transport = null;
  }

  /**
   * Probe payload (subclasses can override)
   */
  buildProbePayload(): Record<string, unknown> {
    return { module: 'debug', method: 'ping', params: {}, request_id: undefined };
  }

  getSnapshot(): Record<string, unknown> {
    return {
      name: this.name,
      mode: this.mode,
      state: this.state,
      epoch: this._epoch,
      disposed: this._disposed,
      ctx: { ...this.ctx },
      transport: this.transport ? this.transport.getSnapshot() : null,
    };
  }
}

export { RpcTimeoutError, RpcTransportError, RpcRemoteError, RpcLifecycleError };
