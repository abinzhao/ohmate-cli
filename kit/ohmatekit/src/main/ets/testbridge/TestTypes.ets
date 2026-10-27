/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreResult } from '../api/CoreTypes';

// Assertions observe existing application state. They must not perform an action.
export interface TestObservationAdapter {
  ready(): Promise<boolean>;
  assert(id: string): Promise<boolean>;
  close(): Promise<boolean>;
}
export class TestBridgeResult extends CoreResult {
  event: string = '';
  assertionId: string = '';
  passed: boolean = false;
  source: string = 'adapter-reported';
  verification: string = 'unverified';
  buildVerification: string = 'unverified-build';
  execution: string = 'manual-only';
  automation: string = 'unavailable';
}
