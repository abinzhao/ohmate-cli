/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { BLANK_HAMMING } from './screen-phash.js';
import { SmokeStatus, type SmokeEvidence, type SmokeVerdict } from './types.js';

export class SmokeJudge {
  public judge(evidence: SmokeEvidence): SmokeVerdict {
    if (!evidence.processAlive) {
      return this.verdict(
        SmokeStatus.FAIL_CRASH,
        'Application process died after launch (possible crash).',
        evidence
      );
    }

    if (evidence.phashBlank === true) {
      return this.verdict(
        SmokeStatus.FAIL_BLANK,
        `Blank/solid screen after launch (hamming ${evidence.phashHamming} ≤ ${BLANK_HAMMING}, hash=${evidence.phash || '-'}).`,
        evidence
      );
    }

    // phashBlank === false → PASS; null (screenshot failed) → PASS with skip note
    const reason =
      evidence.phashBlank === null
        ? 'Process alive; screenshot unavailable, blank check skipped.'
        : 'Process alive; screenshot is not a solid blank screen.';
    return this.verdict(SmokeStatus.PASS, reason, evidence);
  }

  private verdict(
    status: SmokeStatus,
    reason: string,
    evidence: SmokeEvidence
  ): SmokeVerdict {
    return {
      status,
      reason,
      evidence,
      passed: status === SmokeStatus.PASS,
    };
  }
}
