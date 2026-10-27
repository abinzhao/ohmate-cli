/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import build from '../commands/build.js';
import run from '../commands/run.js';
import update from '../commands/update.js';
import device from '../commands/device.js';
import emulator from '../commands/emulator.js';
import auth from '../commands/auth.js';
import skills from '../commands/skills.js';
import log from '../commands/log.js';
import create from '../commands/create.js';
import init from '../commands/init.js';
import serve from '../commands/serve.js';
import docs from '../commands/doc.js';
import ui from '../commands/ui.js';
import check from '../commands/check.js';
import signature from '../commands/signature.js';
import verify from '../commands/verify.js';

/** Registration only. Actions are executed exclusively in the legacy child. */
export function createLegacyProgram(): Command {
  const program = new Command('ohmatecli');
  program.description('OHMate bundled DevEco command compatibility');
  for (const command of [
    build, run, update, device, emulator, auth, skills, log,
    create, init, serve, docs, ui, check, signature, verify,
  ]) {
    program.addCommand(command);
  }
  return program;
}
