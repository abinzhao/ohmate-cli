/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { red } from 'colorette';
import type { Ora } from 'ora';

export function exitWithListCommandError(
  spinner: Ora | undefined,
  message: string
): never {
  if (spinner) {
    spinner.fail(message);
  } else {
    console.error(red(message));
  }
  process.exit(1);
}
