/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red, cyan } from 'colorette';
import * as readline from 'readline';
import {
  loginService,
  getTeamList,
  isDevecoCodeAuth,
  DefinedError,
  type Team,
} from '../auth';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

async function withAuthTrace(
  event: CommandExecuted,
  action: () => Promise<void>,
  onError?: (error: Error) => Error | void
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await action();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    const wrapped = onError?.(error as Error);
    if (wrapped) {
      throw wrapped;
    }
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

function renderTeamTable(teams: Team[]): string {
  if (teams.length === 0) {
    return cyan('No teams found for the current user.');
  }
  const header = ['Id', 'Name'];
  const rows = teams.map((team) => [team.id, team.name]);
  const widths = header.map((cell, idx) =>
    Math.max(cell.length, ...rows.map((row) => row[idx].length))
  );
  const fmt = (cells: string[]): string =>
    cells.map((cell, idx) => cell.padEnd(widths[idx])).join('  ');
  const sep = widths.map((width) => '-'.repeat(width)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

interface LoginOptions {
  // Commander maps --no-prompt onto `prompt`: true by default, false when the flag is passed.
  prompt?: boolean;
}

const authCommand = new Command('auth').description(
  'Authentication commands (login, logout, status, team)'
);

/** Opens the browser directly with --no-prompt or on non-TTY stdin; otherwise waits for Enter. */
async function confirmBrowserOpen(skipPrompt: boolean): Promise<void> {
  if (skipPrompt || !process.stdin.isTTY) {
    // Piped stdin can never answer the prompt; waiting would hang even after EOF.
    console.log(
      cyan(
        skipPrompt
          ? 'Opening browser for login... (--no-prompt: Enter confirmation skipped)'
          : 'Non-interactive terminal: opening browser for login without the Enter confirmation...'
      )
    );
    return;
  }
  console.log(
    cyan(
      'Press Enter to open browser for login (or pass --no-prompt to skip)...'
    )
  );
  await waitForEnter();
}

async function handleLogin(options: LoginOptions): Promise<void> {
  if (isDevecoCodeAuth()) {
    console.log(
      red('Login is managed by DevEco Code. Login from DevEco Code instead.')
    );
    return;
  }
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: ['auth', 'login'],
  };
  await withAuthTrace(
    event,
    async () => {
      const userInfo = await loginService.getUserInfo();
      if (userInfo) {
        console.log(cyan(`Already logged in, User Name:${userInfo.userName}`));
        return;
      }
      console.log(cyan('Starting login process...'));
      await confirmBrowserOpen(options.prompt === false);
      const newUserInfo = await loginService.login();
      console.log(
        cyan(`Login successful. Logged in as ${newUserInfo.userName}.`)
      );
    },
    (e) => {
      if (e instanceof DefinedError) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Network connection failed')) {
        throw e;
      }
      throw new Error('Login failed', { cause: e });
    }
  );
}

authCommand
  .command('login')
  .description('Log in to your Huawei Developer account')
  .option(
    '--no-prompt',
    'Open the browser immediately without the interactive Enter confirmation (agents and non-interactive terminals)'
  )
  .action(async (options: LoginOptions) => {
    await handleLogin(options);
  });

authCommand
  .command('logout')
  .description('Log out of your Huawei Developer account')
  .action(async () => {
    if (isDevecoCodeAuth()) {
      console.log(
        red(
          'Login is managed by DevEco Code. Log out from DevEco Code instead.'
        )
      );
      return;
    }
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['auth', 'logout'],
    };
    await withAuthTrace(
      event,
      async () => {
        const loggedOut = await loginService.logout();
        if (loggedOut) {
          console.log(cyan('Logout successful'));
        } else {
          console.log(cyan('Already logged out.'));
        }
      },
      (e) => new Error('Logout failed', { cause: e })
    );
  });

authCommand
  .command('status')
  .description('Show the currently logged-in user')
  .action(async () => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['auth', 'status'],
    };
    await withAuthTrace(
      event,
      async () => {
        const userInfo = await loginService.getUserInfo();
        if (!userInfo) {
          console.log(cyan('Not logged in'));
          return;
        }
        console.log(cyan(`Current user: ${userInfo.userName}`));
      },
      () => {
        console.log(cyan('Not logged in'));
      }
    );
  });

const teamCommand = authCommand
  .command('team')
  .description('Team-related commands');

teamCommand
  .command('list')
  .description('List team accounts the current user has joined')
  .action(async () => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['auth', 'team', 'list'],
    };
    await withAuthTrace(
      event,
      async () => {
        const result = await getTeamList();
        console.log(renderTeamTable(result.teamList));
      },
      (e) => {
        if (e instanceof DefinedError) {
          console.log(red(e.message));
          return;
        }
        throw new Error('Failed to list teams', { cause: e });
      }
    );
  });

export default authCommand;
