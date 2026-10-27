/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';

export type ProtocolErrorCode =
  | 'INVALID_SCHEMA'
  | 'VERSION_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'CHANNEL_MISMATCH'
  | 'NO_READ_CAPABILITY'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_STATE'
  | 'EPOCH_MISMATCH'
  | 'EPOCH_REUSED'
  | 'RESUME_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'REPLAY_OUTSIDE_WINDOW'
  | 'MESSAGE_ID_CONFLICT'
  | 'SEQUENCE_CONFLICT'
  | 'CLOCK_REGRESSION';

export interface GapDetails {
  expected: number;
  received: number;
  missingFrom: number;
  missingThrough: number;
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    public readonly gap?: GapDetails
  ) {
    // Never include untrusted payloads, Zod input values, or credentials in errors.
    super(code);
    this.name = 'ProtocolError';
  }
}

export function parseProtocol<T extends z.ZodType>(
  schema: T,
  input: unknown
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ProtocolError('INVALID_SCHEMA');
  }
  return result.data;
}
