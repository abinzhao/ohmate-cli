/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  test,
  expect,
  vi,
} from 'vitest';
import {
  buildPlugin,
  repoRoot,
  generateSkill,
  sha256,
} from '../scripts/build.mjs';
import { validateDirectory, validateArchive } from '../scripts/validate.mjs';
import {
  loadPlatforms,
  renderTemplate,
  templateVariables,
} from '../scripts/platforms.mjs';
import {
  resolveRuntime,
  managedRuntime,
  WRAPPER_MARKER,
} from '../runtime/resolve.js';
import {
  installRuntime,
  parseVersion,
  npmEnvironment,
} from '../runtime/install.js';
import { runProcess } from '../runtime/process.js';
import type {
  InstallDependencies,
  RuntimeMetadata,
  RuntimeProcessOptions,
  RuntimeRunner,
} from '../runtime/types.js';

interface PlatformConfig {
  platform: string;
  hostName: string;
  agentName: string;
  manifestPath: string;
  manifest: { name: string };
  runtime: { hostBinDirs: string[]; installRoot: string };
}

interface BuildArtifact {
  platform: string;
  target: string;
  zipPath: string;
}

const require = createRequire(path.join(repoRoot, 'packages/cli/package.json'));
const AdmZip = require('adm-zip');
const windows = process.platform === 'win32';
const metadata = {
  packageName: '@deveco-test/deveco-cli',
  packageVersion: '1.2.3',
  nodeMajorMinimum: 22,
  hostBinDirs: ['.host/bin'],
  installRoot: '.local/share/host/deveco-cli',
};
const ECHO =
  'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),custom:process.env.PLUGIN_TEST_VALUE}));';
let suiteRoot: string;
let platform: PlatformConfig;
let artifact: BuildArtifact;
let built: RuntimeMetadata;
let root: string;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-plugin-test-'));
  [platform] = await loadPlatforms();
  artifact = await buildPlugin(platform, path.join(suiteRoot, 'build'));
  built = JSON.parse(
    await fs.readFile(path.join(artifact.target, 'runtime.json'), 'utf8')
  );
});
afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(suiteRoot, 'case-'));
  vi.stubEnv('DEVECO_PLUGIN_INSTALL_ROOT', path.join(root, 'private'));
  vi.stubEnv('DEVECO_CLI_DEBUG', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function env(extra: Record<string, string | undefined> = {}) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(path|home|userprofile|deveco_plugin_.*|npm_config_.*)$/i.test(key)) {
      delete base[key];
    }
  }
  return {
    ...base,
    PATH: path.dirname(process.execPath),
    HOME: root,
    USERPROFILE: root,
    DEVECO_PLUGIN_INSTALL_ROOT: path.join(root, 'private'),
    ...extra,
  };
}

async function write(file: string, data: string, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  await fs.chmod(file, mode);
}

async function publish(
  packageRoot: string,
  name: string,
  version: string,
  script = `console.log(${JSON.stringify(version)});`
) {
  await write(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name, version, bin: { devecocli: 'cli.js' } })
  );
  await write(path.join(packageRoot, 'cli.js'), script, 0o755);
}

// An npm-style bin in `dir`; a null version leaves the entry without an owning package.
async function fakeCli(
  dir: string,
  text = ECHO,
  version: string | null = '99.0.0'
) {
  const entry = path.join(dir, 'cli.js');
  await write(entry, text, 0o755);
  if (version) {
    await write(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: metadata.packageName,
        version,
        bin: { devecocli: 'cli.js' },
      })
    );
  }
  if (windows) {
    await write(
      path.join(dir, 'devecocli.cmd'),
      '@echo off\r\nnode "%dp0%\\cli.js" %*\r\n'
    );
  } else {
    await fs.symlink(entry, path.join(dir, 'devecocli'));
  }
  return entry;
}

