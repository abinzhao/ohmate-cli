/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DOCS_PKG_NAME } from './constants.js';
import { debugLog } from '../utils/logger.js';

/** Result of installing a docs version on disk. */
export interface InstalledDocs {
  version: string;
  apiVersion: number;
}

interface DocsInstallMeta {
  version: string;
  apiVersion: number;
  dist: { tarball: string; integrity: string };
}

/** Atomically write a JSON file via a temp file + rename. */
export async function atomicWriteJson(
  filePath: string,
  data: unknown
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/** Verify a tarball's sha512 integrity string against the downloaded bytes. */
export function verifyIntegrity(data: Buffer, integrity: string): boolean {
  const dashIdx = integrity.indexOf('-');
  if (dashIdx < 0) {
    return false;
  }
  const algo = integrity.slice(0, dashIdx);
  const base64 = integrity.slice(dashIdx + 1);
  if (algo !== 'sha512') {
    return false;
  }
  const expected = Buffer.from(base64, 'base64');
  const actual = crypto.createHash(algo).update(data).digest();
  return actual.equals(expected);
}

/** Download `npm pack` for the version and verify its integrity. Returns the tarball path. */
async function downloadAndVerify(
  version: string,
  integrity: string,
  docDataDir: string
): Promise<string> {
  debugLog(`Executing: npm pack ${DOCS_PKG_NAME}@${version}`);
  const { stdout: packOutput } = await execa(
    'npm',
    ['pack', `${DOCS_PKG_NAME}@${version}`],
    { cwd: docDataDir }
  );
  const tarballName = packOutput.trim().split('\n').pop()!;
  const tarballPath = path.join(docDataDir, tarballName);
  const tarballData = await fs.readFile(tarballPath);
  if (!verifyIntegrity(tarballData, integrity)) {
    await fs.unlink(tarballPath).catch(() => {});
    throw new Error('Documentation package integrity verification failed');
  }
  return tarballPath;
}

/** Extract the tarball into `<docDataDir>/<version>` and verify required files exist. */
async function extractAndInstall(
  tarballPath: string,
  version: string,
  docDataDir: string
): Promise<string> {
  const versionDir = path.join(docDataDir, version);
  const tmpDir = path.join(docDataDir, `.tmp-${version}-${process.pid}`);
  await fs.rm(versionDir, { recursive: true, force: true });
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  debugLog(`Executing: tar -xzf ${path.basename(tarballPath)} -C ${tmpDir}`);
  await execa('tar', ['-xzf', tarballPath, '-C', tmpDir]);
  await fs.rename(path.join(tmpDir, 'package'), versionDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.unlink(tarballPath).catch(() => {});
  await fs.access(path.join(versionDir, 'dist', 'engine', 'index.js'));
  await fs.access(path.join(versionDir, 'docs.zip'));
  await fs.access(path.join(versionDir, 'index.zip'));
  return versionDir;
}

/**
 * Download, verify, and install a docs knowledgebase version, then update
 * `current.json` to point at it. Shared by `devecocli update` (auto-sync) and
 * `devecocli docs update`.
 *
 * @param meta      version to install (version, apiVersion, dist)
 * @param docDataDir directory holding per-version docs installs + `current.json`
 * @param installedBy marker written to `current.json` for traceability
 */
export async function installDocsVersion(
  meta: DocsInstallMeta,
  docDataDir: string,
  installedBy: string
): Promise<InstalledDocs> {
  await fs.mkdir(docDataDir, { recursive: true });
  const tarballPath = await downloadAndVerify(
    meta.version,
    meta.dist.integrity,
    docDataDir
  );
  await extractAndInstall(tarballPath, meta.version, docDataDir);
  await atomicWriteJson(path.join(docDataDir, 'current.json'), {
    version: meta.version,
    apiVersion: meta.apiVersion,
    installedAt: Date.now(),
    installedBy,
  });
  return { version: meta.version, apiVersion: meta.apiVersion };
}
