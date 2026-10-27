/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolProvider } from '../../toolchain/index.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { debugLog } from '../../utils/logger.js';
import {
  buildSnapshotArgs,
  formatHdcOutput,
  formatSnapshotDisplayOutput,
  isInvalidDisplayOutput,
  parseRemoteFileSize,
} from './hdc-snapshot.js';
import type { FileSystemError, ScreenshotContext } from './types.js';

function timestamp(): string {
  return String(Date.now());
}

function assertWritableDirectory(parent: string): void {
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch (error) {
    const code = (error as FileSystemError).code;
    if (code === 'ENOENT') {
      throw new Error(`Screenshot directory does not exist: ${parent}`, {
        cause: error,
      });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Screenshot directory is not writable: ${parent}`, {
        cause: error,
      });
    }
    throw new Error(
      `Invalid screenshot path: ${(error as Error).message}${code ? ` (${code})` : ''}`,
      { cause: error }
    );
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`Screenshot parent path is not a directory: ${parent}`);
  }

  try {
    fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw new Error(`Screenshot directory is not writable: ${parent}`, {
      cause: error,
    });
  }
}

function assertDestinationAvailable(resolved: string, parent: string): void {
  try {
    fs.lstatSync(resolved);
    throw new Error(`Screenshot file already exists: ${resolved}`);
  } catch (error) {
    const code = (error as FileSystemError).code;
    if (code === 'ENOENT') {
      return;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Screenshot directory is not writable: ${parent}`, {
        cause: error,
      });
    }
    if (error instanceof Error && !code) {
      throw error;
    }
    throw new Error(
      `Invalid screenshot path: ${(error as Error).message}${code ? ` (${code})` : ''}`,
      { cause: error }
    );
  }
}

function assertPngFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Screenshot file was not created: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Screenshot file is empty: ${filePath}`);
  }
  const signature = fs.readFileSync(filePath).subarray(0, 8);
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!signature.equals(pngSignature)) {
    throw new Error(`Screenshot file is not a valid PNG: ${filePath}`);
  }
}

function isPngFile(filePath: string): boolean {
  try {
    assertPngFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function findPngFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findPngFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isPngFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function findReceivedScreenshot(
  receiveDir: string,
  remotePath: string
): string | undefined {
  const expected = path.join(receiveDir, path.basename(remotePath));
  if (isPngFile(expected)) {
    return expected;
  }
  const files = findPngFiles(receiveDir);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    throw new Error(
      `Multiple screenshot files were received in ${receiveDir}.`
    );
  }
  return undefined;
}

function moveScreenshotToDestination(
  sourcePath: string,
  localPath: string
): void {
  try {
    fs.copyFileSync(sourcePath, localPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as FileSystemError).code === 'EEXIST') {
      throw new Error(`Screenshot file already exists: ${localPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  assertPngFile(localPath);
}

/**
 * Capture a device screenshot to a local PNG path.
 *
 * Orchestrates the full `snapshot_display` pipeline: remote capture (with a
 * `-t png` retry), `hdc file recv` into a temp dir, PNG validation, move to
 * the destination, and remote cleanup.
 */
export class ScreenshotCapturer {
  constructor(private readonly toolProvider: ToolProvider) {}