async function privateRuntime(version: string, name: string, script?: string) {
  const id = '00000000-0000-4000-8000-000000000001';
  const packageRoot = path.join(
    root,
    'private/installs',
    id,
    'node_modules',
    ...name.split('/')
  );
  await publish(packageRoot, name, version, script);
  await write(
    path.join(root, 'private/current.json'),
    JSON.stringify({ installId: id, packageName: name })
  );
  return path.join(packageRoot, 'cli.js');
}

function invoke(args: string[], options: RuntimeProcessOptions = {}) {
  return runProcess(
    process.execPath,
    [path.join(artifact.target, 'runtime/main.mjs'), ...args],
    {
      capture: true,
      timeout: 10000,
      env: env(),
      ...options,
    }
  );
}

function populate(target: string, version = '1.2.3', reported = version) {
  return publish(
    path.join(target, 'node_modules', metadata.packageName),
    metadata.packageName,
    version,
    `console.log(${JSON.stringify(reported)});`
  );
}

function installer(run: RuntimeRunner): InstallDependencies {
  return {
    npmInvocation: async () => ({
      command: process.execPath,
      args: ['fake-npm.js'],
    }),
    runProcess: run,
  };
}

const pluginBin = () => path.join(artifact.target, 'bin');
const joinPath = (...dirs: string[]) => dirs.join(path.delimiter);

test('ZIP is self-contained, has executable launchers and tracks the current CLI package', async () => {
  await validateDirectory(artifact.target, platform);
  await validateArchive(artifact.zipPath, platform);
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'packages/cli-wrapper/package.json'), 'utf8')
  );
  expect(built).toEqual({
    packageName: pkg.name,
    packageVersion: pkg.version,
    nodeMajorMinimum: 22,
    ...platform.runtime,
  });
  const original = await fs.readFile(path.join(repoRoot, 'SKILL.md'), 'utf8');
  const guidance = renderTemplate(
    await fs.readFile(
      path.join(repoRoot, '.plugin/runtime-skill-supplement.md'),
      'utf8'
    ),
    templateVariables(platform)
  );
  expect(
    await fs.readFile(
      path.join(artifact.target, 'skills/deveco-cli/SKILL.md'),
      'utf8'
    )
  ).toBe(generateSkill(original, guidance));
  const provenance = JSON.parse(
    await fs.readFile(path.join(artifact.target, 'provenance.json'), 'utf8')
  );
  expect(provenance.skillSha256).toBe(sha256(original));
  expect(await fs.readFile(`${artifact.zipPath}.sha256`, 'utf8')).toContain(
    sha256(await fs.readFile(artifact.zipPath))
  );
  const zip = new AdmZip(await fs.readFile(artifact.zipPath));
  const extracted = path.join(root, 'extracted');
  zip.extractAllTo(extracted);
  const result = await runProcess(
    process.execPath,
    [path.join(extracted, 'runtime/main.mjs'), 'install', '--help'],
    { capture: true, env: env() }
  );
  expect(result.exitCode).toBe(0);
  for (const text of [pkg.name, pkg.version, 'never modified']) {
    expect(result.stdout).toContain(text);
  }
});

