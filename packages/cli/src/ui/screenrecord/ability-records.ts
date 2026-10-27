/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import {
  RECORDER_ABILITY,
  RECORDER_BUNDLE,
  ScreenRecordError,
  type RecorderRecord,
  type RecordingSession,
  type RecordingSnapshot,
} from './types.js';

const URI_BLOCK_RE = /^\s*uri \[([^\]]*)\]\s*$/;
const URI_LINE_RE = /^\s*uri \[/;
const RECORD_ID_RE = /AbilityRecord ID\s*[:#]\s*(\d+)/;
const START_TIME_RE = /start time \[(\d+)\]/;
const BUNDLE_RE = /bundle name \[([^\]]*)\]/;
const MAIN_NAME_RE = /main name \[([^\]]*)\]/;
/** hdc transport failures can surface on stdout; never parse them as a dump. */
const HDC_ERROR_RE = /\[(?:Fail|E\d{5,})\]|^\s*(?:error|Error)(?::|\s)/m;

const SHORT_ABILITY = RECORDER_ABILITY.slice(
  RECORDER_ABILITY.lastIndexOf('.') + 1
);

interface AbilityBlock {
  uri?: string;
  id?: number;
  startedAtMs?: number;
  bundleName?: string;
  mainName?: string;
}

function splitBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (URI_BLOCK_RE.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

function parseBlock(lines: string[]): AbilityBlock {
  const block: AbilityBlock = {};
  for (const line of lines) {
    const uri = URI_BLOCK_RE.exec(line);
    if (uri) {
      block.uri = uri[1].trim();
      continue;
    }
    const id = RECORD_ID_RE.exec(line);
    if (id) {
      block.id = Number(id[1]);
      if (!Number.isSafeInteger(block.id)) {
        throw new ScreenRecordError(
          'DUMP_PARSE_FAILED',
          `Unparseable AbilityRecord ID in aa dump output: ${id[1]}`
        );
      }
      // 不在此处 continue:同一行还会携带 start time。
    }
    const startedAt = START_TIME_RE.exec(line);
    if (startedAt) {
      block.startedAtMs = Number(startedAt[1]);
      continue;
    }
    const bundle = BUNDLE_RE.exec(line);
    if (bundle) {
      block.bundleName = bundle[1].trim();
      continue;
    }
    const main = MAIN_NAME_RE.exec(line);
    if (main) {
      block.mainName = main[1].trim();
    }
  }
  return block;
}

function blockIdentity(block: AbilityBlock): {
  bundleName?: string;
  abilityName?: string;
} {
  let abilityName = block.mainName;
  if ((!block.bundleName || !abilityName) && block.uri) {
    // uri layout: /<bundle>/<module>/<abilityClass>
    const segments = block.uri.split('/').filter(Boolean);
    if (segments.length >= 3) {
      block.bundleName ??= segments[0];
      abilityName ??= segments[segments.length - 1];
    }
  }
  return { bundleName: block.bundleName, abilityName };
}

function isRecorderBlock(block: AbilityBlock): boolean {
  const { bundleName, abilityName } = blockIdentity(block);
  if (bundleName !== RECORDER_BUNDLE || !abilityName) {
    return false;
  }
  return abilityName === RECORDER_ABILITY || abilityName === SHORT_ABILITY;
}

/**
 * Envelope and integrity checks: hdc error text, unknown layout, truncated
 * output, or residue without a complete block are hard errors. Returns the
 * split ability blocks; an empty result means "no records".
 */
function assertRecognizedDumpEnvelope(text: string): string[][] {
  if (HDC_ERROR_RE.test(text)) {
    throw new ScreenRecordError(
      'DUMP_PARSE_FAILED',
      `Unexpected aa dump output: ${text.trim().split(/\r?\n/)[0] ?? ''}`
    );
  }
  if (
    !text.includes('ExtensionRecords') &&
    !text.includes('AbilityRecord ID')
  ) {
    throw new ScreenRecordError(
      'DUMP_PARSE_FAILED',
      'aa dump output has no recognizable extension-record structure'
    );
  }
  // A uri line without its closing bracket means the output was cut
  // mid-block; the recorder record behind it must not be treated as absent.
  for (const line of text.split(/\r?\n/)) {
    if (URI_LINE_RE.test(line) && !URI_BLOCK_RE.test(line)) {
      throw new ScreenRecordError(
        'DUMP_PARSE_FAILED',
        'aa dump output has an unterminated uri line; output may be truncated'
      );
    }
  }
  const blocks = splitBlocks(text);
  if (
    blocks.length === 0 &&
    text.replace(/ExtensionRecords:\s*/, '').trim() !== ''
  ) {
    // No complete ability block at all: only a bare section header means
    // "no records"; any other residue is unparseable output.
    throw new ScreenRecordError(
      'DUMP_PARSE_FAILED',
      'aa dump output has no complete ability records; output may be truncated'
    );
  }
  return blocks;
}

/**
 * Parse `aa dump -e` output into recorder-service records. Empty output, an
 * unknown envelope, truncated output, or a recorder block without a readable
 * ID is a hard error, never "no records": an empty success exit proves
 * nothing about the device state.
 */
export function parseRecorderRecords(text: string): RecorderRecord[] {
  if (!text.trim()) {
    throw new ScreenRecordError(
      'DUMP_PARSE_FAILED',
      'aa dump output is empty; the device state is unknown'
    );
  }
  const byId = new Map<number, RecorderRecord>();
  for (const lines of assertRecognizedDumpEnvelope(text)) {
    const block = parseBlock(lines);
    if (!isRecorderBlock(block)) {
      continue;
    }
    if (block.id === undefined) {
      throw new ScreenRecordError(
        'DUMP_PARSE_FAILED',
        'Recorder ability block is missing its AbilityRecord ID'
      );
    }
    const { bundleName, abilityName } = blockIdentity(block);
    byId.set(block.id, {
      abilityRecordId: block.id,
      bundleName: bundleName ?? RECORDER_BUNDLE,
      abilityName: abilityName ?? RECORDER_ABILITY,
      startedAtMs: block.startedAtMs,
    });
  }
  return [...byId.values()];
}

/** Classify observed recorder records against the local session registration. */
export function classifyRecording(
  records: RecorderRecord[],
  session?: RecordingSession
): RecordingSnapshot {
  if (records.length > 1) {
    throw new ScreenRecordError(
      'AMBIGUOUS_DEVICE_STATE',
      `Multiple screen recorder ability records: ${records
        .map((r) => r.abilityRecordId)
        .join(', ')}`
    );
  }
  const active = records[0];
  if (!active) {
    return { status: 'idle', session };
  }
  return {
    status:
      session?.abilityRecordId === active.abilityRecordId
        ? 'recording'
        : 'busy',
    activeId: active.abilityRecordId,
    session,
  };
}
