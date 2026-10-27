/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  InstallationTargets,
  SkillOperationResult,
} from '../../types/skills.js';
import { assertSafeSkillName } from '../skill-name.js';
import {
  getAgentEntry,
  getAgentNames,
  getSharedAgentSkillsDir,
  getNativeSkillsDir,
  isAgentInstalled,
  isUniversalAgent,
} from '../agent-registry.js';
import {
  installDirectory,
  removeDirectory,
  lstatIfExists,
  resolveDirectoryEntry,
  samePath,
  pathsOverlap,
  skipped,
} from './directory-installation.js';
import {
  getSkillScopes,
  resolveInstallationEntries,
  resolveSkillDestinations,
  type SkillDestination,
  type SkillScope,
} from './agent-paths.js';
import {
  resolveSkillStoreEntry,
  installCustomArchive,
  prepareStoredSkill,
  withSkillLock,
} from './skill-store.js';

function failed(destination: string, error: unknown): SkillOperationResult {
  return {
    success: false,
    path: destination,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function runSkillScopes(
  name: string,
  targets: InstallationTargets,
  action: (scope: SkillScope) => Promise<SkillOperationResult[]>
): Promise<SkillOperationResult[]> {
  const results: SkillOperationResult[] = [];
  for (const scope of getSkillScopes(targets)) {
    try {
      results.push(...(await withSkillLock(name, scope, () => action(scope))));
    } catch (error) {
      results.push(
        failed(path.join(getSharedAgentSkillsDir(scope.project), name), error)
      );
    }
  }
  return results;
}

async function realpathOrEntry(entry: string): Promise<string> {
  return fs.realpath(entry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') {
      return entry;
    }
    throw error;
  });
}

async function clearLegacy(
  destination: SkillDestination,
  source: string
): Promise<void> {
  const realSource = await fs.realpath(source);
  for (const entry of destination.legacy) {
    const stats = await lstatIfExists(entry);
    if (stats && !stats.isSymbolicLink() && pathsOverlap(realSource, entry)) {
      throw new Error(
        `Skill source and legacy destination overlap: ${source}, ${entry}`
      );
    }
    await removeDirectory(entry);
  }
}

async function usingSkill(
  name: string,
  scope: SkillScope,
  entry: string,
  source?: string
): Promise<string[]> {
  const users: string[] = [];
  for (const agent of getAgentNames()) {
    const dir = getNativeSkillsDir(agent, scope.project);
    if (scope.agents.includes(agent)) {
      continue;
    }
    if (
      isUniversalAgent(agent, scope.project) &&
      !isAgentInstalled(agent, scope.project)
    ) {
      continue;
    }
    const candidate = await resolveDirectoryEntry(path.join(dir, name));
    const stats = await lstatIfExists(candidate);
    if (
      stats &&
      ((samePath(candidate, entry) && isAgentInstalled(agent, scope.project)) ||
        (source &&
          stats.isSymbolicLink() &&
          samePath(await realpathOrEntry(candidate), source)))
    ) {
      users.push(getAgentEntry(agent).displayName);
    }
  }
  return [...new Set(users)];
}

function retained(entry: string, users: string[]): SkillOperationResult {
  const reason = `still used by ${users.join(', ')}`;
  console.log(
    `Skill ${path.basename(entry)} in ${path.dirname(entry)} is kept: ${reason}.`
  );
  return skipped(entry, reason);
}

async function removeEntry(
  entry: string,
  name: string,
  scope: SkillScope,
  source?: string
): Promise<SkillOperationResult | undefined> {
  try {
    if (!(await lstatIfExists(entry))) {
      return undefined;
    }
    const users = await usingSkill(name, scope, entry, source);
    return users.length ? retained(entry, users) : await removeDirectory(entry);
  } catch (error) {
    return failed(entry, error);
  }
}

export class SkillInstaller {
  async installBundledSkill(
    sourceDir: string,
    targets: InstallationTargets,
    force = false
  ): Promise<SkillOperationResult[]> {
    await fs.access(path.join(sourceDir, 'SKILL.md'));
    if (targets.customPath) {
      return this.installCustom(
        'deveco-cli',
        sourceDir,
        targets.customPath,
        force
      );
    }
    return runSkillScopes('deveco-cli', targets, (scope) =>
      this.installScope(
        'deveco-cli',
        sourceDir,
        scope,
        targets.explicitAgents,
        force
      )
    );
  }

  async installArchiveSkill(
    name: string,
    buffer: Buffer,
    targets: InstallationTargets,
    force = false
  ): Promise<SkillOperationResult[]> {
    assertSafeSkillName(name);
    if (targets.customPath) {
      return this.installCustom(name, buffer, targets.customPath, force);
    }
    return runSkillScopes(name, targets, (scope) =>
      this.installScope(name, buffer, scope, targets.explicitAgents, force)
    );
  }

  private async installCustom(
    name: string,
    source: string | Buffer,
    customPath: string,
    force: boolean
  ): Promise<SkillOperationResult[]> {
    const entry = path.join(customPath, name);
    try {
      return await withSkillLock(name, { customPath }, async () => [
        typeof source === 'string'
          ? await installDirectory(source, entry, force)
          : await installCustomArchive(name, source, entry, force),
      ]);
    } catch (error) {
      return [failed(entry, error)];
    }
  }

