/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { readProject } from '../project-model/index.js';
import { patchPath } from '../workspace/path-guard.js';
import { digest, evidenceFile } from './evidence.js';
import { sourceTokens as tokens, type SourceToken as Token } from './source-tokens.js';
import { assertPublicValue } from '../tasks/task-state.js';
import type { ExecutionContext } from '../runtime/types.js';

const name = z.string().min(1).max(256).regex(/^[^,\r\n\0=]+$/);
export const testSchema = z.strictObject({
  kind: z.enum(['local', 'instrument']).default('local'),
  modules: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(64).optional(),
  files: z.array(z.string().min(1).max(1024)).min(1).max(128).optional(),
  scope: z.array(name).min(1).max(128).optional(),
  coverage: z.boolean().default(true), asan: z.boolean().default(false), buildOnly: z.boolean().default(false),
  device: z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(256).optional(),
});
function closing(list: Token[], begin: number): number {
  let depth = 0;
  for (let index = begin; index < list.length; index++) {
    if (list[index].text === '{') { depth++; }
    if (list[index].text === '}' && --depth === 0) { return index; }
  }
  throw new Error('Incomplete literal test block');
}
function declarations(list: Token[], suite?: string, suites: string[] = [], methods: string[] = []) {
  for (let index = 0; index < list.length; index++) {
    const call = list[index].text;
    if (!['describe', 'it'].includes(call) || list[index - 1]?.text === '.' || list[index + 1]?.text !== '(') { continue; }
    const literal = list[index + 2]?.literal;
    if (!literal || /[,#\r\n\0]/.test(literal)) { throw new Error('Test range contains an unsupported dynamic or ambiguous name'); }
    if (call === 'it') { if (suite) { methods.push(`${suite}#${literal}`); } continue; }
    const start = list.findIndex((item, position) => position > index + 2 && item.text === '{');
    if (start < 0) { throw new Error('Test suite callback cannot be resolved'); }
    const end = closing(list, start);
    suites.push(literal);
    declarations(list.slice(start + 1, end), literal, suites, methods);
    index = end;
  }
  if (new Set(suites).size !== suites.length || new Set(methods).size !== methods.length) { throw new Error('Duplicate literal test identity'); }
  return { suites, methods };
}
async function discoverTestFiles(modulePath: string, kind: 'local' | 'instrument', context: ExecutionContext) {
  const directory = kind === 'local' ? 'test' : 'ohosTest', files: string[] = [];
  const queue = [join(modulePath, directory), join(modulePath, 'src', directory)];
  let count = 0;
  while (queue.length) {
    context.abortSignal.throwIfAborted();
    const parent = queue.shift()!;
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') { return null; } throw error;
    });
    if (!stat) { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error('Test directory must be a regular directory'); }
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (++count > 1000) { throw new Error('Test discovery exceeds 1000 entries'); }
      const file = join(parent, entry.name);
      if (entry.isDirectory()) { queue.push(file); }
      else if (/\.test\.(?:ets|ts|js)$/.test(entry.name)) { files.push(file); }
    }
  }
  return files.sort();
}
async function readDeclarations(file: string, context: ExecutionContext) {
  const root = context.projectRoot ?? context.cwd, name = relative(root, file).split(sep).join('/');
  const safe = await patchPath(root, name, context.dataDir);
  const evidence = await evidenceFile(context.projectRoot ?? context.cwd, safe);
  if (evidence.size > 1024 * 1024) { throw new Error('Test source exceeds 1 MiB'); }
  const text = await readFile(safe, 'utf8');
  if (digest(text) !== evidence.sha256) { throw new Error('Test source changed during inference'); }
  assertPublicValue(text);
  return { file: safe, evidence, ...declarations(tokens(text)) };
}
export async function resolveTests(input: unknown, context: ExecutionContext) {
  const value = testSchema.parse(input), project = await readProject(context.projectRoot ?? context.cwd);
  if (value.kind === 'local' && value.asan) { throw new Error('Local Test does not support ASan'); }
  const modules = new Set(value.modules ?? (value.files ? [] : project.modules.map((item) => item.name)));
  const selectedFiles = new Set<string>();
  for (const path of value.files ?? []) {
    const file = await patchPath(project.root, path, context.dataDir);
    const owner = project.modules.find((item) => {
      const name = relative(item.path, file).split(sep).join('/');
      return value.kind === 'local' ? /^(?:src\/)?test\/.+\.test\.(?:ets|ts|js)$/.test(name) : /^(?:src\/)?ohosTest\/.+\.test\.(?:ets|ts|js)$/.test(name);
    });
    if (!owner || value.modules && !value.modules.includes(owner.name)) { throw new Error('Test file is outside the selected module/kind'); }
    selectedFiles.add(file); modules.add(owner.name);
  }
  if (!modules.size || [...modules].some((name) => !project.modules.some((item) => item.name === name))) { throw new Error('Unknown or empty test modules'); }
  const candidates = [];
  for (const module of [...modules].sort()) {
    const owner = project.modules.find((item) => item.name === module)!;
    const files = await discoverTestFiles(owner.path, value.kind, context), declarations = [];
    for (const file of files) { declarations.push(await readDeclarations(file, context)); }
    const names = declarations.flatMap((item) => item.suites);
    if (new Set(names).size !== names.length) { throw new Error('Suite identities are ambiguous across test files'); }
    const selected = declarations.filter((item) => !value.files || selectedFiles.has(item.file));
    if (value.files && selected.some((item) => !item.suites.length)) { throw new Error('No literal suite can be inferred from a selected file'); }
    const suites = selected.flatMap((item) => item.suites), methods = selected.flatMap((item) => item.methods);
    if (!methods.length && (value.kind === 'local' || value.buildOnly || value.files)) { throw new Error(`No literal test methods in selected module: ${module}`); }
    candidates.push({ module, suites, methods, declarations });
  }
  const suites = candidates.flatMap((item) => item.suites), methodCandidates = candidates.flatMap((item) => item.methods);
  const scope = [...new Set(value.scope ?? suites)];
  if (scope.some((name) => !suites.includes(name) && !methodCandidates.includes(name))) { throw new Error('Scope is not declared in selected tests'); }
  const selections = candidates.map((item) => ({ module: item.module,
    scope: scope.filter((name) => item.suites.includes(name) || item.methods.includes(name)),
    expectedCases: item.methods.filter((name) => scope.some((selected) => name === selected || name.startsWith(`${selected}#`))),
  }));
  if (selections.some((item) => !item.expectedCases.length) && (value.kind === 'local' || value.buildOnly || value.files)) { throw new Error('Scope omits a selected module'); }
  return { ...value, modules: [...modules].sort(), scope, methodCandidates: [...new Set(methodCandidates)],
    selections, inputs: candidates.flatMap((item) => item.declarations.map((source) => source.evidence)),
    execution: 'not-run' as const, inference: 'literal-candidates', project };
}
