/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { serviceSpec } from '../agent/service-spec.js';
import { IdentifierSchema } from '../debug-protocol/domain-schemas.js';
import { MockRulesSchema, MockSamplesSchema, NetworkMockTable, mockResponseSummary } from '../debug-protocol/network-mock.js';
import { WriteCommandSchema } from '../debug-protocol/write-schemas.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import type { ToolResult, ToolSpec } from '../runtime/types.js';

const validateInput = z.strictObject({ rules: MockRulesSchema });
const planInput = validateInput.extend({ samples: MockSamplesSchema });
const applyInput = planInput.extend({ command: WriteCommandSchema.refine((command) =>
  command.scope === 'network.mock', 'MOCK_SCOPE_REQUIRED') });
const targetInput = z.strictObject({ targetId: IdentifierSchema });
const unavailable = { available: false, reason: 'DEVICE_BUILD_UNVERIFIED', authentication: 'unavailable' };
async function blocked(): Promise<ToolResult> {
  return { exitCode: 5, data: { code: 'DEVICE_BUILD_UNVERIFIED', ...unavailable } };
}
function deniedSpec(id: string, schema: ToolSpec['inputSchema']): ToolSpec {
  // The intended remote action is R2; its unconditional denial must not persist an approval with raw bodies.
  return { ...serviceSpec(id, 'Unavailable remote Mock control; device/build authentication is not established', schema, blocked),
    risk: 'R2', resolveRisk: () => 'R0', idempotency: 'none', requirements: ['authenticated-device-build'] };
}

export function getMockSpecs(): ToolSpec[] {
  return [
    { ...serviceSpec('mock.validate', 'Validate bounded exact Mock rules without executing requests or returning bodies',
      validateInput, async (input) => {
        const { rules } = validateInput.parse(input);
        return { exitCode: 0, data: { mode: 'offline', payloadHash: hashContract(rules), ruleCount: rules.rules.length,
          targetId: rules.targetId, responses: rules.rules.map((rule) => ({ priority: rule.priority,
            ...mockResponseSummary(rule.ruleId, rule.response) })),
          supported: ['fixed', 'template', 'delay', 'timeout', 'network-error'], unsupported: ['file', 'chunks', 'stream'] } };
      }), idempotency: 'read' },
    { ...serviceSpec('mock.plan', 'Dry-run explicitly provided request samples; no observed device traffic or remote approval',
      planInput, async (input) => {
        const { rules, samples } = planInput.parse(input);
        return { exitCode: 0, data: { mode: 'offline', baseline: 'empty-offline-table',
          plan: new NetworkMockTable(rules.targetId).plan(rules, samples), remote: unavailable } };
      }), idempotency: 'read' },
    deniedSpec('mock.apply', applyInput),
    { ...serviceSpec('mock.status', 'Report unavailable remote Mock state without claiming that no rules are active',
      z.strictObject({}), async () => ({ exitCode: 3, data: { ...unavailable, active: null, hits: null } })), idempotency: 'read' },
    deniedSpec('mock.revoke', targetInput),
  ];
}