  private async installScope(
    name: string,
    source: string | Buffer,
    scope: SkillScope,
    explicit = true,
    force = false
  ): Promise<SkillOperationResult[]> {
    const destinations = await resolveInstallationEntries(
      scope,
      name,
      explicit
    );
    const active = destinations.filter((destination) => !destination.skipped);
    const results = destinations
      .filter((destination) => destination.skipped)
      .map((destination) =>
        skipped(destination.path, 'agent-project-root-missing')
      );
    if (!active.length) {
      return results;
    }
    try {
      const prepared =
        typeof source === 'string'
          ? { source, results: [] }
          : await prepareStoredSkill(
              name,
              source,
              scope.project,
              active,
              force
            );
      return [
        ...results,
        ...prepared.results,
        ...(prepared.source
          ? await this.installSkillEntries(prepared.source, active, force)
          : []),
      ];
    } catch (error) {
      return [
        ...results,
        ...active.map((destination) => failed(destination.path, error)),
      ];
    }
  }

  private async installSkillEntries(
    source: string,
    destinations: SkillDestination[],
    force: boolean
  ): Promise<SkillOperationResult[]> {
    const results: SkillOperationResult[] = [];
    for (const destination of destinations) {
      try {
        results.push(await installDirectory(source, destination.path, force));
        if (force) {
          await clearLegacy(destination, source);
        }
      } catch (error) {
        results.push(failed(destination.path, error));
      }
    }
    return results;
  }

  async migrateBundledSkill(source: string, scope: SkillScope): Promise<void> {
    await withSkillLock('deveco-cli', scope, () =>
      this.migrateBundledScope(source, scope)
    );
  }

  private async migrateBundledScope(
    source: string,
    scope: SkillScope
  ): Promise<void> {
    let failure: unknown;
    const handled: string[] = [];
    for (const agent of scope.agents) {
      try {
        for (const destination of await resolveSkillDestinations(
          { ...scope, agents: [agent] },
          'deveco-cli'
        )) {
          await this.migrateBundledDestination(source, destination, handled);
        }
      } catch (error) {
        failure = error;
        console.error(
          `Skill migration failed for ${agent}: ${(error as Error).message}`
        );
      }
    }
    if (failure) {
      throw failure;
    }
  }

  private async migrateBundledDestination(
    source: string,
    destination: SkillDestination,
    handled: string[]
  ): Promise<void> {
    const entry = await lstatIfExists(destination.path);
    if (
      (!entry || (!entry.isDirectory() && !entry.isSymbolicLink())) &&
      !destination.legacy.length
    ) {
      return;
    }
    if (!handled.some((p) => samePath(p, destination.path))) {
      const result = await installDirectory(source, destination.path);
      if (result.reason === 'already-exists') {
        console.warn(
          `Skill migration skipped: ${destination.path} (already exists; run devecocli init --force to replace).`
        );
      }
      handled.push(destination.path);
    }
  }

  async removeSkill(
    name: string,
    targets: InstallationTargets
  ): Promise<SkillOperationResult[]> {
    assertSafeSkillName(name);
    if (targets.customPath) {
      const entry = path.join(targets.customPath, name);
      return withSkillLock(name, targets, async () => [
        await removeDirectory(entry),
      ]);
    }
    return runSkillScopes(name, targets, (scope) =>
      this.removeScope(name, scope, targets.explicitAgents)
    );
  }

  private async removeScope(
    name: string,
    scope: SkillScope,
    explicit = true
  ): Promise<SkillOperationResult[]> {
    const shared = await resolveDirectoryEntry(
      path.join(getSharedAgentSkillsDir(scope.project), name)
    );
    const results = await this.removeAgentEntries(
      name,
      scope,
      shared,
      explicit
    );
    if (results.every((result) => result.success)) {
      const result = await removeEntry(
        shared,
        name,
        scope,
        await realpathOrEntry(shared)
      );
      if (result) {
        results.push(result);
      }
    }
    if (results.every((result) => result.success)) {
      const store = await resolveSkillStoreEntry(name, scope.project);
      const result = await removeEntry(
        store,
        name,
        { ...scope, agents: [] },
        await realpathOrEntry(store)
      );
      if (result) {
        results.push(result);
      }
    }
    if (!results.length) {
      console.log(`Skill ${name} not found for the selected agents.`);
      results.push(skipped(shared, 'not-installed'));
    }
    return results;
  }

  private async removeAgentEntries(
    name: string,
    scope: SkillScope,
    shared: string,
    explicit: boolean
  ): Promise<SkillOperationResult[]> {
    const entries = new Set<string>();
    for (const destination of await resolveSkillDestinations(
      scope,
      name,
      explicit
    )) {
      if (destination.skipped) {
        continue;
      }
      for (const entry of [destination.path, ...destination.legacy]) {
        if (!samePath(entry, shared)) {
          entries.add(entry);
        }
      }
    }
    const results: SkillOperationResult[] = [];
    for (const entry of entries) {
      const result = await removeEntry(entry, name, scope);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }
}
