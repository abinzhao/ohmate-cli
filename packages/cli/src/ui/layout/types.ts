/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface ArkUiNode {
  id?: string;
  type?: string;
  text?: string;
  bounds?: [number, number, number, number];
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  hitTestBehavior?: string;
  children: ArkUiNode[];
}

export interface RawDumpAttributes {
  id?: string;
  key?: string;
  type?: string;
  text?: string;
  originalText?: string;
  bounds?: string;
  opacity?: string;
  clickable?: string;
  enabled?: string;
  focused?: string;
  scrollable?: string;
  checkable?: string;
  checked?: string;
  selected?: string;
  longClickable?: string;
  backgroundColor?: string;
  zIndex?: string;
  clip?: string;
  description?: string;
  accessibilityLevel?: string;
  hitTestBehavior?: string;
  visible?: string;
  [key: string]: unknown;
}

export interface RawDumpNode {
  attributes?: RawDumpAttributes;
  children?: RawDumpNode[];
  [key: string]: unknown;
}
