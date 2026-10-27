/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { DOCS_PKG_NAME, getPublishTag } from './constants.js';
import { debugLog } from '../utils/logger.js';

/** Metadata for one published docs knowledgebase version. */
export interface DocsVersionMeta {
  version: string;
  apiVersion: number;
  dist: { tarball: string; integrity: string };
}

/** Result of querying the registry for the docs knowledgebase. */
export interface DocsVersionResolution {
  /** Version published under the CLI's dist-tag (e.g. 'daily' or 'latest'). */
  latest: DocsVersionMeta;
  /**
   * Same as `latest` when its `apiVersion <= supportedApi`; null when the
   * tagged version requires a newer CLI (user should run `devecocli update`).
   */
  compatible: DocsVersionMeta | null;
}

interface NpmPackMeta {
  version: string;
  apiVersion?: number;
  dist?: { tarball: string; integrity: string };
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, NpmPackMeta>;
}

// npm 12+ wraps object results of `npm view <pkg>@<tag> --json` in a
// single-element array; npm <=11 returns the object directly. Normalize to
// the object. `npm view versions --json` and `npm pack` output are identical
// across npm versions.
export function unwrapViewResult<T>(parsed: unknown): T {
  return (Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed) as T;
}

/**
 * Query npm for the docs knowledgebase version published under the CLI's
 * dist-tag and resolve whether it is compatible with `supportedApi`.
 *
 * The CLI knows its own publish tag (baked at build time via tsup); the
 * knowledge base is published under the same tag in CI. By querying
 * `<pkg>@<tag>` we find the exact version that belongs to this release
 * channel — no need to scan all published versions.
 *
 * Printing is left to callers so this can run silently in the background check
 * and the CLI-update auto-sync.
 */
export async function resolveDocsVersions(
  supportedApi: number
): Promise<DocsVersionResolution> {
  const publishTag = getPublishTag();
  debugLog(`Executing: npm view ${DOCS_PKG_NAME}@${publishTag} --json`);
  const { stdout } = await execa('npm', [
    'view',
    `${DOCS_PKG_NAME}@${publishTag}`,
    '--json',
  ]);

  const doc = unwrapViewResult<NpmPackMeta>(JSON.parse(stdout));

  // npm 12 may return the full packument without a top-level `version`;
  // fall back to `dist-tags[publishTag]` (same pattern as resolveCliVersionMeta
  // in update.ts).
  const version =
    typeof doc.version === 'string'
      ? doc.version.trim()
      : doc['dist-tags']?.[publishTag]?.trim();
  if (!version) {
    throw new Error(
      `Could not resolve version for ${DOCS_PKG_NAME}@${publishTag}`
    );
  }

  // When npm 12 returns the full packument, per-version `dist` and `apiVersion`
  // live in `versions[ver]`, not at the top level.
  const perVersion = doc.versions?.[version];
  const dist = doc.dist ?? perVersion?.dist;
  if (!dist) {
    throw new Error(
      `Could not resolve dist for ${DOCS_PKG_NAME}@${publishTag}`
    );
  }
  const apiVersion = doc.apiVersion ?? perVersion?.apiVersion ?? 0;

  const tagged: DocsVersionMeta = { version, apiVersion, dist };

  if (tagged.apiVersion <= supportedApi) {
    return { latest: tagged, compatible: tagged };
  }

  return { latest: tagged, compatible: null };
}
