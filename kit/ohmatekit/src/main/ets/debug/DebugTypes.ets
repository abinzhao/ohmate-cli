/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// The application owns one current-window surface, including its exact listeners.
// No system window, network or resource is acquired by registration/import.
export interface DebugWindowHost {
  attach(): Promise<boolean>;
  openPanel(): Promise<boolean>;
  closePanel(): Promise<boolean>;
  showFloatingButton(): Promise<boolean>;
  hideFloatingButton(): Promise<boolean>;
  updateConfiguration?(): boolean;
  detach(): Promise<boolean>;
}
export class DebugWindowStatus {
  windowId: string = '';
  state: string = 'attaching';
  panel: string = 'closed';
  floating: string = 'hidden';
  pending: boolean = false;
  attempts: number = 0;
  source: string = 'adapter-reported';
  verification: string = 'unverified';
}
