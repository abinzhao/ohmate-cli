/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'child_process';

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    if (parsed.hostname === '') {
      return false;
    }
    if (url.includes('"')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function escapeForCmd(s: string): string {
  return s.replace(/[&|<>()^%!]/g, (c) => `^${c}`);
}

export async function openBrowser(url: string): Promise<void> {
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }

  let command: string;
  let args: string[];

  switch (process.platform) {
    case 'win32':
      command = 'cmd';
      args = ['/c', 'start', '""', escapeForCmd(url)];
      break;
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
      break;
  }

  const child = spawn(command, args, { stdio: 'ignore', shell: false, windowsHide: true });

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error('Failed to open browser', { cause: err }));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Browser process exited with code ${code}`));
      }
    });
  });
}
