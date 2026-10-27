/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telemetry } from './telemetry-instance.js';
import { Telemetry } from './telemetry.js';

vi.mock('../../mcp/src-server/utils/mcp-logger.js', () => ({
  mcpLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('telemetry singleton', () => {
  let root = '';

  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    root = '';
  });

  it('exports a ready-to-use Telemetry instance', () => {
    expect(telemetry).toBeInstanceOf(Telemetry);
  });

  it('returns the same instance on repeated imports', async () => {
    const mod = await import('./telemetry-instance.js');
    expect(mod.telemetry).toBe(telemetry);
  });

  it('initializes into a storage directory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-telemetry-single-'));
    telemetry.init(root);
    expect(fs.statSync(path.join(root, 'failed')).isDirectory()).toBe(true);
  });
});
