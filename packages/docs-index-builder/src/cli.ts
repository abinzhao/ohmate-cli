/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import {
  buildSearchIndex,
  sha256File,
  INDEX_DB_MAX_BYTES,
  getSynonymsHash,
  getTermsHash,
  INDEX_LEXICON_FILES,
} from '@ohmate/docs-engine/builder';

interface CliArgs {
  docsZip: string;
  output: string;
  lexiconDir?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let docsZip = '';
  let output = '';
  let lexiconDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--docs-zip' && args[i + 1]) {
      docsZip = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === '--lexicon-dir' && args[i + 1]) {
      lexiconDir = args[++i];
    }
  }
  if (!docsZip || !output) {
    console.error(
      'Usage: build-index --docs-zip <path> --output <path> [--lexicon-dir <path>]'
    );
    process.exit(1);
  }
  return { docsZip, output, lexiconDir };
}

async function packIndexZip(
  outputDir: string,
  indexZipPath: string,
  searchDbPath: string
): Promise<number> {
  console.log('Packing index.zip…');
  const bundle = new AdmZip();
  bundle.addLocalFile(searchDbPath);
  bundle.addLocalFile(path.join(outputDir, 'build-meta.json'));
  for (const name of INDEX_LEXICON_FILES) {
    bundle.addLocalFile(path.join(outputDir, name));
  }
  bundle.writeZip(indexZipPath);
  const stat = await fs.promises.stat(indexZipPath);
  return stat.size;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const docsZipPath = path.resolve(args.docsZip);
  const indexZipPath = path.resolve(args.output);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const lexiconDir = args.lexiconDir ?? path.join(scriptDir, '..', 'data');
  if (!fs.existsSync(docsZipPath)) {
    throw new Error(`docs.zip not found at ${docsZipPath}`);
  }
  const docsZipSha256 = await sha256File(docsZipPath);
  const outputDir = path.join(path.dirname(indexZipPath), '.index-build');
  const searchDbPath = path.join(outputDir, 'search.db');
  try {
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });
    console.log('Building search.db…');
    const meta = await buildSearchIndex({
      docsZipPath,
      tmpDir: outputDir,
      docsZipSha256,
      termsHash: getTermsHash(lexiconDir),
      synonymsHash: getSynonymsHash(lexiconDir),
      builtBy: 'doc-init',
      lexiconDir,
      onProgress: (progress: { message: string }) => {
        process.stdout.write(`\r${progress.message}`);
      },
    });
    process.stdout.write('\n');
    const dbStat = await fs.promises.stat(searchDbPath);
    if (dbStat.size > INDEX_DB_MAX_BYTES) {
      throw new Error(
        `search.db exceeds ${(INDEX_DB_MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit`
      );
    }
    const indexZipSize = await packIndexZip(outputDir, indexZipPath, searchDbPath);
    console.log(
      `Done. segments=${meta.segmentCount.toLocaleString()}, index.zip=${(indexZipSize / 1024 / 1024).toFixed(2)} MB`
    );
  } finally {
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
