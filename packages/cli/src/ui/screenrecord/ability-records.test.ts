/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { classifyRecording, parseRecorderRecords } from './ability-records.js';
import {
  RECORDER_ABILITY,
  RECORDER_BUNDLE,
  type RecordingSession,
} from './types.js';

/** Shape captured from a real HarmonyOS device (`aa dump -e`). */
const REAL_DUMP = `  ExtensionRecords:
    uri [/com.huawei.hmos.aidataservice/dataaiprocess/AiProcessServiceAbility]
      AbilityRecord ID #2338   state #ACTIVE   start time [101890206]
      main name [AiProcessServiceAbility]
      bundle name [com.huawei.hmos.aidataservice]
      ability type [SERVICE]
      app state #BEGIN
        isKeepAlive: true
      Connections: 1
       > com.huawei.hmos.aidataservice/AiProcessServiceAbility   connectionState #CONNECTED
    uri [/com.huawei.hmos.screenrecorder/phone/com.huawei.hmos.screenrecorder.ServiceExtAbility]
      AbilityRecord ID #14945   state #ACTIVE   start time [792347775]
      main name [com.huawei.hmos.screenrecorder.ServiceExtAbility]
      bundle name [com.huawei.hmos.screenrecorder]
      ability type [SERVICE]
      app state #BEGIN
        isKeepAlive: false
      Connections: 0
    uri [/com.huawei.hms.adsservice/ads_service/AdsCommonService]
      AbilityRecord ID #56   state #ACTIVE   start time [23445]
      main name [AdsCommonService]
      bundle name [com.huawei.hms.adsservice]
      ability type [SERVICE]
`;

/** OpenHarmony-style block using `ID:` and a short main name. */
const OH_DUMP = `ExtensionRecords:
  uri [/com.huawei.hmos.screenrecorder/phone/ServiceExtAbility]
    AbilityRecord ID: 274   state #ACTIVE
    main name [ServiceExtAbility]
    bundle name [com.huawei.hmos.screenrecorder]
`;

const IDLE_DUMP = `  ExtensionRecords:
    uri [/com.huawei.hmos.aidataservice/dataaiprocess/AiProcessServiceAbility]
      AbilityRecord ID #2338   state #ACTIVE   start time [101890206]
      main name [AiProcessServiceAbility]
      bundle name [com.huawei.hmos.aidataservice]
      ability type [SERVICE]
`;

function session(
  id: number,
  fileName = 'devecocli-20260916-115530123-a3f2.mp4'
): RecordingSession {
  return {
    fileName,
    abilityRecordId: id,
    startTime: 1789530530123,
    localPath: 'C:\\out\\demo.mp4',
  };
}

