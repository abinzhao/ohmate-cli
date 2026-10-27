/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const generatorRequire = createRequire(require.resolve('generate-license-file'));
const Arborist = generatorRequire('@npmcli/arborist');
const { resolveLicenseContent } = generatorRequire('./lib/internal/resolveLicenseContent/index.js');
const { resolveNotices } = generatorRequire('./lib/internal/resolveNoticeContent/index.js');
const product = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));
const tree = await new Arborist({ path: root }).loadActual();
const entry = tree.inventory.get('packages/cli');
if (!entry || entry.package.name !== product.name) { throw new Error('Production workspace was not found in the installed dependency graph'); }
const pending = [entry], visited = new Set(), licenses = [];
while (pending.length) {
  const node = pending.pop();
  if (visited.has(node.realpath)) { continue; }
  visited.add(node.realpath);
  for (const edge of node.edgesOut.values()) {
    if (edge.type === 'dev') { continue; }
    if (!edge.to) {
      if (edge.optional) { continue; }
      throw new Error(`Production dependency missing: ${edge.name}`);
    }
    pending.push(edge.to.target ?? edge.to);
  }
  if (node.package.name.startsWith('@ohmate/')) { continue; }
  // Reuse the installed generator's license/notice readers, but traverse the root
  // workspace graph explicitly so hoisted dependencies cannot be silently omitted.
  licenses.push({ name: `${node.package.name}@${node.package.version}`,
    text: await resolveLicenseContent(node.realpath, node.package, {}), notices: await resolveNotices(node.realpath) });
}
const text = licenses.sort((a, b) => a.name.localeCompare(b.name)).map((item) =>
  `${item.name}\n\n${item.text}\n${item.notices.join('\n')}\n`).join('\n-----------\n\n');
for (const name of Object.keys(product.dependencies).filter((name) => !name.startsWith('@ohmate/'))) {
  if (!text.includes(`${name}@`)) { throw new Error(`Production license missing: ${name}`); }
}
await writeFile(join(root, 'packages/cli/THIRD-PARTY-LICENSES'), text);
console.log(`Verified licenses for ${licenses.length} resolved production packages.`);
