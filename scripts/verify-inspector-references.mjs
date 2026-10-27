/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { ToolProvider } from '../packages/cli/src/toolchain/tool-provider.ts';
import { inspectorCatalog } from '../packages/cli/src/debug/inspector-catalog.ts';

const provider = await ToolProvider.new(), sdkRoot = await realpath(provider.sdkPath);
const output = resolve(process.argv[2] ?? 'artifacts/validation/m2-inspector-sdk-references.json');
const negative = process.argv.includes('--negative');
function declarations(file) {
  const found = [];
  function visit(node, parents = []) {
    const named = ts.isModuleDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node);
    const name = named && node.name ? node.name.getText(file) : null;
    const names = name ? [...parents, name] : parents;
    if (name) {
      found.push({ name: names.join('.'), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
    ts.forEachChild(node, (child) => visit(child, names));
  }
  visit(file);
  return found;
}
const references = new Map(inspectorCatalog().inspectors.filter((item) => item.reference.kind === 'sdk-declaration')
  .map((item) => [item.reference.module, item.reference]));
if (negative) {
  references.get('@ohos.hidebug').symbols = [...references.get('@ohos.hidebug').symbols, 'OHMateMissingReference'];
}
const verified = [];
for (const [module, reference] of references) {
  assert.match(module, /^@ohos\.[A-Za-z.]+$/);
  const path = await realpath(join(sdkRoot, 'default', 'openharmony', 'ets', 'api', `${module}.d.ts`));
  const inside = relative(sdkRoot, path);
  assert(inside && !inside.startsWith('..') && !inside.startsWith('/'), 'Reference escaped SDK');
  const bytes = await readFile(path);
  assert(bytes.length <= 4 * 1024 * 1024, 'Reference exceeds inspection budget');
  const ast = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = declarations(ast);
  const symbols = reference.symbols.map((symbol) => {
    const declaration = names.find((entry) => entry.name === symbol || entry.name.endsWith(`.${symbol}`));
    assert(declaration, `Missing SDK declaration: ${module}.${symbol}`);
    return { symbol, declaration: declaration.name, line: declaration.line };
  });
  verified.push({ module, path: inside.split('\\').join('/'), sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, symbols, evidence: 'declaration-only', executionObserved: false });
}
const metadataPath = join(sdkRoot, 'default', 'sdk-pkg.json'), metadataBytes = await readFile(metadataPath);
const metadata = JSON.parse(metadataBytes.toString());
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ schemaVersion: '1.0', references: verified, sdk: {
  platformVersion: metadata.data?.platformVersion ?? null,
  apiVersion: metadata.data?.apiVersion ?? null,
  metadataHash: createHash('sha256').update(metadataBytes).digest('hex'),
}, captureVerification: 'unverified', devicesProbed: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Verified ${verified.length} SDK declaration references: ${output}`);
