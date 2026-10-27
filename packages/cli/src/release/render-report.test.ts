/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { releaseHtml, releaseReportHash, releaseSarif, type ReleaseReport } from './render-report.js';

it('escapes finding locations and gaps and retains their hash and SARIF coordinates', () => {
  const source = '<script>alert("location")</script>&', sha256 = 'a'.repeat(64);
  const report: ReleaseReport = { schemaVersion: '1.0', analyzerVersion: '1.0', ready: false, verification: 'static-and-package-evidence',
    product: 'default', modules: ['entry@default'], inputs: [], excludedInputs: [], manifest: null, packages: [],
    native: [], sbom: { status: 'missing' }, symbolication: 'not-run', externalActions: [], scope: { root: '/private/fixture' },
    summary: { failed: 1, incomplete: 0, passed: 0 }, purityEvidence: {
      finalArtifacts: [], toolchain: { version: null, binding: 'manifest-declared-only' },
      coreOnlyBaseline: { status: 'unverified', missing: ['core-only'] },
    }, gates: [{ number: 1, id: 'release.probes', title: source, status: 'failed', scope: 'selected fixture', missing: [source],
      findings: [{ code: 'DEBUG_SENTINEL', message: source, confidence: 'observed', evidence: [
        { path: source, sha256, line: 7, entry: 'debug&<.abc' },
      ] }] }],
  };
  const html = releaseHtml(report), sarif = releaseSarif(report);
  expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  expect(html).toContain(releaseReportHash(report));
  expect(sarif.runs[0].properties.ready).toBe(false);
  expect(sarif.runs[0].results[0]).toMatchObject({ level: 'error', locations: [{
    physicalLocation: { artifactLocation: { uri: source.split('/').map(encodeURIComponent).join('/') }, region: { startLine: 7 } },
    properties: { sha256, entry: 'debug&<.abc' },
  }] });
  expect(sarif.runs[0].results[1]).toMatchObject({ level: 'warning', properties: { certification: 'unverified' } });
  expect(releaseReportHash(report)).toBe(releaseReportHash(structuredClone(report)));
});
