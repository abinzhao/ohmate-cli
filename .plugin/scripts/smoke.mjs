/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { repoRoot, loadPlatforms, artifactPaths } from './platforms.mjs';

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'deveco-qoder-smoke-')
);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(path|home|userprofile|npm_config_cache|deveco_plugin_.*)$/i.test(key)) {
    delete env[key];
  }
}
Object.assign(env, {
  PATH: path.dirname(process.execPath),
  HOME: temporary,
  USERPROFILE: temporary,
  npm_config_cache: path.join(temporary, 'npm-cache'),
  DEVECO_PLUGIN_INSTALL_ROOT: path.join(temporary, 'private'),
  DEVECO_CLI_DATA_DIR: path.join(temporary, 'data'),
  DEVECO_CLI_DISABLE_TELEMETRY: '1',
});

async function invoke(plugin, args, capture = false) {
  const entry = path.join(plugin, 'runtime/main.mjs');
  if (env.DEVECO_CLI_DEBUG) {
    console.error(`Executing: ${process.execPath} ${entry} ${args.join(' ')}`);
  }
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let output = '';
  child.stdout?.on('data', (data) => {
    output += data;
  });
  child.stderr?.on('data', (data) => {
    process.stderr.write(data);
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${args.join(' ')} exited with ${code}`))
    );
  });
  return output;
}

try {
  for (const platform of await loadPlatforms()) {
    const plugin = artifactPaths(platform).target;
    const metadata = JSON.parse(
      await fs.readFile(path.join(plugin, 'runtime.json'))
    );
    await invoke(plugin, ['install']);
    const selected = JSON.parse(await invoke(plugin, ['check'], true));
    if (selected.source !== 'private') {
      throw new Error(
        `Smoke test selected ${selected.source}, not the isolated private Runtime.`
      );
    }
    const version = (await invoke(plugin, ['run', '--version'], true)).trim();
    if (version !== metadata.packageVersion) {
      throw new Error(`Expected ${metadata.packageVersion}; got ${version}`);
    }
    const help = await invoke(plugin, ['run', '--help'], true);
    if (!help.includes('build') || !help.includes('run')) {
      throw new Error('CLI help is missing expected commands.');
    }
    console.log(
      `${platform.platform} Runtime smoke passed: ${metadata.packageName}@${version}`
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
