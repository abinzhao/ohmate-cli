// Record the supplied source snapshot without importing or executing its code.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] ?? '../deveco-cli-develop/deveco-cli-develop');
const excluded = new Set([
  '.git', 'node_modules', 'dist', '.gitcode', '.github', '.husky',
  '__pycache__', '.DS_Store', '.env',
]);
const sensitive = new Set(['.p12', '.pfx', '.pem', '.key', '.jks', '.keystore']);
const files = [];

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name) || sensitive.has(extname(entry.name).toLowerCase())) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: relative(source, path).split('\\').join('/'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
}

await visit(source);
const workspaces = {};
for (const directory of ['cli', 'cli-wrapper', 'docs-zh', 'docs-engine', 'docs-index-builder']) {
  const pkg = JSON.parse(await readFile(join(source, 'packages', directory, 'package.json'), 'utf8'));
  workspaces[directory] = { name: pkg.name, version: pkg.version };
}
const record = {
  schemaVersion: '1.0',
  source: relative(root, source).split('\\').join('/'),
  revision: null,
  license: 'MIT',
  copyright: 'Huawei Device Co., Ltd.',
  snapshotHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  excluded: [...excluded, ...sensitive],
  workspaces,
  files,
};
await writeFile(join(root, 'upstream-baseline.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`Recorded ${files.length} files; snapshot ${record.snapshotHash}`);
