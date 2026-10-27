/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildOutputObserverSource } from './build-output-observer-source.js';
import { collectBuildOutputLayout } from './build-output-layout.js';

it.skipIf(process.platform === 'win32').each([false, true])('retains completed paths without exit callbacks (explicit metadata query=%s)', async (query) => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-output-worker-')), output = join(root, 'observations');
  let child: ReturnType<typeof fork> | undefined, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let didClose = false;
  try {
    await mkdir(output);
    const base = join(root, 'hvigor-ohos-plugin/src/common/iml'); await mkdir(base, { recursive: true });
    const script = join(root, 'worker.cjs'), preload = join(root, 'observer.cjs');
    await writeFile(join(base, 'module-path-info-iml.js'), `
      exports.ModulePathInfoIml = class {
        constructor() { this._modulePath = ${JSON.stringify(join(root, 'entry'))}; this._productName = 'default'; this._targetName = 'default'; }
        getModuleBuildOutputPath() { return ${JSON.stringify(join(root, 'build/custom'))}; }
        getIntermediatesOutputMetadata() { return ${JSON.stringify(join(root, 'cache/hap.json'))}; }
        getIntermediatesHspOutputMetadata() { return ${JSON.stringify(join(root, 'cache/hsp.json'))}; }
      };
    `);
    await writeFile(preload, buildOutputObserverSource);
    await writeFile(script, `
      const { ModulePathInfoIml } = require('./hvigor-ohos-plugin/src/common/iml/module-path-info-iml.js');
      const paths = new ModulePathInfoIml();
      paths.getModuleBuildOutputPath();
      ${query ? '' : 'paths.getIntermediatesOutputMetadata(); paths.getIntermediatesHspOutputMetadata();'}
      process.send('path-returned');
      setInterval(() => {}, 1000);
    `);
    child = fork(script, [], { execPath: process.execPath, execArgv: ['--require', preload], cwd: root,
      env: { HOME: root, USERPROFILE: root, TMPDIR: root, OHMATE_COMPILER_PROJECT: root, OHMATE_BUILD_OUTPUT_OBSERVATIONS: output,
        ...(query ? { OHMATE_QUERY_OUTPUT_METADATA: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    closed = new Promise((done, reject) => {
      child!.once('error', reject);
      child!.once('close', (code, signal) => { didClose = true; done({ code, signal }); });
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Private worker did not return its path')), 1000);
      child!.once('message', (message) => {
        clearTimeout(timer);
        if (message === 'path-returned') { done(); }
        else { reject(new Error('Unexpected readiness message')); }
      });
    });
    child.kill('SIGKILL');
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await collectBuildOutputLayout(output, root)).toMatchObject({ invalid: false, binding: 'observed-partial',
      paths: [
        { scope: 'module', product: 'default', target: 'default', modulePath: 'entry', path: 'build/custom' },
        { scope: 'module-metadata', kind: 'hap', product: 'default', target: 'default', modulePath: 'entry', path: 'cache/hap.json' },
        { scope: 'module-metadata', kind: 'hsp', product: 'default', target: 'default', modulePath: 'entry', path: 'cache/hsp.json' },
      ] });
  } finally {
    if (child && !didClose) { child.kill('SIGKILL'); }
    if (closed) { await closed; }
    await rm(root, { recursive: true, force: true });
  }
});
