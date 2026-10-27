/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { deflateSync, inflateSync } from 'node:zlib';
import fs from 'node:fs';

const HASH_SIZE = 8;
const SAMPLE = 32;
const CROP_TOP = 0.06;
const CROP_BOTTOM = 0.04;
export const BLANK_HAMMING = 10;

export type PhashBlankResult = {
  phash: string;
  hamming: number;
  isBlank: boolean;
};

export class ScreenPhash {
  private whiteBits: boolean[] | null = null;
  private blackBits: boolean[] | null = null;

  analyzeRgb(
    width: number,
    height: number,
    rgb: Uint8Array
  ): PhashBlankResult | null {
    if (width < 8 || height < 8 || rgb.length < width * height * 3) {
      return null;
    }
    const cropped = this.cropChrome(width, height, rgb);
    const bits = this.hashBits(cropped.width, cropped.height, cropped.rgb);
    const dist = Math.min(
      this.hammingDistance(bits, this.solidRefBits(255)),
      this.hammingDistance(bits, this.solidRefBits(0))
    );
    return {
      phash: this.bitsToHex(bits),
      hamming: dist,
      isBlank: dist <= BLANK_HAMMING,
    };
  }

  analyzeFile(filePath: string): PhashBlankResult | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return null;
    }
    const decoded = this.decodePngRgb(buf);
    if (!decoded) {
      return null;
    }
    return this.analyzeRgb(decoded.width, decoded.height, decoded.rgb);
  }

  /** Test helper: encode RGB888 into a minimal PNG. */
  static encodePngRgb(width: number, height: number, rgb: Uint8Array): Buffer {
    const crcTable = ScreenPhash.pngCrcTable();
    const chunks: Buffer[] = [Buffer.from('\x89PNG\r\n\x1a\n', 'binary')];
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    chunks.push(ScreenPhash.pngChunk('IHDR', ihdr, crcTable));
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 3 + 1)] = 0;
      Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
        raw,
        y * (width * 3 + 1) + 1
      );
    }
    chunks.push(ScreenPhash.pngChunk('IDAT', deflateSync(raw), crcTable));
    chunks.push(ScreenPhash.pngChunk('IEND', Buffer.alloc(0), crcTable));
    return Buffer.concat(chunks);
  }

  private cropChrome(
    width: number,
    height: number,
    rgb: Uint8Array
  ): { width: number; height: number; rgb: Uint8Array } {
    const top = Math.floor(height * CROP_TOP);
    const bottom = Math.floor(height * (1 - CROP_BOTTOM));
    if (bottom <= top + 8) {
      return { width, height, rgb };
    }
    const h = bottom - top;
    const out = new Uint8Array(width * h * 3);
    for (let y = 0; y < h; y++) {
      const src = (top + y) * width * 3;
      out.set(rgb.subarray(src, src + width * 3), y * width * 3);
    }
    return { width, height: h, rgb: out };
  }

  private hashBits(width: number, height: number, rgb: Uint8Array): boolean[] {
    const gray = this.toGray(width, height, rgb);
    const sampled = this.resizeGray(gray, SAMPLE, SAMPLE);
    const dct = this.dct2(sampled);
    const low: number[][] = [];
    for (let y = 0; y < HASH_SIZE; y++) {
      low.push(dct[y].slice(0, HASH_SIZE));
    }
    const flat = this.stabilizeDct(low);
    const med = this.median(flat);
    return flat.map((v) => v > med);
  }

  /** Cached reference hashes for solid white / black screens. */
  private solidRefBits(channel: 0 | 255): boolean[] {
    if (channel === 255) {
      return (this.whiteBits ??= this.solidBits(255, 255, 255));
    }
    return (this.blackBits ??= this.solidBits(0, 0, 0));
  }

  private solidBits(r: number, g: number, b: number): boolean[] {
    const size = 64;
    const rgb = new Uint8Array(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
    return this.hashBits(size, size, rgb);
  }

  private hammingDistance(a: readonly boolean[], b: readonly boolean[]): number {
    const n = Math.min(a.length, b.length);
    let d = Math.abs(a.length - b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        d++;
      }
    }
    return d;
  }

  private bitsToHex(bits: readonly boolean[]): string {
    let value = 0n;
    for (const bit of bits) {
      value = (value << 1n) | (bit ? 1n : 0n);
    }
    const width = Math.max(1, Math.ceil(bits.length / 4));
    return value.toString(16).padStart(width, '0');
  }

  private toGray(width: number, height: number, rgb: Uint8Array): number[][] {
    const out: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        row.push(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
      }
      out.push(row);
    }
    return out;
  }

  private resizeGray(src: number[][], tw: number, th: number): number[][] {
    const sh = src.length;
    const sw = src[0]?.length ?? 0;
    if (sw === tw && sh === th) {
      return src;
    }
    const out: number[][] = [];
    for (let y = 0; y < th; y++) {
      const fy = ((y + 0.5) * sh) / th - 0.5;
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
      const wy = fy - y0;
      const row: number[] = [];
      for (let x = 0; x < tw; x++) {
        const fx = ((x + 0.5) * sw) / tw - 0.5;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
        const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
        const wx = fx - x0;
        const v00 = src[y0][x0];
        const v10 = src[y0][x1];
        const v01 = src[y1][x0];
        const v11 = src[y1][x1];
        row.push(
          v00 * (1 - wx) * (1 - wy) +
            v10 * wx * (1 - wy) +
            v01 * (1 - wx) * wy +
            v11 * wx * wy
        );
      }
      out.push(row);
    }
    return out;
  }

  private stabilizeDct(low: number[][]): number[] {
    const flat = low.flat();
    const dc = Math.abs(flat[0] ?? 0);
    const eps = Math.max(1e-3, dc * 1e-8);
    return flat.map((v) => (Math.abs(v) < eps ? 0 : v));
  }

  private median(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }
    const ordered = [...values].sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    if (ordered.length % 2) {
      return ordered[mid];
    }
    return 0.5 * (ordered[mid - 1] + ordered[mid]);
  }

  private dct2(matrix: number[][]): number[][] {
    const n = matrix.length;
    const dct1 = (vec: number[]): number[] => {
      const out = new Array<number>(n).fill(0);
      for (let k = 0; k < n; k++) {
        let total = 0;
        for (let i = 0; i < n; i++) {
          total += vec[i] * Math.cos((Math.PI * (i + 0.5) * k) / n);
        }
        out[k] = total;
      }
      return out;
    };
    const rows = matrix.map(dct1);
    const cols: number[][] = [];
    for (let c = 0; c < n; c++) {
      cols.push(dct1(rows.map((row) => row[c])));
    }
    const trans: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row: number[] = [];
      for (let c = 0; c < n; c++) {
        row.push(cols[c][r]);
      }
      trans.push(row);
    }
    return trans;
  }

  private decodePngRgb(
    buf: Buffer
  ): { width: number; height: number; rgb: Uint8Array } | null {
    const parsed = this.parsePngChunks(buf);
    if (!parsed) {
      return null;
    }
    let inflated: Buffer;
    try {
      inflated = inflateSync(Buffer.concat(parsed.idat));
    } catch {
      return null;
    }
    const rgb = this.pngScanlinesToRgb(
      inflated,
      parsed.width,
      parsed.height,
      parsed.colorType
    );
    return { width: parsed.width, height: parsed.height, rgb };
  }

  private parsePngChunks(buf: Buffer): {
    width: number;
    height: number;
    colorType: number;
    idat: Buffer[];
  } | null {
    if (
      buf.length < 8 ||
      buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n'
    ) {
      return null;
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: Buffer[] = [];
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
      const data = buf.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }
    if (
      !width ||
      !height ||
      bitDepth !== 8 ||
      (colorType !== 2 && colorType !== 6)
    ) {
      return null;
    }
    return { width, height, colorType, idat };
  }

  private pngScanlinesToRgb(
    inflated: Buffer,
    width: number,
    height: number,
    colorType: number
  ): Uint8Array {
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const filter = inflated[src++];
      cur.set(inflated.subarray(src, src + stride));
      src += stride;
      this.applyPngFilter(filter, cur, prev, bpp);
      for (let x = 0; x < width; x++) {
        const di = (y * width + x) * 3;
        const si = x * bpp;
        rgb[di] = cur[si];
        rgb[di + 1] = cur[si + 1];
        rgb[di + 2] = cur[si + 2];
      }
      prev.set(cur);
    }
    return rgb;
  }

  private applyPngFilter(
    filter: number,
    cur: Uint8Array,
    prev: Uint8Array,
    bpp: number
  ) {
    for (let i = 0; i < cur.length; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) {
        cur[i] = (cur[i] + left) & 255;
      } else if (filter === 2) {
        cur[i] = (cur[i] + up) & 255;
      } else if (filter === 3) {
        cur[i] = (cur[i] + Math.floor((left + up) / 2)) & 255;
      } else if (filter === 4) {
        cur[i] = (cur[i] + this.paeth(left, up, upLeft)) & 255;
      }
    }
  }

  private paeth(a: number, b: number, c: number) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
      return a;
    }
    if (pb <= pc) {
      return b;
    }
    return c;
  }

  private static pngChunk(
    type: string,
    data: Buffer,
    crcTable: Uint32Array
  ): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(ScreenPhash.pngCrc(body, crcTable), 8 + data.length);
    return out;
  }

  private static pngCrcTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  private static pngCrc(buf: Buffer, table: Uint32Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
}
