#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runTerminal } from './terminal/index.js';
import { isMainModule } from './runtime/entry-detection.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runTerminal(argv, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    stdin: process.stdin, output: process.stdout,
  });
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
