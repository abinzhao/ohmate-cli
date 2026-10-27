/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { compareVersions, extractVersion } from '../../common/utils/version.js';

/** Agent filename pattern: uitest_agent_v<semver>[.x86_64].so */
const AGENT_RE = /^uitest_agent_v(\d+\.\d+\.\d+)(\.x86_64)?\.so$/;

/** Fixed device-side destination path */
export const AGENT_REMOTE_PATH = '/data/local/tmp/agent.so';

/** Agent binary embedded version probe string: cat <so> | grep -a UITEST_AGENT_LIBRARY */
export const AGENT_VERSION_PROBE = 'UITEST_AGENT_LIBRARY';

export interface AgentCandidate {
  fileName: string;
  localPath: string;
  version: string;
  x86_64: boolean;
  remotePath: string;
  versionProbe: string;
}

/**
 * List files in the resource directory (returns empty array if not found, caller decides)
 */
export function listResourceFiles(dir: string): string[] {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.so'));
}

/**
 * Select the agent for operation RPC
 */
export function selectAgent({ dir, arch, isNewUiTest }: { dir: string; arch: string; isNewUiTest: boolean }): AgentCandidate | null {
  const x86 = arch === 'x86_64';
  const matched = [];
  for (const name of listResourceFiles(dir)) {
    const m = AGENT_RE.exec(name);
    if (!m) {
      continue;
    }
    const isX86 = !!m[2];
    if (x86 !== isX86) {
      continue; // Architecture must match exactly
    }
    if (x86) {
      // x86_64 (emulator) has only 1.1.9 agent, no old/new uitest distinction
      matched.push({ fileName: name, version: m[1], x86_64: isX86 });
      continue;
    }
    // arm: old/new uitest use different agent generations, cannot mix
    // New uitest (>= 6.0.2.2) -> agent >= 1.2.2
    // Old uitest -> agent < 1.2.2 (i.e. 1.1.9)
    const newEnough = compareVersions(m[1], '1.2.2') >= 0;
    if (isNewUiTest === newEnough) {
      matched.push({ fileName: name, version: m[1], x86_64: isX86 });
    }
  }
  if (!matched.length) {
    return null;
  }
  // Pick highest filename version (usually only one, more robust with multi-version)
  matched.sort((a, b) => compareVersions(b.version, a.version));
  const pick = matched[0];
  return {
    fileName: pick.fileName,
    localPath: join(dir, pick.fileName),
    version: pick.version,
    x86_64: pick.x86_64,
    remotePath: AGENT_REMOTE_PATH,
    versionProbe: AGENT_VERSION_PROBE,
  };
}

/**
 * Extract version from so embedded probe output
 * Device returns e.g. `...UITEST_AGENT_LIBRARY#1.2.2...`, take version after '#'
 */
export function parseAgentVersionProbe(probeOutput: string): string | null {
  const text = String(probeOutput || '');
  const idx = text.indexOf('#');
  const tail = idx >= 0 ? text.slice(idx + 1) : text;
  return extractVersion(tail);
}

/** Resource catalog snapshot (for logging / diagnostics) */
export function describeCatalog(dir: string) {
  const names = listResourceFiles(dir).map((n) => basename(n));
  return {
    dir,
    agents: names.filter((n) => AGENT_RE.test(n)),
  };
}