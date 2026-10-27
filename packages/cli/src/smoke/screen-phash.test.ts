/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { BLANK_HAMMING, ScreenPhash } from './screen-phash.js';

describe('ScreenPhash', () => {
  const phash = new ScreenPhash();

  it('detects solid white as blank', () => {
    const w = 64;
    const h = 64;
    const rgb = new Uint8Array(w * h * 3);
    rgb.fill(255);
    const file = path.join(os.tmpdir(), `smoke-phash-white-${Date.now()}.png`);
    fs.writeFileSync(file, ScreenPhash.encodePngRgb(w, h, rgb));
    try {
      const result = phash.analyzeFile(file);
      expect(result).not.toBeNull();
      expect(result!.isBlank).toBe(true);
      expect(result!.hamming).toBeLessThanOrEqual(BLANK_HAMMING);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('detects structured image as not blank', () => {
    const w = 64;
    const h = 64;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        rgb[i] = (x * 7) % 256;
        rgb[i + 1] = (y * 13) % 256;
        rgb[i + 2] = ((x + y) * 3) % 256;
      }
    }
    const file = path.join(os.tmpdir(), `smoke-phash-struct-${Date.now()}.png`);
    fs.writeFileSync(file, ScreenPhash.encodePngRgb(w, h, rgb));
    try {
      const result = phash.analyzeFile(file);
      expect(result).not.toBeNull();
      expect(result!.isBlank).toBe(false);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
