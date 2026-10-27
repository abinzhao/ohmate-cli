/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../toolchain/index.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { SmokeFormatter } from './smoke-formatter.js';
import { SmokeInspector } from './smoke-inspector.js';
import { SmokeJudge } from './smoke-judge.js';
import type { SmokeExecuteContext } from './types.js';

export class SmokeVerifier {
  private readonly inspector: SmokeInspector;
  private readonly judge = new SmokeJudge();
  private readonly formatter = new SmokeFormatter();

  constructor(
    toolProvider: ToolProvider,
    projectRoot: string,
    hdcAdapter?: HdcAdapter
  ) {
    const hdc = hdcAdapter ?? new HdcAdapter(toolProvider);
    this.inspector = new SmokeInspector(toolProvider, hdc, projectRoot);
  }

  public async execute(ctx: SmokeExecuteContext): Promise<void> {
    const evidence = await this.inspector.collect(ctx);
    const verdict = this.judge.judge(evidence);
    if (verdict.passed) {
      // PASS keeps no screenshot, so .hvigor/ does not accumulate smoke-screenshot-*.png
      this.inspector.discardEvidence(evidence);
      console.log(this.formatter.formatPass(verdict));
      return;
    }
    // Verdict is final: mark the run ended (its failed evidence is retained
    // for the 24h read window and reclaimed by a later run — issue #453 race).
    this.inspector.finalizeRun();
    // Let run's catch print Error.message once (avoid duplicate stderr).
    throw this.formatter.toTraceError(verdict, ctx);
  }
}
