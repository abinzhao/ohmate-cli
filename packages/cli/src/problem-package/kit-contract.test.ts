/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { problemSchemas } from './schemas.js';
import { KIT_DOMAINS } from './kit-profile.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const example = join(root, 'examples/OHMateKitProducer');
const schemaPath = 'entry/src/main/resources/rawfile/ohmate-problem-schemas.json';
const expected = () => Object.fromEntries(problemSchemas(true, true, true, true));
test('published protocol generator resolves the exact version used by the Kit schemas', async () => {
  const manifestPath = join(root, 'packages/cli/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: { zod: string } };
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dependencies?: { zod: string } }>;
  };
  const resolved = createRequire(manifestPath)('zod/package.json') as { version: string };
  expect(manifest.dependencies.zod).toBe(resolved.version);
  expect(lock.packages['packages/cli'].dependencies!.zod).toBe(resolved.version);
});
function constant(text: string, name: string): string {
  const matched = text.match(new RegExp(`export const ${name}: string = (.+);`));
  expect(matched, `Missing compiled ${name}`).not.toBeNull();
  return JSON.parse(matched![1]) as string;
}
test('example compiles all current problem schemas from their canonical definitions', async () => {
  const text = await readFile(join(example, 'entry/src/main/ets/bridge/GeneratedContract.ets'), 'utf8');
  const schemas = JSON.parse(constant(text, 'PROBLEM_SCHEMAS')) as Record<string, object>;
  expect(schemas).toEqual(expected());
  expect(Object.keys(schemas).filter((path) => path.startsWith('schemas/kit-'))).toHaveLength(19);
});
test('example embeds the same public schemas as its rawfile resource', async () => {
  const resource = await readFile(join(example, schemaPath), 'utf8').catch(() => '');
  expect(resource, 'Missing problem schema resource').not.toBe('');
  expect(JSON.parse(resource)).toEqual(expected());
});
test('memory file path comes from the shared domain definition', async () => {
  const text = await readFile(join(example, 'entry/src/main/ets/bridge/GeneratedContract.ets'), 'utf8');
  expect(constant(text, 'KIT_MEMORY_PATH')).toBe(KIT_DOMAINS.find((item) => item.domain === 'memory')!.path);
  expect(constant(text, 'KIT_UI_PATH')).toBe(KIT_DOMAINS.find((item) => item.domain === 'ui')!.path);
});
test('application export embeds its exact uncalibrated schema layout and domain coverage names', async () => {
  const text = await readFile(join(example, 'entry/src/main/ets/bridge/GeneratedContract.ets'), 'utf8');
  expect(JSON.parse(constant(text, 'KIT_EXPORT_SCHEMAS'))).toEqual(Object.fromEntries(problemSchemas(false, false, false, true, true)));
  expect(JSON.parse(constant(text, 'KIT_READONLY_EXPORT_SCHEMAS'))).toEqual(
    Object.fromEntries(problemSchemas(false, false, false, true, 'app-readonly-summary')));
  expect(JSON.parse(constant(text, 'KIT_DOMAIN_NAMES'))).toEqual(KIT_DOMAINS.map((item) => item.domain));
});
test('generator check rejects schema resource drift without overwriting it', async () => {
  const temporary = await mkdtemp('/private/tmp/ohmate-kit-contract-');
  try {
    await cp(join(root, 'packages/cli/src'), join(temporary, 'packages/cli/src'), { recursive: true });
    await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n');
    await cp(join(root, 'packages/cli/package.json'), join(temporary, 'packages/cli/package.json'));
    await symlink(join(root, 'packages/cli/node_modules'), join(temporary, 'packages/cli/node_modules'));
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'));
    await mkdir(join(temporary, 'scripts'));
    await cp(join(root, 'scripts/generate-kit-contract.mjs'), join(temporary, 'scripts/generate-kit-contract.mjs'));
    await cp(join(example, 'entry/src/main/ets/bridge/GeneratedContract.ets'),
      join(temporary, 'examples/OHMateKitProducer/entry/src/main/ets/bridge/GeneratedContract.ets'), { recursive: true });
    const raw = join(temporary, 'examples/OHMateKitProducer/entry/src/main/resources/rawfile');
    await mkdir(raw, { recursive: true });
    await cp(join(example, 'entry/src/main/resources/rawfile/ohmate-protocol.json'), join(raw, 'ohmate-protocol.json'));
    const changed = '{"unexpected":"schema drift"}\n';
    await writeFile(join(raw, 'ohmate-problem-schemas.json'), changed);
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/generate-kit-contract.mjs', '--check'],
      { cwd: temporary, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TMPDIR: temporary },
        timeout: 10000 }).then(() => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('KIT_CONTRACT_DRIFT: entry/src/main/resources/rawfile/ohmate-problem-schemas.json');
    expect(await readFile(join(raw, 'ohmate-problem-schemas.json'), 'utf8')).toBe(changed);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
