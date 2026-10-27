/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const uploadMock = vi.hoisted(() => ({
  fn: vi.fn<(payload: string, installId: string) => Promise<boolean>>(),
}));

vi.mock('./trace-uploader.js', () => ({
  TraceUploader: class {
    upload = uploadMock.fn;
  },
}));

vi.mock('../../mcp/src-server/utils/mcp-logger.js', () => ({
  mcpLog: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

import { Telemetry } from './telemetry.js';
import {
  decryptTraceLine,
  encryptTraceLine,
  resolveTraceFileKey,
} from './file-crypto.js';

function makeEncryptedLines(count: number, key: Buffer): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const plain = JSON.stringify({
      event: `evt${i}`,
      properties: { i },
      eventtime: 1700000000000 + i,
    });
    lines.push(encryptTraceLine(plain, key));
  }
  return lines;
}

describe('Telemetry flush (lazy decrypt + raw write-back)', () => {
  let storageDir: string;
  let failedDir: string;
  let telemetry: Telemetry;

  beforeEach(() => {
    delete process.env.DEVECO_CLI_DISABLE_TELEMETRY;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-flush-'));
    failedDir = path.join(storageDir, 'failed');
    telemetry = new Telemetry();
    telemetry.init(storageDir);
    uploadMock.fn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('uploads in batches of at most 200 and deletes the file on success', async () => {
    const key = resolveTraceFileKey(storageDir);
    const lines = makeEncryptedLines(500, key);
    const file = path.join(storageDir, 'telemetry-2026-09-21.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    uploadMock.fn.mockResolvedValue(true);

    const ok = await telemetry.flush();

    expect(ok).toBe(true);
    expect(uploadMock.fn).toHaveBeenCalledTimes(3);
    for (const call of uploadMock.fn.mock.calls) {
      const items = JSON.parse(call[0]);
      expect(items.length).toBeLessThanOrEqual(200);
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(file + '.pending')).toBe(false);
  });

  it('writes raw ciphertext to failed dir on failure (no re-encrypt)', async () => {
    const key = resolveTraceFileKey(storageDir);
    const lines = makeEncryptedLines(50, key);
    fs.writeFileSync(
      path.join(storageDir, 'telemetry-2026-09-21.txt'),
      lines.join('\n') + '\n'
    );
    uploadMock.fn.mockResolvedValue(false);

    const ok = await telemetry.flush();

    expect(ok).toBe(false);
    const failedFile = path.join(failedDir, 'telemetry-2026-09-21.txt');
    expect(fs.existsSync(failedFile)).toBe(true);
    const failedContent = fs
      .readFileSync(failedFile, 'utf8')
      .trim()
      .split('\n');
    // 与原始密文逐字节相同——若被 re-encrypt 则 iv/authTag 不同，必然不等
    expect(failedContent).toEqual(lines);
    for (const line of failedContent) {
      expect(decryptTraceLine(line, key)).not.toBeNull();
    }
  });

  it('writes all remaining raw ciphertext when a mid-stream batch fails', async () => {
    const key = resolveTraceFileKey(storageDir);
    const lines = makeEncryptedLines(450, key);
    fs.writeFileSync(
      path.join(storageDir, 'telemetry-2026-09-21.txt'),
      lines.join('\n') + '\n'
    );
    // 第一批 200 成功，第二批失败
    uploadMock.fn
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const ok = await telemetry.flush();

    expect(ok).toBe(false);
    expect(uploadMock.fn).toHaveBeenCalledTimes(2);
    const failedContent = fs
      .readFileSync(path.join(failedDir, 'telemetry-2026-09-21.txt'), 'utf8')
      .trim()
      .split('\n');
    // 第二批起点 200 起的剩余 250 行原样写回
    expect(failedContent).toEqual(lines.slice(200));
  });

  it('skips undecryptable lines and uploads only valid events', async () => {
    const key = resolveTraceFileKey(storageDir);
    const good = makeEncryptedLines(5, key);
    const bad = ['corrupt-line-1', 'corrupt-line-2'];
    const all = [...good.slice(0, 2), ...bad, ...good.slice(2)];
    fs.writeFileSync(
      path.join(storageDir, 'telemetry-2026-09-21.txt'),
      all.join('\n') + '\n'
    );
    uploadMock.fn.mockResolvedValue(true);

    await telemetry.flush();

    expect(uploadMock.fn).toHaveBeenCalledTimes(1);
    const items = JSON.parse(uploadMock.fn.mock.calls[0][0]);
    expect(items.length).toBe(5);
  });
});
