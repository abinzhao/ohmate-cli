/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digest, evidenceFile, type FileEvidence } from './evidence.js';

const declarations = [
  ['ASSEMBLE_HAP', 'assembleHap', 'AssembleHapCA'], ['ASSEMBLE_HSP', 'assembleHsp', 'AssembleHspCA'],
  ['ASSEMBLE_HAR', 'assembleHar', 'AssembleHarCA'], ['TEST', 'test', 'TestCA'], ['ON_DEVICE_TEST', 'onDeviceTest', 'DeviceTestHookCA'],
  ['UNIT_TEST_BUILD', 'UnitTestBuild', 'UnitTestBuildCA'],
];
/** Read installed plugin literals; importing project or plugin JS would execute unapproved code. */
export async function installedTaskDefinitions(hvigorEntry: string) {
  const root = dirname(dirname(hvigorEntry)), base = join(root, 'hvigor-ohos-plugin/src/tasks');
  const inputs: FileEvidence[] = [], texts: string[] = [];
  for (const file of [join(base, 'common/task-names.js'), join(base, 'manager/global-task-creation-manager.js')]) {
    try {
      const evidence = await evidenceFile(root, file);
      if (evidence.size > 2 * 1024 * 1024) { throw new Error('Task definition exceeds 2 MiB'); }
      const text = await readFile(file, 'utf8');
      if (digest(text) !== evidence.sha256) { throw new Error('Task definition changed while reading'); }
      texts.push(text); inputs.push(evidence);
    } catch { return { tasks: [] as string[], inputs: [] as FileEvidence[], status: 'unavailable' }; }
  }
  const tasks = declarations.filter(([symbol, name, creator]) =>
    new RegExp(`\\.${symbol}\\s*=\\s*\\{\\s*name\\s*:\\s*["']${name}["']`).test(texts[0]) &&
    new RegExp(`class\\s+${creator}\\b[\\s\\S]*?declareTaskDetail\\s*=\\s*\\(\\)\\s*=>[^;{}]*\\.${symbol}\\b`).test(texts[1])).map(([, name]) => name);
  return { tasks, inputs, status: tasks.length ? 'observed-installed-literals' : 'unavailable' };
}
