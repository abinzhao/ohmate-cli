#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Public entry: resolve the mandatory, same-version OHMate implementation.
// Command parsing, error handling, and exit code are all owned by the impl pkg.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { basename } from 'node:path';
import process from 'node:process';

// Pass wrapper identity to the impl process so an explicit update installs
// THIS package (the one the user installed), not the nested impl dependency.
// These env names are NOT in tsup's `env` map, so they survive as runtime
// process.env reads in the built impl bundle.
const wrapperPkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);
process.env.OHMATE_WRAPPER_NAME = wrapperPkg.name;
process.env.OHMATE_WRAPPER_VERSION = wrapperPkg.version;
if (!process.env.OHMATE_BIN_NAME) {
  const invoked = basename(process.argv[1] ?? '');
  process.env.OHMATE_BIN_NAME = invoked === 'ohc' || invoked === 'ohmatecli' ? invoked : 'ohmatecli';
}

const IMPL_PKG = '@ohmate/cli-common';

let cliPath;
try {
  cliPath = createRequire(import.meta.url).resolve(IMPL_PKG + '/dist/cli.js');
} catch (err) {
  process.stderr.write(
    `ohmatecli: implementation package "${IMPL_PKG}" is not installed.\n` +
      `  platform: ${process.platform}\n` +
      `  expected: ${IMPL_PKG}\n` +
      `  cause: ${err && err.message ? err.message : err}\n`
  );
  process.exit(1);
}

const args = [cliPath, ...process.argv.slice(2)];
if (process.env.DEVECO_CLI_DEBUG) {
  process.stderr.write(
    `[DEBUG] Executing: ${process.execPath} ${cliPath} (${args.length - 1} arguments)\n`
  );
}
const child = spawn(process.execPath, args, {
  shell: false,
  detached: process.platform !== 'win32',
  stdio: 'inherit',
  windowsHide: true,
});

const handlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const handler = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    // Each interrupt reaches cleanup in the impl; killing it would orphan detached tools.
    // Windows console Ctrl+C reaches the child directly.
    if (process.platform !== 'win32' || signal !== 'SIGINT') {
      child.kill(signal);
    }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

function cleanup() {
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
}

child.once('error', (error) => {
  cleanup();
  process.stderr.write(
    `ohmatecli: failed to spawn implementation: ${error.message}\n`
  );
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  cleanup();
  process.exitCode ??=
    code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
});
