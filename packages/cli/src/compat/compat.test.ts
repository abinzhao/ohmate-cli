/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCheckCommand, handleVersionsCommand } from './compat.js';
import { Project } from '../utils/project.js';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { projectSkillChecker } from '../skills/index.js';

vi.mock('../trace/index.js', () => ({
  telemetry: { track: vi.fn().mockResolvedValue(undefined) }, EventType: { CheckCommand: 'check' },
}));
vi.mock('../utils/process-rss.js', () => ({
  readProcessRss: vi.fn().mockResolvedValue(null), formatBytesMb: vi.fn(),
}));

describe('compatibility command boundaries', () => {
  it('rejects invalid versions format before resolving tools', async () => {
    const provider = vi.spyOn(ToolProvider, 'new');
    try {
      await expect(handleVersionsCommand('csv')).rejects.toThrow('--format must be default or json');
      expect(provider).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it('retains the original compiler failure as the cause', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmate-compat-cause-'));
    const cause = new Error('test compiler failed');
    try {
      await writeFile(join(root, 'sdk_6.0.0(20)_release.json'), '{}');
      await writeFile(join(root, 'sdk_6.1.0(21)_release.json'), '{}');
      vi.spyOn(Project, 'discover').mockReturnValue({ rootDir: root, profile: { modules: [] } } as unknown as Project);
      vi.spyOn(projectSkillChecker, 'warnInvalidBundledLinks').mockResolvedValue(undefined);
      vi.spyOn(ToolProvider, 'new').mockResolvedValue({
        javaPath: join(root, 'java'), sdkPath: root, sourceType: 'studio',
        getApiscanPaths: () => ({ apiChangeDir: root, scriptPath: join(root, 'scan.js') }),
      } as unknown as ToolProvider);
      vi.spyOn(HvigorAdapter.prototype, 'compileNative').mockRejectedValue(cause);
      await expect(handleCheckCommand([], {
        sourceVersion: 'sdk_6.0.0(20)_release', targetVersion: 'sdk_6.1.0(21)_release',
        format: 'json', limit: 10,
      })).rejects.toMatchObject({ message: expect.stringContaining('test compiler failed'), cause });
    } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  });
});
