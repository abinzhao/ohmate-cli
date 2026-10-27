/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { createSchema, executeCreation, reviewCreation } from './create-service.js';

export function getCreationSpecs(): ToolSpec[] {
  return [{
    ...serviceSpec('deveco.create', 'Review bundled DevEco template files and create an application in an empty target',
      createSchema, executeCreation, [
        valueOption('app-name', 'ASCII project/application name'),
        valueOption('project-path', 'Target below the current project/cwd; real parent must exist'),
        valueOption('bundle-name', 'Application bundle name'),
        valueOption('api-level', 'Supported template API, or observed SDK API if omitted'),
        valueOption('device-types', 'Supported device types', true),
      ]),
    command: ['create'], risk: 'R2', idempotency: 'none', evidence: ['file-diff', 'project-create-manifest'],
    review: reviewCreation,
  }];
}
