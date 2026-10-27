/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { inspectSources } from './source-gates.js';
import { gateDefinitions, type Gate, type ReleaseSelection } from './types.js';

function inspect(path: string, value: unknown) {
  const text = JSON.stringify(value);
  const gates = new Map<string, Gate>(gateDefinitions.map(([id, title], index) => [id, {
    id, number: index + 1, title, status: 'incomplete', scope: 'source', findings: [], missing: [],
  }]));
  inspectSources({ sources: [{ path, text, sha256: 'a'.repeat(64), size: text.length }],
    model: { modules: [{ name: 'entry' }] } } as ReleaseSelection, gates);
  return gates.get('release.probes')!;
}
const manifest = { schemaVersion: '1.0', profile: 'release-none', buildMode: 'release', inputHash: 'b'.repeat(64),
  entry: { path: 'entry/src/main/ets/OHMateRuntimeEntry.ets', sha256: 'c'.repeat(64) },
  probes: [], buildId: null, completeness: 'incomplete' };

it.each(['debug', 'test'])('rejects a selected generated %s Profile manifest', profile => {
  const gate = inspect('entry/ohmate-profile-manifest.json', {
    ...manifest, profile,
  });
  expect(gate.findings.map(item => item.code)).toContain('DEBUG_PROFILE_MANIFEST');
});

it('rejects compiled probe claims in a selected release Profile manifest', () => {
  const gate = inspect('entry/ohmate-profile-manifest.json', {
    ...manifest, profile: 'release-core', probes: [
      { id: 'p', kind: 'abckitts', module: 'entry', ruleHash: 'd'.repeat(64), runtimeGate: true },
    ],
  });
  expect(gate.findings.map(item => item.code)).toContain('RELEASE_DEBUG_PROBE_MANIFEST');
});

it('does not promote empty none manifests into compiler purity evidence', () => {
  const gate = inspect('entry/ohmate-profile-manifest.json', {
    ...manifest,
  });
  expect(gate.findings).toEqual([]);
  expect(gate.missing).toContain('entry/ohmate-profile-manifest.json:compiler-bound-profile-manifest');
});

it('keeps malformed Profile manifests a finding without crashing source inspection', () => {
  expect(inspect('entry/ohmate-profile-manifest.json', { profile: 'release-none' }).findings.map(item => item.code))
    .toContain('PROFILE_MANIFEST_INVALID');
});

it('does not interpret an ordinary business manifest as a debug probe manifest', () => {
  expect(inspect('entry/business-manifest.json', { profile: 'debug' }).findings).toEqual([]);
});

it.each(['runtime', 'debug', 'test', 'window'])('rejects actual single-package %s public imports in Release', entry => {
  const text = `import { API } from '@ohmate/ohmatekit/src/main/ets/api/${entry}';\n`;
  const gates = new Map<string, Gate>(gateDefinitions.map(([id, title], index) => [id, {
    id, number: index + 1, title, status: 'incomplete', scope: 'source', findings: [], missing: [],
  }]));
  inspectSources({ sources: [{ path: 'entry/src/main/ets/EntryAbility.ets', text, sha256: 'a'.repeat(64), size: text.length }],
    model: { modules: [{ name: 'entry' }] } } as ReleaseSelection, gates);
  expect(gates.get('release.kit-core')!.findings.map(item => item.code)).toContain('KIT_DEBUG_IMPORT');
});
