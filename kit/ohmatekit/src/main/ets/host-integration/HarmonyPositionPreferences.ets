/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { FloatingPosition, FloatingPositionStore, positionScopeValid, positionValid } from './FloatingPosition';

class PositionRow {
  scope: string;
  bucket: string;
  value: FloatingPosition;
  constructor(scope: string, bucket: string, value: FloatingPosition) {
    this.scope = scope; this.bucket = bucket;
    this.value = { rightSide: value.rightSide, edgeRatio: value.edgeRatio };
  }
}

// One Runtime owns this private XML cache. No observer, data group, raw window
// name, coordinates or configuration is stored. XML does not certify multiprocess
// safety or physical durability. A failed flush keeps its exact proposed table.
export class HarmonyPositionPreferences implements FloatingPositionStore {
  private context: common.Context | undefined;
  private options: preferences.Options = { name: 'ohmate-debug-position-v1' };
  private instance: preferences.Preferences | undefined = undefined;
  private rows: PositionRow[] = [];
  private loaded: boolean = false;
  private cacheOwned: boolean = false;
  private busy: boolean = false;
  private revoked: boolean = false;
  private failed: boolean = false;
  private attempts: number = 0;
  private pending: string = '';
  private state: string = 'ready';
  constructor(context: common.Context) { this.context = context; }
  getState(): string { return this.state; }
  async read(scope: string, bucket: string): Promise<FloatingPosition | undefined> {
    if (!this.validKey(scope, bucket) || !this.enter()) { return undefined; }
    try {
      if (!await this.load() || this.revoked) { return undefined; }
      const row: PositionRow | undefined = this.rows.find((item: PositionRow): boolean =>
        item.scope === scope && item.bucket === bucket);
      return row === undefined ? undefined : { rightSide: row.value.rightSide, edgeRatio: row.value.edgeRatio };
    } catch (_) { this.failed = true; this.state = 'unavailable'; return undefined; }
    finally { this.busy = false; }
  }
  async write(scope: string, bucket: string, value: FloatingPosition): Promise<boolean> {
    if (!this.validKey(scope, bucket) || !positionValid(value) || !this.enter()) { return false; }
    try {
      if (!await this.load() || this.revoked) { return false; }
      const next: PositionRow[] = this.rows.filter((row: PositionRow): boolean =>
        row.scope !== scope || row.bucket !== bucket);
      if (!this.rows.some((row: PositionRow): boolean => row.scope === scope) &&
        this.rows.filter((row: PositionRow, index: number): boolean =>
          this.rows.findIndex((item: PositionRow): boolean => item.scope === row.scope) === index).length >= 32) {
        this.state = 'quota'; return false;
      }
      next.push(new PositionRow(scope, bucket, value));
      this.pending = this.encode(next);
      return await this.publish();
    } catch (_) { this.failed = true; this.state = this.pending === '' ? 'unavailable' : 'save-uncertain'; return false; }
    finally { this.busy = false; }
  }
  async retry(): Promise<boolean> {
    if (this.pending === '' || !this.enter(true)) { return false; }
    try { return await this.publish(); }
    catch (_) { this.failed = true; this.state = 'save-uncertain'; return false; }
    finally { this.busy = false; }
  }
  async close(): Promise<boolean> {
    this.revoked = true; this.state = 'closed';
    if (this.busy) { return false; }
    const context: common.Context | undefined = this.context;
    if (context === undefined) { return true; }
    this.busy = true;
    try {
      if (this.cacheOwned) {
        await preferences.removePreferencesFromCache(context, this.options); this.cacheOwned = false;
      }
      this.instance = undefined; this.context = undefined; this.rows = []; this.pending = ''; return true;
    } catch (_) { this.state = 'cleanup-required'; return false; }
    finally { this.busy = false; }
  }
  private enter(retry: boolean = false): boolean {
    if (this.revoked || this.context === undefined || (this.failed && !retry)) { return false; }
    if (this.busy) { this.state = 'busy'; return false; }
    if (this.attempts >= 256) { this.state = 'quota'; return false; }
    this.attempts++; this.busy = true; this.state = 'ready'; return true;
  }
  private validKey(scope: string, bucket: string): boolean {
    return positionScopeValid(scope) && typeof bucket === 'string' && /^[pls][012][012]$/.test(bucket);
  }
  private async load(): Promise<boolean> {
    if (this.loaded) { return true; }
    const context: common.Context | undefined = this.context;
    if (context === undefined || !canIUse('SystemCapability.DistributedDataManager.Preferences.Core')) {
      this.failed = true; this.state = 'unavailable'; return false;
    }
    // getPreferences may acquire its cache before throwing or returning late.
    this.cacheOwned = true;
    this.instance = await preferences.getPreferences(context, this.options);
    if (this.revoked) { return false; }
    const value: preferences.ValueType = await this.instance.get('positions-v1', '');
    if (this.revoked) { return false; }
    if (typeof value !== 'string') { this.failed = true; this.state = 'unavailable'; return false; }
    const rows: PositionRow[] | undefined = this.decode(value);
    if (rows === undefined) { this.failed = true; this.state = 'unavailable'; return false; }
    this.rows = rows; this.loaded = true; this.state = 'ready'; return true;
  }
  private async publish(): Promise<boolean> {
    const instance: preferences.Preferences | undefined = this.instance;
    if (instance === undefined || this.pending === '' || this.revoked) { return false; }
    await instance.put('positions-v1', this.pending);
    if (this.revoked) { return false; }
    await instance.flush();
    if (this.revoked) { return false; }
    const rows: PositionRow[] | undefined = this.decode(this.pending);
    if (rows === undefined) { this.failed = true; this.state = 'save-uncertain'; return false; }
    this.rows = rows; this.pending = ''; this.failed = false; this.state = 'ready'; return true;
  }
  private encode(rows: PositionRow[]): string {
    return 'ohmate-position-v1\n' + rows.map((row: PositionRow): string =>
      row.scope + '|' + row.bucket + '|' + (row.value.rightSide ? 'r' : 'l') + '|' +
      (Math.round(row.value.edgeRatio * 1000000) / 1000000).toString()).join('\n');
  }
  private decode(text: string): PositionRow[] | undefined {
    if (text === '') { return []; }
    if (text.length >= 65536 || !text.startsWith('ohmate-position-v1\n')) { return undefined; }
    const lines: string[] = text.substring(19).split('\n');
    if (lines.length > 864) { return undefined; }
    const result: PositionRow[] = [];
    const scopes: string[] = [];
    for (const line of lines) {
      if (!/^[a-z][a-z0-9-]{0,31}\|[pls][012][012]\|[rl]\|(0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(line)) {
        return undefined;
      }
      const parts: string[] = line.split('|');
      if (result.some((row: PositionRow): boolean => row.scope === parts[0] && row.bucket === parts[1])) {
        return undefined;
      }
      if (!scopes.includes(parts[0])) { scopes.push(parts[0]); }
      if (scopes.length > 32) { return undefined; }
      result.push(new PositionRow(parts[0], parts[1], { rightSide: parts[2] === 'r', edgeRatio: Number(parts[3]) }));
    }
    return result;
  }
}
