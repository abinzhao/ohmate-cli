/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { RecordingSession } from './types.js';

/** 使用全部登记字段确认会话身份。 */
export function sameSession(
  a: RecordingSession | undefined,
  b: RecordingSession | undefined
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.fileName === b.fileName &&
    a.abilityRecordId === b.abilityRecordId &&
    a.startTime === b.startTime &&
    a.localPath === b.localPath
  );
}
