/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// All internal hm-driver logs (TRACE~ERROR) go through deveco-cli's debugLog,
// controlled by the DEVECO_CLI_DEBUG environment variable, not directly printed to console.

import { configureRootLogger, type Transport } from './common/logger.js';
import { debugLog } from '../../utils/logger.js';

const bridgeTransport: Transport = {
  write: (_record, formatted) => debugLog(formatted),
};

configureRootLogger({
  name: 'uitest',
  level: 'trace', // Pass through all levels; output is gated by debugLog's DEVECO_CLI_DEBUG
  transports: [bridgeTransport],
});

import { RealHdcExecutor } from './transport/hdc-executor.js';
import { createConfig } from './common/config.js';
import { getLogger, createDfx } from './common/index.js';
import { HMDevice } from './device/device.js';
import type { UiTestDriver } from './uitest/driver.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolve the uitest agent.so resource directory.
 *
 * Dev mode (tsx): import.meta.url points to src/device/uitest/index.ts
 *   → ../../resources/uitest = src/resources/uitest/
 *
 * Dist mode (tsup bundled): import.meta.url points to dist/cli.js
 *   → ../src/resources/uitest = src/resources/uitest/
 */
function resolveResourcesDir(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dir, '../../resources/uitest'),
    join(dir, '../src/resources/uitest'),
  ];
  return candidates.find((p) => {
    return existsSync(join(p, 'uitest_agent_v1.1.9.so'));
  }) || candidates[1];
}

/**
 * Handle to UiTestDriver and associated resources.
 *
 * driver is the UiTestDriver facade for UI automation operations.
 * dispose is used to fully release underlying RPC connections, port forwarding, and daemon processes,
 * preventing TCP sockets from staying open and blocking process exit.
 */
export interface UiDriverHandle {
  readonly driver: UiTestDriver;
  dispose(): Promise<void>;
}

/**
 * Create a UiTestDriver instance (convenience factory)
 *
 * Only needs the hdc path and device serial number; internally auto-completes:
 *   1. Create RealHdcExecutor (spawn hdc process)
 *   2. Create config (default fast mode, reuse port for quick connection)
 *   3. Create HMDevice (including resource push, fport, RPC lifecycle)
 *   4. Return { driver, dispose } handle
 *
 * Internal logs go through the bridging transport to deveco-cli's debugLog,
 * controlled by the DEVECO_CLI_DEBUG environment variable.
 *
 * Call dispose() after use to release underlying connections and processes.
 *
 * @param hdcPath Path to the hdc executable
 * @param serial Device serial number
 * @returns UiDriverHandle (including driver and dispose)
 */
export async function createUiDriver(hdcPath: string, serial: string): Promise<UiDriverHandle> {
  const logger = getLogger('HMDevice');
  const dfx = createDfx({ logger, tags: { mode: 'fast' } });
  const executor = new RealHdcExecutor({ bin: hdcPath, logger, dfx });
  const config = createConfig({ device: { resourcesDir: resolveResourcesDir() } });
  const device = new HMDevice({
    serial,
    executor,
    config,
    logger,
    dfx,
    rpcMode: config.get('rpc.mode', 'fast'),
  });
  // Pre-probe uitest environment (architecture/version/endpoint form)
  await device.getUitestInfo();
  return {
    driver: device.uitest,
    async dispose() {
      // 1. Clean up Driver remote references (may trigger fast reconnect to send clearRefs)
      await device.uitest.release();
      // 2. In fast mode, release only closes the TCP socket, keeping fport and daemon for next reuse
      await device.release();
    },
  };
}

export { UiTestDriver } from './uitest/driver.js';
export type { ShellProvider } from './uitest/driver.js';
export { Selector, normalizeSelectorJson } from './uitest/selector.js';
export { Component } from './uitest/component.js';
export { Window } from './uitest/window.js';
export { RemoteRefSession, clearRefs } from './uitest/remote-ref.js';
export { expandGesture } from './uitest/gesture-dsl.js';
export { buildRemotePointerMatrix } from './uitest/pointer-matrix.js';
export type { UiTestHost } from './uitest/host.js';
export type { RpcLike } from './uitest/remote-ref.js';
export * from './uitest/types.js';

export { UiTestRpc } from './rpc/operate-rpc.js';
export { BaseRpc, RpcState } from './rpc/base-rpc.js';
export { RpcTransport, ConcurrencyMode } from './rpc/rpc-transport.js';
export { OPERATE_ENDPOINT } from './rpc/rpc-endpoint.js';
export { createEnvelope, hasRemoteException, unwrapResult, OPERATE_MODULE, OPERATE_METHOD } from './rpc/protocol.js';

export { HMDevice } from './device/device.js';
export { HMDeviceManager, createExecutor } from './device/device-manager.js';

export { RealHdcExecutor } from './transport/hdc-executor.js';
export { HdcExecutor, HdcResult, parseTargets, parseFportList, parseProcessList } from './transport/base-hdc-executor.js';

export { Config, createConfig, DEFAULT_CONFIG } from './common/config.js';
export { Logger, LogLevel, getLogger, configureRootLogger } from './common/logger.js';
export { Dfx, createDfx } from './common/dfx.js';
export {
  HmError, HdcError, HdcTimeoutError, HdcCommandError,
  DeviceError, DeviceNotFoundError, DeviceFileError,
  RpcError, RpcLifecycleError, RpcDisposedError, RpcTransportError, RpcTimeoutError, RpcProtocolError, RpcRemoteError,
  isTransportLevelError, isRecoverableRpcError,
} from './common/errors.js';
export { sleep, withTimeout, retry, waitUntil, Mutex, Semaphore, SingleFlight, Deferred } from './common/utils/async.js';
export { requestId } from './common/utils/id.js';
export { isPortOpen, getFreePort, tcpConnect, parseDeviceEndpoint } from './common/utils/net.js';
export { compareVersions, extractVersion } from './common/utils/version.js';
export { shellQuote, shellJoin } from './common/utils/shell-escape.js';
