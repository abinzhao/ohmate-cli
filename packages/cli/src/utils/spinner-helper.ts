/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import ora from 'ora';

/**
 * Helper class to manage ora spinner with pause/resume support for console.log interactions
 */
export class SpinnerHelper {
  private spinner: ReturnType<typeof ora> | null = null;
  private isRunning: boolean = false;

  start(text: string): void {
    if (!this.spinner) {
      this.spinner = ora(text);
    } else {
      this.spinner.text = text;
    }
    this.spinner.start();
    this.isRunning = true;
  }

  stop(): void {
    if (this.spinner && this.isRunning) {
      this.spinner.stop();
      this.isRunning = false;
    }
  }

  succeed(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text);
      this.isRunning = false;
    }
  }

  fail(text?: string): void {
    if (this.spinner) {
      this.spinner.fail(text);
      this.isRunning = false;
    }
  }
}