test('platform config builds the platform manifest outside shared sources', async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(artifact.target, platform.manifestPath), 'utf8')
  );
  expect(manifest).toEqual(platform.manifest);
  expect(artifact.target).toBe(
    path.join(suiteRoot, 'build', platform.manifest.name)
  );
  await expect(
    fs.stat(path.join(repoRoot, '.plugin', platform.manifestPath))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('another host renders its configured runtime paths', async () => {
  const other = {
    ...platform,
    platform: 'example-host',
    hostName: 'Example Host',
    agentName: 'example-agent',
    manifestPath: '.example-plugin/plugin.json',
    runtime: {
      hostBinDirs: [],
      installRoot: '.example/runtime',
    },
  };
  const config = path.join(root, 'platforms.json');
  await write(config, JSON.stringify([other]));
  const [loaded] = await loadPlatforms(config);
  const result = await buildPlugin(loaded, path.join(root, 'other-build'));
  const readme = await fs.readFile(
    path.join(result.target, 'README.md'),
    'utf8'
  );
  expect(readme).toContain(other.hostName);
  expect(readme).toContain('~/.example/runtime');
  const skill = await fs.readFile(
    path.join(result.target, 'skills/deveco-cli/SKILL.md'),
    'utf8'
  );
  expect(skill).toContain('## Example Host Plugin Runtime');
  expect(skill).toContain('--agent example-agent --force');
});

test.each<[string, (p: PlatformConfig) => unknown, RegExp]>([
  ['an empty array', () => [], /non-empty array/],
  ['a duplicate platform', (p) => [p, p], /duplicate plugin platform/],
  ['a missing host name', (p) => [{ ...p, hostName: ' ' }], /host name/],
  ['a missing agent name', (p) => [{ ...p, agentName: '' }], /agent name/],
  [
    'an unsafe manifest path',
    (p) => [{ ...p, manifestPath: '../x.json' }],
    /Invalid manifest path/,
  ],
  [
    'a wrong plugin name',
    (p) => [{ ...p, manifest: { ...p.manifest, name: 'x' } }],
    /Invalid plugin manifest/,
  ],
  [
    'an install root outside the home directory',
    (p) => [{ ...p, runtime: { ...p.runtime, installRoot: '../x' } }],
    /relative to the user home/,
  ],
  [
    'an absolute host directory',
    (p) => [{ ...p, runtime: { ...p.runtime, hostBinDirs: ['/usr/bin'] } }],
    /relative to the user home/,
  ],
  [
    'missing host directories',
    (p) => [{ ...p, runtime: { ...p.runtime, hostBinDirs: undefined } }],
    /relative to the user home/,
  ],
])('platform config rejects %s', async (_name, config, message) => {
  const file = path.join(root, 'platforms.json');
  await write(file, JSON.stringify(config(platform)));
  await expect(loadPlatforms(file)).rejects.toThrow(message);
});

test('templates render platform values and reject unknown variables', () => {
  const variables = templateVariables(platform);
  expect(
    renderTemplate('{{hostName}} {{installRoot}} {{agentName}}', variables)
  ).toBe(
    `${platform.hostName} \`~/${platform.runtime.installRoot}\` ${platform.agentName}`
  );
  expect(() => renderTemplate('{{missing}}', variables)).toThrow(
    'Unknown plugin template variable'
  );
});

test.each<[string, (dir: string) => Promise<unknown>, RegExp]>([
  [
    'missing manifest',
    async (dir) => fs.unlink(path.join(dir, platform.manifestPath)),
    /Missing plugin file/,
  ],
  [
    'extra source',
    async (dir) => write(path.join(dir, 'node_modules/unwanted'), 'x'),
    /Unexpected plugin file/,
  ],
  [
    'wrong manifest',
    async (dir) =>
      write(path.join(dir, platform.manifestPath), '{"name":"wrong"}'),
    /Invalid plugin manifest/,
  ],
  [
    'wrong Runtime',
    async (dir) => write(path.join(dir, 'runtime.json'), '{}'),
    /Invalid Runtime metadata/,
  ],
  [
    'Runtime paths from another platform',
    async (dir) =>
      write(
        path.join(dir, 'runtime.json'),
        JSON.stringify({ ...built, hostBinDirs: ['.other/bin'] })
      ),
    /Invalid Runtime metadata/,
  ],
  [
    'wrong provenance',
    async (dir) => write(path.join(dir, 'provenance.json'), '{}'),
    /provenance/,
  ],
  [
    'missing skill guidance',
    async (dir) =>
      write(
        path.join(dir, 'skills/deveco-cli/SKILL.md'),
        '---\nname: deveco-cli\n---\n'
      ),
    /Invalid generated skill/,
  ],
  [
    'an unrendered template',
    async (dir) => write(path.join(dir, 'README.md'), '{{hostName}}'),
    /Unrendered template variable/,
  ],
  [
    'CRLF shell',
    async (dir) => write(path.join(dir, 'bin/devecocli'), '#!/bin/sh\r\n'),
    /Invalid launcher/,
  ],
])('validator rejects %s', async (_name, mutate, message) => {
  const dir = path.join(root, 'invalid');
  await fs.cp(artifact.target, dir, { recursive: true });
  await mutate(dir);
  await expect(validateDirectory(dir, platform)).rejects.toThrow(message);
});

test('validator rejects archives without executable bits', async () => {
  const zip = new AdmZip(await fs.readFile(artifact.zipPath));
  zip.getEntry('bin/devecocli').attr = 0;
  const file = path.join(root, 'invalid.zip');
  await fs.writeFile(file, zip.toBuffer());
  await expect(validateArchive(file, platform)).rejects.toThrow(
    'Missing executable permissions'
  );
});

test('an explicit entry is used as-is and an invalid one fails without falling back', async () => {
  const entry = await fakeCli(path.join(root, 'explicit'), ECHO, '0.0.1');
  expect(
    await resolveRuntime(
      metadata,
      env({ DEVECO_PLUGIN_RUNTIME_EXECUTABLE: entry })
    )
  ).toMatchObject({ source: 'explicit', version: '0.0.1', skipped: [] });
  await expect(
    resolveRuntime(
      metadata,
      env({ DEVECO_PLUGIN_RUNTIME_EXECUTABLE: path.join(root, 'missing') })
    )
  ).rejects.toThrow('Invalid Runtime entry');
});

test('host then global entries are selected when they meet the minimum version', async () => {
  const dir = path.join(root, 'tools');
  await fakeCli(dir, ECHO, metadata.packageVersion);
  const testEnv = env({ PATH: dir });
  expect(await resolveRuntime(metadata, testEnv)).toMatchObject({
    source: 'path',
    version: '1.2.3',
    skipped: [],
  });
  await fakeCli(path.join(root, '.host/bin'), ECHO, '1.3.0-beta.1');
  expect(await resolveRuntime(metadata, testEnv)).toMatchObject({
    source: 'host',
    version: '1.3.0-beta.1',
  });
});

test.each(['missing', 'old', 'unidentified'] as const)(
  'a %s first host entry is skipped and the second host entry is selected before PATH',
  async (first) => {
    const hostBinDirs = ['.first-host/bin', '.second-host/bin'];
    const firstEntry =
      first === 'missing'
        ? null
        : await fakeCli(
            path.join(root, hostBinDirs[0]),
            ECHO,
            first === 'old' ? '1.2.2' : null
          );
    const secondEntry = await fakeCli(
      path.join(root, hostBinDirs[1]),
      ECHO,
      metadata.packageVersion
    );
    const globalDir = path.join(root, 'tools');
    await fakeCli(globalDir, ECHO, metadata.packageVersion);

    const resolved = await resolveRuntime(
      { ...metadata, hostBinDirs },
      env({ PATH: globalDir })
    );
    expect(resolved).toMatchObject({
      source: 'host',
      entry: await fs.realpath(secondEntry),
      version: metadata.packageVersion,
    });
    expect(resolved.skipped).toEqual(
      firstEntry
        ? [
            {
              source: 'host',
              entry: await fs.realpath(firstEntry),
              version: first === 'old' ? '1.2.2' : null,
            },
          ]
        : []
    );
  }
);

test('PATH is selected only after both host entries fail their version checks', async () => {
  const hostBinDirs = ['.first-host/bin', '.second-host/bin'];
  const firstEntry = await fakeCli(
    path.join(root, hostBinDirs[0]),
    ECHO,
    '1.2.2'
  );
  const secondEntry = await fakeCli(
    path.join(root, hostBinDirs[1]),
    ECHO,
    null
  );
  const globalDir = path.join(root, 'tools');
  const globalEntry = await fakeCli(globalDir, ECHO, metadata.packageVersion);

  const resolved = await resolveRuntime(
    { ...metadata, hostBinDirs },
    env({ PATH: globalDir })
  );
  expect(resolved).toMatchObject({
    source: 'path',
    entry: await fs.realpath(globalEntry),
    version: metadata.packageVersion,
  });
  expect(resolved.skipped).toEqual([
    {
      source: 'host',
      entry: await fs.realpath(firstEntry),
      version: '1.2.2',
    },
    {
      source: 'host',
      entry: await fs.realpath(secondEntry),
      version: null,
    },
  ]);
});

test('an old global CLI is skipped, reported and left unchanged while the plugin-managed Runtime runs', async () => {
  const marker = path.join(root, 'executed');
  const dir = path.join(root, 'tools');
  const oldEntry = await fakeCli(
    dir,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    '0.0.1'
  );
  const before = await fs.readFile(oldEntry, 'utf8');
  const entry = await privateRuntime(
    built.packageVersion,
    built.packageName,
    'console.log("private " + process.argv.slice(2).join(" "));'
  );
  const testEnv = env({ PATH: joinPath(pluginBin(), dir) });
  const check = await invoke(['check'], { env: testEnv });
  expect(check.exitCode).toBe(0);
  const resolved = JSON.parse(check.stdout);
  expect(resolved).toMatchObject({
    source: 'private',
    entry,
    version: built.packageVersion,
  });
  expect(resolved.skipped).toEqual([
    {
      source: 'path',
      entry: await fs.realpath(oldEntry),
      version: '0.0.1',
    },
  ]);
  const run = await invoke(['run', 'build'], { env: testEnv });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.trim()).toBe('private build');
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(oldEntry, 'utf8')).toBe(before);
});

