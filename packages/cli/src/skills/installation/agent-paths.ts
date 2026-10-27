/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import path from 'node:path';
import type { InstallationTargets } from '../../types/skills.js';
import {
  getSharedAgentSkillsDir,
  getNativeSkillsDir,
  hasProjectAgentRoot,
  getStaleSkillsDirs,
  isUniversalAgent,
} from '../agent-registry.js';
import {
  lstatIfExists,
  resolveDirectoryEntry,
  samePath,
} from './directory-installation.js';

export interface SkillScope {
  readonly agents: readonly string[];
  readonly project?: string;
}

export interface SkillDestination {
  readonly path: string;
  readonly legacy: string[];
  skipped: boolean;
}

export function getSkillScopes(targets: InstallationTargets): SkillScope[] {
  const scopes: SkillScope[] = [];
  if (targets.agents.length) {
    scopes.push({
      agents: [...new Set(targets.agents)],
    });
  }
  const projects = new Map<string, string[]>();
  for (const { project, agent } of targets.projectAgents) {
    const names = projects.get(project) ?? [];
    names.push(agent);
    projects.set(project, names);
  }
  for (const [project, names] of projects) {
    scopes.push({ project, agents: [...new Set(names)] });
  }
  return scopes;
}

async function legacyEntries(
  agent: string,
  scope: SkillScope,
  name: string,
  keep: readonly string[]
): Promise<string[]> {
  const entries: string[] = [];
  for (const dir of getStaleSkillsDirs(agent, scope.project)) {
    const entry = await resolveDirectoryEntry(path.join(dir, name));
    if (!keep.some((p) => samePath(p, entry)) && (await lstatIfExists(entry))) {
      entries.push(entry);
    }
  }
  return entries;
}

/** 按真实父目录去重，旧条目与共享位置相同时交由共享入口的生命周期处理。 */
export async function resolveSkillDestinations(
  scope: SkillScope,
  name: string,
  explicitAgents = true
): Promise<SkillDestination[]> {
  const canonical = await resolveDirectoryEntry(
    path.join(getSharedAgentSkillsDir(scope.project), name)
  );
  const destinations: SkillDestination[] = [];
  for (const agent of scope.agents) {
    const dir = getNativeSkillsDir(agent, scope.project);
    const entry = await resolveDirectoryEntry(path.join(dir, name));
    const legacy = await legacyEntries(agent, scope, name, [canonical, entry]);
    const skipped = !!(
      scope.project &&
      !explicitAgents &&
      !isUniversalAgent(agent, scope.project) &&
      legacy.length === 0 &&
      !hasProjectAgentRoot(scope.project, agent)
    );
    const previous = destinations.find((d) => samePath(d.path, entry));
    if (previous) {
      previous.legacy.push(
        ...legacy.filter((p) => !previous.legacy.some((v) => samePath(v, p)))
      );
      previous.skipped &&= skipped;
    } else {
      destinations.push({ path: entry, legacy, skipped });
    }
  }
  return destinations;
}

/** 有有效 Agent 目标时，将共享入口加入同一安装批次。 */
export async function resolveInstallationEntries(
  scope: SkillScope,
  name: string,
  explicitAgents = true
): Promise<SkillDestination[]> {
  const destinations = await resolveSkillDestinations(
    scope,
    name,
    explicitAgents
  );
  if (destinations.every((destination) => destination.skipped)) {
    return destinations;
  }
  const shared = await resolveDirectoryEntry(
    path.join(getSharedAgentSkillsDir(scope.project), name)
  );
  if (!destinations.some((destination) => samePath(destination.path, shared))) {
    destinations.unshift({ path: shared, legacy: [], skipped: false });
  }
  return destinations;
}
