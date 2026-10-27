/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z, toJSONSchema } from 'zod';
import { sha256 } from '../agent/context-files.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { InputInvalidError } from '../runtime/types.js';
import type { ToolSpecRegistry } from '../runtime/registry.js';

export const skillFiles = ['SKILL.md', 'commands.json', 'manifest.json'] as const;
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), name: z.literal('ohmate-cli'), toolVersion: z.string(),
  registryHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.strictObject({ path: z.enum(['SKILL.md', 'commands.json']), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(2),
});
function portableSchema(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(portableSchema); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['default', 'examples'].includes(key))
      .map(([key, item]) => [key, portableSchema(item)]));
  }
  return value;
}
export function assertPortable(text: string): void {
  if (/(?:^|[\s"'`])(?:\/(?!\/)[A-Za-z0-9._-]+\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/m.test(text) ||
    /--raw\b|--api-key\b|(?:exec|spawn)(?:File|Sync|FileSync)?\s*\(|\b(?:sh|bash)\s+-c\b|\bcmd\s+\/c\b/i.test(text)) {
    throw new InputInvalidError('Portable Skill contains forbidden machine data or executable instructions');
  }
  try { assertPublicValue(text); }
  catch { throw new InputInvalidError('Portable Skill contains private credential data'); }
}

export function commandCatalog(registry: ToolSpecRegistry) {
  return registry.list().filter((spec) => !spec.hidden).map((spec) => ({
    id: spec.id, command: spec.command, description: spec.description, adapter: spec.adapter,
    risk: spec.risk, protocol: Boolean(spec.protocol), requirements: spec.requirements,
    inputSchema: portableSchema(toJSONSchema(spec.inputSchema)), arguments: spec.arguments,
    options: spec.options.filter((option) => !option.flags.includes('--api-key')).map((option) => ({
      flags: option.flags, required: option.required, optional: option.optional, mandatory: option.mandatory,
      ...(option.choices ? { choices: option.choices } : {}),
    })),
  }));
}

export function skillContent(registry: ToolSpecRegistry) {
  const commands = commandCatalog(registry), toolVersion = process.env.npm_package_version ?? '0.1.0';
  const catalog = `${JSON.stringify({ schemaVersion: '1.0', toolVersion, entry: 'ohmatecli', commands }, null, 2)}\n`;
  const skill = `---
name: ohmate-cli
description: Develop and inspect HarmonyOS projects through OHMate CLI. Use for build, test, debug and quality tasks. Do not use for unrestricted shell execution.
---

# OHMate CLI

Use the installed \`ohmatecli\` entry. Deterministic tools work without a model or a browser.
Read [commands.json](commands.json) for the exact registry, input schemas, risks and protocol modes.
The DevEco source capabilities use the same entry and appear with the \`deveco.\` identifier prefix.
Check \`ohmatecli capabilities --format json\` and \`ohmatecli doctor --format json\` before selecting a capability.

Select the exact command and its registered arguments. Use \`ohmatecli COMMAND --help\` to confirm its syntax.
For structured native input, place public input in request.json and pass \`--input-file request.json\`.
Select an explicit project with \`--project .\`; do not infer a target device.
Use secure references for model credentials. This Skill grants no additional execution permission.
For a blocked write, inspect the returned Diff and obtain approval for that exact plan.
Resume with \`--approve-plan PLAN_ID\` only after approval; never manufacture or reuse a plan.
Use the receipt's journal and recovery commands when reverting an approved change.
Protocol tools require a terminal and must not be submitted as background tasks.

Request JSON or NDJSON for automation and preserve original diagnostics and artifact hashes.
Exit codes are 0 passed, 1 findings, 2 error, 3 degraded, 4 invalid, 5 blocked, 6 failed, 130 cancelled.
Treat degraded, blocked and incomplete evidence as unfinished work.
Verify this export with \`ohmatecli skill verify --path . --format json\` from this directory.
`;
  assertPortable(skill); assertPortable(catalog);
  const manifest = manifestSchema.parse({ schemaVersion: '1.0', name: 'ohmate-cli', toolVersion,
    registryHash: sha256(JSON.stringify(commands)),
    files: [{ path: 'SKILL.md', sha256: sha256(skill) }, { path: 'commands.json', sha256: sha256(catalog) }] });
  return { commands, files: { 'SKILL.md': skill, 'commands.json': catalog, 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` } };
}
