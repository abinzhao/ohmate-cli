/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { sourceTokens, type SourceToken } from '../quality/source-tokens.js';
import { InputInvalidError } from '../runtime/types.js';

export const hvigorTasks = {
  ohmatecliScan: 'scan',
  ohmatecliDocs: 'docs.check',
  ohmatecliTest: 'test.plan',
  ohmatecliVerifyRelease: 'release.verify',
} as const;
export type HvigorTaskName = keyof typeof hvigorTasks;

function closing(tokens: SourceToken[], start: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index].text;
    if (text in pairs) { stack.push(pairs[text]); }
    else if (['}', ']', ')'].includes(text)) {
      if (stack.pop() !== text) { throw new InputInvalidError('Unbalanced Hvigor declaration'); }
      if (!stack.length) { return index; }
    }
  }
  throw new InputInvalidError('Incomplete Hvigor declaration');
}

function pluginArray(tokens: SourceToken[]) {
  const start = tokens.findIndex((token, i) => token.text === 'export' && tokens[i + 1]?.text === 'default');
  if (start < 0 || tokens[start + 2]?.text !== '{') { throw new InputInvalidError('Hvigor default export must be a literal object'); }
  const end = closing(tokens, start + 2), arrays: number[] = [];
  for (let i = start + 3; i < end; i++) {
    const token = tokens[i];
    if (token.text === '.' || (token.text === '[' && tokens[i - 1]?.text !== ':')) {
      throw new InputInvalidError('Computed or spread Hvigor properties require manual integration');
    }
    if (token.text === 'plugins' || token.literal === 'plugins') {
      if (tokens[i + 1]?.text !== ':' || tokens[i + 2]?.text !== '[') { throw new InputInvalidError('Hvigor plugins must be a literal array'); }
      arrays.push(i + 2);
    }
    if (['{', '[', '('].includes(token.text)) { i = closing(tokens, i); }
  }
  if (arrays.length !== 1) { throw new InputInvalidError('Exactly one literal plugins array is required'); }
  const first = arrays[0], last = closing(tokens, first);
  return { first: tokens[first], last: tokens[last], hasItems: last > first + 1, trailingComma: tokens[last - 1].text === ',' };
}

export function attachPlugin(text: string, binding = 'ohmatePlugin', importPath = './ohmate-hvigor'): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(binding) || !/^\.\/[a-z][a-z0-9-]*$/.test(importPath)) {
    throw new InputInvalidError('Invalid generated Hvigor plugin binding');
  }
  const tokens = sourceTokens(text);
  if (tokens.some((token) => token.text === binding || token.literal === importPath)) {
    throw new InputInvalidError('OHMate Hvigor integration already exists or its binding is occupied');
  }
  const array = pluginArray(tokens), newline = text.includes('\r\n') ? '\r\n' : '\n';
  const offset = array.last.offset, delimiter = array.hasItems && !array.trailingComma ? ', ' : '';
  const body = text.slice(0, offset) + delimiter + `${binding}()` + text.slice(offset);
  const bom = body.startsWith('\ufeff') ? '\ufeff' : '';
  return `${bom}import { ${binding} } from '${importPath}';${newline}${body.slice(bom.length)}`;
}

export function pluginSource(): string {
  const names = JSON.stringify(Object.keys(hvigorTasks));
  return `/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from 'node:child_process';
import type { HvigorPlugin } from '@ohos/hvigor';

export function ohmatePlugin(inputs: Partial<Record<${Object.keys(hvigorTasks).map((name) => `'${name}'`).join(' | ')}, Record<string, unknown>>> = {}): HvigorPlugin {
  return {
    pluginId: 'ohmate.cli',
    apply(node) {
      for (const task of ${names}) {
        node.registerTask({
          name: task,
          run: () => new Promise<void>((resolve, reject) => {
            let entry: string;
            try { entry = require.resolve('@ohmate/cli-common/dist/cli.js'); }
            catch { reject(new Error('Install @ohmate/ohmatecli in this project before invoking OHMate tasks')); return; }
            const project = node.getNodeDir().getPath();
            const argv = [entry, 'integrate', 'hvigor-task', '--input', JSON.stringify({
              task, submit: task === 'ohmatecliTest', input: inputs[task as keyof typeof inputs] ?? {},
            }), '--project', project, '--format', 'json'];
            execFile(process.execPath, argv, {
              cwd: project, shell: false, timeout: 1800000, maxBuffer: 4194304,
            }, (error, stdout, stderr) => {
              if (stdout) { process.stdout.write(stdout); }
              if (stderr) { process.stderr.write(stderr); }
              if (error) { reject(new Error('OHMate task did not pass; inspect its original receipt')); }
              else { resolve(); }
            });
          }),
        });
      }
    },
  };
}
`;
}
