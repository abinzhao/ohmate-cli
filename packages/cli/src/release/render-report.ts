/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { digest } from '../quality/evidence.js';
import { escapeHtml } from '../scan/render-report.js';
import type { verifyRelease } from './release-gates.js';

export type ReleaseReport = Awaited<ReturnType<typeof verifyRelease>>;
export const releaseReportHash = (report: ReleaseReport) => digest(JSON.stringify(report, null, 2));
export function releaseSarif(report: ReleaseReport) {
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{
    tool: { driver: { name: 'OHMate Release', version: report.analyzerVersion,
      rules: report.gates.map(gate => ({ id: gate.id, name: gate.title })) } },
    properties: { reportHash: releaseReportHash(report), ready: report.ready, summary: report.summary,
      verification: report.verification, purityEvidence: report.purityEvidence },
    results: report.gates.flatMap(gate => [
      ...gate.findings.map(finding => ({ ruleId: gate.id, level: 'error', message: { text: finding.message },
        locations: finding.evidence.map(item => ({ physicalLocation: {
          artifactLocation: { uri: item.path.split('/').map(encodeURIComponent).join('/') },
          ...item.line === undefined ? {} : { region: { startLine: item.line } },
        }, properties: { sha256: item.sha256, entry: item.entry ?? null } })),
        properties: { code: finding.code, confidence: finding.confidence, status: gate.status } })),
      ...gate.missing.map(missing => ({ ruleId: gate.id, level: 'warning', message: { text: missing },
        properties: { status: 'incomplete', certification: 'unverified' } })),
    ]),
  }] };
}
export function releaseHtml(report: ReleaseReport): string {
  const rows = report.gates.map(gate => `<tr><td>${gate.number}</td><td>${escapeHtml(gate.title)}</td><td>${gate.status}</td><td>${
    gate.findings.map(finding => `${escapeHtml(finding.code)}: ${escapeHtml(finding.message)}<br>${
      finding.evidence.map(item => escapeHtml(`${item.path}${item.line === undefined ? '' : `:${item.line}`}${item.entry ? `#${item.entry}` : ''}`)).join('<br>')}`).join('<br>')
  }</td><td>${gate.missing.map(escapeHtml).join('<br>')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OHMate Release purity</title>
<style>body{font:16px system-ui;max-width:1200px;margin:40px auto;padding:0 20px;color:#17212b}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style>
<h1>OHMate Release purity</h1><p>${report.ready ? 'Ready' : 'Not ready'}. Static and package evidence; incomplete gates do not certify purity.</p>
<p>Report SHA256: ${releaseReportHash(report)}</p><pre>${escapeHtml(JSON.stringify(report.purityEvidence, null, 2))}</pre>
<table><thead><tr><th>#</th><th>Gate</th><th>Status</th><th>Findings and locations</th><th>Missing evidence</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