test('with only an old global CLI, check asks to install the plugin-managed Runtime', async () => {
  const dir = path.join(root, 'tools');
  await fakeCli(dir, ECHO, '0.0.1');
  for (const args of [['check'], ['run', '--version']]) {
    const result = await invoke(args, { env: env({ PATH: dir }) });
    expect(result.exitCode).toBe(1);
    for (const text of [
      `No DevEco CLI meeting the minimum version ${built.packageVersion}`,
      'global DevEco CLI',
      'version 0.0.1',
      'left unchanged',
      'Run devecocli-install',
    ]) {
      expect(result.stderr).toContain(text);
    }
    expect(result.stderr).not.toContain('--global');
  }
});

test.each<
  [string, () => Promise<unknown>, { source: string; version: string | null }[]]
>([
  [
    'host-managed',
    () => fakeCli(path.join(root, '.host/bin'), ECHO, '1.2.2'),
    [{ source: 'host', version: '1.2.2' }],
  ],
  [
    'unidentified global',
    () => fakeCli(path.join(root, 'tools'), ECHO, null),
    [{ source: 'path', version: null }],
  ],
])(
  'a %s CLI below the minimum is skipped in favour of the plugin-managed Runtime',
  async (_name, setup, skipped) => {
    await setup();
    await privateRuntime(metadata.packageVersion, metadata.packageName);
    const resolved = await resolveRuntime(
      metadata,
      env({ PATH: path.join(root, 'tools') })
    );
    expect(resolved.source).toBe('private');
    expect(resolved.skipped).toMatchObject(skipped);
  }
);