  /**
   * Resolve a user-supplied path (existing directory or explicit .png file)
   * to a concrete destination: a directory gets a fresh `screenshot-<ts>.png`
   * name; a file path must be a writable, non-existing PNG destination.
   */
  public resolveDestinationPath(input: string | undefined): string {
    if (!input?.trim()) {
      throw new Error('--path is required.');
    }
    const value = input.trim();
    const resolved = path.resolve(value);
    try {
      if (fs.statSync(resolved).isDirectory()) {
        assertWritableDirectory(resolved);
        const destination = path.join(
          resolved,
          `screenshot-${timestamp()}.png`
        );
        assertDestinationAvailable(destination, resolved);
        return destination;
      }
    } catch (error) {
      const code = (error as FileSystemError).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
    if (path.extname(resolved).toLowerCase() !== '.png') {
      throw new Error(
        `Screenshot path must be an existing directory or a PNG file: ${resolved}`
      );
    }
    const parent = path.dirname(resolved);
    assertWritableDirectory(parent);
    assertDestinationAvailable(resolved, parent);
    return resolved;
  }

  /** Capture the device screen to `localPath` (validated, no overwrite). */
  public async captureToPath(
    serial: string,
    localPath: string,
    display?: string
  ): Promise<void> {
    const parent = path.dirname(path.resolve(localPath));
    assertWritableDirectory(parent);
    assertDestinationAvailable(path.resolve(localPath), parent);
    const remotePath = `/data/local/tmp/devecocli-${randomUUID()}.png`;
    await this.capture({
      hdcPath: this.toolProvider.hdcPath,
      serial,
      localPath: path.resolve(localPath),
      remotePath,
      display,
    });
  }

  private async capture(ctx: ScreenshotContext): Promise<void> {
    try {
      await this.createRemoteScreenshot(ctx);
      await this.receiveScreenshotFile(ctx);
    } finally {
      await this.removeRemoteScreenshot(ctx);
    }
  }

  private async getRemoteScreenshotSize(
    ctx: ScreenshotContext
  ): Promise<number | undefined> {
    const args = ['-t', ctx.serial, 'shell', 'ls', '-l', ctx.remotePath];
    debugLog(`Executing: ${ctx.hdcPath} ${args.join(' ')}`);
    const result = await runHdcWithRetry(ctx.hdcPath, args);
    return result.exitCode === 0
      ? parseRemoteFileSize(result.stdout)
      : undefined;
  }

  private async tryCreateRemoteScreenshot(
    ctx: ScreenshotContext,
    type?: string
  ): Promise<{ created: boolean; output: string }> {
    const args = buildSnapshotArgs(ctx, type);
    debugLog(`Executing: ${ctx.hdcPath} ${args.join(' ')}`);
    const result = await runHdcWithRetry(ctx.hdcPath, args);
    const size = await this.getRemoteScreenshotSize(ctx);
    return {
      created: size !== undefined && size > 0,
      output: formatSnapshotDisplayOutput(
        formatHdcOutput(result.stdout, result.stderr)
      ),
    };
  }

  private async createRemoteScreenshot(ctx: ScreenshotContext): Promise<void> {
    let output = '';
    for (const type of [undefined, 'png']) {
      const result = await this.tryCreateRemoteScreenshot(ctx, type);
      if (result.created) {
        return;
      }
      if (ctx.display !== undefined && isInvalidDisplayOutput(result.output)) {
        throw new Error(
          `Screenshot was not created on device: ${ctx.remotePath}.\nsnapshot_display output:\n${result.output}`
        );
      }
      if (result.output) {
        output = result.output;
      }
    }
    throw new Error(
      output
        ? `Screenshot was not created on device: ${ctx.remotePath}.\nsnapshot_display output:\n${output}`
        : `Screenshot was not created on device: ${ctx.remotePath}.`
    );
  }

  private async tryReceiveScreenshot(
    ctx: ScreenshotContext,
    receiveDir: string,
    localTarget: string
  ): Promise<string | undefined> {
    const args = [
      '-t',
      ctx.serial,
      'file',
      'recv',
      ctx.remotePath,
      localTarget,
    ];
    debugLog(`Executing: ${ctx.hdcPath} ${args.join(' ')}`);
    const result = await runHdcWithRetry(ctx.hdcPath, args);
    if (result.exitCode !== 0) {
      debugLog(
        `hdc file recv failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`
      );
    }
    return findReceivedScreenshot(receiveDir, ctx.remotePath);
  }

  private async receiveScreenshotFile(ctx: ScreenshotContext): Promise<void> {
    const receiveDir = fs.mkdtempSync(
      path.join(path.dirname(ctx.localPath), '.devecocli-screenshot-')
    );
    try {
      const receivedPath =
        (await this.tryReceiveScreenshot(
          ctx,
          receiveDir,
          path.join(receiveDir, path.basename(ctx.remotePath))
        )) ??
        (await this.tryReceiveScreenshot(ctx, receiveDir, receiveDir)) ??
        (await this.tryReceiveScreenshot(
          ctx,
          receiveDir,
          path.join(receiveDir, 'screenshot.png')
        ));
      if (!receivedPath) {
        throw new Error(`Screenshot file was not created in ${receiveDir}.`);
      }
      moveScreenshotToDestination(receivedPath, ctx.localPath);
    } finally {
      fs.rmSync(receiveDir, { recursive: true, force: true });
    }
  }

  private async removeRemoteScreenshot(ctx: ScreenshotContext): Promise<void> {
    const args = ['-t', ctx.serial, 'shell', 'rm', '-f', ctx.remotePath];
    debugLog(`Executing: ${ctx.hdcPath} ${args.join(' ')}`);
    await runHdcWithRetry(ctx.hdcPath, args);
  }
}
