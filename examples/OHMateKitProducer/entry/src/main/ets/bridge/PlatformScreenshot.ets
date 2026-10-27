/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { UIContext, FrameNode, componentSnapshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { requireWire } from './Wire';

// The host permits this fixed, non-sensitive subtree only; never capture the pairing page.
export class PlatformScreenshot {
  private generation: number = 0;
  private pending: boolean = false;
  private pixel: image.PixelMap | undefined = undefined;
  private packer: image.ImagePacker | undefined = undefined;
  private releasing: Promise<void> | undefined = undefined;

  busy(): boolean { return this.pending || this.pixel !== undefined || this.packer !== undefined || this.releasing !== undefined; }
  needsClose(): boolean { return !this.pending && (this.pixel !== undefined || this.packer !== undefined); }
  invalidate(): void { ++this.generation; }
  async close(): Promise<void> {
    this.invalidate();
    // Native async work must settle before its inputs can be released.
    if (!this.pending) { await this.releaseResources(); }
  }
  private async releaseResources(): Promise<void> {
    if (this.releasing !== undefined) { return this.releasing; }
    const operation = this.releaseOwned();
    this.releasing = operation;
    try { await operation; } finally { this.releasing = undefined; }
  }
  private async releaseOwned(): Promise<void> {
    let failed = false;
    const packer = this.packer;
    if (packer !== undefined) {
      try { await packer.release(); if (this.packer === packer) { this.packer = undefined; } }
      catch { failed = true; }
    }
    const pixel = this.pixel;
    if (pixel !== undefined) {
      try { await pixel.release(); if (this.pixel === pixel) { this.pixel = undefined; } }
      catch { failed = true; }
    }
    requireWire(!failed, 'SCREENSHOT_CLOSE_FAILED');
  }
  private target(context: UIContext): FrameNode {
    const root = context.getFrameNodeById('bridge_capture_root');
    const target = context.getFrameNodeById('bridge_snapshot_target');
    requireWire(root !== null && root !== undefined && target !== null && target !== undefined, 'SCREENSHOT_SOURCE_INVALID');
    if (root === null || root === undefined || target === null || target === undefined) {
      throw new Error('SCREENSHOT_SOURCE_INVALID');
    }
    requireWire(!root.isDisposed() && root.isAttached() && !target.isDisposed() &&
      target.isAttached() && target.isVisible(), 'SCREENSHOT_SOURCE_INVALID');
    const rootId = root.getUniqueId();
    requireWire(Number.isSafeInteger(rootId) && rootId > 0, 'SCREENSHOT_SOURCE_INVALID');
    let parent: FrameNode | null = target.getParent();
    for (let depth = 0; depth < 32 && parent !== null; depth++) {
      requireWire(!parent.isDisposed() && parent.isAttached(), 'SCREENSHOT_SOURCE_INVALID');
      if (parent.getUniqueId() === rootId) { return target; }
      parent = parent.getParent();
    }
    throw new Error('SCREENSHOT_SOURCE_INVALID');
  }
  async capture(context: UIContext, active: () => boolean, settled: () => void): Promise<Uint8Array> {
    requireWire(!this.busy() && active(), 'SCREENSHOT_CAPTURE_BUSY');
    const generation = ++this.generation;
    let accepting = true;
    const current = (): boolean => accepting && generation === this.generation && active();
    this.pending = true;
    const work = this.collect(context, current).finally(() => { this.pending = false; settled(); });
    let timer: number = -1;
    const timeout = new Promise<Uint8Array>((_resolve, reject) => {
      timer = setTimeout(() => { accepting = false; reject(new Error('SCREENSHOT_TIMEOUT')); }, 3000);
    });
    try { return await Promise.race([work, timeout]); }
    finally { accepting = false; clearTimeout(timer); }
  }
  private async collect(context: UIContext, current: () => boolean): Promise<Uint8Array> {
    let bytes = new Uint8Array(0);
    let failed = false;
    let uniqueId: number = 0;
    try {
      const target = this.target(context);
      uniqueId = target.getUniqueId();
      const size = target.getMeasuredSize();
      requireWire(Number.isSafeInteger(uniqueId) && uniqueId > 0 &&
        Number.isFinite(size.width) && Number.isFinite(size.height) &&
        size.width > 0 && size.height > 0 && size.width <= 65536 && size.height <= 65536,
        'SCREENSHOT_SIZE_INVALID');
      const options: componentSnapshot.SnapshotOptions = {
        scale: Math.min(1, 512 / Math.max(size.width, size.height)), waitUntilRenderFinished: true
      };
      requireWire(current(), 'SCREENSHOT_EXPIRED');
      // 文档依据：UI系统场景化能力 text/10-component-snapshot.md；API26 UIContext.d.ts。
      const pixel = await context.getComponentSnapshot().getWithUniqueId(uniqueId, options);
      requireWire(pixel !== null && pixel !== undefined, 'SCREENSHOT_EMPTY');
      this.pixel = pixel;
      requireWire(current() && this.target(context).getUniqueId() === uniqueId, 'SCREENSHOT_EXPIRED');
      const pixelBytes = pixel.getPixelBytesNumber();
      requireWire(Number.isSafeInteger(pixelBytes) && pixelBytes > 0 && pixelBytes <= 1048576, 'SCREENSHOT_SIZE_INVALID');
      const info = await pixel.getImageInfo();
      requireWire(current() && Number.isSafeInteger(info.size.width) && Number.isSafeInteger(info.size.height) &&
        info.size.width > 0 && info.size.height > 0 && info.size.width <= 512 && info.size.height <= 512,
        'SCREENSHOT_SIZE_INVALID');
      const packer = image.createImagePacker();
      this.packer = packer;
      const packing: image.PackingOption = {
        format: 'image/png', quality: 100, bufferSize: 262144, needsPackProperties: false
      };
      // 文档依据：Image Kit text/04-image-packer-and-encoding.md；不写盘或保留图像属性。
      bytes = new Uint8Array(await packer.packToData(pixel, packing));
      requireWire(bytes.length >= 8 && bytes.length <= 262144 && current() &&
        this.target(context).getUniqueId() === uniqueId, 'SCREENSHOT_SIZE_INVALID');
      const signature: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
      requireWire(signature.every((value: number, index: number): boolean => bytes[index] === value), 'SCREENSHOT_FORMAT_INVALID');
    } catch { failed = true; }
    finally {
      try { await this.releaseResources(); } catch { failed = true; }
    }
    try { if (current() && this.target(context).getUniqueId() !== uniqueId) { failed = true; } }
    catch { failed = true; }
    if (failed || !current()) { bytes.fill(0); throw new Error('SCREENSHOT_CAPTURE_FAILED'); }
    return bytes;
  }
}