test('an old plugin-managed Runtime is rejected with the install hint', async () => {
  await fakeCli(path.join(root, 'tools'), ECHO, '1.0.0');
  await privateRuntime('1.2.2', metadata.packageName);
  await expect(
    resolveRuntime(metadata, env({ PATH: path.join(root, 'tools') }))
  ).rejects.toThrow(
    /plugin-managed .*version 1\.2\.2.*minimum version 1\.2\.3.*Skipped the global .*version 1\.0\.0.*Run devecocli-install/
  );
});

test.each([true, false])(
  'the absolute launcher selects the private CLI regardless of PATH order (global first: %s)',
  async (globalFirst) => {
    const dir = path.join(root, 'tools');
    await fakeCli(dir, 'console.log("old global");', '0.0.1');
    await privateRuntime(built.packageVersion, built.packageName);
    const dirs = globalFirst ? [dir, pluginBin()] : [pluginBin(), dir];
    const testEnv = env({
      PATH: joinPath(
        ...dirs,
        path.dirname(process.execPath),
        ...(windows
          ? [path.join(process.env.SystemRoot ?? '', 'System32')]
          : ['/usr/bin', '/bin'])
      ),
    });
    const result = await invoke(['check'], { env: testEnv, cwd: root });
    expect(result.exitCode).toBe(0);
    const resolved = JSON.parse(result.stdout);
    expect(resolved.source).toBe('private');
    expect(resolved).not.toHaveProperty('shadowedBy');
    expect(resolved).not.toHaveProperty('standaloneSkills');
    expect(resolved.launcher).toBe(
      path.join(artifact.target, 'bin', windows ? 'devecocli.cmd' : 'devecocli')
    );
    const command = windows ? process.env.ComSpec : resolved.launcher;
    const args = windows
      ? ['/d', '/s', '/c', '""' + resolved.launcher + '" --version"']
      : ['--version'];
    const run = await runProcess(command, args, {
      windowsVerbatimArguments: windows,
      capture: true,
      timeout: 10000,
      env: testEnv,
      cwd: root,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(built.packageVersion);
  }
);

test('check skips its own wrapper, does not execute the CLI or install anything', async () => {
  const marker = path.join(root, 'executed');
  const entry = await fakeCli(
    path.join(root, 'tools'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`
  );
  const testEnv = env({
    PATH: joinPath(pluginBin(), path.join(root, 'tools')),
  });
  const result = await invoke(['check'], { env: testEnv });
  expect(result.exitCode).toBe(0);
  const resolved = JSON.parse(result.stdout);
  expect(resolved).toMatchObject({
    source: 'path',
    version: '99.0.0',
    minimumVersion: built.packageVersion,
    skipped: [],
  });
  expect(resolved.entry).toContain(path.basename(path.dirname(entry)));
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(root, 'private'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('missing Runtime and self-reference give actionable errors', async () => {
  const result = await invoke(['check'], { env: env({ PATH: pluginBin() }) });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('devecocli-install');
  expect(WRAPPER_MARKER).toBeTruthy();
});

test('forwarding preserves cwd, environment, argv, stdout, stderr and failure code', async () => {
  const code = `${ECHO}process.stderr.write("original error");process.exitCode=23;`;
  const dir = path.join(root, '工具 with spaces');
  await fakeCli(dir, code);
  const cwd = path.join(root, '鸿蒙 project');
  await fs.mkdir(cwd);
  const args = [
    'ui',
    'text',
    'hello "quoted" & echo bad',
    '中文',
    '',
    '%PATH%',
    '$(bad)',
    'a\\b',
  ];
  const result = await invoke(['run', ...args], {
    cwd,
    env: env({ PATH: dir, PLUGIN_TEST_VALUE: 'kept' }),
  });
  expect(result.exitCode).toBe(23);
  expect(JSON.parse(result.stdout)).toEqual({
    argv: args,
    cwd,
    custom: 'kept',
  });
  expect(result.stderr).toBe('original error');
});

test('installer uses a private prefix and publishes only a verified Runtime', async () => {
  const calls: string[][] = [];
  const deps = installer(async (command, args, options) => {
    calls.push(args);
    if (args[0] !== 'fake-npm.js') {
      return runProcess(command, args, options);
    }
    const target = args[args.indexOf('--prefix') + 1];
    await populate(target);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  expect(
    await installRuntime(
      metadata,
      metadata.packageVersion,
      artifact.target,
      deps
    )
  ).toBe(0);
  expect(calls[0]).toContain(`${metadata.packageName}@1.2.3`);
  expect(calls[0]).not.toContain('-g');
  expect(calls[0]).not.toContain('--global');
  const selected = await managedRuntime(
    path.join(root, 'private'),
    metadata.packageName
  );
  expect(selected?.version).toBe('1.2.3');
  expect(selected?.source).toBe('private');
  await expect(
    fs.stat(path.join(root, 'private/install.lock'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('failed, unverified or too-old installs preserve the previous active Runtime', async () => {
  const install = async (
    spec: string,
    installed = spec,
    reported = installed,
    exitCode = 0
  ) =>
    installRuntime(
      metadata,
      spec,
      artifact.target,
      installer(async (command, args, options) => {
        if (args[0] !== 'fake-npm.js') {
          return runProcess(command, args, options);
        }
        if (exitCode) {
          return { exitCode, stdout: '', stderr: '' };
        }
        await populate(args[args.indexOf('--prefix') + 1], installed, reported);
        return { exitCode: 0, stdout: '', stderr: '' };
      })
    );
  await install('1.2.3');
  const state = await fs.readFile(
    path.join(root, 'private/current.json'),
    'utf8'
  );
  expect(await install('1.2.4', '1.2.4', '1.2.4', 17)).toBe(17);
  await expect(install('1.2.4', '1.2.4', 'wrong')).rejects.toThrow(
    'verification failed'
  );
  await expect(install('old', '1.2.2')).rejects.toThrow('below the minimum');
  await expect(
    installRuntime(
      metadata,
      '1.2.2',
      artifact.target,
      installer(async () => {
        throw new Error('must not run');
      })
    )
  ).rejects.toThrow('below the minimum');
  expect(
    await fs.readFile(path.join(root, 'private/current.json'), 'utf8')
  ).toBe(state);
  expect(await fs.readdir(path.join(root, 'private/installs'))).toHaveLength(1);
});

test('concurrent install fails while the first owns its lock', async () => {
  let ready: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    ready = () => resolve();
  });
  const release = new Promise<void>((resolve) => {
    resume = () => resolve();
  });
  const first = installRuntime(
    metadata,
    '1.2.3',
    artifact.target,
    installer(async () => {
      ready?.();
      await release;
      return { exitCode: 9, stdout: '', stderr: '' };
    })
  );
  try {
    await waiting;
    await expect(
      installRuntime(
        metadata,
        '1.2.3',
        artifact.target,
        installer(async () => {
          throw new Error('must not run');
        })
      )
    ).rejects.toThrow('Another installation');
  } finally {
    resume?.();
    await first;
  }
  await expect(
    fs.stat(path.join(root, 'private/install.lock'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('private CLI update is blocked but docs and help are forwarded', async () => {
  await privateRuntime(
    built.packageVersion,
    built.packageName,
    'console.log(JSON.stringify(process.argv.slice(2)));'
  );
  const result = await invoke(['run', 'update']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('plugin-managed');
  for (const arg of ['docs', '--help']) {
    const passed = await invoke(['run', 'update', arg]);
    expect(passed.exitCode).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual(['update', arg]);
  }
});

test('private Runtime never runs init or skill mutations, including explicit private entries', async () => {
  const skill = path.join(root, '.host/skills', 'deveco-cli/SKILL.md');
  await write(skill, 'original global skill');
  const entry = await privateRuntime(
    built.packageVersion,
    built.packageName,
    `require('node:fs').writeFileSync(${JSON.stringify(skill)}, 'modified');`
  );
  for (const blocked of [
    ['init'],
    ['init', '--skill', '--force'],
    ['init', '--mcp'],
    ['init', '--path', '--help'],
    ['skills', 'add', '--all'],
    ['skills', 'add', '--skill=deveco-cli', '--force'],
    ['skills', 'add', '--skill', 'other-skill'],
    ['skills', 'add', '--skill', '--help'],
    ['skills', 'remove', '--skill', 'deveco-cli'],
    ['skills', 'remove', '--skill=other-skill'],
    ['--', 'init', '--skill'],
  ]) {
    for (const extra of [{}, { DEVECO_PLUGIN_RUNTIME_EXECUTABLE: entry }]) {
      const result = await invoke(['run', ...blocked], {
        env: env(extra),
        cwd: root,
      });
      expect(await fs.readFile(skill, 'utf8'), JSON.stringify(blocked)).toBe(
        'original global skill'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('plugin-managed');
    }
  }
});

test('private Runtime forwards read-only skill commands; global CLI can update its skill', async () => {
  const echo = 'console.log(JSON.stringify(process.argv.slice(2)));';
  await privateRuntime(built.packageVersion, built.packageName, echo);
  for (const allowed of [
    ['init', '--help'],
    ['init', '-h'],
    ['init', 'help'],
    ['skills', '--help'],
    ['skills', 'add', '--help'],
    ['skills', 'remove', '--help'],
    ['skills', 'list'],
    ['skills', 'find', 'deveco-cli'],
  ]) {
    const passed = await invoke(['run', ...allowed]);
    expect(passed.exitCode).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual(allowed);
  }
  const dir = path.join(root, 'tools');
  await fakeCli(dir, echo);
  const forwarded = await invoke(['run', 'init', '--skill'], {
    env: env({ PATH: dir }),
  });
  expect(forwarded.exitCode).toBe(0);
  expect(JSON.parse(forwarded.stdout)).toEqual(['init', '--skill']);
});

test('installer validates the requested version before running npm', async () => {
  expect(parseVersion([], '1.2.3')).toBe('1.2.3');
  expect(parseVersion(['--version', 'latest'], '1.2.3')).toBe('latest');
  for (const args of [
    ['--version', '../local'],
    ['--version', '1.0.0; bad'],
    ['--version'],
    ['--global'],
  ]) {
    expect(() => parseVersion(args, '1.2.3')).toThrow('Usage');
  }
  const result = await invoke(['install', '--global']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Usage');
});

test('npm 12 script policy is preserved in private project config without changing input env', async () => {
  const input = {
    npm_config_allow_scripts: 'opencode-ai',
    npm_config_registry: 'https://registry.npmjs.org',
  };
  const actual = await npmEnvironment(root, input);
  expect(actual).toEqual({ npm_config_registry: input.npm_config_registry });
  expect(await fs.readFile(path.join(root, '.npmrc'), 'utf8')).toBe(
    'allow-scripts="opencode-ai"\n'
  );
  expect(input.npm_config_allow_scripts).toBe('opencode-ai');
  await expect(
    npmEnvironment(root, {
      NPM_CONFIG_ALLOW_SCRIPTS: 'x\nignore-scripts=false',
    })
  ).rejects.toThrow('single line');
});

test.skipIf(windows)(
  'SIGTERM reaches the CLI and its exit is awaited',
  async () => {
    const stopped = path.join(root, 'stopped');
    const entry = await fakeCli(
      path.join(root, 'runtime'),
      `process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0);});console.log('READY');setInterval(()=>{},1000);`
    );
    const child = spawn(
      process.execPath,
      [path.join(artifact.target, 'runtime/main.mjs'), 'run'],
      {
        env: env({ DEVECO_PLUGIN_RUNTIME_EXECUTABLE: entry }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Runtime did not become ready')),
          5000
        );
        child.stdout.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(await fs.readFile(stopped, 'utf8')).toBe('stopped');
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }
);
