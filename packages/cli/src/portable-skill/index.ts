/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpecRegistry } from '../runtime/registry.js';
import type { ToolSpec } from '../runtime/types.js';
import { exportSkill, verifySkill } from './skill-service.js';

export function getPortableSkillSpecs(registry: ToolSpecRegistry): ToolSpec[] {
  return [
    { ...serviceSpec('skill.export', 'Export a portable Skill from the live registry into immutable private artifacts',
      z.strictObject({}), (_, context) => exportSkill(registry, context)), risk: 'R1',
      evidence: ['skill-manifest', 'registry-hash'], recovery: 'verify-and-retry' },
    serviceSpec('skill.verify', 'Check portable Skill integrity, privacy and command drift without executing its files',
      z.strictObject({ path: z.string().min(1).max(1024) }),
      (input, context) => verifySkill(registry, (input as { path: string }).path, context),
      [valueOption('path', 'Exported ohmate-cli directory')]),
  ];
}
