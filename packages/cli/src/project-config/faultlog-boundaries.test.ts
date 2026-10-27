/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

let root: string;
const sourcePath = 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets';
const header = 'import { FaultLogExtensionAbility, hiAppEvent } from "@kit.PerformanceAnalysisKit";\n';
const body = 'export default class OHMateFaultLogExtension extends FaultLogExtensionAbility { onFaultReportReady(): void {} }\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-faultlog-boundary-'));
  await mkdir(join(root, 'AppScope'));
  await mkdir(join(root, 'entry/src/main/ets/faultlogextension'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default', compatibleSdkVersion: '26.0.0' }] },
    modules: [{ name: 'entry', srcPath: './entry' }],
  }));
  await writeFile(join(root, 'entry/src/main/module.json5'), JSON.stringify({ module: {
    name: 'entry', type: 'entry', extensionAbilities: [{ name: 'OHMateFaultLogExtension', type: 'faultLog',
      srcEntry: './ets/faultlogextension/OHMateFaultLogExtension.ets', exported: false }],
  } }));
  await writeFile(join(root, sourcePath), header + body);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function validate() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute('config.validate', { path: 'entry/src/main/module.json5' }, context);
}
it('keeps unknown members in a restricted Kit unverified rather than treating every member as forbidden', async () => {
  await writeFile(join(root, sourcePath), 'import { unknownFutureModule } from "@kit.CameraKit";\n' + header + body);
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result.data)).not.toContain('FAULTLOG_FORBIDDEN_MODULE');
  expect(JSON.stringify(result.data)).toContain('FAULTLOG_DEPENDENCY_UNVERIFIED');
});
it('rejects an API suffix below21 rather than interpreting its HarmonyOS version as the API', async () => {
  await writeFile(join(root, 'build-profile.json5'), '{"app":{"products":[{"name":"default","compatibleSdkVersion":"6.0.0(20)"}]},"modules":[{"name":"entry","srcPath":"entry"}]}');
  expect((await validate()).exitCode).toBe(1);
});
it('keeps missing SDK declarations incomplete', async () => {
  await writeFile(join(root, 'build-profile.json5'), '{"modules":[{"name":"entry","srcPath":"entry"}]}');
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result.data)).toContain('FAULTLOG_API_UNVERIFIED');
});
it('does not follow source symlinks or emit their target contents', async () => {
  await writeFile(join(root, sourcePath), 'import { value } from "./linked";\n' + header + body);
  await writeFile(join(root, 'unowned.ets'), 'export const value = "EXAMPLE_DO_NOT_READ";');
  await symlink(join(root, 'unowned.ets'), join(root, 'entry/src/main/ets/faultlogextension/linked.ets'));
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result.data)).not.toContain('EXAMPLE_DO_NOT_READ');
  expect(JSON.stringify(result.data)).toContain('FAULTLOG_DEPENDENCY_UNVERIFIED');
});
it('bounds recursive source traversal and terminates cycles', async () => {
  await writeFile(join(root, sourcePath), 'import { value } from "./cycle";\n' + header + body);
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/cycle.ets'),
    'export { default as value } from "./OHMateFaultLogExtension";');
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ faultLog: { sources: [{ path: sourcePath },
    { path: 'entry/src/main/ets/faultlogextension/cycle.ets' }] } });
});
it('marks the depth budget incomplete without reading the next source', async () => {
  await writeFile(join(root, sourcePath), 'import { value } from "./depth0";\n' + header + body);
  for (let index = 0; index < 17; index++) {
    await writeFile(join(root, `entry/src/main/ets/faultlogextension/depth${index}.ets`),
      `export {value} from "./depth${index + 1}";`);
  }
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result.data)).toContain('FAULTLOG_DEPENDENCY_UNVERIFIED');
  const data = result.data as { faultLog: { sources: { path: string }[] } };
  expect(data.faultLog.sources).toHaveLength(17);
  expect(data.faultLog.sources.some((item) => item.path.endsWith('depth16.ets'))).toBe(false);
});
it('checks the actual independent Extension template closure without claiming host or system execution', async () => {
  const files = ['OHMateFaultLogExtension.ets', 'FaultLogSummary.ets'];
  for (const name of files) {
    const source = new URL('../../../../examples/OHMateKitProducer/entry/src/main/ets/faultlogextension/' + name, import.meta.url);
    await writeFile(join(root, 'entry/src/main/ets/faultlogextension', name), await readFile(source));
  }
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ valid: null, faultLog: { staticValid: true, sources: [
    { path: sourcePath }, { path: 'entry/src/main/ets/faultlogextension/FaultLogSummary.ets' },
  ], hostRegistration: 'not-verified', delayedExecution: 'not-run' } });
});
