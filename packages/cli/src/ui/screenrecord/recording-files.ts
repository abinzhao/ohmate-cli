/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { createFile } from 'mp4box';
import { makeLocalFileName, recoveryCandidates } from './recording-paths.js';
import { ScreenRecordError } from './types.js';

const RECEIVE_DIR_PREFIX = '.devecocli-record-';

function err(message: string, cause?: unknown): ScreenRecordError {
  return new ScreenRecordError(
    'INVALID_RECORDING_PATH',
    cause instanceof Error ? `${message}: ${cause.message}` : message,
    cause instanceof Error ? { cause } : undefined
  );
}

async function statOrNull(
  target: string
): Promise<{ stat: fs.Stats } | { code: string } | null> {
  try {
    return { stat: await fs.promises.stat(target) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    return { code: code ?? 'UNKNOWN' };
  }
}

async function assertWritableDirectory(dir: string): Promise<void> {
  const result = await statOrNull(dir);
  if (!result) {
    throw err(`Directory does not exist: ${dir}`);
  }
  if ('code' in result) {
    throw err(`Directory is not accessible: ${dir}`);
  }
  if (!result.stat.isDirectory()) {
    throw err(`Path is not a directory: ${dir}`);
  }
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch (error) {
    throw err(`Directory is not writable: ${dir}`, error);
  }
}

/** Friendly precheck only; the final arbiter is the exclusive publish. */
export async function assertDestinationAvailable(
  target: string
): Promise<void> {
  if (await statOrNull(target)) {
    throw new ScreenRecordError(
      'DESTINATION_EXISTS',
      `Destination already exists: ${target}`
    );
  }
}

/**
 * Resolve `--path` (existing directory or new `.mp4` file) to an absolute,
 * non-existing destination. Directory targets get an auto-generated name.
 */
export async function resolveDestination(
  input: string | undefined,
  deviceName: string,
  now: Date,
  rand4: string
): Promise<string> {
  if (!input?.trim()) {
    throw err('--path is required.');
  }
  const resolved = path.resolve(input.trim());
  const existing = await statOrNull(resolved);
  if (existing && 'stat' in existing && existing.stat.isDirectory()) {
    await assertWritableDirectory(resolved);
    const destination = path.join(
      resolved,
      makeLocalFileName(deviceName, now, rand4)
    );
    await assertDestinationAvailable(destination);
    return destination;
  }
  if (existing) {
    throw new ScreenRecordError(
      'DESTINATION_EXISTS',
      `Destination already exists: ${resolved}`
    );
  }
  if (path.extname(resolved).toLowerCase() !== '.mp4') {
    throw err(
      `Destination must be an existing directory or a new .mp4 file: ${resolved}`
    );
  }
  const parent = path.dirname(resolved);
  await assertWritableDirectory(parent);
  return resolved;
}

/** Create a private receive directory next to the publish target. */
export async function createReceiveDir(target: string): Promise<string> {
  return fs.promises.mkdtemp(
    path.join(path.dirname(target), RECEIVE_DIR_PREFIX)
  );
}

interface Mp4Inspection {
  size: number;
  /** mp4box consumed the file exactly to its last byte. */
  complete: boolean;
  hasMovieHeader: boolean;
  videoTrackCount: number;
}

/** Stream the MP4 through the parser in bounded chunks (recordings can be large). */
const PARSE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Parse the file with mp4box. A finished recording is consumed to the very
 * last byte (the parser's next expected position equals the file size),
 * carries a movie header, and has at least one video track; an unfinished
 * export fails one of the three.
 */
async function inspectMp4(filePath: string): Promise<Mp4Inspection> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const mp4 = createFile();
    let next: number | undefined = 0;
    for (let offset = 0; offset < size; ) {
      const length = Math.min(PARSE_CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) {
        break;
      }
      const buffer = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + bytesRead
      ) as ArrayBuffer & { fileStart: number };
      buffer.fileStart = offset;
      next = mp4.appendBuffer(buffer, offset + bytesRead >= size);
      offset += bytesRead;
    }
    mp4.flush();
    const moov = mp4.getBox('moov');
    return {
      size,
      complete: next === size,
      hasMovieHeader: moov?.mvhd !== undefined,
      videoTrackCount:
        moov?.mvhd !== undefined ? mp4.getInfo().videoTracks.length : 0,
    };
  } finally {
    await handle.close();
  }
}

/**
 * The recording is acceptable when it is a non-empty MP4 that parses
 * completely, carries a movie header, and contains a video track. An
 * unfinished export is typically truncated or lacks the movie header.
 */
export async function validateReceived(filePath: string): Promise<number> {
  let info: Mp4Inspection;
  try {
    info = await inspectMp4(filePath);
  } catch (error) {
    throw new ScreenRecordError(
      'SAVE_FAILED',
      `Cannot inspect received file: ${(error as Error).message}`,
      { cause: error }
    );
  }
  if (info.size === 0) {
    throw new ScreenRecordError('MEDIA_NOT_READY', 'Received file is empty');
  }
  if (!info.complete || !info.hasMovieHeader) {
    throw new ScreenRecordError(
      'MEDIA_NOT_READY',
      'Received file is not a complete MP4'
    );
  }
  if (info.videoTrackCount < 1) {
    throw new ScreenRecordError(
      'MEDIA_NOT_READY',
      'Received file has no video track'
    );
  }
  return info.size;
}

async function fsyncFile(filePath: string): Promise<void> {
  // Windows cannot fsync a read-only handle; open read-write.
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDir(filePath: string): Promise<void> {
  try {
    const dir = await fs.promises.open(path.dirname(filePath), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; best effort.
  }
}

/**
 * Publish `source` (fully received + validated, same filesystem as the
 * target directory) under the first free name of the recovery sequence.
 * Hard links give exclusive publication: an existing name fails instead of
 * replacing a user file. No overwrite copy/rename fallback is provided.
 */
export async function publishWithoutOverwrite(
  source: string,
  target: string
): Promise<string> {
  await fsyncFile(source);
  for (const candidate of recoveryCandidates(target)) {
    try {
      await fs.promises.link(source, candidate);
      await syncParentDir(candidate);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        continue;
      }
      throw new ScreenRecordError(
        'SAVE_FAILED',
        `Cannot publish recording to ${candidate}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  throw new ScreenRecordError(
    'DESTINATION_UNAVAILABLE',
    `All recovery names are taken near ${target}`
  );
}

/** Remove a receive dir created by us; only ever inside the target parent. */
export async function removeReceiveDir(
  receiveDir: string,
  target: string
): Promise<void> {
  const parent = path.dirname(target);
  const base = path.basename(receiveDir);
  if (
    path.dirname(receiveDir) !== parent ||
    !base.startsWith(RECEIVE_DIR_PREFIX)
  ) {
    // Never delete anything we cannot prove is our own temp directory.
    return;
  }
  await fs.promises
    .rm(receiveDir, { recursive: true, force: true })
    .catch(() => undefined);
}
