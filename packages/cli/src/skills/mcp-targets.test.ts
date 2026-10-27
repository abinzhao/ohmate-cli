/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMcpInstallationTargets } from './mcp-targets.js';

describe('MCP targets independent of Skill agents', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-targets-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  it('does not infer MCP support from an installed Skill agent', async () => {
    await fs.mkdir(path.join(home, '.kilo'));
    await expect(resolveMcpInstallationTargets({})).rejects.toThrow(
      'No agents supporting MCP'
    );
    await expect(
      resolveMcpInstallationTargets({ agent: 'kilo' })
    ).rejects.toThrow('Invalid MCP agent');
    await fs.mkdir(path.join(home, '.cursor'));
    expect((await resolveMcpInstallationTargets({})).agents).toEqual([
      'cursor',
    ]);
  });
  it('preserves explicit not-yet-installed and project MCP targets', async () => {
    expect(
      await resolveMcpInstallationTargets({ agent: 'codex,codex' }, home)
    ).toEqual({
      agents: [],
      projectAgents: [{ agent: 'codex', project: home }],
    });
  });
});
