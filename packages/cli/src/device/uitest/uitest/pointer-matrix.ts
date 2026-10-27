/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { expandGesture } from './gesture-dsl.js';
import { RemoteRefSession } from './remote-ref.js';
import { GestureDsl } from './types.js';

/** Seed thisRef for creating remote PointerMatrix */
export const POINTER_SEED = 'PointerMatrix#seed';

/**
 * Build remote PointerMatrix within a controlled session, returns {ref, speed}.
 * ref is tracked by session, auto-cleaned on exit.
 */
export async function buildRemotePointerMatrix(
  session: RemoteRefSession,
  dsl: GestureDsl,
): Promise<{ ref: string; speed: number }> {
  const { fingers, speed } = expandGesture(dsl);
  if (fingers.length === 0) {
    throw new Error('Empty gesture');
  }
  const steps = fingers[0].length;
  const ref = await session.create('PointerMatrix.create', [fingers.length, steps], POINTER_SEED);
  for (let f = 0; f < fingers.length; f++) {
    for (let st = 0; st < steps; st++) {
      const p = fingers[f][st];
      await session.call('PointerMatrix.setPoint', ref, [f, st, { x: p.x, y: p.y }]);
    }
  }
  return { ref, speed };
}