/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as readline from 'readline';
import authCommand from './auth.js';
import { loginService, isDevecoCodeAuth, type UserInfo } from '../auth';

vi.mock('../auth', () => ({
  loginService: {
    getUserInfo: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
  getTeamList: vi.fn(),
  isDevecoCodeAuth: vi.fn(() => false),
  DefinedError: class DefinedError extends Error {},
}));

vi.mock('../trace/index.js', () => ({
  telemetry: { track: vi.fn().mockResolvedValue(undefined) },
  EventType: { CommandExecuted: 'command_executed' },
  toTraceErrorCode: vi.fn(() => null),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: (_query: string, callback: () => void) => callback(),
    close: vi.fn(),
  })),
}));

const loggedInUser = { userName: 'tester' } as unknown as UserInfo;

function setStdinTty(value: boolean | undefined) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('auth login confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDevecoCodeAuth).mockReturnValue(false);
    vi.mocked(loginService.getUserInfo).mockResolvedValue(null);
    vi.mocked(loginService.login).mockResolvedValue(loggedInUser);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setStdinTty(undefined);
  });

  it('waits for Enter on an interactive terminal', async () => {
    setStdinTty(true);
    await authCommand.parseAsync(['login'], { from: 'user' });
    expect(readline.createInterface).toHaveBeenCalledTimes(1);
    expect(loginService.login).toHaveBeenCalledTimes(1);
  });

  it('skips the Enter prompt with --no-prompt', async () => {
    setStdinTty(true);
    await authCommand.parseAsync(['login', '--no-prompt'], { from: 'user' });
    expect(readline.createInterface).not.toHaveBeenCalled();
    expect(loginService.login).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Enter confirmation skipped')
    );
  });

  it('skips the Enter prompt when stdin is not a TTY', async () => {
    await authCommand.parseAsync(['login'], { from: 'user' });
    expect(readline.createInterface).not.toHaveBeenCalled();
    expect(loginService.login).toHaveBeenCalledTimes(1);
  });

  it('does not prompt when already logged in', async () => {
    vi.mocked(loginService.getUserInfo).mockResolvedValue(loggedInUser);
    setStdinTty(true);
    await authCommand.parseAsync(['login'], { from: 'user' });
    expect(readline.createInterface).not.toHaveBeenCalled();
    expect(loginService.login).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Already logged in')
    );
  });
});
