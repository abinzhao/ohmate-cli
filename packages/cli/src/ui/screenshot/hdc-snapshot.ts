/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ScreenshotContext } from './types.js';

/** Build `hdc shell snapshot_display` args for a capture context. */
export function buildSnapshotArgs(
  ctx: ScreenshotContext,
  type?: string
): string[] {
  const args = ['-t', ctx.serial, 'shell', 'snapshot_display'];
  if (ctx.display !== undefined) {
    args.push('-i', ctx.display);
  }
  args.push('-f', ctx.remotePath);
  if (type) {
    args.push('-t', type);
  }
  return args;
}

/** Join hdc stdout/stderr into a single trimmed diagnostic string. */
export function formatHdcOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

/** Normalize the `Tips: supported displayIds` block to a comma-separated list. */
export function formatSnapshotDisplayOutput(output: string): string {
  return output.replace(
    /(Tips:\s*supported\s+displayIds)\s*:?[ \t]*(?:\r?\n[ \t]*)?(\d+(?:(?:[ \t]*,[ \t]*|[ \t]+|\r?\n[ \t]*)\d+)*)/gi,
    (_match: string, label: string, ids: string) =>
      `${label}: ${ids.match(/\d+/g)?.join(', ') ?? ids}`
  );
}

/** Whether snapshot_display output indicates an invalid/unavailable display id. */
export function isInvalidDisplayOutput(output: string): boolean {
  const invalid = String.raw`invalid|not found|not exist|does not exist|out of range|unsupported`;
  return (
    new RegExp(String.raw`display(?:\s*id)?.*(?:${invalid})`, 'is').test(
      output
    ) ||
    new RegExp(String.raw`(?:${invalid}).*display(?:\s*id)?`, 'is').test(output)
  );
}

/** Parse `ls -l` output into the remote file size (bytes), if present. */
export function parseRemoteFileSize(output: string): number | undefined {
  const text = output.trim();
  if (!text || /No such file|not found|cannot access/i.test(text)) {
    return undefined;
  }
  const fields = text.split(/\s+/);
  const size = Number(fields[4]);
  return Number.isFinite(size) ? size : undefined;
}
