/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AGENT_VERSION_PROBE,
  parseAgentVersionProbe,
  selectAgent,
} from './resource-catalog.js';
import type { AgentCandidate } from './resource-catalog.js';
import { compareVersions } from '../../common/utils/version.js';
import { shellJoin, shellQuote } from '../../common/utils/shell-escape.js';
import { DeviceError } from '../../common/errors.js';
import type { HMDevice } from '../device.js';
import type { Config } from '../../common/config.js';
import type { Logger } from '../../common/logger.js';
import type { Dfx } from '../../common/dfx.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_RESOURCES_DIR = join(PACKAGE_ROOT, 'resources');

export interface ResourceManagerOptions {
  device: HMDevice;
  config: Config;
  logger?: Logger | null;
  dfx?: Dfx | null;
}

export interface EnsureAgentResult {
  candidate: AgentCandidate;
  updated: boolean;
  remoteVersion: string | null;
}

export class UitestResourceManager {
  device: HMDevice;
  config: Config;
  logger: Logger | null;
  dfx: Dfx | null;
  _agentState: EnsureAgentResult | null;

  constructor({ device, config, logger, dfx }: ResourceManagerOptions) {
    this.device = device;
    this.config = config;
    this.logger = logger ? logger.child('ResourceMgr') : null;
    this.dfx = dfx ?? null;
    this._agentState = null;
  }

  /** Resource directory: config first, otherwise bundled resources/ */
  get resourcesDir(): string {
    return this.config.get('device.resourcesDir') || DEFAULT_RESOURCES_DIR;
  }

  /** uitest runtime environment (passes through device cache) */
  async getInfo(force: boolean = false): Promise<import('./uitest-probe.js').UitestInfo> {
    return this.device.getUitestInfo(force);
  }

  /* ---------------------- Operation RPC agent ---------------------- */

  /**
   * Ensure device-side /data/local/tmp/agent.so exists and is the latest matching architecture/version
   * @param options.force Force re-comparison
   */
  async ensureAgent(options: { force?: boolean } = {}): Promise<EnsureAgentResult> {
    if (this._agentState && !options.force) {
      return this._agentState;
    }

    const info = await this.getInfo();
    const candidate = selectAgent({
      dir: this.resourcesDir,
      arch: info.arch,
      isNewUiTest: info.isNewUiTest,
    });
    if (!candidate) {
      throw new DeviceError(
        `no uitest agent found for arch=${info.arch} isNewUiTest=${info.isNewUiTest} in ${this.resourcesDir}`,
        { details: { resourcesDir: this.resourcesDir } },
      );
    }

    const exists = await this.device.fileExists(candidate.remotePath);
    let remoteVersion: string | null = null;
    let needPush = !exists;

    if (exists) {
      remoteVersion = await this._probeAgentVersion(candidate.remotePath);
      if (!remoteVersion || compareVersions(candidate.version, remoteVersion) > 0) {
        needPush = true;
      }
    }

    if (needPush) {
      if (this.logger) {
        this.logger.info(
          `update agent.so: local=v${candidate.version} remote=${remoteVersion || 'none'} ` +
            `(arch=${candidate.x86_64 ? 'x86_64' : 'arm64'})`,
        );
      }
      // Precisely stop running uitest daemon before push (agent is held by process, overwrite would fail)
      await this.stopUitestDaemons();
      await this.device.rm(candidate.remotePath);
      await this._push(candidate.localPath, candidate.remotePath, 'agent.so');
      if (this.dfx) {
        this.dfx.counter('resource.agent.update', 1, { arch: info.arch });
      }
    } else if (this.logger) {
      this.logger.debug(`agent.so up-to-date: v${remoteVersion}`);
    }

    this._agentState = { candidate, updated: needPush, remoteVersion };
    return this._agentState;
  }

  /**
   * Unconditionally delete and re-push agent.so (do not trust version probe).
   *
   * Use case: when agent process fails to start, device-side agent.so may be corrupted
   * (version string intact but code broken) - version comparison cannot detect this,
   * need forced delete + re-push.
   */
  async repushAgent(): Promise<void> {
    let candidate = this._agentState?.candidate;
    if (!candidate) {
      const state = await this.ensureAgent();
      candidate = state.candidate;
    }
    if (this.logger) {
      this.logger.info(`repush agent.so unconditionally (suspect corruption): ${candidate.fileName}`);
    }
    await this.stopUitestDaemons();
    await this.device.rm(candidate.remotePath);
    await this._push(candidate.localPath, candidate.remotePath, 'agent.so');
    if (this.dfx) {
      this.dfx.counter('resource.agent.repush', 1, { file: candidate.fileName });
    }
    this._agentState = { candidate, updated: true, remoteVersion: candidate.version };
  }

  /** Read device-side agent.so embedded version: cat <so> | grep -a UITEST_AGENT_LIBRARY */
  async _probeAgentVersion(remotePath: string): Promise<string | null> {
    try {
      const out = await this.device.shell(
        `cat ${shellQuote(remotePath)} | ${shellJoin(['grep', '-a', AGENT_VERSION_PROBE])}`,
      );
      return parseAgentVersionProbe(out);
    } catch {
      return null;
    }
  }

  /* ---------------------- Internal utilities ---------------------- */

  async _push(localPath: string, remotePath: string, label: string): Promise<void> {
    const end = this.dfx ? this.dfx.timer('resource.push', { file: label }) : null;
    await this.device.fileSend(localPath, remotePath);
    if (end) {
      end({ ok: 1 });
    }
  }

  /**
   * Precisely stop all uitest daemons (operation + recording), kill by pid individually.
   */
  async stopUitestDaemons(): Promise<number> {
    const procs = await this.device.findProcesses();
    const daemonPids = procs
      .filter((p) => p.cmd.includes('uitest') && p.cmd.includes('start-daemon'))
      .map((p) => p.pid);
    for (const pid of daemonPids) {
      try {
        await this.device.killProcess(pid);
      } catch (err) {
        if (this.logger) {
          this.logger.debug(`kill daemon pid=${pid} failed: ${(err as Error).message}`);
        }
      }
    }
    if (daemonPids.length && this.logger) {
      this.logger.info(`stopped uitest daemons before agent update: [${daemonPids.join(', ')}]`);
    }
    return daemonPids.length;
  }
}