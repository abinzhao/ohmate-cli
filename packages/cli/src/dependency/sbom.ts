/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { sha256 } from '../agent/context-files.js';
import type { DependencyComponent, DependencyGraph } from './types.js';

function checksum(node: DependencyComponent) {
  if (node.origin === 'binary') {
    const hash = node.evidence.find((item) => item.path === node.path)?.sha256;
    if (hash && /^[a-f0-9]{64}$/.test(hash)) { return { algorithm: 'SHA-256', value: hash }; }
    return undefined;
  }
  const match = node.integrity?.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) { return undefined; }
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length === Number(match[1].slice(3)) / 8 ? { algorithm: match[1].toUpperCase().replace('SHA', 'SHA-'), value: bytes.toString('hex') } : undefined;
}
function purl(node: DependencyComponent) {
  if (node.kind !== 'package' || !node.version) { return undefined; }
  const name = node.name.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `pkg:${node.ecosystem}/${name}@${encodeURIComponent(node.version)}`;
}
export function cycloneDx(graph: DependencyGraph) {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: 'application', name: 'OHMate CLI dependency analyzer', version: graph.analyzerVersion }] } },
    components: graph.components.map((node) => {
      const hash = checksum(node);
      return { type: 'library', 'bom-ref': node.id, name: node.name, ...(node.version ? { version: node.version } : {}),
        ...(purl(node) ? { purl: purl(node) } : {}),
        ...(node.license ? { licenses: [{ license: { name: node.license } }] } : {}),
        ...(hash ? { hashes: [{ alg: hash.algorithm, content: hash.value }] } : {}),
        properties: [{ name: 'ohmate:ecosystem', value: node.ecosystem }, { name: 'ohmate:origin', value: node.origin },
          { name: 'ohmate:input-path', value: node.path }, { name: 'ohmate:input-sha256', value: node.evidence[0]?.sha256 ?? '' },
          { name: 'ohmate:version-source', value: node.versionSource ?? node.origin },
          ...(node.binary ? [{ name: 'ohmate:native-binary', value: JSON.stringify(node.binary) },
            { name: 'ohmate:native-abi-validation', value: 'not-run' }, { name: 'ohmate:artifact-authentication', value: 'unverified' }] : []),
          ...(node.declaredVersion !== undefined ? [{ name: 'ohmate:declared-version', value: node.declaredVersion ?? 'unknown' }] : [])] };
    }),
    dependencies: graph.components.map((node) => ({ ref: node.id,
      dependsOn: [...new Set(graph.relationships.filter((edge) => edge.from === node.id).map((edge) => edge.to))].sort() })),
    properties: [{ name: 'ohmate:completeness', value: graph.completeness }, { name: 'ohmate:vulnerability-scan', value: 'not-run' },
      ...(graph.project ? [{ name: 'ohmate:project-kind', value: graph.project.kind },
        { name: 'ohmate:project-facets', value: graph.project.facets.join(',') },
        { name: 'ohmate:project-evidence', value: JSON.stringify(graph.project.facetEvidence) }] : [])],
  };
}
const knownLicenses = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'CC0-1.0', 'Unlicense', 'GPL-2.0-only', 'GPL-3.0-only', 'LGPL-2.1-only', 'LGPL-3.0-only', 'AGPL-3.0-only']);
function spdxId(node: DependencyComponent) { return `SPDXRef-${sha256(node.id).slice(0, 32)}`; }
export function spdx(graph: DependencyGraph) {
  const identity = sha256(JSON.stringify({ inputs: graph.inputs, components: graph.components, relationships: graph.relationships }));
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: 'OHMate dependency inventory', documentNamespace: `https://ohmate.local/spdx/${identity}`,
    creationInfo: { creators: ['Tool: OHMate-CLI-0.1.0'], created: new Date().toISOString() },
    packages: graph.components.map((node) => {
      const hash = checksum(node), license = node.license && knownLicenses.has(node.license) ? node.license : 'NOASSERTION';
      return { SPDXID: spdxId(node), name: node.name, ...(node.version ? { versionInfo: node.version } : {}),
        downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION',
        licenseDeclared: license, copyrightText: 'NOASSERTION',
        ...(hash ? { checksums: [{ algorithm: hash.algorithm.replace('-', ''), checksumValue: hash.value }] } : {}),
        comment: `ecosystem=${node.ecosystem}; origin=${node.origin}; input=${node.path}; hash=${node.evidence[0]?.sha256 ?? ''}` +
          (node.binary ? `; nativeBinary=${JSON.stringify(node.binary)}; nativeAbi=not-run; artifactAuthentication=unverified` : '') };
    }),
    relationships: [
      ...graph.components.map((node) => ({ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: spdxId(node), relationshipType: 'DESCRIBES' })),
      ...graph.relationships.map((edge) => ({ spdxElementId: spdxId(graph.components.find((node) => node.id === edge.from)!),
        relatedSpdxElement: spdxId(graph.components.find((node) => node.id === edge.to)!), relationshipType: 'DEPENDS_ON', comment: `kind=${edge.kind}; scope=${edge.scope}` })),
    ],
    documentComment: `completeness=${graph.completeness}; licenseValidation=not-run; vulnerabilityScan=not-run; nativeAbi=not-run` +
      (graph.project ? `; projectKind=${graph.project.kind}; facets=${graph.project.facets.join(',')}; projectEvidence=${JSON.stringify(graph.project.facetEvidence)}` : ''),
  };
}
