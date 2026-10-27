/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const target = new URL('packages/cli/', root);

await mkdir(new URL('skills/deveco-cli/', target), { recursive: true });
await copyFile(new URL('README.md', root), new URL('README.md', target));
await copyFile(
  new URL('SKILL.md', root),
  new URL('skills/deveco-cli/SKILL.md', target)
);
await copyFile(new URL('upstream-baseline.json', root), new URL('upstream-baseline.json', target));
await mkdir(new URL('docs/', target), { recursive: true });
for (const name of [
  'usage.md', 'commands.md', 'command-catalog.json', 'command-guide.md',
  'trae-model-bridge.md', 'debug-clock.md', 'debug-inspector.md', 'debug-event-batches.md',
  'debug-retention.md', 'debug-bridge.md', 'problem-package.md', 'kit-problem-panel-design.md',
]) {
  await copyFile(new URL(`docs/${name}`, root), new URL(`docs/${name}`, target));
}
for (const name of ['cli', 'cli-wrapper', 'docs-zh']) {
  await copyFile(new URL('LICENSE', root), new URL(`packages/${name}/LICENSE`, root));
}
