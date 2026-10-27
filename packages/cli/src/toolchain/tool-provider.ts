/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverStudioInstallRoot } from './studio-discovery.js';
import { compareStudioVersions, readStudioVersion } from './studio-version.js';
import { resolveEnvRoot } from './environment-path.js';
import { debugLog } from '../utils/logger.js';
import { IDE_DOWNLOAD_URL } from '../config/constants.js';
import {
  resolveCanonicalPath,
  resolvePathInsideRoot,
} from '../utils/path-containment.js';
import { TraceError } from '../trace/index.js';

const CLT_VERSION = /^#\s*Version:\s*(\S+)/;

/**
 * compat 命令所需的最低 DevEco Studio 版本。
 */
const COMPAT_MIN_STUDIO_VERSION = '26.0.0.810';

type InstallSourceType = 'clt' | 'studio';

function parseApiLevel(file: string): number | undefined {
  try {
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      apiVersion?: unknown;
      data?: { apiVersion?: unknown };
    };
    const level = Number(metadata.apiVersion ?? metadata.data?.apiVersion);
    return Number.isInteger(level) && level >= 17 ? level : undefined;
  } catch (e) {
    debugLog(`[ToolProvider] Failed to parse API level from ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function sdkMetadataPaths(sdkPath: string): string[] {
  const openHarmonyPath = path.join(sdkPath, 'default', 'openharmony');
  return [
    path.join(sdkPath, 'default', 'sdk-pkg.json'),
    ...['toolchains', 'native', 'previewer'].map((directory) =>
      path.join(openHarmonyPath, directory, 'oh-uni-package.json')
    ),
  ];
}

export class ToolProvider {
  private static installSourcePromise:
    | Promise<{ sourceType: InstallSourceType; toolchainRoot: string }>
    | undefined;

  private constructor(
    private readonly _sourceType: InstallSourceType,
    private readonly _toolchainRoot: string,
    private readonly _devecoStudioPath: string | undefined,
    private readonly _nodePath: string,
    private readonly _ohpmJsPath: string,
    private readonly _hvigorJsPath: string,
    private _javaPath: string,
    private readonly _sdkPath: string,
    private readonly _hdcPath: string,
    private readonly _emulatorPath: string
  ) {}

  public get sourceType(): InstallSourceType {
    return this._sourceType;
  }
  public get toolchainRoot(): string {
    return this._toolchainRoot;
  }
  public get devecoStudioPath(): string | undefined {
    return this._devecoStudioPath;
  }
  public get nodePath(): string {
    return this._nodePath;
  }
  public get ohpmJsPath(): string {
    return this._ohpmJsPath;
  }
  public get hvigorJsPath(): string {
    return this._hvigorJsPath;
  }
  /** 获取当前工具链中的 Code Linter JS 入口。 */
  public get codelinterPath(): string {
    return ToolProvider.resolveCodelinterPath(
      this._toolchainRoot,
      this._sourceType
    );
  }
  public get arktsdocPath(): string {
    this.assertStudio();
    const entry = path.join(this._toolchainRoot,
      ...(os.platform() === 'darwin' ? ['Contents'] : []), 'tools', 'arktsdoc', 'index.js');
    if (!ToolProvider.isFile(entry)) {
      throw new Error('ArkTSDoc not found in DevEco Studio.');
    }
    const resolved = resolveCanonicalPath(entry);
    ToolProvider.assertInsideRoot(resolved, resolveCanonicalPath(this._toolchainRoot), 'arktsdoc');
    return resolved;
  }
  /** arkts-lang-server 根目录（Studio: plugins/openharmony；CLT: arkts-lsp/lib），未安装返回 null。 */
  public get arktsLangServerPath(): string | null {
    const candidates = ToolProvider.buildToolPaths(
      this._toolchainRoot,
      this._sourceType
    ).arktsLangServerCandidates;
    for (const c of candidates) {
      if (fs.existsSync(c.marker)) {
        return c.root;
      }
    }
    return null;
  }
  /** clangd 可执行文件路径，未安装返回 null。 */
  public get clangdPath(): string | null {
    const p = ToolProvider.buildToolPaths(
      this._toolchainRoot,
      this._sourceType
    ).clangdPath;
    return fs.existsSync(p) ? p : null;
  }
  public get javaPath(): string {
    return this._javaPath ?? '';
  }
  public get sdkPath(): string {
    return this._sdkPath;
  }
  public get hdcPath(): string {
    return this._hdcPath;
  }
  public get emulatorPath(): string {
    return this._emulatorPath;
  }
  public get emulatorLauncherPath(): string {
    return this.emulatorPath;
  }

  public assertJava(): void {
    if (this._sourceType === 'clt') {
      this._javaPath = ToolProvider.resolveCltJava(true);
    }
    if (!this._javaPath) {
      throw new Error(
        'Java runtime is required to run hvigor. Set JAVA_HOME or add Java to PATH.'
      );
    }
  }

  public assertStudio(): void {
    if (this._sourceType === 'clt') {
      throw new Error(
        'This operation requires DevEco Studio. Set DEVECO_CLI_STUDIO_PATH to a DevEco Studio installation.'
      );
    }
  }

  public assertLsp(): void {
    this.assertStudio();
  }

  public static compareVersion(left: string, right: string): number {
    return compareStudioVersions(left, right);
  }

  public static async checkVersion(): Promise<void> {
    const source = await ToolProvider.resolveInstallSource();
    const provider =
      source.sourceType === 'clt'
        ? ToolProvider.fromCLT(source.toolchainRoot)
        : ToolProvider.fromIDE(source.toolchainRoot, source.sourceType);
    provider.assertVersion();
  }

  public static async new(): Promise<ToolProvider> {
    const source = await ToolProvider.resolveInstallSource();
    return source.sourceType === 'clt'
      ? ToolProvider.fromCLT(source.toolchainRoot)
      : ToolProvider.fromIDE(source.toolchainRoot, source.sourceType);
  }

  public static fromCLT(cltRoot: string): ToolProvider {
    const tools = ToolProvider.buildToolPaths(cltRoot, 'clt');
    ToolProvider.assertBuiltPathsInsideRoot(cltRoot, tools, false);
    return new ToolProvider(
      'clt',
      cltRoot,
      undefined,
      tools.nodePath,
      tools.ohpmJsPath,
      tools.hvigorJsPath,
      ToolProvider.resolveCltJava(false),
      tools.sdkPath,
      tools.hdcPath,
      tools.emulatorPath
    );
  }

  public static fromIDE(
    studioRoot: string,
    sourceType: Exclude<InstallSourceType, 'clt'> = 'studio'
  ): ToolProvider {
    const tools = ToolProvider.buildToolPaths(studioRoot, 'studio');
    ToolProvider.assertBuiltPathsInsideRoot(studioRoot, tools, true);
    return new ToolProvider(
      sourceType,
      studioRoot,
      studioRoot,
      tools.nodePath,
      tools.ohpmJsPath,
      tools.hvigorJsPath,
      tools.javaPath,
      tools.sdkPath,
      tools.hdcPath,
      tools.emulatorPath
    );
  }

  public assertVersion(): void {
    if (this._sourceType === 'clt') {
      this.assertCltVersion();
      return;
    }
    this.assertIdeVersion();
  }

  /** 按当前安装类型读取版本号：CLT 读 version.txt，Studio 读 Info.plist / product-info.json。 */
  public readVersion(): string | undefined {
    return this._sourceType === 'clt'
      ? ToolProvider.readCltVersion(this._toolchainRoot)
      : readStudioVersion(this._toolchainRoot);
  }

  public assertCltVersion(minimum = '26.0.0'): void {
    if (this._sourceType !== 'clt') {
      throw new Error('This operation requires Command Line Tools.');
    }
    ToolProvider.assertMinimumVersion(
      ToolProvider.readCltVersion(this._toolchainRoot),
      'Command Line Tools',
      'version.txt',
      minimum,
      this._toolchainRoot
    );
  }

  /** 校验 Studio 版本，默认使用全局最低版本 6.0.0。 */
  public assertIdeVersion(minimum = '6.0.0'): void {
    this.assertStudio();
    ToolProvider.assertMinimumVersion(
      readStudioVersion(this._toolchainRoot),
      'DevEco Studio',
      'product-info.json / Info.plist',
      minimum,
      this._toolchainRoot
    );
  }

  public require(requirement: {
    studio?: false | string;
    clt?: false | string;
  }): void {
    if (this._sourceType === 'clt') {
      this.requireClt(requirement.clt);
      return;
    }
    this.requireIde(requirement.studio);
  }

  private requireClt(rule: false | string | undefined): void {
    if (rule === false) {
      throw new Error(
        'This operation is not supported in Command Line Tools mode.'
      );
    }
    if (typeof rule === 'string') {
      this.assertCltVersion(rule);
    }
  }

  private requireIde(rule: false | string | undefined): void {
    if (rule === false) {
      throw new Error('This operation is not supported in DevEco Studio mode.');
    }
    if (typeof rule === 'string') {
      this.assertIdeVersion(rule);
    }
  }

  private static assertMinimumVersion(
    version: string | undefined,
    label: string,
    marker: string,
    minimum: string,
    root: string
  ): void {
    if (!version) {
      throw new TraceError(
        `Failed to determine ${label} version from ${marker} at ${root}`,
        `Failed to determine ${label} version from ${marker}`
      );
    }
    if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
      throw new TraceError(
        `Invalid ${label} version "${version}" from ${marker} at ${root}`,
        `Invalid ${label} version "${version}" from ${marker}`
      );
    }
    if (compareStudioVersions(version, minimum) < 0) {
      throw new Error(
        `The detected ${label} version is ${version}, which is below the minimum required version ${minimum}. Upgrade before using deveco-cli:\n${IDE_DOWNLOAD_URL}`
      );
    }
  }

  /** 在 IDE 或 CLT 安装目录中解析 Code Linter 入口。 */
  private static resolveCodelinterPath(
    root: string,
    source: InstallSourceType
  ): string {
    const candidates = ToolProvider.buildToolPaths(
      root,
      source
    ).codelinterCandidates;
    const entry = candidates.find(ToolProvider.isFile);
    if (!entry) {
      const label =
        source === 'studio'
          ? 'Code Linter not found in DevEco Studio.'
          : 'Code Linter not found in DevEco Command Line Tools.';
      throw new TraceError(
        `${label}\nSearched paths:\n  ${candidates.join('\n  ')}`,
        label
      );
    }

    const realRoot = resolveCanonicalPath(root);
    const realEntry = resolveCanonicalPath(entry);
    ToolProvider.assertInsideRoot(realEntry, realRoot, 'codelinter');
    return realEntry;
  }

  private static isValidRoot(root: string, source: 'clt' | 'studio'): boolean {
    if (!ToolProvider.isDirectory(root)) {
      return false;
    }
    if (source === 'clt') {
      return fs.existsSync(path.join(root, 'version.txt'));
    }
    const contentRoot =
      os.platform() === 'darwin' ? path.join(root, 'Contents') : root;
    const marker =
      os.platform() === 'darwin'
        ? path.join(contentRoot, 'Info.plist')
        : path.join(contentRoot, 'product-info.json');
    if (!fs.existsSync(marker)) {
      return false;
    }
    const tools = ToolProvider.buildToolPaths(root, 'studio');
    return [tools.nodePath, tools.ohpmJsPath, tools.hvigorJsPath].every(
      fs.existsSync
    );
  }

  private static buildToolPaths(root: string, source: InstallSourceType) {
    return source === 'clt'
      ? ToolProvider.buildCltToolPaths(root)
      : ToolProvider.buildStudioToolPaths(root);
  }

  private static buildCltToolPaths(cltRoot: string) {
    const windows = os.platform() === 'win32';
    const ext = windows ? '.exe' : '';
    const sdkPath = path.join(cltRoot, 'sdk');
    return {
      nodePath: windows
        ? path.join(cltRoot, 'tool', 'node', 'node.exe')
        : path.join(cltRoot, 'tool', 'node', 'bin', 'node'),
      ohpmJsPath: path.join(cltRoot, 'ohpm', 'bin', 'pm-cli.js'),
      hvigorJsPath: path.join(cltRoot, 'hvigor', 'bin', 'hvigorw.js'),
      javaPath: '',
      sdkPath,
      hdcPath: path.join(
        sdkPath,
        'default',
        'openharmony',
        'toolchains',
        `hdc${ext}`
      ),
      emulatorPath: path.join(
        cltRoot,
        'emulator',
        windows ? 'Emulator.exe' : 'Emulator'
      ),
      clangdPath: ToolProvider.clangdPathFor(sdkPath),
      arktsLangServerCandidates: [
        {
          root: path.join(cltRoot, 'arkts-lsp', 'lib'),
          marker: path.join(cltRoot, 'arkts-lsp', 'lib', 'out', 'index.js'),
        },
      ],
      codelinterCandidates: ToolProvider.codelinterCandidatesFor(
        cltRoot,
        'clt'
      ),
    };
  }

  private static buildStudioToolPaths(studioRoot: string) {
    const mac = os.platform() === 'darwin';
    const windows = os.platform() === 'win32';
    const root = mac ? path.join(studioRoot, 'Contents') : studioRoot;
    const toolsDir = path.join(root, 'tools');
    const sdkPath = path.join(root, 'sdk');
    const ext = windows ? '.exe' : '';
    return {
      nodePath: windows
        ? path.join(toolsDir, 'node', 'node.exe')
        : path.join(toolsDir, 'node', 'bin', 'node'),
      ohpmJsPath: path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js'),
      hvigorJsPath: path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js'),
      javaPath: windows
        ? path.join(studioRoot, 'jbr', 'bin', 'java.exe')
        : mac
          ? path.join(root, 'jbr', 'Contents', 'Home', 'bin', 'java')
          : path.join(root, 'jbr', 'bin', 'java'),
      sdkPath,
      hdcPath: path.join(
        sdkPath,
        'default',
        'openharmony',
        'toolchains',
        `hdc${ext}`
      ),
      emulatorPath: path.join(
        toolsDir,
        'emulator',
        windows ? 'Emulator.exe' : 'Emulator'
      ),
      clangdPath: ToolProvider.clangdPathFor(sdkPath),
      arktsLangServerCandidates:
        ToolProvider.studioArktsLangServerCandidates(studioRoot),
      codelinterCandidates: ToolProvider.codelinterCandidatesFor(
        studioRoot,
        'studio'
      ),
    };
  }

  /** 按安装类型生成 Code Linter 入口候选路径。 */
  private static codelinterCandidatesFor(
    root: string,
    source: InstallSourceType
  ): string[] {
    if (source === 'clt') {
      return [
        path.join(root, 'codelinter', 'index.js'),
        path.join(root, 'codelinter', 'run', 'index.js'),
        path.join(root, 'tool', 'codelinter', 'bin', 'codelinter.js'),
        path.join(root, 'tool', 'codelinter', 'codelinter.js'),
      ];
    }
    const macPrefix = os.platform() === 'darwin' ? ['Contents'] : [];
    return [
      path.join(root, ...macPrefix, 'plugins', 'codelinter', 'run', 'index.js'),
      path.join(root, ...macPrefix, 'plugins', 'codelinter', 'index.js'),
      path.join(
        root,
        ...macPrefix,
        'tools',
        'codelinter',
        'bin',
        'codelinter.js'
      ),
      path.join(root, ...macPrefix, 'tools', 'codelinter', 'codelinter.js'),
    ];
  }

  /** Studio 布局的 arkts-lang-server 候选（Linux 不支持 Studio，无候选）。 */
  private static studioArktsLangServerCandidates(
    studioRoot: string
  ): Array<{ root: string; marker: string }> {
    if (os.platform() === 'linux') {
      return [];
    }
    const macPrefix = os.platform() === 'darwin' ? ['Contents'] : [];
    const base = path.join(studioRoot, ...macPrefix, 'plugins', 'openharmony');
    return [
      {
        root: base,
        marker: path.join(base, 'ace-server', 'out', 'index.js'),
      },
    ];
  }

  /** clangd 可执行文件路径：`<sdkPath>/default/openharmony/native/llvm/bin/clangd(.exe)`。 */
  private static clangdPathFor(sdkPath: string): string {
    return path.join(
      sdkPath,
      'default',
      'openharmony',
      'native',
      'llvm',
      'bin',
      os.platform() === 'win32' ? 'clangd.exe' : 'clangd'
    );
  }

  /** 判断路径是否为文件。 */
  private static isFile(value: string): boolean {
    try {
      return fs.statSync(value).isFile();
    } catch {
      return false;
    }
  }

  private static isDirectory(value: string): boolean {
    try {
      return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  }

  private static resolveInstallSource() {
    if (!ToolProvider.installSourcePromise) {
      ToolProvider.installSourcePromise =
        ToolProvider.resolveInstallSourceUncached();
    }
    return ToolProvider.installSourcePromise;
  }

  private static async resolveInstallSourceUncached() {
    const candidates = [
      ['DEVECO_CLI_STUDIO_PATH', 'studio', 'studio'],
      ['DEVECO_CLI_CLT_PATH', 'clt', 'clt'],
      ['DEVECO_HOME', 'studio', 'studio'],
      ['DEVECO_PATH', 'studio', 'studio'],
    ] as const;
    for (const [env, expected, sourceType] of candidates) {
      const value = process.env[env]?.trim();
      if (value) {
        const toolchainRoot = ToolProvider.resolveExplicitRoot(
          value,
          expected,
          env
        );
        debugLog(`[ToolProvider] Using ${env} → ${toolchainRoot}`);
        return {
          sourceType,
          toolchainRoot,
        };
      }
    }
    const discovered = await discoverStudioInstallRoot();
    debugLog(
      `[ToolProvider] Using auto → ${discovered.root} (${discovered.version})`
    );
    return {
      sourceType: 'studio' as const,
      toolchainRoot: discovered.root,
    };
  }

  private static resolveExplicitRoot(
    input: string,
    expected: 'clt' | 'studio',
    env: string
  ): string {
    let root: string;
    try {
      root = resolveEnvRoot(input);
    } catch (error) {
      throw new Error(
        `Invalid ${env}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    if (expected === 'studio' && os.platform() === 'darwin') {
      root = ToolProvider.normalizeMacStudioRoot(root);
    }
    if (ToolProvider.isValidRoot(root, expected)) {
      return root;
    }
    return ToolProvider.throwInvalidSource(root, expected, env, input);
  }

  private static assertBuiltPathsInsideRoot(
    root: string,
    tools: ReturnType<typeof ToolProvider.buildToolPaths>,
    includeBundledJava: boolean
  ): void {
    const realRoot = resolveCanonicalPath(root);
    const entries: Array<[string, string]> = [
      ['node', tools.nodePath],
      ['ohpm', tools.ohpmJsPath],
      ['hvigor', tools.hvigorJsPath],
      ['sdk', tools.sdkPath],
      ['hdc', tools.hdcPath],
      ['emulator', tools.emulatorPath],
    ];
    if (includeBundledJava && tools.javaPath) {
      entries.push(['java', tools.javaPath]);
    }
    for (const [label, child] of entries) {
      ToolProvider.assertInsideRoot(child, realRoot, label);
    }
  }

  private static assertInsideRoot(
    child: string,
    realRoot: string,
    label: string
  ): void {
    if (resolvePathInsideRoot(child, realRoot) === null) {
      throw new Error(
        `Unsafe toolchain path: ${label} resolves outside the toolchain root`
      );
    }
  }

  private static throwInvalidSource(
    root: string,
    expected: 'clt' | 'studio',
    env: string,
    input: string
  ): never {
    if (expected === 'clt' && ToolProvider.isValidRoot(root, 'studio')) {
      throw new Error(
        `${env} must point to Command Line Tools, not a DevEco Studio installation; use DEVECO_CLI_STUDIO_PATH instead`
      );
    }
    if (expected === 'studio' && ToolProvider.isValidRoot(root, 'clt')) {
      throw new Error(
        `${env} must point to a DevEco Studio installation, not Command Line Tools; use DEVECO_CLI_CLT_PATH instead`
      );
    }
    throw new Error(`Invalid ${env}: ${input}`);
  }

  private static normalizeMacStudioRoot(root: string): string {
    const suffix = `${path.sep}Contents`;
    const normalized = path.normalize(root);
    return normalized.endsWith(suffix)
      ? normalized.slice(0, -suffix.length)
      : normalized;
  }

  private static readCltVersion(root: string): string | undefined {
    try {
      return fs
        .readFileSync(path.join(root, 'version.txt'), 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.match(CLT_VERSION)?.[1]?.trim())
        .find(Boolean);
    } catch {
      return undefined;
    }
  }

  private static resolveCltJava(required: boolean): string {
    const home = process.env.JAVA_HOME?.trim();
    const fromHome =
      home &&
      (ToolProvider.javaIn(path.join(home, 'bin')) ??
        ToolProvider.javaIn(home));
    const candidates = [fromHome, ...ToolProvider.locateJavaFromPath()].filter(
      (candidate): candidate is string => Boolean(candidate)
    );
    if (!required) {
      return candidates[0] ? fs.realpathSync(candidates[0]) : '';
    }
    for (const candidate of candidates) {
      if (ToolProvider.isUsableJava(candidate)) {
        return fs.realpathSync(candidate);
      }
    }
    throw new Error(
      'No Java runtime found in CLT mode. Set JAVA_HOME to a JDK/JBR installation directory (or point JAVA_HOME at the JDK bin directory), or add the JDK bin directory to PATH.'
    );
  }

  private static locateJavaFromPath(): string[] {
    const windows = os.platform() === 'win32';
    const command = windows ? 'where.exe' : 'which';
    const args = windows ? ['java'] : ['-a', 'java'];
    debugLog(`Executing: ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 2000,
      windowsHide: true,
    });
    return result.error || result.status !== 0
      ? []
      : result.stdout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
  }

  private static javaIn(directory: string): string | undefined {
    const names =
      os.platform() === 'win32' ? ['java.exe', 'java.cmd'] : ['java'];
    return names.map((name) => path.join(directory, name)).find(fs.existsSync);
  }

  private static isUsableJava(javaPath: string): boolean {
    const args = ['-version'];
    debugLog(`Executing: ${javaPath} ${args.join(' ')}`);
    const result = spawnSync(javaPath, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 2000,
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  }

  public getMaxApiLevel(): number {
    return this.getAvailableApiLevel() ?? 23;
  }
  public getAvailableApiLevel(): number | undefined {
    for (const file of sdkMetadataPaths(this.sdkPath)) {
      const level = parseApiLevel(file);
      if (level !== undefined) {
        return level;
      }
    }
    return undefined;
  }
  /** 读取默认 SDK 包的平台版本。 */
  public getSdkPlatformVersion(): string {
    const metadataPath = path.join(this.sdkPath, 'default', 'sdk-pkg.json');
    let metadata: { data?: { platformVersion?: unknown } };
    try {
      metadata = JSON.parse(
        fs.readFileSync(metadataPath, 'utf8')
      ) as typeof metadata;
    } catch (error) {
      throw new Error(`Failed to read SDK metadata: ${metadataPath}`, {
        cause: error,
      });
    }

    const rawPlatformVersion = metadata.data?.platformVersion;
    const platformVersion =
      typeof rawPlatformVersion === 'string' ? rawPlatformVersion.trim() : '';
    if (!platformVersion) {
      throw new Error(
        `Missing data.platformVersion in SDK metadata: ${metadataPath}`
      );
    }
    return platformVersion;
  }
  public detectApiLevel(): number {
    return this.getMaxApiLevel();
  }

  private _apiscanPaths?: { apiChangeDir: string; scriptPath: string };

  getApiscanPaths(): { apiChangeDir: string; scriptPath: string } {
    if (this._apiscanPaths) {
      return this._apiscanPaths;
    }
    const platform = os.platform();
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new Error(
        `Unsupported platform: ${platform}. compat only supports macOS and Windows.`
      );
    }
    if (!this._devecoStudioPath) {
      throw new Error(
        'DevEco Studio is required for compatibility checking. ' +
          'Set DEVECO_CLI_STUDIO_PATH or install DevEco Studio.'
      );
    }
    const contentsPrefix = platform === 'darwin' ? 'Contents' : '';
    const pluginPath = path.join(
      this._devecoStudioPath,
      contentsPrefix,
      'plugins',
      'harmony',
      'arkanalyzer-apiscan'
    );
    const apiChangeDir = path.join(pluginPath, 'resources', 'apiChange');
    const scriptPath = path.join(pluginPath, 'api-change-scan.js');
    if (!fs.existsSync(apiChangeDir) || !fs.existsSync(scriptPath)) {
      const current = readStudioVersion(this._toolchainRoot) ?? 'unknown';
      throw new Error(
        `A required component is missing. The detected DevEco Studio version is ${current}. ` +
          `The minimum required version is ${COMPAT_MIN_STUDIO_VERSION}. ` +
          `Upgrade before using 'check compat' at ${IDE_DOWNLOAD_URL}`
      );
    }
    this._apiscanPaths = { apiChangeDir, scriptPath };
    return this._apiscanPaths;
  }

}
