/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { posix } from 'node:path';
import { publicPath } from '../workspace/path-guard.js';
import { componentId } from './package-graph.js';
import { evidence, finding } from './types.js';
import type { DependencyComponent, DependencyGraph, PackageManifest, SourceFile } from './types.js';
import type { DependencyResolution } from './ohpm-lock.js';

function withoutComments(text: string) {
  return text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, quoted: string | undefined) => quoted ?? match.replace(/[^\n]/g, ' '));
}
function line(text: string, offset: number) { return text.slice(0, offset).split('\n').length; }
function cmakeTokenEnd(text: string, start: number): number {
  const comment = text[start] === '#', offset = start + (comment ? 1 : 0);
  const bracketPattern = /\[(=*)\[/y;
  bracketPattern.lastIndex = offset;
  const bracket = text[offset] === '[' ? bracketPattern.exec(text) : null;
  if (bracket) {
    const end = text.indexOf(`]${bracket[1]}]`, offset + bracket[0].length);
    return end < 0 ? text.length : end + bracket[1].length + 2;
  }
  if (comment) { const end = text.indexOf('\n', start); return end < 0 ? text.length : end; }
  if (text[start] === '"') {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === '\\') { index++; }
      else if (text[index] === '"') { return index + 1; }
    }
    return text.length;
  }
  return start;
}
function cmakeBody(text: string, start: number) {
  let depth = 1, body = '';
  for (let index = start; index < text.length; index++) {
    const tokenEnd = cmakeTokenEnd(text, index);
    if (tokenEnd > index) {
      body += text[index] === '#' ? ' ' : text.slice(index, tokenEnd);
      index = tokenEnd - 1; continue;
    }
    if (text[index] === '(') { depth++; }
    if (text[index] === ')' && --depth === 0) { return { body, end: index + 1, closed: true }; }
    body += text[index];
  }
  return { body, end: text.length, closed: false };
}
export function cmakeCommands(file: SourceFile) {
  const text = file.text, commands: { name: string; args: string[]; line: number; dynamic: boolean }[] = [];
  const word = /[a-z_]\w*/iy;
  let previous = 0, currentLine = 1;
  for (let index = 0; index < text.length;) {
    if (commands.length >= 2_000) { commands.push({ name: 'unparsed', args: [], line: currentLine, dynamic: true }); break; }
    const tokenEnd = cmakeTokenEnd(text, index);
    if (tokenEnd > index) { index = tokenEnd; continue; }
    word.lastIndex = index;
    const match = word.exec(text);
    if (!match) { index++; continue; }
    let open = word.lastIndex;
    while (/\s/.test(text[open] ?? '') && open < text.length) { open++; }
    if (text[open] !== '(') { index = open; continue; }
    currentLine += text.slice(previous, index).split('\n').length - 1; previous = index;
    const body = cmakeBody(text, open + 1);
    commands.push({ name: match[0].toLowerCase(),
      args: body.body.match(/"(?:\\.|[^"\\])*"|[^\s]+/g)?.map((item) => item.replace(/^"|"$/g, '')) ?? [],
      line: currentLine, dynamic: !body.closed || /[$;\\]|\[=*\[/.test(body.body) });
    index = body.end;
  }
  return commands;
}
function nativeNode(graph: DependencyGraph, file: SourceFile, name: string, kind: 'target' | 'library') {
  const node: DependencyComponent = { id: componentId('native', file.path, name), name, version: null, ecosystem: 'native',
    kind, origin: 'cmake', path: file.path, evidence: [evidence(file)] };
  if (!graph.components.some((item) => item.id === node.id)) { graph.components.push(node); }
  return node;
}
export function nativeImportedLocations(commands: ReturnType<typeof cmakeCommands>, target: string) {
  const locations: { path: string; line: number }[] = [];
  for (const command of commands.filter((item) => item.name === 'set_target_properties' && !item.dynamic)) {
    const properties = command.args.indexOf('PROPERTIES');
    if (properties < 0 || !command.args.slice(0, properties).includes(target)) { continue; }
    for (let index = properties + 1; index + 1 < command.args.length; index += 2) {
      if (command.args[index] === 'IMPORTED_LOCATION') { locations.push({ path: command.args[index + 1], line: command.line }); }
    }
  }
  return locations;
}
function unresolvedConfiguration(command: ReturnType<typeof cmakeCommands>[number]) {
  return command.dynamic || ['include', 'find_package', 'add_subdirectory', 'if', 'foreach', 'while', 'function', 'macro', 'set_property'].includes(command.name) ||
    (command.name === 'target_link_libraries' && command.args.some((item) => ['debug', 'optimized'].includes(item)));
}
function localLibrary(file: SourceFile, name: string, files: SourceFile[]) {
  if (!name || name.startsWith('/') || /[\\:$;]/.test(name)) { return undefined; }
  const path = posix.normalize(posix.join(posix.dirname(file.path), name));
  try { publicPath(path); } catch { return undefined; }
  return files.find((item) => item.path === path && item.binary && item.bytes! > 0);
}
function binaryNode(graph: DependencyGraph, file: SourceFile) {
  const id = componentId('native', file.path, 'binary'), existing = graph.components.find((node) => node.id === id);
  if (existing) { return existing; }
  const node: DependencyComponent = { id, name: posix.basename(file.path), version: null, ecosystem: 'native',
    kind: 'library', origin: 'binary', path: file.path, binary: file.nativeBinary, evidence: [evidence(file)] };
  graph.components.push(node);
  if (file.nativeBinary?.archive?.status === 'complete') { return node; }
  if (!file.nativeBinary?.elf) {
    finding(graph, file, file.nativeBinary?.archive ? 'NATIVE_ARCHIVE_MEMBERS_UNINSPECTED' : 'NATIVE_BINARY_METADATA_UNAVAILABLE',
      'Native bytes are hashed; ELF metadata or bounded archive member evidence remains incomplete', true, 'info');
  } else if (!file.nativeBinary.elf.abiHint) {
    finding(graph, file, 'NATIVE_ELF_MACHINE_UNRECOGNIZED', 'Observed ELF machine has no supported ABI hint; path names do not establish ABI', true, 'info');
  }
  return node;
}
function binaryLink(graph: DependencyGraph, from: DependencyComponent, binary: SourceFile, declaration: SourceFile, line: number) {
  const to = binaryNode(graph, binary), proof = [evidence(declaration, line), evidence(binary)];
  const existing = graph.relationships.find((edge) => edge.from === from.id && edge.to === to.id && edge.kind === 'links');
  if (existing) {
    for (const item of proof) {
      if (!existing.evidence.some((entry) => entry.path === item.path && entry.line === item.line)) { existing.evidence.push(item); }
    }
  } else { graph.relationships.push({ from: from.id, to: to.id, kind: 'links', scope: 'unknown', evidence: proof }); }
}
function addImportedBinaries(file: SourceFile, files: SourceFile[], graph: DependencyGraph, targets: Map<string, DependencyComponent[]>) {
  const commands = cmakeCommands(file);
  if (commands.some(unresolvedConfiguration)) { return; }
  for (const command of commands.filter((item) => item.name === 'add_library' && !item.dynamic && item.args.includes('IMPORTED'))) {
    const from = targets.get(command.args[0]);
    if (from?.length !== 1) { continue; }
    const locations = nativeImportedLocations(commands, command.args[0]);
    if (new Set(locations.map((item) => item.path)).size > 1) {
      finding(graph, file, 'NATIVE_IMPORTED_LOCATION_AMBIGUOUS', 'Multiple literal imported locations require official final configuration', true, 'info'); continue;
    }
    const location = locations[0], binary = location && localLibrary(file, location.path, files);
    if (!binary) {
      finding(graph, file, 'NATIVE_IMPORTED_LOCATION_UNRESOLVED', 'Imported target has no unique safe nonempty local binary at its literal location', true, 'info'); continue;
    }
    binaryLink(graph, from[0], binary, file, location.line);
  }
}
export function addNative(files: SourceFile[], graph: DependencyGraph) {
  const cmake = files.filter((file) => file.path.endsWith('CMakeLists.txt') || file.path.endsWith('.cmake'));
  const targets = new Map<string, DependencyComponent[]>();
  for (const file of cmake) {
    for (const command of cmakeCommands(file)) {
      if (unresolvedConfiguration(command)) {
        finding(graph, file, 'CMAKE_DYNAMIC_UNRESOLVED', 'CMake variables, includes and configure-time discovery require official configuration', true, 'info'); continue;
      }
      if (!['add_library', 'add_executable'].includes(command.name) || !command.args[0]) { continue; }
      const target = nativeNode(graph, file, command.args[0], 'target');
      targets.set(target.name, [...targets.get(target.name) ?? [], target]);
    }
  }
  for (const [name, nodes] of targets) {
    if (nodes.length > 1) { finding(graph, cmake[0], 'NATIVE_TARGET_CONFLICT', `Multiple literal CMake declarations use target ${name}`); }
  }
  for (const file of cmake) {
    addImportedBinaries(file, files, graph, targets);
    addNativeLinks(file, files, graph, targets);
  }
}
function addNativeLinks(file: SourceFile, files: SourceFile[], graph: DependencyGraph, targets: Map<string, DependencyComponent[]>) {
  const commands = cmakeCommands(file);
  const unresolved = commands.some(unresolvedConfiguration);
  for (const command of commands.filter((item) => !item.dynamic && item.name === 'target_link_libraries')) {
    const owners = targets.get(command.args[0]);
    const from = owners?.find((node) => node.path === file.path) ?? (owners?.length === 1 ? owners[0] : undefined);
    if (!from) { finding(graph, file, 'CMAKE_LINK_TARGET_UNRESOLVED', 'CMake link owner cannot be resolved', true, 'info'); continue; }
    for (const name of command.args.slice(1).filter((item) => !['PUBLIC', 'PRIVATE', 'INTERFACE', 'debug', 'optimized', 'general'].includes(item))) {
      const available = /\.(?:a|so(?:\.\d+)*)$/.test(name) && localLibrary(file, name, files);
      if ((name.includes('/') && /\.(?:a|so(?:\.\d+)*)$/.test(name)) || available) {
        const binary = !unresolved && available;
        if (binary) { binaryLink(graph, from, binary, file, command.line); }
        else { finding(graph, file, 'NATIVE_LINK_BINARY_UNRESOLVED', 'Literal link path has no safe nonempty local binary or requires configuration', true, 'info'); }
        continue;
      }
      const candidates = targets.get(name);
      if (candidates && candidates.length !== 1) { continue; }
      const to = candidates?.[0] ?? nativeNode(graph, file, name, 'library');
      graph.relationships.push({ from: from.id, to: to.id, kind: 'links', scope: 'unknown', evidence: [evidence(file, command.line)] });
    }
  }
}
function ownerOf(file: SourceFile, owners: PackageManifest[]) {
  return owners.filter((owner) => owner.directory === '.' || file.path.startsWith(`${owner.directory}/`))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}
function packageRoot(spec: string) { return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]; }
export function addImports(files: SourceFile[], owners: PackageManifest[], graph: DependencyGraph, resolutions: DependencyResolution) {
  for (const file of files.filter((item) => /\.(?:ets|ts|js|mjs|cjs)$/.test(item.path))) {
    const owner = ownerOf(file, owners);
    if (!owner) { continue; }
    const text = withoutComments(file.text);
    for (const match of text.matchAll(/\b(?:from\s*|import\s*|(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1], imported = packageRoot(spec), source = evidence(file, line(text, match.index));
      if (/^lib.+\.so$/.test(spec)) {
        const name = spec.slice(3, -3), target = graph.components.filter((node) => node.ecosystem === 'native' && node.kind === 'target' && node.name === name);
        if (target.length === 1) { graph.relationships.push({ from: owner.node.id, to: target[0].id, kind: 'native-bridge', scope: 'production', evidence: [source] }); }
        else { finding(graph, file, 'NATIVE_BRIDGE_UNRESOLVED', 'Literal native import has no unambiguous CMake target', true, 'info'); }
        continue;
      }
      const target = resolutions.get(owner.node.id)?.get(imported);
      if (!target) { continue; }
      graph.relationships.push({ from: owner.node.id, to: target.id, kind: 'imports', scope: 'unknown', evidence: [source] });
      if (spec !== imported) {
        graph.findings.push({ code: 'DEEP_IMPORT', severity: 'warning', confidence: 'inferred', message: `Literal import enters ${imported} below its public package root`, evidence: [source], components: [target.id] });
      }
    }
  }
}
