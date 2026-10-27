/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { configPathSchema, configEditSchema, inspectConfig, validateConfig, prepareConfigEdit, editConfig } from './config-service.js';

export function getConfigSpecs(): ToolSpec[] {
  const options = [valueOption('path', 'Relative public configuration path')];
  return [
    serviceSpec('config.inspect', 'Read public configuration and its input hash', configPathSchema, inspectConfig, options),
    serviceSpec('config.validate', 'Validate JSON5 syntax and lossless edit support; official checks reported separately', configPathSchema, validateConfig, options),
    { ...serviceSpec('config.edit', 'Review configuration field add/remove/replace or supported ArkGuard rule edits', configEditSchema, editConfig),
      risk: 'R2', idempotency: 'none', evidence: ['field-diff', 'patch-journal'],
      review: async (input, context) => (await prepareConfigEdit(input, context)).review },
  ];
}
