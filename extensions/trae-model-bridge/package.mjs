/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const AdmZip = require('adm-zip');
const pkg = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const zip = new AdmZip();
const files = ['package.json', 'extension.cjs', 'bridge.mjs', 'vscode-host.mjs', 'README.md'];
for (const file of files) { zip.addFile(`extension/${file}`, await readFile(new URL(file, import.meta.url))); }
zip.addFile('extension/LICENSE', await readFile(new URL('../../LICENSE', import.meta.url)));
zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`));
zip.addFile('extension.vsixmanifest', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/><DisplayName>${pkg.displayName}</DisplayName><Description xml:space="preserve">${pkg.description}</Description><Tags>AI,OHMate,TRAE</Tags><Categories>AI,Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/></Properties><License>extension/LICENSE</License></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets>
</PackageManifest>`));
const bytes = zip.toBuffer(), verified = new AdmZip(bytes);
assert.deepEqual(verified.getEntries().map((item) => item.entryName).sort(),
  ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/LICENSE', ...files.map((file) => `extension/${file}`)].sort());
for (const file of files) {
  assert.equal(verified.getEntry(`extension/${file}`).getData().compare(await readFile(new URL(file, import.meta.url))), 0);
}
const output = resolve(process.env.OHMATE_TRAE_BRIDGE_OUTPUT ?? fileURLToPath(new URL('../../dist/extensions/', import.meta.url)));
await mkdir(output, { recursive: true });
const name = `${pkg.name}-${pkg.version}.vsix`, hash = createHash('sha256').update(bytes).digest('hex');
await writeFile(resolve(output, name), bytes);
await writeFile(resolve(output, `${name}.sha256`), `${hash}  ${name}\n`);
console.log(JSON.stringify({ path: resolve(output, name), sha256: hash, files: verified.getEntries().length, installed: false }));
