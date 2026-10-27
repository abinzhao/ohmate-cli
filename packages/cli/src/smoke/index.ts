/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { SmokeVerifier } from './smoke-verifier.js';
import type { SmokeContext } from './types.js';

/** Post-launch cold-start gate; throws TraceError with FAIL_CRASH / FAIL_BLANK. */
export async function runPostLaunchSmoke(ctx: SmokeContext): Promise<void> {
  const verifier = new SmokeVerifier(
    ctx.toolProvider,
    ctx.projectRoot,
    ctx.hdcAdapter
  );
  await verifier.execute(ctx);
}

export type { SmokeContext } from './types.js';
