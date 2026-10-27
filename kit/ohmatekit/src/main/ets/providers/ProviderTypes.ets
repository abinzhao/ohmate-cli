/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreResult, CoreSchema, CoreValue } from '../api/CoreTypes';

export interface ProviderDescriptor {
  id: string;
  schema: CoreSchema;
}
// An application-owned readonly Adapter. Registration cannot acquire native resources.
export interface SummaryProvider {
  read(): Promise<Record<string, Object>>;
  close(): Promise<boolean>;
}
export class ProviderReadResult extends CoreResult {
  fields: Record<string, CoreValue> = {};
  rejectedFields: number = 0;
  source: string = 'adapter-reported';
  verification: string = 'unverified';
}
export class ProviderStatus {
  id: string = '';
  eventName: string = '';
  state: string = 'registered';
  reads: number = 0;
  errors: number = 0;
  rejectedFields: number = 0;
  pending: boolean = false;
  source: string = 'adapter-reported';
  verification: string = 'unverified';
}
