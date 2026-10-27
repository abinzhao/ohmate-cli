/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { shouldSuppressUpgradeBanner } from './upgrade-banner.js';

function buildCommandTree(): { root: Command; screenrecordStatus: Command } {
  const root = new Command('cli');
  const screenrecord = new Command('screenrecord');
  const status = new Command('status').option('--format <format>');
  screenrecord.addCommand(status);
  root.addCommand(screenrecord);
  return { root, screenrecordStatus: status };
}

describe('shouldSuppressUpgradeBanner', () => {
  it('suppresses for log --format json', () => {
    const log = new Command('log').option('--format <format>');
    log.parse(['--format', 'json'], { from: 'user' });
    expect(shouldSuppressUpgradeBanner(log)).toBe(true);
  });

  it('suppresses for log --format hilog', () => {
    const log = new Command('log').option('--format <format>');
    log.parse(['--format', 'hilog'], { from: 'user' });
    expect(shouldSuppressUpgradeBanner(log)).toBe(true);
  });

  it('does not suppress for log --format report or default', () => {
    const report = new Command('log').option('--format <format>');
    report.parse(['--format', 'report'], { from: 'user' });
    expect(shouldSuppressUpgradeBanner(report)).toBe(false);

    const plain = new Command('log');
    expect(shouldSuppressUpgradeBanner(plain)).toBe(false);
  });

  it('suppresses for ui screenrecord status --format json', () => {
    const { screenrecordStatus } = buildCommandTree();
    screenrecordStatus.parse(['--format', 'json'], { from: 'user' });
    expect(shouldSuppressUpgradeBanner(screenrecordStatus)).toBe(true);
  });

  it('does not suppress for ui screenrecord status without json', () => {
    const { screenrecordStatus } = buildCommandTree();
    expect(shouldSuppressUpgradeBanner(screenrecordStatus)).toBe(false);
  });

  it('does not suppress for other commands with a json format option', () => {
    const other = new Command('other').option('--format <format>');
    other.parse(['--format', 'json'], { from: 'user' });
    expect(shouldSuppressUpgradeBanner(other)).toBe(false);
  });
});
