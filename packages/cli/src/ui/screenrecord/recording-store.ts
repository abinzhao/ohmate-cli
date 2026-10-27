/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LockLease } from './file-lock.js';
import { encodeSerial } from './recording-paths.js';
import { sameSession } from './session-identity.js';
import { ScreenRecordError, type RecordingSession } from './types.js';

function validateSession(value: unknown, source: string): RecordingSession {
  const session = value as Partial<RecordingSession> | null;
  const bad = (field: string) =>
    new ScreenRecordError(
      'SESSION_CORRUPT',
      `Invalid recording session ${field} in ${source}`
    );
  if (!session || typeof session !== 'object') {
    throw bad('object');
  }
  if (
    typeof session.fileName !== 'string' ||
    session.fileName.length === 0 ||
    session.fileName !== path.basename(session.fileName) ||
    session.fileName.includes('..')
  ) {
    throw bad('fileName');
  }
  if (
    typeof session.abilityRecordId !== 'number' ||
    !Number.isSafeInteger(session.abilityRecordId) ||
    session.abilityRecordId <= 0
  ) {
    throw bad('abilityRecordId');
  }
  if (
    typeof session.startTime !== 'number' ||
    !Number.isFinite(session.startTime)
  ) {
    throw bad('startTime');
  }
  if (
    typeof session.localPath !== 'string' ||
    session.localPath.length === 0 ||
    !path.isAbsolute(session.localPath)
  ) {
    throw bad('localPath');
  }
  return {
    fileName: session.fileName,
    abilityRecordId: session.abilityRecordId,
    startTime: session.startTime,
    localPath: session.localPath,
  };
}

/**
 * Session registration file `<recordDir>/<serialHex>.json`. Written once
 * after device confirmation, never updated, deleted after a successful
 * finalize or when a later start discards an interrupted session. `status`
 * observes a complete record or no record: creation uses write-fsync-hardlink.
 */
export class RecordingStore {
  constructor(private readonly recordDir: string) {}

  public sessionPath(serial: string): string {
    return path.join(this.recordDir, `${encodeSerial(serial)}.json`);
  }

  public async read(serial: string): Promise<RecordingSession | undefined> {
    const filePath = this.sessionPath(serial);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new ScreenRecordError(
        'SESSION_CORRUPT',
        `Cannot read recording session: ${(error as Error).message}`,
        { cause: error }
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ScreenRecordError(
        'SESSION_CORRUPT',
        `Recording session file is not valid JSON: ${filePath}`,
        { cause: error }
      );
    }
    return validateSession(parsed, filePath);
  }

  /** Create the registration exclusively; EEXIST means a lost race. */
  public async createAtomic(
    serial: string,
    session: RecordingSession,
    lease: LockLease
  ): Promise<void> {
    await fs.promises.mkdir(this.recordDir, { recursive: true });
    const finalPath = this.sessionPath(serial);
    const tempPath = path.join(
      this.recordDir,
      `${encodeSerial(serial)}.${randomBytes(6).toString('hex')}.tmp`
    );
    const payload = JSON.stringify(validateSession(session, 'input'));

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(tempPath, 'wx');
    } catch (error) {
      throw new ScreenRecordError(
        'SESSION_PUBLISH_FAILED',
        `Cannot create session temp file: ${(error as Error).message}`,
        { cause: error }
      );
    }
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.promises.unlink(tempPath).catch(() => undefined);
      throw new ScreenRecordError(
        'SESSION_PUBLISH_FAILED',
        `Cannot write session temp file: ${(error as Error).message}`,
        { cause: error }
      );
    }
    await handle.close();

    try {
      await lease.assertOwned();
      if (await this.exists(finalPath)) {
        throw new ScreenRecordError(
          'SESSION_CHANGED',
          `A recording session was created concurrently for ${serial}`
        );
      }
      // Hard link = exclusive atomic publish; never overwrites a record.
      await fs.promises.link(tempPath, finalPath);
      await this.syncDir();
    } finally {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
  }

  /** Delete only when the on-disk record is still the expected session. */
  public async deleteIfSame(
    serial: string,
    expected: RecordingSession,
    lease: LockLease
  ): Promise<void> {
    await lease.assertOwned();
    const current = await this.read(serial);
    if (!current) {
      return; // Already gone; must not re-trigger anything device-side.
    }
    if (!sameSession(current, expected)) {
      throw new ScreenRecordError(
        'SESSION_CHANGED',
        'The recording session changed hands; leaving the new record untouched'
      );
    }
    await fs.promises.unlink(this.sessionPath(serial));
    await this.syncDir();
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async syncDir(): Promise<void> {
    try {
      const dir = await fs.promises.open(this.recordDir, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is unsupported on some platforms; best effort.
    }
  }
}
