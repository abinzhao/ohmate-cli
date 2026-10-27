/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { FingerGesture, FingerStep, FingerAction, GestureDsl, ExpandedGesture, Point } from './types.js';

const DEFAULT_SPEED = 600;
const MIN_MOVE_STEPS = 1;
const STEP_INTERVAL_MS = 16;

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Calculate interpolation steps based on speed and (optional) durationMs */
function moveSteps(from: Point, to: Point, speed: number, durationMs?: number): number {
  if (durationMs !== undefined && durationMs > 0) {
    return Math.max(MIN_MOVE_STEPS, Math.round(durationMs / STEP_INTERVAL_MS));
  }
  const d = dist(from, to);
  if (d <= 0 || speed <= 0) {
    return MIN_MOVE_STEPS;
  }
  const ms = (d / speed) * 1000;
  return Math.max(MIN_MOVE_STEPS, Math.round(ms / STEP_INTERVAL_MS));
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

interface FingerContext {
  cur: Point | null;
  pressed: boolean;
}

function holdSteps(steps: FingerStep[], cur: Point | null, pressed: boolean, n: number): void {
  if (cur === null) {
    throw new Error('wait/pressHold before first down, missing start coordinate');
  }
  for (let i = 0; i < n; i++) {
    steps.push({ pressed, x: cur.x, y: cur.y });
  }
}

function handleDown(steps: FingerStep[], action: Extract<FingerAction, { type: 'down' }>, ctx: FingerContext): void {
  if (ctx.pressed) {
    throw new Error('Duplicate down: finger already pressed');
  }
  const cur: Point = { x: action.x, y: action.y };
  ctx.cur = cur;
  ctx.pressed = true;
  steps.push({ pressed: ctx.pressed, x: cur.x, y: cur.y });
}

function handleMoveTo(steps: FingerStep[], action: Extract<FingerAction, { type: 'moveTo' }>, speed: number, ctx: FingerContext): void {
  if (ctx.cur === null) {
    throw new Error('moveTo before down');
  }
  const cur = ctx.cur;
  const to = { x: action.x, y: action.y };
  const n = moveSteps(cur, to, speed, action.durationMs);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    steps.push({ pressed: ctx.pressed, x: lerp(cur.x, to.x, t), y: lerp(cur.y, to.y, t) });
  }
  ctx.cur = to;
}

function handleMove(steps: FingerStep[], action: Extract<FingerAction, { type: 'move' }>, speed: number, ctx: FingerContext): void {
  if (ctx.cur === null) {
    throw new Error('move before down');
  }
  const cur = ctx.cur;
  const to: Point = { x: cur.x + action.dx, y: cur.y + action.dy };
  const n = moveSteps(cur, to, speed, action.durationMs);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    steps.push({ pressed: ctx.pressed, x: lerp(cur.x, to.x, t), y: lerp(cur.y, to.y, t) });
  }
  ctx.cur = to;
}

function handleWait(steps: FingerStep[], action: Extract<FingerAction, { type: 'wait' }>, ctx: FingerContext): void {
  holdSteps(steps, ctx.cur, ctx.pressed, Math.max(1, Math.round(action.durationMs / STEP_INTERVAL_MS)));
}

function handlePressHold(steps: FingerStep[], action: Extract<FingerAction, { type: 'pressHold' }>, ctx: FingerContext): void {
  if (!ctx.pressed) {
    throw new Error('pressHold before down');
  }
  holdSteps(steps, ctx.cur, ctx.pressed, Math.max(1, Math.round(action.durationMs / STEP_INTERVAL_MS)));
}

function handleUp(steps: FingerStep[], ctx: FingerContext): void {
  if (!ctx.pressed) {
    throw new Error('up before down');
  }
  ctx.pressed = false;
  const cur = ctx.cur;
  if (cur !== null) {
    steps.push({ pressed: ctx.pressed, x: cur.x, y: cur.y });
  }
}

/** Expand a single finger's action sequence into timeline sample points */
function expandFinger(gesture: FingerGesture, speed: number): FingerStep[] {
  const steps: FingerStep[] = [];
  const ctx: FingerContext = { cur: null, pressed: false };
  for (const action of gesture.actions) {
    switch (action.type) {
      case 'down': {
        handleDown(steps, action, ctx);
        break;
      }
      case 'moveTo': {
        handleMoveTo(steps, action, speed, ctx);
        break;
      }
      case 'move': {
        handleMove(steps, action, speed, ctx);
        break;
      }
      case 'wait': {
        handleWait(steps, action, ctx);
        break;
      }
      case 'pressHold': {
        handlePressHold(steps, action, ctx);
        break;
      }
      case 'up': {
        handleUp(steps, ctx);
        break;
      }
      default: {
        const _: never = action;
        throw new Error(`Unknown gesture action: ${JSON.stringify(_)}`);
      }
    }
  }
  return steps;
}

/** Expand DSL into multi-finger aligned sample point matrix */
export function expandGesture(dsl: GestureDsl): ExpandedGesture {
  if (!dsl.fingers.length) {
    throw new Error('Gesture requires at least one finger');
  }
  const speed = dsl.speed ?? DEFAULT_SPEED;
  const axes = dsl.fingers.map((g) => expandFinger(g, speed));
  const maxLen = Math.max(...axes.map((a) => a.length));
  const fingers: FingerStep[][] = axes.map((axis) => {
    if (axis.length === 0) {
      return [];
    }
    const last = axis[axis.length - 1];
    const padded = [...axis];
    while (padded.length < maxLen) {
      padded.push({ ...last });
    }
    return padded;
  });
  return { fingers, speed };
}
