#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { isMainModule } from '../runtime/entry-detection.js';

export async function main(argv: string[]): Promise<number> {
  // Set before loading the old modules: Telemetry snapshots this switch.
  process.env.DEVECO_CLI_DISABLE_TELEMETRY = '1';
  process.env.DEVECO_CLI_DISABLE_UPDATE = 'all';
  const { createLegacyProgram } = await import('./commands.js');
  const program = createLegacyProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: 'user' });
    return Number(process.exitCode ?? 0);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version') {
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return code?.startsWith('commander.') ? 2 : 6;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
