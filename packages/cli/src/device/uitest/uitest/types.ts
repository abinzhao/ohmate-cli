/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Text match pattern (consistent with device-side On/By selector, pass integer to daemon) */
export enum MatchPattern {
  Equals = 0,
  Contains = 1,
  StartsWith = 2,
  EndsWith = 3,
}

/** Text match condition */
export interface TextMatcher {
  value: string;
  pattern?: MatchPattern;
}

/**
 * Selector construction data (pure JSON, no remote On#N reference).
 * On object is constructed on the device side only when findComponent / component methods are called.
 */
export interface SelectorSpec {
  text?: TextMatcher;
  key?: string;
  id?: string;
  type?: string;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  /** Relative positioning: target is before the component matched by this selector */
  isBefore?: SelectorSpec;
  /** Relative positioning: target is after the component matched by this selector */
  isAfter?: SelectorSpec;
  /** Container nesting: target is within the container matched by this selector */
  within?: SelectorSpec;
}

/** Text match input: plain string (default EQUALS) or [value, match pattern] */
export type TextInput = string | [string, MatchPattern?];

/**
 * Relative positioning anchor (flat selector, does not allow further nesting of isBefore/isAfter).
 * Used for SelectorJson.isBefore / isAfter — satisfies the "relative positioning nesting only one level" constraint.
 */
export interface SelectorAnchorJson {
  text?: TextInput;
  key?: string;
  id?: string;
  type?: string;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
}

/**
 * Selector JSON input form (can be passed directly from outside, no fluent API needed).
 *
 * key = match attribute; value has three forms:
 *   1. Primitive type (string/boolean) → direct match value, text defaults to EQUALS
 *   2. Array [match value, match pattern?] → with match pattern (mainly for text)
 *   3. Object (only isBefore/isAfter) → relative positioning anchor, nesting only one level
 *
 * Examples:
 *   { text: 'Login', type: 'Button' }                          // Primitive type
 *   { text: ['Log', MatchPattern.Contains], clickable: true }  // Array with pattern
 *   { text: 'Target', isBefore: { text: 'Title' } }            // Relative positioning, one level nesting
 */
export interface SelectorJson {
  text?: TextInput;
  key?: string;
  id?: string;
  type?: string;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  /** Relative positioning: target is before the component matched by this anchor (anchor is flat, no further relative positioning nesting) */
  isBefore?: SelectorAnchorJson;
  /** Relative positioning: target is after the component matched by this anchor (anchor is flat, no further relative positioning nesting) */
  isAfter?: SelectorAnchorJson;
  /** Container nesting: target is within the container matched by this anchor (anchor is flat, no further relative positioning nesting) */
  within?: SelectorAnchorJson;
}

/** Window filter conditions (pure JSON) */
export interface WindowFilterSpec {
  title?: string | TextMatcher;
  bundleName?: string;
  active?: boolean;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Component property snapshot (pure data returned by getComponentInfo etc.) */
export interface ComponentInfo {
  id?: string;
  key?: string;
  text?: string;
  type?: string;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  bounds?: Rect;
  boundsCenter?: Point;
}

/** Window property snapshot */
export interface WindowInfo {
  title?: string;
  bundleName?: string;
  activate?: boolean;
  bounds?: Rect;
}

/**
 * Gesture DSL: describes each finger as an "action sequence", expanded by gesture-dsl into per-sample-points.
 * User only writes key points, no need to manually write each setPoint.
 */
export type FingerAction =
  | { type: 'down'; x: number; y: number }
  | { type: 'moveTo'; x: number; y: number; durationMs?: number }
  | { type: 'move'; dx: number; dy: number; durationMs?: number }
  | { type: 'up' }
  | { type: 'wait'; durationMs: number }
  | { type: 'pressHold'; durationMs: number };

export interface FingerGesture {
  actions: FingerAction[];
}

export interface GestureDsl {
  fingers: FingerGesture[];
  /** px/s, used for moveTo/move interpolation, default 600 */
  speed?: number;
}

/** A single sample point on the expanded single-finger timeline */
export interface FingerStep {
  /** Whether the finger is pressed at this step (false after up) */
  pressed: boolean;
  x: number;
  y: number;
}

/** Fully expanded gesture: one equal-length timeline per finger */
export interface ExpandedGesture {
  fingers: FingerStep[][];
  speed: number;
}
