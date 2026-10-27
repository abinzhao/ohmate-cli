/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { ProjectConstants } from './project.js';

describe('ProjectConstants', () => {
  it('pins the project file names', () => {
    expect(ProjectConstants.OH_PACKAGE_JSON5).toBe('oh-package.json5');
    expect(ProjectConstants.BUILD_PROFILE_JSON5).toBe('build-profile.json5');
  });

  it('pins the sync output and ohpm lock paths', () => {
    expect(ProjectConstants.SYNC_OUTPUT_PATH).toBe(
      '.hvigor/outputs/sync/output.json'
    );
    expect(ProjectConstants.LOCK_JSON5_PATH).toBe(
      'oh_modules/.ohpm/lock.json5'
    );
  });
});