describe('parseRecorderRecords', () => {
  it('parses the real device dump with the #ID form', () => {
    const records = parseRecorderRecords(REAL_DUMP);
    expect(records).toEqual([
      {
        abilityRecordId: 14945,
        bundleName: RECORDER_BUNDLE,
        abilityName: RECORDER_ABILITY,
        startedAtMs: 792347775,
      },
    ]);
  });

  it('parses the OpenHarmony ID: form and short main name', () => {
    const records = parseRecorderRecords(OH_DUMP);
    expect(records.map((r) => r.abilityRecordId)).toEqual([274]);
  });

  it('returns no records when only unrelated abilities exist', () => {
    expect(parseRecorderRecords(IDLE_DUMP)).toEqual([]);
  });

  it('rejects empty output instead of treating it as idle', () => {
    expect(() => parseRecorderRecords('')).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
    expect(() => parseRecorderRecords('   \n')).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });

  it('treats a bare ExtensionRecords header as no records', () => {
    expect(parseRecorderRecords('ExtensionRecords:\n')).toEqual([]);
    expect(parseRecorderRecords('  ExtensionRecords:  \r\n')).toEqual([]);
  });

  it('rejects residue without any complete ability block', () => {
    expect(() => parseRecorderRecords('AbilityRecord ID #5')).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
    expect(() =>
      parseRecorderRecords('ExtensionRecords:\n  uri [/com.example.partial')
    ).toThrowError(expect.objectContaining({ code: 'DUMP_PARSE_FAILED' }));
  });

  it('rejects a truncated recorder uri line after complete blocks', () => {
    // 传输截断发生在录屏块中间:其他能力块完整,录屏 uri 行未闭合。
    const truncated =
      IDLE_DUMP +
      '    uri [/com.huawei.hmos.screenrecorder/phone/com.huawei.hmos.screenrecorder.ServiceExtAbility';
    expect(() => parseRecorderRecords(truncated)).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });

  it('captures the record start time as device uptime ms', () => {
    const records = parseRecorderRecords(REAL_DUMP);
    expect(records[0].startedAtMs).toBe(792347775);
    // OH 式样例没有 start time 行:字段缺省,不影响识别。
    expect(parseRecorderRecords(OH_DUMP)[0].startedAtMs).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    const crlf = REAL_DUMP.replace(/\n/g, '\r\n');
    expect(parseRecorderRecords(crlf).map((r) => r.abilityRecordId)).toEqual([
      14945,
    ]);
  });

  it('does not confuse ID 27 with ID 274', () => {
    const dump27 = OH_DUMP.replace('ID: 274', 'ID: 27');
    const dump274 = OH_DUMP;
    expect(parseRecorderRecords(dump27)[0].abilityRecordId).toBe(27);
    expect(parseRecorderRecords(dump274)[0].abilityRecordId).toBe(274);
  });

  it('deduplicates repeated blocks with the same ID', () => {
    const dup = `${OH_DUMP}${OH_DUMP}`;
    expect(parseRecorderRecords(dup)).toHaveLength(1);
  });

  it('reports multiple distinct recorder records for the caller to reject', () => {
    const two = `${OH_DUMP}${OH_DUMP.replace('ID: 274', 'ID: 275')}`;
    expect(parseRecorderRecords(two)).toHaveLength(2);
  });

  it('fails a recorder block that lost its ID instead of dropping it', () => {
    const broken = OH_DUMP.replace(/ {4}AbilityRecord ID: 274.*\n/, '');
    expect(() => parseRecorderRecords(broken)).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });

  it('rejects hdc error text instead of treating it as an idle dump', () => {
    expect(() =>
      parseRecorderRecords('[Fail]ExecuteCommand need connect-key')
    ).toThrowError(expect.objectContaining({ code: 'DUMP_PARSE_FAILED' }));
    expect(() => parseRecorderRecords('error: device offline')).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });

  it('rejects an unknown non-empty envelope', () => {
    expect(() => parseRecorderRecords('some unexpected output')).toThrowError(
      expect.objectContaining({ code: 'DUMP_PARSE_FAILED' })
    );
  });
});

describe('classifyRecording', () => {
  it('idle without records', () => {
    expect(classifyRecording([], undefined).status).toBe('idle');
    expect(classifyRecording([], session(5))).toMatchObject({
      status: 'idle',
      session: session(5),
    });
  });

  it('recording when the active ID matches the session', () => {
    const records = parseRecorderRecords(REAL_DUMP);
    expect(classifyRecording(records, session(14945)).status).toBe('recording');
  });

  it('busy when the active ID differs from the session or none exists', () => {
    const records = parseRecorderRecords(REAL_DUMP);
    expect(classifyRecording(records, session(27)).status).toBe('busy');
    expect(classifyRecording(records, undefined).status).toBe('busy');
    expect(classifyRecording(records, session(27)).activeId).toBe(14945);
  });

  it('throws on ambiguous device state', () => {
    const two = parseRecorderRecords(
      `${OH_DUMP}${OH_DUMP.replace('ID: 274', 'ID: 275')}`
    );
    expect(() => classifyRecording(two, undefined)).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_DEVICE_STATE' })
    );
  });
});
