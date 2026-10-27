/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAgentNames,
  getProjectSkillsDir,
  getSharedAgentSkillsDir,
} from '../agent-registry.js';
import { resolveBundledSkillDir } from '../skill-package.js';
import {
  lstatIfExists,
  resolveDirectoryEntry,
  samePath,
} from './directory-installation.js';

interface LinkIssue {
  path: string;
  reason: string;
  repair: boolean;
}

function quotePath(value: string): string {
  const escaped =
    process.platform === 'win32'
      ? value.replace(/'/g, "''")
      : value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

async function checkEntry(
  entry: string,
  source: string
): Promise<LinkIssue | undefined> {
  try {
    const stats = await lstatIfExists(entry);
    if (!stats?.isSymbolicLink()) {
      return undefined;
    }
    const target = await fs.realpath(entry);
    return samePath(target, source)
      ? undefined
      : { path: entry, reason: `points to ${target}`, repair: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const broken = code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
    return {
      path: entry,
      reason: broken
        ? 'broken link'
        : `cannot check: ${(error as Error).message}`,
      repair: broken,
    };
  }
}

/** 只检查当前工程的 bundled Skill 链接；异常仅提示，不改变安装或命令结果。 */
export class ProjectSkillChecker {
  private readonly checked = new Set<string>();

  async warnInvalidBundledLinks(projectDir: string): Promise<void> {
    try {
      const project = await fs.realpath(projectDir);
      const key =
        process.platform === 'win32' ? project.toLowerCase() : project;
      if (this.checked.has(key)) {
        return;
      }
      this.checked.add(key);
      const source = await fs.realpath(resolveBundledSkillDir());
      if (!(await fs.stat(path.join(source, 'SKILL.md'))).isFile()) {
        throw new Error(`Skill source has no SKILL.md: ${source}`);
      }
      const issues = await this.checkKnownEntries(project, source);
      this.reportIssues(project, issues);
    } catch (error) {
      console.warn(
        `Cannot check project Skill links for ${projectDir}: ${(error as Error).message}`
      );
    }
  }

  private async checkKnownEntries(
    project: string,
    source: string
  ): Promise<LinkIssue[]> {
    const directories = new Set([
      getSharedAgentSkillsDir(project),
      ...getAgentNames().map((agent) => getProjectSkillsDir(project, agent)),
    ]);
    const checked: string[] = [];
    const issues: LinkIssue[] = [];
    for (const directory of directories) {
      const entry = path.join(directory, 'deveco-cli');
      try {
        const physical = await resolveDirectoryEntry(entry);
        if (checked.some((previous) => samePath(previous, physical))) {
          continue;
        }
        checked.push(physical);
        const issue = await checkEntry(physical, source);
        if (issue) {
          issues.push(issue);
        }
      } catch (error) {
        issues.push({
          path: entry,
          reason: `cannot check: ${(error as Error).message}`,
          repair: false,
        });
      }
    }
    return issues;
  }

  private reportIssues(project: string, issues: LinkIssue[]): void {
    for (const issue of issues) {
      console.warn(`Project Skill link: ${issue.path} (${issue.reason}).`);
    }
    if (issues.some((issue) => issue.repair)) {
      console.warn(`Run: devecocli init --project ${quotePath(project)} -f`);
      console.warn(
        'Existing copies and local edits in the selected installation scope will be replaced.'
      );
    }
  }
}

export const projectSkillChecker = new ProjectSkillChecker();
