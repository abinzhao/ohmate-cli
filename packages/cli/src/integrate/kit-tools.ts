/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { createExecutionContext } from '../runtime/context.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import { resolveRelease } from '../release/release-inputs.js';
import { verifyRelease } from '../release/release-gates.js';
import { releaseSchema } from '../release/types.js';
import { releaseHtml, releaseReportHash, releaseSarif } from '../release/render-report.js';
import { inspectKitDoctor } from './kit-doctor.js';
import { prepareRuntimeIntegration, runtimeIntegrationSchema, unavailableRuntimeIntegration } from './runtime-integration.js';

export type KitTool = 'doctor' | 'generate-integration' | 'verify-release';
const helperReleaseSchema = releaseSchema.extend({ format: z.enum(['json', 'sarif', 'html']).default('json') });
/** Shared source for bundled build helpers. Never applies patches or runs producers. */
export async function runKitTool(tool: KitTool, input: unknown, context: ExecutionContext): Promise<ToolResult> {
  if (tool === 'doctor') { return inspectKitDoctor(input, context); }
  if (tool === 'verify-release') {
    const { format, ...value } = helperReleaseSchema.parse(input);
    const report = await verifyRelease(await resolveRelease(value, context), context);
    const data = format === 'json' ? report : { format, reportHash: releaseReportHash(report),
      content: format === 'sarif' ? releaseSarif(report) : releaseHtml(report) };
    return { exitCode: report.summary.failed ? 1 : report.summary.incomplete ? 3 : 0, data };
  }
  const value = runtimeIntegrationSchema.parse(input);
  if (value.write) { throw new Error('HELPER_WRITE_UNAVAILABLE'); }
  if (value.profile === 'release-core') { return unavailableRuntimeIntegration(value); }
  return { exitCode: 0, data: { ...await prepareRuntimeIntegration(value, context), write: false } };
}
/** Only the thin executable calls this; importing the bundle has no effects. */
export async function kitToolMain(tool: KitTool, argv: string[]): Promise<void> {
  let result: ToolResult;
  try {
    const args = new Map<string, string>();
    if (argv.length !== 6) { throw new Error('HELPER_ARGUMENT_INVALID'); }
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index], value = argv[index + 1];
      if (!['--project', '--data-dir', '--input'].includes(key) || args.has(key) || !value) {
        throw new Error('HELPER_ARGUMENT_INVALID');
      }
      args.set(key, value);
    }
    const context = await createExecutionContext({ cwd: args.get('--project'), projectRoot: args.get('--project'),
      dataDir: args.get('--data-dir') });
    result = await runKitTool(tool, JSON.parse(args.get('--input')!), context);
  } catch {
    result = { exitCode: 4, data: { code: 'HELPER_INPUT_INVALID', write: false } };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.exitCode;
}
