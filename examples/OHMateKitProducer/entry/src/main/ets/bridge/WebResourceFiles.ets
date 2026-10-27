/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { resourceManager } from '@kit.LocalizationKit';
import { fileIo, ReadOptions } from '@kit.CoreFileKit';
import { url } from '@kit.ArkTS';
import { CryptoPort, keysOf, requireWire } from './Wire';
import { ResourceEntry, safeUrl } from './WebResourceOverride';

export interface ResourceFileEntry {
  name: string; url: string; mimeType: string; sensitivity: string; bytes: number; sha256: string;
}

// Only the host's packaged test directory is readable. The raw HAP descriptor
// is closed through its ResourceManager, never by filesystem path or fileIo.close.
export class WebResourceFiles {
  private crypto: CryptoPort;
  private manager: resourceManager.ResourceManager;
  private entries: ResourceFileEntry[] = [];
  private active: () => boolean;
  private used: boolean = false;
  private pendingName: string = '';

  constructor(crypto: CryptoPort, manager: resourceManager.ResourceManager, pageUrl: string,
    entries: ResourceFileEntry[], active: () => boolean) {
    this.crypto = crypto; this.manager = manager; this.active = active;
    requireWire(Array.isArray(entries) && entries.length <= 32, 'RESOURCE_FILE_INVALID');
    const origin = url.URL.parseURL(pageUrl).origin;
    let total = 0;
    for (const entry of entries) {
      try { keysOf(entry, ['name', 'url', 'mimeType', 'sensitivity', 'bytes', 'sha256']); }
      catch { throw new Error('RESOURCE_FILE_INVALID'); }
      requireWire(typeof entry.name === 'string' && entry.name.length <= 128 &&
        new RegExp('^ohmate-resources/[A-Za-z0-9][A-Za-z0-9_-]{0,63}[.](?:css|txt)$').test(entry.name) &&
        !new RegExp('(?:^|[/_-])(?:auth|login|logout|oauth|token|password|payments?|checkout|purchase|upload|delete)(?:[._-]|$)',
          'i').test(entry.name) &&
        safeUrl(entry.url) && url.URL.parseURL(entry.url).origin === origin && entry.url !== pageUrl &&
        entry.sensitivity === 'ordinary' && ['text/plain', 'text/css'].includes(entry.mimeType) &&
        Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 65536 &&
        typeof entry.sha256 === 'string' && new RegExp('^[a-f0-9]{64}$').test(entry.sha256) &&
        !this.entries.some((item: ResourceFileEntry): boolean => item.name === entry.name || item.url === entry.url),
        'RESOURCE_FILE_INVALID');
      total += entry.bytes;
      requireWire(total <= 262144, 'RESOURCE_FILE_INVALID');
      this.entries.push({ name: entry.name, url: entry.url, mimeType: entry.mimeType,
        sensitivity: entry.sensitivity, bytes: entry.bytes, sha256: entry.sha256 });
    }
  }
  needsClose(): boolean { return this.pendingName !== ''; }
  retryClose(): void {
    const name = this.pendingName;
    if (!name) { return; }
    try { this.manager.closeRawFdSync(name); this.pendingName = ''; }
    catch { throw new Error('RESOURCE_FILE_CLOSE_REQUIRED'); }
  }
  read(): ResourceEntry[] {
    requireWire(!this.used && !this.needsClose() && this.current(), 'RESOURCE_FILE_UNAVAILABLE');
    this.used = true;
    const result: ResourceEntry[] = [];
    try {
      for (const entry of this.entries) {
        requireWire(this.current(), 'RESOURCE_FILE_FAILED');
        const body = this.readOne(entry);
        result.push({ url: entry.url, mimeType: entry.mimeType, sensitivity: entry.sensitivity, body: body });
      }
      requireWire(this.current(), 'RESOURCE_FILE_FAILED');
      return result;
    } catch {
      for (const item of result) { item.body = ''; }
      throw new Error(this.needsClose() ? 'RESOURCE_FILE_CLOSE_REQUIRED' : 'RESOURCE_FILE_FAILED');
    } finally { this.entries = []; }
  }
  private current(): boolean {
    try { return this.active() === true; } catch { return false; }
  }
  private readOne(entry: ResourceFileEntry): string {
    const descriptor = this.manager.getRawFdSync(entry.name);
    this.pendingName = entry.name;
    const bytes = new Uint8Array(entry.bytes);
    try {
      requireWire(this.current() && Number.isSafeInteger(descriptor.fd) && descriptor.fd >= 0 &&
        Number.isSafeInteger(descriptor.offset) && descriptor.offset >= 0 &&
        Number.isSafeInteger(descriptor.length) && descriptor.length === entry.bytes &&
        Number.isSafeInteger(descriptor.offset + descriptor.length), 'RESOURCE_FILE_FAILED');
      let count = 0;
      while (count < bytes.length) {
        const chunk = new ArrayBuffer(Math.min(4096, bytes.length - count));
        try {
          requireWire(this.current() && fileIo.lseek(descriptor.fd, descriptor.offset + count,
            fileIo.WhenceType.SEEK_SET) === descriptor.offset + count, 'RESOURCE_FILE_FAILED');
          const options: ReadOptions = { length: chunk.byteLength };
          const read = fileIo.readSync(descriptor.fd, chunk, options);
          requireWire(this.current() && Number.isSafeInteger(read) && read > 0 && read <= chunk.byteLength,
            'RESOURCE_FILE_FAILED');
          bytes.set(new Uint8Array(chunk, 0, read), count); count += read;
        } finally { new Uint8Array(chunk).fill(0); }
      }
      // Decoder BOM defaults differ by platform; enforce the raw-file contract
      // before decoding, while preserving U+FEFF inside ordinary text.
      requireWire(!(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
        'RESOURCE_FILE_FAILED');
      const text = this.crypto.decode(bytes);
      const encoded = this.crypto.encode(text);
      try {
        requireWire(encoded.length === bytes.length &&
          encoded.every((value: number, index: number): boolean => value === bytes[index]) &&
          this.crypto.hash(text) === entry.sha256 && this.current(), 'RESOURCE_FILE_FAILED');
      } finally { encoded.fill(0); }
      return text;
    } finally { bytes.fill(0); this.retryClose(); }
  }
}
