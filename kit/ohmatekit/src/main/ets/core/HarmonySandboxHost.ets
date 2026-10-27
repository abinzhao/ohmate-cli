/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { fileIo } from '@kit.CoreFileKit';
import { systemDateTime, BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { CoreClock, CoreEnvelope, CoreHost, CoreOptions, CorePruneSummary, CoreSegment } from '../api/CoreTypes';
import { coreIdentifier } from './SchemaRegistry';
import { exactKeys } from '../recorder/SegmentRecovery';
import { copyOptions, optionsValid } from './OHMateCore';

interface SandboxEntry {
  path: string;
  kind: string;
  bytes: number;
  modifiedSeconds: number;
}
interface SandboxFile {
  name: string;
  bytes: number;
  modifiedSeconds: number;
}
interface SandboxDirectory {
  path: string;
  files: SandboxFile[];
}
interface SandboxIndex {
  schemaVersion: string;
  directories: SandboxDirectory[];
}
interface SandboxSessionManifest {
  schemaVersion: string;
  sessionId: string;
  buildVerification: string;
  lifecycleEvidence: string;
  segments: SandboxFile[];
}
interface SandboxListOptions {
  recursion: boolean;
  listNum: number;
}
export class HarmonySandboxHost implements CoreHost {
  private root: string;
  private options: CoreOptions;
  private session: string = '';
  private originMs: number = 0;
  private previousMs: number = 0;
  private lock: fileIo.File | undefined = undefined;
  private locked: boolean = false;
  private disposed: boolean = false;
  private ready: Promise<void> | undefined = undefined;
  private initialized: boolean = false;
  private queue: Promise<void> = Promise.resolve<void>(undefined);
  private inventory: SandboxEntry[] = [];
  private total: number = 0;
  private dirtyDirectories: Set<string> = new Set<string>();
  private releasing: Promise<void> | undefined = undefined;
  private released: boolean = false;
  private uncertain: Map<string, string> = new Map<string, string>();
  private pendingHashes: Map<string, string> = new Map<string, string>();
  private encoder: util.TextEncoder = new util.TextEncoder();
  constructor(filesDir: string, options: CoreOptions) {
    if (!filesDir.startsWith('/') || filesDir.includes('\0') || filesDir.split('/').includes('..')) {
      throw new Error('SANDBOX_INVALID');
    }
    if (!optionsValid(options)) { throw new Error('OPTIONS_INVALID'); }
    if (!canIUse('SystemCapability.FileManagement.File.FileIO') ||
      !canIUse('SystemCapability.MiscServices.Time') || !canIUse('SystemCapability.Security.CryptoFramework')) {
      throw new Error('CORE_SYSCAP_UNAVAILABLE');
    }
    this.root = filesDir.replace(new RegExp('/+$'), '') + '/ohmate-kit'; this.options = copyOptions(options);
    this.session = 'session-' + util.generateRandomUUID(false);
    this.originMs = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false); this.previousMs = this.originMs;
    if (!Number.isSafeInteger(this.originMs) || this.originMs < 0) { throw new Error('CLOCK_INVALID'); }
  }
  now(): CoreClock {
    // The UUID scopes ordering to this session; it is not a verified system boot identity.
    const current: number = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
    const elapsedNs: number = (current - this.originMs) * 1000000;
    if (!Number.isSafeInteger(current) || current < this.previousMs || !Number.isSafeInteger(elapsedNs)) {
      throw new Error('CLOCK_INVALID');
    }
    this.previousMs = current;
    return { clockId: 'system-startup-ms-session-scope', bootId: this.session,
      monotonicNs: elapsedNs,
      wallTimeUtc: new Date(systemDateTime.getTime(false)).toISOString() };
  }
  random(): number { return Math.random(); }
  sessionId(): string { return this.session; }
  private encode(text: string): Uint8Array { return text === '' ? new Uint8Array(0) : this.encoder.encodeInto(text); }
  byteLength(text: string): number { return this.encode(text).byteLength; }
  hash(text: string): string { return this.hashBytes(this.encode(text)); }
  hashBytes(bytes: Uint8Array): string {
    // 文档依据：Crypto Architecture Kit（加解密算法框架服务）.md，SHA256 同步摘要示例；
    // API26 cryptoFramework.Md.updateSync/digestSync。输入由 Core 和文件预算限制。
    const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
    const input: cryptoFramework.DataBlob = { data: bytes };
    md.updateSync(input);
    let output: string = '';
    for (const value of md.digestSync().data) { output += value.toString(16).padStart(2, '0'); }
    return output;
  }
  private check(): void { if (this.disposed) { throw new Error('HOST_DISPOSED'); } }
  private async directory(path: string): Promise<void> {
    this.check();
    let stat: fileIo.Stat | undefined = undefined;
    try { stat = await fileIo.lstat(path); }
    catch (error) { if ((error as BusinessError).code !== 13900002) { throw new Error('SANDBOX_UNAVAILABLE'); } }
    this.check();
    if (stat === undefined) { await fileIo.mkdir(path); stat = await fileIo.lstat(path); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('SANDBOX_INVALID'); }
  }
  private async initialize(): Promise<void> {
    await this.directory(this.root);
    const names: string[] = await this.names(this.root, 6);
    if (names.some((name: string): boolean => !['owner.lock', 'index.json', 'sessions', 'problems', 'temp'].includes(name))) {
      throw new Error('SANDBOX_INVENTORY_INVALID');
    }
    this.check();
    const lock: fileIo.File = await fileIo.open(this.root + '/owner.lock',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW | fileIo.OpenMode.NONBLOCK);
    this.lock = lock; this.check(); lock.tryLock(true); this.locked = true;
    for (const name of ['sessions', 'problems', 'temp']) { await this.directory(this.root + '/' + name); }
    await this.scan();
    for (const session of await this.names(this.root + '/sessions', 64)) { await this.sessionManifest(session); }
    await this.index();
    this.initialized = true;
  }
  private prepare(): Promise<void> {
    this.check();
    if (this.ready === undefined) { this.ready = this.initialize(); }
    return this.ready;
  }
  private async names(directory: string, maximum: number): Promise<string[]> {
    await this.directory(directory);
    const options: SandboxListOptions = { recursion: false, listNum: maximum + 1 };
    const names: string[] = await fileIo.listFile(directory, options);
    this.check();
    if (names.length > maximum || names.some((name: string): boolean => !coreIdentifier(name))) {
      throw new Error('SANDBOX_INVENTORY_INVALID');
    }
    return names.sort();
  }
  private async entry(relative: string, kind: string): Promise<void> {
    const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + relative);
    this.check();
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error('SANDBOX_INVENTORY_INVALID');
    }
    this.total += stat.size;
    if (this.total > this.options.maxStorageBytes) { throw new Error('SANDBOX_QUOTA'); }
    const item: SandboxEntry = { path: relative, kind, bytes: stat.size, modifiedSeconds: stat.mtime }; this.inventory.push(item);
  }
  private async scan(): Promise<void> {
    this.inventory = []; this.total = 0;
    await this.entry('owner.lock', 'metadata');
    if (this.total > 32768) { throw new Error('SANDBOX_READ_BOUND'); }
    const rootNames: string[] = await this.names(this.root, 6);
    if (rootNames.includes('index.json')) {
      await this.entry('index.json', 'metadata');
      if (this.inventory[this.inventory.length - 1].bytes > 32768) { throw new Error('SANDBOX_READ_BOUND'); }
    }
    for (const session of await this.names(this.root + '/sessions', 64)) {
      if (!session.startsWith('session-')) { throw new Error('SANDBOX_INVENTORY_INVALID'); }
      const segments: string[] = await this.names(this.root + '/sessions/' + session, 257);
      for (const name of segments) {
        if (name === 'manifest.json') {
          await this.entry('sessions/' + session + '/' + name, 'session-manifest');
          if (this.inventory[this.inventory.length - 1].bytes > 32768) { throw new Error('SANDBOX_READ_BOUND'); }
          continue;
        }
        if (!new RegExp('^segment-[0-9]{12}\\.seg$').test(name)) { throw new Error('SANDBOX_INVENTORY_INVALID'); }
        await this.entry('sessions/' + session + '/' + name, 'segment');
        if (this.inventory.filter((item: SandboxEntry): boolean => item.kind === 'segment').length > 256) {
          throw new Error('SANDBOX_QUOTA');
        }
      }
    }
    for (const name of await this.names(this.root + '/problems', this.options.maxProblems)) {
      if (!new RegExp('^problem-[A-Za-z0-9_.-]+\\.json$').test(name)) { throw new Error('SANDBOX_INVENTORY_INVALID'); }
      await this.entry('problems/' + name, 'problem');
    }
    // Unpublished files remain accounted for. They are never treated as committed records.
    for (const name of await this.names(this.root + '/temp', 64)) {
      const files: string[] = await this.names(this.root + '/temp/' + name, 1);
      for (const file of files) { await this.entry('temp/' + name + '/' + file, 'pending'); }
    }
  }
  private async read(relative: string, maximum: number): Promise<string> {
    const file: fileIo.File = await fileIo.open(this.root + '/' + relative,
      fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW | fileIo.OpenMode.NONBLOCK);
    try {
      const stat: fileIo.Stat = await fileIo.stat(file.fd);
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > maximum) { throw new Error('SANDBOX_READ_BOUND'); }
      const output = new Uint8Array(stat.size);
      let offset: number = 0;
      while (offset < output.byteLength) {
        const part: ArrayBuffer = new ArrayBuffer(output.byteLength - offset);
        const count: number = await fileIo.read(file.fd, part);
        this.check();
        if (count < 1 || count > part.byteLength) { throw new Error('SANDBOX_READ_INCOMPLETE'); }
        output.set(new Uint8Array(part, 0, count), offset); offset += count;
      }
      const decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { fatal: true });
      return decoder.decodeToString(output);
    } finally { await fileIo.close(file); }
  }
  private unwrap(text: string): string {
    const envelope: CoreEnvelope = JSON.parse(text) as CoreEnvelope;
    if (!exactKeys(envelope, ['schemaVersion', 'bytes', 'sha256', 'payload']) ||
      envelope.schemaVersion !== '1.0' || typeof envelope.payload !== 'string' ||
      envelope.bytes !== this.byteLength(envelope.payload) || envelope.sha256 !== this.hash(envelope.payload)) {
      throw new Error('SANDBOX_CHECKSUM');
    }
    return envelope.payload;
  }
  private async writeFile(path: string, text: string): Promise<void> {
    const file: fileIo.File = await fileIo.open(path, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE |
      fileIo.OpenMode.NOFOLLOW | fileIo.OpenMode.NONBLOCK);
    try {
      const data: Uint8Array = this.encode(text);
      let offset: number = 0;
      while (offset < data.byteLength) {
        this.check();
        const chunk: ArrayBuffer = data.slice(offset).buffer as ArrayBuffer;
        const count: number = await fileIo.write(file.fd, chunk);
        if (count < 1 || count > chunk.byteLength) { throw new Error('SANDBOX_WRITE_INCOMPLETE'); }
        offset += count;
      }
      await fileIo.fsync(file.fd); this.check();
    } finally { await fileIo.close(file); }
  }
  private async syncDirectory(relative: string): Promise<void> {
    const file: fileIo.File = await fileIo.open(this.root + '/' + relative,
      fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
    try { await fileIo.fsync(file.fd); this.check(); }
    finally { await fileIo.close(file); }
  }
  private async removeStaging(path: string, directoryOnly: boolean): Promise<void> {
    try {
      if (directoryOnly) { await fileIo.rmdir(path.substring(0, path.lastIndexOf('/'))); }
      else { await fileIo.unlink(path); }
    } catch (error) {
      if ((error as BusinessError).code !== 13900002) { throw new Error('SANDBOX_STAGING_UNCERTAIN'); }
    }
  }
  private fileFor(item: SandboxEntry): SandboxFile {
    const file: SandboxFile = { name: item.path.substring(item.path.lastIndexOf('/') + 1),
      bytes: item.bytes, modifiedSeconds: item.modifiedSeconds };
    return file;
  }
  private indexFor(entries: SandboxEntry[]): SandboxIndex {
    // Derived metadata shares directory prefixes; checksummed segments remain the recovery source.
    const index: SandboxIndex = { schemaVersion: '1.1', directories: [] };
    for (const item of entries) {
      if (item.kind === 'metadata') { continue; }
      const parent: string = item.path.substring(0, item.path.lastIndexOf('/'));
      let group: SandboxDirectory | undefined = index.directories.find((directory: SandboxDirectory): boolean =>
        directory.path === parent);
      if (group === undefined) {
        group = { path: parent, files: [] }; index.directories.push(group);
      }
      group.files.push(this.fileFor(item));
    }
    return index;
  }
  private manifestFor(session: string, entries: SandboxEntry[]): SandboxSessionManifest {
    const manifest: SandboxSessionManifest = { schemaVersion: '1.1', sessionId: session,
      buildVerification: 'unverified-build', lifecycleEvidence: 'segment-records-only',
      segments: entries.filter((item: SandboxEntry): boolean =>
        item.kind === 'segment' && item.path.startsWith('sessions/' + session + '/'))
        .map((item: SandboxEntry): SandboxFile => this.fileFor(item)) };
    return manifest;
  }
  private publicationFits(relative: string, cost: number): boolean {
    const kind: string = relative.startsWith('problems/') ? 'problem' : 'segment';
    const limit: number = kind === 'problem' ? this.options.maxProblems : 256;
    const reserved: string[] = Array.from(this.uncertain.keys()).filter((name: string): boolean =>
      name !== relative && !this.inventory.some((item: SandboxEntry): boolean => item.path === name) &&
      (kind === 'problem' ? name.startsWith('problems/') : name.startsWith('sessions/')));
    if (this.inventory.filter((item: SandboxEntry): boolean => item.kind === kind).length + reserved.length >= limit) {
      return false;
    }
    const pending: string | undefined = this.uncertain.get(relative);
    const stagedPath: string = pending?.substring(this.root.length + 1) ?? '';
    const entries: SandboxEntry[] = this.inventory.filter((item: SandboxEntry): boolean =>
      item.kind !== 'metadata' && item.path !== stagedPath);
    const prospective: SandboxEntry = { path: relative, kind, bytes: cost, modifiedSeconds: Number.MAX_VALUE };
    entries.push(prospective);
    let manifestCost: number = 0, replacedCost: number = 0;
    if (kind === 'segment') {
      const target: string = 'sessions/' + this.session + '/manifest.json';
      manifestCost = this.byteLength(JSON.stringify(this.manifestFor(this.session, entries))) + 64;
      if (manifestCost > 32768) { return false; }
      const old: SandboxEntry | undefined = entries.find((item: SandboxEntry): boolean => item.path === target);
      replacedCost = old?.bytes ?? 0;
      if (old !== undefined) { entries.splice(entries.indexOf(old), 1); }
      const manifest: SandboxEntry = { path: target, kind: 'session-manifest',
        bytes: manifestCost, modifiedSeconds: Number.MAX_VALUE }; entries.push(manifest);
    }
    const index: SandboxIndex = this.indexFor(entries);
    // Reserve timestamp/size serialization growth before any record is published.
    const indexCost: number = this.byteLength(JSON.stringify(index)) + 128;
    const addedCost: number = this.uncertain.has(relative) ? 0 : cost;
    return indexCost <= 32768 && this.total + addedCost +
      Math.max(32768, manifestCost, manifestCost - replacedCost + indexCost) <= this.options.maxStorageBytes;
  }
  private supersedes(previous: string, next: string): boolean {
    // Only a strict event-prefix extension of the same session segment may replace bytes.
    try {
      const before: CoreSegment = JSON.parse(this.unwrap(previous)) as CoreSegment;
      const after: CoreSegment = JSON.parse(this.unwrap(next)) as CoreSegment;
      if (before.sessionId !== after.sessionId || before.buildId !== after.buildId ||
        before.firstSequence !== after.firstSequence || before.events.length >= after.events.length ||
        after.events.length > 1024 || before.lastSequence !== before.events[before.events.length - 1].sequence ||
        after.lastSequence !== after.events[after.events.length - 1].sequence) { return false; }
      for (let index: number = 0; index < before.events.length; index++) {
        if (JSON.stringify(before.events[index]) !== JSON.stringify(after.events[index])) { return false; }
      }
      return before.lastSequence < after.lastSequence;
    } catch (_) { return false; }
  }
  private replacementFits(relative: string, cost: number): boolean {
    const target: string = 'sessions/' + this.session + '/manifest.json';
    const entries: SandboxEntry[] = this.inventory.filter((item: SandboxEntry): boolean =>
      item.kind !== 'metadata' && item.path !== relative);
    entries.push({ path: relative, kind: 'segment', bytes: cost, modifiedSeconds: Number.MAX_VALUE });
    const manifestCost: number = this.byteLength(JSON.stringify(this.manifestFor(this.session, entries))) + 64;
    if (manifestCost > 32768) { return false; }
    entries.push({ path: target, kind: 'session-manifest', bytes: manifestCost, modifiedSeconds: Number.MAX_VALUE });
    const indexCost: number = this.byteLength(JSON.stringify(this.indexFor(entries))) + 128;
    // Peak includes the old segment plus the staged replacement and new metadata.
    return indexCost <= 32768 && this.total + cost + manifestCost + indexCost <= this.options.maxStorageBytes;
  }
  private async replaceSegment(relative: string, text: string, old: SandboxEntry): Promise<'synced' | 'uncertain'> {
    const cost: number = this.byteLength(text), pending: string | undefined = this.uncertain.get(relative);
    const previous: string = await this.read(relative, 524288);
    if (previous === text) {
      if (pending !== undefined) { await this.removeStaging(pending, true); await this.syncDirectory('temp'); }
      await this.syncDirectory(relative.substring(0, relative.lastIndexOf('/')));
      this.uncertain.delete(relative); this.pendingHashes.delete(relative); return 'synced';
    }
    if (!this.supersedes(previous, text) || cost > 524288 || !this.replacementFits(relative, cost)) {
      return 'uncertain';
    }
    let retry: string = pending ?? '';
    if (retry === '') {
      await this.names(this.root + '/temp', 62);
      const directory: string = await fileIo.mkdtemp(this.root + '/temp/write-XXXXXX');
      this.check(); retry = directory + '/data';
      this.total += cost; this.uncertain.set(relative, retry); this.pendingHashes.set(relative, this.hash(text));
      this.inventory.push({ path: retry.substring(this.root.length + 1), kind: 'pending',
        bytes: cost, modifiedSeconds: Number.MAX_VALUE });
    } else { await this.removeStaging(retry, false); }
    await this.writeFile(retry, text); this.check();
    await fileIo.rename(retry, this.root + '/' + relative); this.check();
    this.total -= old.bytes;
    this.inventory = this.inventory.filter((item: SandboxEntry): boolean =>
      item.path !== retry.substring(this.root.length + 1));
    const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + relative);
    old.bytes = cost; old.modifiedSeconds = stat.mtime;
    await this.removeStaging(retry, true); await this.syncDirectory('temp');
    await this.syncDirectory(relative.substring(0, relative.lastIndexOf('/')));
    this.uncertain.delete(relative); this.pendingHashes.delete(relative); return 'synced';
  }
  private async publish(relative: string, text: string): Promise<'synced' | 'uncertain'> {
    const cost: number = this.byteLength(text);
    const old: SandboxEntry | undefined = this.inventory.find((item: SandboxEntry): boolean => item.path === relative);
    const pending: string | undefined = this.uncertain.get(relative);
    try {
      this.check();
      if (pending !== undefined && this.pendingHashes.get(relative) !== this.hash(text)) { return 'uncertain'; }
      if (old !== undefined) {
        if (await this.read(relative, 524288) !== text) { return 'uncertain'; }
        if (pending !== undefined) { await this.removeStaging(pending, true); await this.syncDirectory('temp'); }
        await this.syncDirectory(relative.substring(0, relative.lastIndexOf('/')));
        this.uncertain.delete(relative); this.pendingHashes.delete(relative); return 'synced';
      }
      if (cost > 524288 || !this.publicationFits(relative, cost)) {
        return 'uncertain';
      }
      let temporary: string = pending ?? '';
      if (temporary === '') {
        // Leave one of the 64 recovery slots available for derived metadata.
        await this.names(this.root + '/temp', 62);
        const directory: string = await fileIo.mkdtemp(this.root + '/temp/write-XXXXXX');
        this.check(); temporary = directory + '/data';
        this.total += cost; this.uncertain.set(relative, temporary); this.pendingHashes.set(relative, this.hash(text));
        const staged: SandboxEntry = { path: temporary.substring(this.root.length + 1), kind: 'pending',
          bytes: cost, modifiedSeconds: Number.MAX_VALUE }; this.inventory.push(staged);
      } else {
        // The previous write may be partial. Only this host owns the staging file.
        await this.removeStaging(temporary, false);
      }
      await this.writeFile(temporary, text); this.check();
      await this.directory(this.root + '/' + relative.substring(0, relative.lastIndexOf('/')));
      await fileIo.rename(temporary, this.root + '/' + relative);
      const item: SandboxEntry = { path: relative, kind: relative.startsWith('problems/') ? 'problem' : 'segment',
        bytes: cost, modifiedSeconds: Number.MAX_VALUE };
      this.inventory = this.inventory.filter((entry: SandboxEntry): boolean =>
        entry.path !== temporary.substring(this.root.length + 1));
      this.inventory.push(item);
      const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + relative); item.modifiedSeconds = stat.mtime;
      await this.removeStaging(temporary, true); await this.syncDirectory('temp');
      await this.syncDirectory(relative.substring(0, relative.lastIndexOf('/')));
      this.uncertain.delete(relative); this.pendingHashes.delete(relative); return 'synced';
    } catch (_) { return 'uncertain'; }
  }
  private async index(): Promise<void> {
    const index: SandboxIndex = this.indexFor(this.inventory);
    await this.derived('index.json', JSON.stringify(index), 'metadata', '');
  }
  private async sessionManifest(session: string): Promise<void> {
    const segments: SandboxEntry[] = this.inventory.filter((item: SandboxEntry): boolean =>
      item.kind === 'segment' && item.path.startsWith('sessions/' + session + '/'));
    if (segments.length === 0) { return; }
    const manifest: SandboxSessionManifest = this.manifestFor(session, this.inventory);
    await this.derived('sessions/' + session + '/manifest.json', JSON.stringify(manifest), 'session-manifest',
      'sessions/' + session);
  }
  private async derived(target: string, text: string, kind: string, parent: string): Promise<void> {
    const cost: number = this.byteLength(text);
    if (cost > 32768 || this.total + cost > this.options.maxStorageBytes) {
      throw new Error('SANDBOX_QUOTA');
    }
    await this.names(this.root + '/temp', 63);
    const directory: string = await fileIo.mkdtemp(this.root + '/temp/index-XXXXXX');
    const relative: string = directory.substring(this.root.length + 1) + '/data';
    const staged: SandboxEntry = { path: relative, kind: 'pending', bytes: cost,
      modifiedSeconds: systemDateTime.getTime(false) / 1000 };
    this.inventory.push(staged); this.total += cost;
    try {
      await this.writeFile(directory + '/data', text);
      this.check();
      await fileIo.rename(directory + '/data', this.root + '/' + target);
      const old: SandboxEntry | undefined = this.inventory.find((item: SandboxEntry): boolean => item.path === target);
      this.total -= old?.bytes ?? 0;
      this.inventory = this.inventory.filter((item: SandboxEntry): boolean => item.path !== target && item !== staged);
      const published: SandboxEntry = { path: target, kind, bytes: cost, modifiedSeconds: systemDateTime.getTime(false) / 1000 };
      this.inventory.push(published);
      const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + target); published.modifiedSeconds = stat.mtime;
      await fileIo.rmdir(directory); await this.syncDirectory(parent);
    } finally {
      if (this.inventory.includes(staged)) {
        try {
          const stat: fileIo.Stat = await fileIo.lstat(directory + '/data');
          this.total += stat.size - staged.bytes; staged.bytes = stat.size; staged.modifiedSeconds = stat.mtime;
        } catch (_) {
          // Keep the reservation when the staging result cannot be measured.
        }
      }
    }
  }
  accountedStorageBytes(): number { return this.initialized ? this.total : -1; }
  private async syncDeletionDirectory(relative: string): Promise<void> {
    this.dirtyDirectories.add(relative);
    await this.syncDirectory(relative); this.dirtyDirectories.delete(relative);
  }
  private serial(operation: () => Promise<'synced' | 'uncertain'>): Promise<'synced' | 'uncertain'> {
    const result: Promise<'synced' | 'uncertain'> = this.queue.then(async (): Promise<'synced' | 'uncertain'> => {
      try { await this.prepare(); this.check(); return await operation(); }
      catch (_) { return 'uncertain'; }
    });
    this.queue = result.then((): void => {}); return result;
  }
  private readSeries(operation: () => Promise<string[]>): Promise<string[]> {
    const result: Promise<string[]> = this.queue.then(async (): Promise<string[]> => {
      await this.prepare(); this.check(); return operation();
    });
    this.queue = result.then((): void => {}, (): void => {}); return result;
  }
  recover(): Promise<string[]> {
    return this.readSeries(async (): Promise<string[]> => {
      const result: string[] = [];
      for (const item of this.inventory) {
        if (item.kind === 'segment') { result.push(await this.read(item.path, 524288)); }
      }
      return result;
    });
  }
  recoverProblems(): Promise<string[]> {
    return this.readSeries(async (): Promise<string[]> => {
      const result: string[] = [];
      for (const item of this.inventory) {
        if (item.kind === 'problem') { result.push(this.unwrap(await this.read(item.path, 32768))); }
      }
      return result;
    });
  }
  append(text: string): Promise<'synced' | 'uncertain'> {
    return this.serial(async (): Promise<'synced' | 'uncertain'> => {
      const segment: CoreSegment = JSON.parse(this.unwrap(text)) as CoreSegment;
      if (segment.sessionId !== this.session || !Number.isSafeInteger(segment.firstSequence) ||
        segment.firstSequence < 1 || segment.firstSequence > 999999999999) { return 'uncertain'; }
      const sessions: string[] = await this.names(this.root + '/sessions', 64);
      if (!sessions.includes(this.session) && sessions.length >= 64) { return 'uncertain'; }
      await this.directory(this.root + '/sessions/' + this.session);
      const result: string = await this.publish('sessions/' + this.session + '/segment-' +
        segment.firstSequence.toString().padStart(12, '0') + '.seg', text);
      if (result !== 'synced') { return 'uncertain'; }
      await this.sessionManifest(this.session); return 'synced';
    });
  }
  // Explicit rolling-segment extension: only the exact stored event prefix may grow.
  extendSegment(text: string): Promise<'synced' | 'uncertain'> {
    return this.serial(async (): Promise<'synced' | 'uncertain'> => {
      const segment: CoreSegment = JSON.parse(this.unwrap(text)) as CoreSegment;
      if (segment.sessionId !== this.session || !Number.isSafeInteger(segment.firstSequence) ||
        segment.firstSequence < 1 || segment.firstSequence > 999999999999) { return 'uncertain'; }
      const relative: string = 'sessions/' + this.session + '/segment-' +
        segment.firstSequence.toString().padStart(12, '0') + '.seg';
      const item: SandboxEntry | undefined = this.inventory.find((entry: SandboxEntry): boolean =>
        entry.path === relative);
      if (item === undefined) { return 'uncertain'; }
      const result: string = await this.replaceSegment(relative, text, item);
      if (result !== 'synced') { return 'uncertain'; }
      await this.sessionManifest(this.session); return 'synced';
    });
  }
  saveProblem(id: string, text: string): Promise<'synced' | 'uncertain'> {
    return this.serial(async (): Promise<'synced' | 'uncertain'> => {
      if (!coreIdentifier(id) || !id.startsWith('problem-') || this.byteLength(text) > 16384) { return 'uncertain'; }
      const envelope: CoreEnvelope = { schemaVersion: '1.0', bytes: this.byteLength(text), sha256: this.hash(text), payload: text };
      return this.publish('problems/' + id + '.json', JSON.stringify(envelope));
    });
  }
  async deleteProblem(id: string): Promise<boolean> {
    if (!coreIdentifier(id) || !id.startsWith('problem-')) { return false; }
    const result: string = await this.serial(async (): Promise<'synced' | 'uncertain'> => {
      const relative: string = 'problems/' + id + '.json';
      const item: SandboxEntry | undefined = this.inventory.find((entry: SandboxEntry): boolean => entry.path === relative);
      if (item === undefined && this.uncertain.has(relative)) { return 'uncertain'; }
      await this.directory(this.root + '/problems');
      if (item !== undefined) {
        await fileIo.unlink(this.root + '/' + relative);
        // Unlink is observable before durability. A failed sync must not leave a readable stale path.
        this.total -= item.bytes;
        this.inventory = this.inventory.filter((entry: SandboxEntry): boolean => entry.path !== relative);
        this.uncertain.delete(relative); this.pendingHashes.delete(relative);
      }
      await this.syncDeletionDirectory('problems');
      await this.index(); return 'synced';
    });
    return result === 'synced';
  }
  async prune(): Promise<CorePruneSummary> {
    const summary = new CorePruneSummary();
    summary.code = 'PRUNE_UNCERTAIN';
    await this.serial(async (): Promise<'synced' | 'uncertain'> => {
      const nowSeconds: number = systemDateTime.getTime(false) / 1000;
      if (!Number.isFinite(nowSeconds) || nowSeconds < 0 || this.uncertain.size > 0) { return 'uncertain'; }
      for (const directory of Array.from(this.dirtyDirectories)) { await this.syncDeletionDirectory(directory); }
      const before: SandboxEntry[] = this.inventory, bytesBefore: number = this.total;
      try { await this.scan(); }
      catch (_) { this.inventory = before; this.total = bytesBefore; throw new Error('SANDBOX_INVENTORY_INVALID'); }
      const cutoff: number = nowSeconds - this.options.retentionDays * 86400;
      for (const item of this.inventory.slice()) {
        if (item.kind === 'metadata' || item.kind === 'session-manifest' ||
          !Number.isFinite(item.modifiedSeconds) || item.modifiedSeconds < 0 || item.modifiedSeconds > cutoff ||
          item.path.startsWith('sessions/' + this.session + '/')) { continue; }
        const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + item.path);
        this.check();
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || stat.mtime !== item.modifiedSeconds) {
          return 'uncertain';
        }
        await fileIo.unlink(this.root + '/' + item.path);
        this.inventory = this.inventory.filter((entry: SandboxEntry): boolean => entry.path !== item.path);
        this.total -= item.bytes;
        if (item.kind === 'problem') {
          summary.deletedProblems.push(item.path.substring('problems/'.length).replace(new RegExp('\\.json$'), ''));
        }
        await this.syncDeletionDirectory(item.path.substring(0, item.path.lastIndexOf('/')));
      }
      for (const name of await this.names(this.root + '/sessions', 64)) {
        if (name === this.session) { continue; }
        const relative: string = 'sessions/' + name;
        const stat: fileIo.Stat = await fileIo.lstat(this.root + '/' + relative);
        const files: string[] = await this.names(this.root + '/' + relative, 257);
        const manifest: SandboxEntry | undefined = this.inventory.find((item: SandboxEntry): boolean =>
          item.path === relative + '/manifest.json');
        if (manifest !== undefined && files.length === 1 && files[0] === 'manifest.json') {
          await fileIo.unlink(this.root + '/' + manifest.path);
          this.inventory = this.inventory.filter((item: SandboxEntry): boolean => item !== manifest); this.total -= manifest.bytes;
          await this.syncDeletionDirectory(relative); files.splice(0, 1);
        }
        if ((manifest !== undefined || stat.mtime <= cutoff) && files.length === 0) {
          await fileIo.rmdir(this.root + '/' + relative); await this.syncDeletionDirectory('sessions');
        } else { await this.sessionManifest(name); }
      }
      await this.index(); summary.code = 'PRUNED'; return 'synced';
    });
    summary.segmentBytes = this.inventory.filter((item: SandboxEntry): boolean => item.kind === 'segment')
      .reduce((sum: number, item: SandboxEntry): number => sum + item.bytes, 0);
    return summary;
  }
  private async release(): Promise<void> {
    try { await this.ready; } catch (_) {}
    await this.queue;
    if (this.lock !== undefined) {
      const lock: fileIo.File = this.lock; this.lock = undefined;
      try { if (this.locked) { lock.unlock(); this.locked = false; } }
      finally { await fileIo.close(lock); }
    }
    this.released = true;
  }
  resourcesReleased(): boolean { return this.released; }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.releasing === undefined) { this.releasing = this.release(); }
    let timer: number = -1;
    const expired: Promise<void> = new Promise<void>((resolve): void => {
      timer = setTimeout((): void => resolve(), this.options.closeTimeoutMs);
    });
    try { await Promise.race<void>([this.releasing, expired]); }
    finally { if (timer !== -1) { clearTimeout(timer); } }
  }
}
