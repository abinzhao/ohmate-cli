/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
const problemTools = new Set(['debug.problem.plan', 'debug.problem.export', 'replay.import', 'replay.verify', 'replay.show', 'replay.plan']);
export function isProblemPackageTool(id: string): boolean { return problemTools.has(id); }
