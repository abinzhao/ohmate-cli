/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ScanFinding } from './codelinter-report.js';
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function scanSarif(findings: ScanFinding[], coverage: unknown) {
  const rules = [...new Set(findings.map((item) => item.ruleId))];
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{
    tool: { driver: { name: 'OHMate', version: '0.1.0', rules: rules.map((id) => ({ id })) } }, properties: { coverage },
    results: findings.map((finding) => ({ ruleId: finding.ruleId, level: finding.severity === 'info' ? 'note' : finding.severity,
      message: { text: finding.message }, locations: [{ physicalLocation: {
        artifactLocation: { uri: finding.file.split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' },
        region: { startLine: finding.line, startColumn: finding.column },
      } }], properties: { source: finding.source, confidence: finding.confidence, reportHash: finding.evidence.reportHash } })),
  }] };
}
export function scanHtml(findings: ScanFinding[], coverage: unknown): string {
  const rows = findings.map((item) => `<tr><td>${escapeHtml(item.file)}:${item.line}:${item.column}</td><td>${escapeHtml(item.ruleId)}</td><td>${escapeHtml(item.severity)}</td><td>${escapeHtml(item.message)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OHMate Scan</title>
<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#17212b}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style>
<h1>OHMate Scan</h1><p>Findings: ${findings.length}. Coverage describes executed producers and their limits.</p><pre>${escapeHtml(JSON.stringify(coverage, null, 2))}</pre>
<table><thead><tr><th>Location</th><th>Rule</th><th>Severity</th><th>Official message</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
