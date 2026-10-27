/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { HMDevice } from '../device/device.js';
import { shellJoin } from '../common/utils/shell-escape.js';

export interface RpcEndpoint {
  name: string;
  displayName?: string;
  socketName: string;
  devicePort: number;
  buildStartCommand: (ctx: { style: 'unix' | 'tcp' }) => string;
  buildStopCommands: (pids: number[]) => string[];
  matchProcess: (p: { pid: number; cmd: string }) => boolean;
  buildDeviceEndpoint: (style: 'unix' | 'tcp') => string;
  isListening: (device: HMDevice, style: 'unix' | 'tcp') => Promise<boolean>;
}

export const OPERATE_ENDPOINT: RpcEndpoint = {
  name: 'operate',
  displayName: 'uitest',
  socketName: 'uitest_socket',
  devicePort: 8012,

  buildDeviceEndpoint(style: 'unix' | 'tcp') {
    return style === 'unix' ? `localabstract:${this.socketName}` : `tcp:${this.devicePort}`;
  },

  buildStartCommand() {
    return '/system/bin/uitest start-daemon singleness &';
  },

  buildStopCommands(pids: number[]) {
    return pids.map((pid) => shellJoin(['kill', '-9', pid]));
  },

  matchProcess(p: { pid: number; cmd: string }) {
    return (
      p.cmd.includes('uitest start-daemon singleness') && !p.cmd.includes('--extension-name')
    );
  },

  async isListening(device: HMDevice, style: 'unix' | 'tcp') {
    if (style === 'unix') {
      const out = await device.shell(`cat /proc/net/unix | ${shellJoin(['grep', this.socketName])}`);
      return out.includes(this.socketName);
    }
    const out = await device.shell(`netstat -anp | ${shellJoin(['grep', String(this.devicePort)])}`);
    return out.includes('LISTEN');
  },
};
