/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { fileIo, picker } from '@kit.CoreFileKit';
import { CORE_ARCHIVE_MAX_BYTES } from '../core/StoredZip';
import { ArchiveSaveHost } from './ArchiveSaveOwner';

// Temporary Picker URI stays private to the original host; no general file API.
export class HarmonyArchiveSaveHost implements ArchiveSaveHost {
  private context: common.Context;
  private bound: window.Window;
  private uri: string = '';
  private file: fileIo.File | undefined = undefined;
  constructor(context: common.Context, bound: window.Window) { this.context = context; this.bound = bound; }
  available(): boolean {
    return canIUse('SystemCapability.FileManagement.UserFileService') &&
      canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection') &&
      canIUse('SystemCapability.FileManagement.File.FileIO');
  }
  async pick(fileName: string): Promise<boolean> {
    if (this.uri !== '' || this.file !== undefined || !this.available()) { return false; }
    const options: picker.DocumentSaveOptions = { newFileNames: [fileName], autoCreateEmptyFile: false };
    const uris: string[] = await new picker.DocumentViewPicker(this.context, this.bound).save(options);
    if (uris.length === 0) { return false; }
    if (uris.length !== 1 || typeof uris[0] !== 'string' || uris[0].length > 4096 ||
      !uris[0].startsWith('file://') || /[\u0000-\u001f\u007f]/.test(uris[0])) {
      throw new Error('SAVE_DESTINATION_INVALID');
    }
    this.uri = uris[0]; return true;
  }
  async write(bytes: Uint8Array, current: () => boolean): Promise<boolean> {
    if (this.uri === '' || this.file !== undefined || bytes.length < 1 ||
      bytes.length > CORE_ARCHIVE_MAX_BYTES || !current()) { return false; }
    this.file = await fileIo.open(this.uri,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW | fileIo.OpenMode.NONBLOCK);
    if (!current()) { return false; }
    const stat: fileIo.Stat = await fileIo.stat(this.file.fd);
    // Picker consent never permits truncating another existing nonempty document.
    if (!current() || !stat.isFile() || stat.size !== 0) { return false; }
    let offset: number = 0, attempts: number = 0;
    while (offset < bytes.length) {
      if (!current() || attempts++ >= 256) { return false; }
      const chunk: Uint8Array = bytes.slice(offset, Math.min(bytes.length, offset + 65536));
      const count: number = await fileIo.write(this.file.fd, chunk.buffer as ArrayBuffer);
      if (!current() || !Number.isSafeInteger(count) || count < 1 || count > chunk.length) { return false; }
      offset += count;
    }
    if (!current()) { return false; }
    await fileIo.fsync(this.file.fd);
    return current();
  }
  async close(): Promise<boolean> {
    try {
      if (this.file !== undefined) {
        await fileIo.close(this.file); this.file = undefined;
      }
      this.uri = ''; return true;
    } catch (_) { return false; }
  }
}
