/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type * as TS from 'typescript';
import { z } from 'zod';
import { evidenceFile } from '../quality/evidence.js';
import { readEvidenceText, type SourceScope } from '../quality/source-scope.js';
import type { ExecutionContext } from '../runtime/types.js';
import { compilerHost, compilerInputs } from './compiler-inputs.js';

export interface PublicSymbol {
  file: string; name: string; declarationFile: string; declarationName: string; signatures: string[];
  anonymousText?: string; anonymousSignature?: string;
  members: { name: string; signatures: string[] }[];
}
const loaded = new Map<string, { hash: string; ts: typeof TS }>();
async function officialCompiler(sdk: string) {
  const root = join(sdk, 'default/openharmony/ets/build-tools/ets-loader/node_modules/typescript');
  const metadata = await readEvidenceText(sdk, join(root, 'package.json'));
  const value = z.object({ name: z.string(), version: z.string() }).parse(JSON.parse(metadata.text));
  const file = join(root, 'lib/typescript.js'), script = await evidenceFile(sdk, file), prior = loaded.get(file);
  if (prior && prior.hash !== script.sha256) { throw new Error('Loaded SDK compiler changed; restart before public API analysis'); }
  const ts = prior?.ts ?? createRequire(import.meta.url)(file) as typeof TS;
  if (typeof ts.createProgram !== 'function' || typeof ts.resolveModuleName !== 'function') { throw new Error('SDK compiler does not expose the required public APIs'); }
  loaded.set(file, { hash: script.sha256, ts });
  return { ts, evidence: { packageName: value.name, packageVersion: value.version, frontendVersion: ts.version, metadata: metadata.evidence, script } };
}
function signatures(ts: typeof TS, checker: TS.TypeChecker, symbol: TS.Symbol, node: TS.Node, name: string) {
  return checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, node), ts.SignatureKind.Call)
    .map((signature) => `${name}${checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation)}`);
}
function publicMembers(ts: typeof TS, checker: TS.TypeChecker, target: TS.Symbol, declaration: TS.Declaration) {
  if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) { return []; }
  const members = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target));
  return members.flatMap((member) => {
    const own = member.getDeclarations()?.filter((node) => node.parent === declaration) ?? [];
    if (!own.length || own.some((node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) || member.name.startsWith('#')) { return []; }
    return [{ name: member.name, signatures: signatures(ts, checker, member, own[0], member.name) }];
  });
}
function publicSymbol(ts: typeof TS, checker: TS.TypeChecker, symbol: TS.Symbol, file: string, scope: SourceScope): PublicSymbol {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = target.getDeclarations() ?? [], declaration = declarations[0];
  if (!declaration || ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration)) { throw new Error(`Cannot resolve public declaration ${symbol.name}`); }
  const origin = relative(scope.project.root, declaration.getSourceFile().fileName).split(sep).join('/');
  if (!scope.inputs.files.some((item) => item.path === origin) || !scope.project.modules.some((module) =>
    /^src\/.+\.(?:ets|ts)$/.test(relative(module.path, join(scope.project.root, origin)).split(sep).join('/')))) {
    throw new Error(`Public declaration ${symbol.name} requires an unrecorded or external documentation source`);
  }
  if (declarations.some((node) => node.getSourceFile() !== declaration.getSourceFile())) { throw new Error(`Merged public declaration ${symbol.name} requires a dedicated documentation merge`); }
  const named = (declaration as TS.NamedDeclaration).name;
  return { file, name: symbol.name, declarationFile: origin, declarationName: named && ts.isIdentifier(named) ? named.text : target.name,
    ...(!named && (ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) ?
      { anonymousText: declaration.getText(), anonymousSignature: `${ts.isClassDeclaration(declaration) ? 'class' : 'function'} default` } : {}),
    signatures: signatures(ts, checker, target, declaration, symbol.name), members: publicMembers(ts, checker, target, declaration) };
}
function fileExports(ts: typeof TS, checker: TS.TypeChecker, program: TS.Program, file: string, scope: SourceScope) {
  const source = program.getSourceFile(join(scope.project.root, file));
  if (!source) { throw new Error('Compiler omitted a selected source'); }
  const module = checker.getSymbolAtLocation(source);
  return module ? checker.getExportsOfModule(module).map((symbol) => publicSymbol(ts, checker, symbol, file, scope)) : [];
}
export async function resolvePublicApi(scope: SourceScope, sdk: string, context: ExecutionContext) {
  const compiler = await officialCompiler(sdk), { ts } = compiler, input = compilerInputs(scope.project.root, context);
  const options: TS.CompilerOptions = { noEmit: true, noLib: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, allowNonTsExtensions: true };
  const adapter = compilerHost(ts, options, scope.project.root, input), exports: PublicSymbol[] = [];
  let failure: string | null = null, sourceFiles: string[] = [], diagnostics: { code: number; file: string | null; message: string }[] = [];
  try {
    const program = ts.createProgram(scope.files.map((file) => join(scope.project.root, file)), options, adapter.host), checker = program.getTypeChecker();
    sourceFiles = program.getSourceFiles().map((file) => relative(scope.project.root, file.fileName).split(sep).join('/')).sort();
    const syntax = program.getSyntacticDiagnostics();
    diagnostics = [...syntax, ...program.getSemanticDiagnostics()].map((item) => ({
      code: item.code, file: item.file ? relative(scope.project.root, item.file.fileName).split(sep).join('/') : null,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
    }));
    if (syntax.length || adapter.resolutions.some((item) => !item.resolved) ||
      diagnostics.some((item) => [2300, 2305, 2306, 2308, 2459, 2724].includes(item.code))) { throw new Error('Cannot resolve the selected public export program; consult compiler diagnostics'); }
    for (const file of scope.files) {
      const symbols = fileExports(ts, checker, program, file, scope);
      if (exports.length + symbols.length > 10_000) { throw new Error('Public export program exceeds the symbol budget'); }
      exports.push(...symbols);
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const verify = async () => {
    const drift = await input.verify();
    for (const entry of [compiler.evidence.metadata, compiler.evidence.script]) {
      const current = await evidenceFile(sdk, join(sdk, entry.path)).catch(() => null);
      if (current?.sha256 !== entry.sha256) { drift.push(`sdk/${entry.path}`); }
    }
    return drift.sort();
  };
  return { exports, verify, evidence: { schemaVersion: '1.0', compiler: compiler.evidence,
    completeness: 'public-export-program', buildInputClosure: 'not-established', options, sourceFiles, diagnostics,
    reads: [...input.reads.values()].sort((a, b) => a.path.localeCompare(b.path)), resolutions: adapter.resolutions, exports, failure } };
}
