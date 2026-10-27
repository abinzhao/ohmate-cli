/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import { requireWire } from './Wire';
import { KIT_EXPORT_MAX_BYTES } from './KitProblemArchive';

export class PlatformProblemExport {
  private choosing: boolean = false;
  private file: fileIo.File | undefined = undefined;
  busy(): boolean { return this.choosing || this.file !== undefined; }
  needsClose(): boolean { return this.file !== undefined; }
  close(): void {
    const file = this.file;
    if (file !== undefined) {
      fileIo.closeSync(file);
      this.file = undefined;
    }
  }
  async save(context: common.Context, bytes: Uint8Array, current: () => boolean): Promise<boolean> {
    requireWire(!this.busy(), 'EXPORT_BUSY');
    requireWire(bytes.length > 0 && bytes.length <= KIT_EXPORT_MAX_BYTES, 'EXPORT_SIZE_LIMIT');
    this.choosing = true;
    try {
      const view = new picker.DocumentViewPicker(context);
      const options: picker.DocumentSaveOptions = {
        newFileNames: ['OHMate.ohmate-problem.zip'], autoCreateEmptyFile: false
      };
      const uris = await view.save(options);
      if (!current() || uris.length === 0) { return false; }
      requireWire(uris.length === 1, 'EXPORT_DESTINATION_INVALID');
      this.file = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW);
      try {
        // A chosen existing nonempty file is never truncated or overwritten.
        const stat = fileIo.statSync(this.file.fd);
        requireWire(stat.isFile() && stat.size === 0, 'EXPORT_DESTINATION_INVALID');
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = bytes.slice(offset, Math.min(offset + 65536, bytes.length));
          const count = fileIo.writeSync(this.file.fd, chunk.buffer);
          requireWire(Number.isSafeInteger(count) && count > 0 && count <= chunk.length, 'EXPORT_WRITE_FAILED');
          offset += count;
        }
        fileIo.fsyncSync(this.file.fd);
      } finally { this.close(); }
      return true;
    } finally { this.choosing = false; }
  }
}
