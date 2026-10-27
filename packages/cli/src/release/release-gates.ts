/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { resolve } from 'node:path';
import { z } from 'zod';
import { digest } from '../quality/evidence.js';
import { cycloneDx } from '../dependency/sbom.js';
import { assertPublicValue } from '../tasks/task-state.js';
import type { ExecutionContext } from '../runtime/types.js';
import { gateDefinitions, type Gate, type ReleaseSelection } from './types.js';
import { reachableNodes, readReleaseFile } from './release-inputs.js';
import { addFinding, inspectSources } from './source-gates.js';
import { readElf } from './elf.js';

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function dependencies(selection: ReleaseSelection, gates: Map<string, Gate>) {
  const reachable = reachableNodes(selection);
  for (const node of selection.dependencies.components.filter((n) => reachable.has(n.id))) {
    if (/(?:^|[/@_.-])(?:debug|mock|test|hypium|hypiumtest)(?:$|[/_.-])/i.test(node.name)) {
      const source = node.evidence[0] ?? { path: node.path, sha256: '' };
      addFinding(gates.get('release.dependencies')!, source, 'FORBIDDEN_RELEASE_DEPENDENCY', 'Production dependency closure reaches a debug, mock or test package', {}, 'inferred');
      if (/@ohmate\/(?:debug|desktop|test)-|ohmatekit\/(?:debug|bridge|mock)/i.test(node.name)) {
        addFinding(gates.get('release.kit-core')!, source, 'KIT_DEBUG_DEPENDENCY', 'Production closure reaches an explicit Kit debug package');
      }
    }
  }
  gates.get('release.dependencies')!.missing.push('configure-time-and-dynamic-production-closure');
  if (selection.dependencies.completeness !== 'complete') { gates.get('release.dependencies')!.missing.push('dependency-resolution'); }
}
function packagedMetadata(selection: ReleaseSelection, gates: Map<string, Gate>) {
  const gate = gates.get('release.build-mode')!, expected = selection.manifest?.value.buildMode;
  if (expected !== undefined && expected !== 'release') {
    addFinding(gate, selection.manifest!.file, 'NOT_RELEASE_BUILD', 'Build manifest records a non-release build mode');
  }
  if (!expected) { gate.missing.push('build-manifest-mode'); }
  if (!selection.packages.length) { gate.missing.push('packaged-module-metadata'); }
  for (const pkg of selection.packages) {
    if (!pkg.modules.length) { gate.missing.push(`${pkg.file.path}:module-metadata`); continue; }
    for (const metadata of pkg.modules) {
      const app = obj(metadata.app), module = obj(metadata.module);
      const debuggable = app.debug === true || app.debuggable === true || module.debuggable === true ? true :
        app.debug ?? app.debuggable ?? module.debuggable;
      if (debuggable === true) { addFinding(gate, pkg.file, 'DEBUGGABLE_PACKAGE', 'Packaged metadata enables debugging', { entry: 'module.json' }); }
      else if (debuggable !== false) { gate.missing.push(`${pkg.file.path}:debuggable-metadata`); }
      if (app.buildMode !== undefined && app.buildMode !== 'release') {
        addFinding(gate, pkg.file, 'PACKAGED_BUILD_MODE_MISMATCH', 'Packaged metadata records a non-release build mode', { entry: 'module.json' });
      }
      if (!selection.modules.some((m) => m.split('@')[0] === module.name)) { gate.missing.push(`${pkg.file.path}:module-identity`); }
    }
  }
}
function packageContent(selection: ReleaseSelection, gates: Map<string, Gate>) {
  const gate = gates.get('release.package-content')!;
  if (!selection.packages.length) { gate.missing.push('release-package'); }
  for (const pkg of selection.packages) {
    for (const entry of pkg.entries) {
      if (/source.?maps?|\.map$/i.test(entry.path)) { addFinding(gate, pkg.file, 'PACKAGED_SOURCEMAP', 'Package contains a SourceMap candidate', { entry: entry.path }); }
      if (entry.bytes === null) { addFinding(gate, pkg.file, 'PACKAGED_CERTIFICATE', 'Package contains a certificate or private-key filename; payload was not decoded', { entry: entry.path }); }
      if (entry.bytes && /(?:\/(?:Users|home|private\/tmp)\/|[A-Za-z]:\\(?:Users|workspace)\\)/.test(entry.bytes.toString('utf8'))) {
        addFinding(gate, pkg.file, 'PACKAGED_HOST_PATH', 'Package contains a host absolute path', { entry: entry.path });
      }
      if (/(?:^|[/_.-])(?:debug|mock|fixture|ohosTest)(?:$|[/_.-])/i.test(entry.path)) {
        addFinding(gates.get('release.entries')!, pkg.file, 'PACKAGED_DEBUG_ENTRY', 'Package contains a debug/test entry candidate', { entry: entry.path }, 'inferred');
      }
    }
  }
}
function nativeEvidence(selection: ReleaseSelection, gates: Map<string, Gate>) {
  const native = [], symbols = selection.symbols.filter((s) => /\.(?:so|debug)$/.test(s.path)).map((s) => ({ file: s, elf: readElf(s.bytes) }));
  for (const pkg of selection.packages) {
    for (const entry of pkg.entries.filter((e) => e.path.endsWith('.so') && e.bytes)) {
      const elf = readElf(entry.bytes!), source = pkg.file, detail = { entry: entry.path };
      native.push({ artifact: source.path, entry: entry.path, ...elf });
      if (!elf.stripped) { addFinding(gates.get('release.package-content')!, source, 'PACKAGED_NATIVE_DEBUG_SYMBOLS', 'ELF contains debug sections or a static symbol table', detail); }
      const abi = entry.path.match(/(?:^|\/)libs\/([^/]+)\//)?.[1];
      if (!elf.abi || abi !== elf.abi || elf.type !== 3) {
        addFinding(gates.get('release.native-abi')!, source, 'NATIVE_ABI_MISMATCH', 'Packaged Native ELF machine/type does not match its ABI directory', detail);
      }
      if (!elf.buildId) { gates.get('release.symbol-correlation')!.missing.push(`${entry.path}:gnu-buildId`); }
      else if (!symbols.some((s) => s.elf.buildId === elf.buildId && s.elf.machine === elf.machine && !s.elf.stripped)) {
        gates.get('release.symbol-correlation')!.missing.push(`${entry.path}:matched-unstripped-symbol-file`);
      }
    }
  }
  return native;
}
async function buildIdentity(selection: ReleaseSelection, gates: Map<string, Gate>, context: ExecutionContext) {
  const gate = gates.get('release.build-identity')!, manifest = selection.manifest;
  if (!manifest) { gate.missing.push('build-manifest'); return; }
  for (const source of manifest.value.inputs) {
    const current = await readReleaseFile(context, source.path).catch(() => null);
    if (current?.sha256 !== source.sha256) { addFinding(gate, manifest.file, 'BUILD_INPUT_DRIFT', 'A recorded build input is unavailable or changed', { entry: source.path }); }
  }
  if (manifest.value.sourceDrift?.length) { addFinding(gate, manifest.file, 'BUILD_SOURCE_DRIFT', 'Build producer recorded source changes during execution'); }
  const snapshot = obj(manifest.value.dependencies);
  if (snapshot.root === selection.model.root && Array.isArray(snapshot.inputs)) {
    const identity = (items: unknown[]) => digest(JSON.stringify(items.map((i) => ({ path: obj(i).path, sha256: obj(i).sha256 })).sort((a, b) => String(a.path).localeCompare(String(b.path)))));
    if (identity(snapshot.inputs) !== identity(selection.dependencies.inputs)) { addFinding(gate, manifest.file, 'BUILD_DEPENDENCY_DRIFT', 'Current dependency inputs differ from the recorded build snapshot'); }
  } else { gate.missing.push('producer-dependency-snapshot'); }
  if (manifest.value.completeness !== 'complete') { gate.missing.push('complete-build-input-closure'); }
  gate.missing.push('cloud-output-identity-or-producer-verified-inapplicability');
}
const sbomReference = z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.literal('cyclonedx'), scope: z.literal('dependency-inventory') });
async function verifySbom(selection: ReleaseSelection, gate: Gate, context: ExecutionContext) {
  const manifest = selection.manifest;
  gate.missing.push('production-sbom-closure');
  if (!manifest || manifest.value.sbom === undefined) {
    gate.missing.push('manifest-bound-sbom'); return { status: 'missing' as const };
  }
  const reference = sbomReference.safeParse(manifest.value.sbom);
  if (!reference.success) {
    addFinding(gate, manifest.file, 'BUILD_SBOM_UNAVAILABLE', 'Build SBOM reference is unsupported');
    return { status: 'failed' as const };
  }
  const file = await readReleaseFile(context, reference.data.path, true, 8 * 1024 * 1024).catch(() => null);
  if (!file) {
    addFinding(gate, manifest.file, 'BUILD_SBOM_UNAVAILABLE', 'Build SBOM is unavailable or outside its input boundary');
    return { status: 'failed' as const };
  }
  if (file.sha256 !== reference.data.sha256) {
    addFinding(gate, manifest.file, 'BUILD_SBOM_DRIFT', 'Build SBOM bytes differ from the manifest');
    return { status: 'failed' as const };
  }
  let document: Record<string, unknown>;
  try {
    document = obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)));
    assertPublicValue(document);
  } catch {
    addFinding(gate, manifest.file, 'BUILD_SBOM_UNAVAILABLE', 'Build SBOM is not bounded public JSON');
    return { status: 'failed' as const };
  }
  const expected = cycloneDx(selection.dependencies);
  // Only the creation timestamp varies; all inventory and declared coverage fields must match.
  const projection = (value: Record<string, unknown>) => ({ bomFormat: value.bomFormat, specVersion: value.specVersion,
    version: value.version, tools: obj(value.metadata).tools, components: value.components,
    dependencies: value.dependencies, properties: value.properties });
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ?
      Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (canonical(projection(document)) !== canonical(projection(expected))) {
    addFinding(gate, manifest.file, 'BUILD_SBOM_INVENTORY_MISMATCH', 'Build SBOM differs from the current dependency inventory');
    return { status: 'failed' as const };
  }
  return { status: 'verified-inventory' as const, path: file.path, sha256: file.sha256,
    format: reference.data.format, scope: reference.data.scope };
}
function missingProducers(selection: ReleaseSelection, gates: Map<string, Gate>) {
  const missing: Record<string, string[]> = {
    'release.entries': ['compiler-reachable-abilities-routes-and-resources'],
    'release.web-debug': ['compiled-debug-api-purity'],
    'release.arkguard': ['effective-consumer-rule-merge', 'build-bound-nameCache'],
    'release.permissions': ['compiler-permission-use', 'exported-component-review'],
    'release.sensitive-logs': ['compiled-sensitive-log-rules'],
    'release.symbol-correlation': ['producer-buildId', 'SourceMap-nameCache-native-symbol-association'],
    'release.native-abi': ['native-abi-matrix-or-producer-verified-inapplicability'],
    'release.kit-core': ['compiler-reachable-kit-core-only-or-verified-inapplicability'],
    'release.debug-writes': ['compiled-DOM-Console-Storage-debug-write-purity'],
    'release.probes': ['compiled-Aspect-AbcKitTS-and-debug-manifest-purity'],
  };
  for (const [id, requirements] of Object.entries(missing)) { gates.get(id)!.missing.push(...requirements); }
  if (!selection.manifest) { gates.get('release.symbol-correlation')!.missing.push('build-manifest'); }
}
export async function verifyRelease(selection: ReleaseSelection, context: ExecutionContext) {
  const gates = new Map<string, Gate>(gateDefinitions.map(([id, title], index) => [id, {
    id, number: index + 1, title, status: 'incomplete', scope: 'selected source evidence and explicit package bytes',
    findings: [], missing: [],
  }]));
  dependencies(selection, gates); inspectSources(selection, gates);
  packagedMetadata(selection, gates); packageContent(selection, gates);
  const native = nativeEvidence(selection, gates);
  await buildIdentity(selection, gates, context); missingProducers(selection, gates);
  const sbom = await verifySbom(selection, gates.get('release.build-identity')!, context);
  for (const gate of gates.values()) {
    gate.missing = [...new Set(gate.missing)];
    gate.status = gate.findings.length ? 'failed' : gate.missing.length ? 'incomplete' : 'passed';
  }
  const list = [...gates.values()], failed = list.filter((g) => g.status === 'failed').length;
  const incomplete = list.filter((g) => g.status === 'incomplete').length;
  const file = ({ path, sha256, size }: { path: string; sha256: string; size: number }) => ({ path, sha256, size });
  return { schemaVersion: '1.0', analyzerVersion: '1.0', ready: !failed && !incomplete,
    product: selection.product, modules: selection.modules, gates: list, summary: { failed, incomplete, passed: 14 - failed - incomplete },
    inputs: selection.sources.map(file), excludedInputs: selection.excluded,
    manifest: selection.manifest ? file(selection.manifest.file) : null,
    packages: selection.packages.map((p) => ({ ...file(p.file), entries: p.entries.map(({ path, sha256, size }) => ({ path, sha256, size })) })),
    purityEvidence: {
      finalArtifacts: selection.packages.map(p => file(p.file)),
      toolchain: { version: typeof obj(selection.manifest?.value.toolchain).version === 'string' ?
        obj(selection.manifest?.value.toolchain).version : null, binding: 'manifest-declared-only' },
      coreOnlyBaseline: { status: 'unverified', missing: ['compiler-bound-core-only-final-artifact-baseline'] },
    },
    native, sbom,
    verification: 'static-and-package-evidence', symbolication: 'not-run', externalActions: [], scope: { root: resolve(selection.model.root) } };
}
