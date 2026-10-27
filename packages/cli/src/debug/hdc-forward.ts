/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { ToolProvider } from '../toolchain/index.js';
import { DeviceManager } from '../service/device-manager.js';
import { debugLog } from '../utils/logger.js';
import { acquireDataLock } from '../runtime/execution-lock.js';

interface ForwardRule { serial: string; local: string; remote: string; direction: 'Forward' | 'Reverse' }
export const HdcSelectorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
export const ForwardBindingSchema = z.strictObject({
  state: z.enum(['active', 'released', 'cleanup-failed']),
  direction: z.literal('device-to-host'), targetHash: z.string().regex(/^[a-f0-9]{64}$/),
  port: z.number().int().min(1024).max(65535), authentication: z.literal('unverified'),
});
export type ForwardBinding = z.infer<typeof ForwardBindingSchema>;
export interface ForwardDependencies {
  select(selector: string, signal: AbortSignal): Promise<string>;
  run(args: string[], signal: AbortSignal): Promise<string>;
}
export interface ForwardOptions { dataDir: string; selector: string; port: number; signal: AbortSignal }
export class ForwardAcquisitionError extends Error {
  #owner: HdcReadonlyForward;
  constructor(owner: HdcReadonlyForward) {
    super('HDC_FORWARD_CLEANUP_REQUIRED'); this.#owner = owner;
  }
  get owner(): HdcReadonlyForward { return this.#owner; }
}

export function parseForwardRules(output: string): ForwardRule[] {
  if (Buffer.byteLength(output) > 64 * 1024) { throw new Error('HDC_FORWARD_TABLE_INVALID'); }
  if (!output.trim() || output.trim() === '[Empty]') { return []; }
  return output.trim().split(/\r?\n/).map((line) => {
    const match = /^(\S+) +(\S+:\S+) +(\S+:\S+) +\[(Forward|Reverse)\]$/.exec(line.trim().replace(/\t/g, ' '));
    if (!match || [match[2], match[3]].some((node) => node.startsWith('tcp:') &&
      (!/^tcp:\d{1,5}$/.test(node) || Number(node.slice(4)) < 1 || Number(node.slice(4)) > 65535))) {
      throw new Error('HDC_FORWARD_TABLE_INVALID');
    }
    return { serial: match[1], local: match[2], remote: match[3], direction: match[4] as ForwardRule['direction'] };
  });
}
async function installedDependencies(): Promise<ForwardDependencies> {
  const tools = await ToolProvider.new(), devices = DeviceManager.from(tools);
  return {
    select: async (selector, signal) => {
      if (signal.aborted) { throw new Error('CANCELLED'); }
      const entries = await devices.listDevices(signal);
      const selected = entries.find((entry) => entry.serial === selector);
      if (!selected || !['device', 'Connected', 'connected'].includes(selected.status)) { throw new Error('HDC_TARGET_UNAVAILABLE'); }
      return HdcSelectorSchema.parse(selected.serial);
    },
    run: async (args, signal) => {
      debugLog(`Executing: ${tools.hdcPath} ${args[0] === '-t' ? ['-t', '<selected-device>', ...args.slice(2)] : args}`);
      return (await execa(tools.hdcPath, args, { shell: false, timeout: 5000, cancelSignal: signal,
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })).stdout;
    },
  };
}

export class HdcReadonlyForward {
  private state: ForwardBinding;
  private closing?: Promise<void>;
  private constructor(private serial: string, private port: number, private io: ForwardDependencies,
    private unlock: () => Promise<void>) {
    this.state = { state: 'active', direction: 'device-to-host', targetHash: createHash('sha256').update(serial).digest('hex'),
      port, authentication: 'unverified' };
  }
  get binding(): ForwardBinding { return structuredClone(this.state); }
  static async acquire(options: ForwardOptions, supplied?: ForwardDependencies): Promise<HdcReadonlyForward> {
    HdcSelectorSchema.parse(options.selector);
    z.number().int().min(1024).max(65535).parse(options.port);
    if (options.signal.aborted) { throw new Error('CANCELLED'); }
    const io = supplied ?? await installedDependencies();
    let serial: string;
    try { serial = HdcSelectorSchema.parse(await io.select(options.selector, options.signal)); }
    catch { throw new Error('HDC_TARGET_UNAVAILABLE'); }
    const unlock = await acquireDataLock(options.dataDir, 'debug-hdc-forward');
    const owner = new HdcReadonlyForward(serial, options.port, io, unlock);
    let attempted = false;
    try {
      const initial = await owner.table(options.signal);
      if (owner.selected(initial).length) { throw new Error('HDC_FORWARD_CONFLICT'); }
      attempted = true;
      await owner.command(['-t', serial, 'rport', owner.endpoint(), owner.endpoint()], options.signal);
      if (!owner.matches(await owner.table(AbortSignal.timeout(5000)))) { throw new Error('HDC_FORWARD_NOT_OBSERVED'); }
      if (options.signal.aborted) { throw new Error('CANCELLED'); }
      return owner;
    } catch (error) {
      if (attempted) {
        try { await owner.close(); }
        catch { throw new ForwardAcquisitionError(owner); }
      } else { await unlock(); }
      throw error;
    }
  }
  private endpoint(): string { return `tcp:${this.port}`; }
  private selected(rules: ForwardRule[]): ForwardRule[] {
    return rules.filter((rule) => rule.serial === this.serial && rule.direction === 'Reverse' && rule.local === this.endpoint());
  }
  private matches(rules: ForwardRule[]): boolean {
    const selected = this.selected(rules);
    return selected.length === 1 && selected[0].remote === this.endpoint();
  }
  private async command(args: string[], signal: AbortSignal): Promise<string> {
    try { return await this.io.run(args, signal); }
    catch { throw new Error('HDC_FORWARD_COMMAND_FAILED'); }
  }
  private async table(signal: AbortSignal): Promise<ForwardRule[]> {
    return parseForwardRules(await this.command(['fport', 'ls'], signal));
  }
  close(): Promise<void> {
    if (this.state.state === 'released') { return Promise.resolve(); }
    if (this.closing) { return this.closing; }
    this.closing = this.remove().catch((error) => {
      this.state.state = 'cleanup-failed'; this.closing = undefined; throw error;
    });
    return this.closing;
  }
  private async remove(): Promise<void> {
    const signal = AbortSignal.timeout(10_000), rules = await this.table(signal);
    if (this.selected(rules).length) {
      if (!this.matches(rules)) { throw new Error('HDC_FORWARD_CHANGED'); }
      await this.command(['-t', this.serial, 'fport', 'rm', this.endpoint(), this.endpoint()], signal);
      if (this.selected(await this.table(signal)).length) { throw new Error('HDC_FORWARD_REMOVE_NOT_OBSERVED'); }
    }
    await this.unlock(); this.state.state = 'released';
  }
}
