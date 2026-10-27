/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { CommonUtils } from './common-utils.js';
import { TraceError } from '../trace/trace-error.js';
import { debugLog } from './logger.js';
import { ProjectConstants } from '../config/project.js';
import type { BuildOutputLayout } from '../quality/build-output-layout.js';
import { privateEvidenceName } from '../quality/evidence.js';

export interface ProductNode {
  name: string;
  /** Per-product bundleName override. Falls back to AppScope/app.json5 when absent. */
  bundleName?: string;
}

export interface BuildModeNode {
  name: string;
}

export interface AppNode {
  products: ProductNode[];
  buildModeSet: BuildModeNode[];
  signingConfigs?: { name: string }[];
}

export interface ModuleNode {
  name: string;
  srcPath: string;
  targets?: TargetNode[];
}

export interface ProjectProfile {
  app: AppNode;
  modules: ModuleNode[];
}

export interface TargetNode {
  name: string;
  applyToProducts?: string[];
}

export interface AbilityNode {
  name: string;
}

export interface ModuleProfile {
  targets: TargetNode[];
}

export class Project {
  public rootDir: string;
  public profile: ProjectProfile;

  private constructor(rootDir: string, profile: ProjectProfile, private readonly outputLayout?: BuildOutputLayout) {
    this.rootDir = rootDir;
    this.profile = profile;
  }

  public static discover(startDir: string, outputLayout?: BuildOutputLayout): Project {
    let currentDir = startDir;

    while (true) {
      const profile = Project.tryLoadProjectProfile(currentDir);
      if (profile) {
        return new Project(currentDir, profile, outputLayout ? structuredClone(outputLayout) : undefined);
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    throw new Error(
      'Not in a valid project directory (project-level build-profile.json5 not found).'
    );
  }

  private static tryLoadProjectProfile(dir: string): ProjectProfile | null {
    const profilePath = path.join(dir, 'build-profile.json5');
    if (!fs.existsSync(profilePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const profile = json5.parse(content) as ProjectProfile;
      return profile.app ? profile : null;
    } catch (e) {
      console.error(`Error parsing ${profilePath}:`, e);
      return null;
    }
  }

  private getRunnableModuleNames(): string {
    return this.profile.modules
      .map((m) => m.name)
      .filter((name) => this.getModuleType(name) !== 'har')
      .join(', ');
  }

  public getModuleType(moduleName: string): string {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new TraceError(
        `Module '${moduleName}' not found in project-level build-profile.json5.`,
        'Module not found in project-level build-profile.json5.'
      );
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const moduleJsonPath = path.join(moduleDir, 'src', 'main', 'module.json5');

    if (!fs.existsSync(moduleJsonPath)) {
      // Default to 'entry' if module.json5 doesn't exist or isn't found
      return 'entry';
    }

    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const moduleInfo = json5.parse(content) as {
        module?: { type?: string };
      };
      return moduleInfo?.module?.type || 'entry';
    } catch (e) {
      console.warn(`Warning: Failed to parse ${moduleJsonPath}:`, e);
      return 'entry';
    }
  }

  public findOwningModule(filePath: string): string | null {
    const normalized = path.normalize(filePath);
    for (const m of this.profile.modules) {
      const moduleDir = path.normalize(path.join(this.rootDir, m.srcPath));
      const prefix = moduleDir + path.sep;
      if (normalized.startsWith(prefix) || normalized === moduleDir) {
        return m.name;
      }
    }
    return null;
  }

  public getModuleProfile(moduleName: string): ModuleProfile {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new TraceError(
        `Module '${moduleName}' not found in project-level build-profile.json5.`,
        `Module not found in project-level build-profile.json5.`
      );
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const profilePath = path.join(moduleDir, 'build-profile.json5');

    if (!fs.existsSync(profilePath)) {
      throw new TraceError(
        `Build profile for module '${moduleName}' not found at ${profilePath}.`,
        'Build profile for module not found at ${profilePath}.'
      );
    }

    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const profile = json5.parse(content) as ModuleProfile;
      return profile;
    } catch (e) {
      throw new Error(
        `Failed to parse module build profile at ${profilePath}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    }
  }

  public getBundleName(productName?: string): string {
    // Prefer per-product bundleName override from build-profile.json5
    if (productName) {
      const product = this.profile.app.products?.find((p) => p.name === productName);
      if (product?.bundleName) {
        return product.bundleName;
      }
    }
    // Fall back to AppScope/app.json5
    const appJson5Path = path.join(this.rootDir, 'AppScope', 'app.json5');
    if (fs.existsSync(appJson5Path)) {
      try {
        const content = fs.readFileSync(appJson5Path, 'utf-8');
        const json = json5.parse(content) as {
          app?: { bundleName?: string };
        };
        if (json?.app?.bundleName) {
          return json.app.bundleName;
        }
      } catch (e) {
        console.warn(`Warning: Failed to parse ${appJson5Path}:`, e);
      }
    }
    throw new Error('Could not find bundleName in AppScope/app.json5.');
  }

  public isAtomicService(): boolean {
    const appJson5Path = path.join(this.rootDir, 'AppScope', 'app.json5');
    if (!fs.existsSync(appJson5Path)) {
      return false;
    }
    try {
      const content = fs.readFileSync(appJson5Path, 'utf-8');
      const json = json5.parse(content) as {
        app?: { bundleType?: string };
      };
      return json?.app?.bundleType === 'atomicService';
    } catch {
      return false;
    }
  }

  public getMainAbility(moduleName: string, ability?: string): string {
    if (ability) {
      return ability;
    }

    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      return 'EntryAbility';
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const moduleJsonPath = path.join(moduleDir, 'src', 'main', 'module.json5');

    if (!fs.existsSync(moduleJsonPath)) {
      return 'EntryAbility';
    }

    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const json = json5.parse(content) as {
        module?: { abilities?: AbilityNode[] };
      };
      const abilities = json?.module?.abilities || [];

      if (abilities.length === 0) {
        return 'EntryAbility';
      }

      const entryAbility = abilities.find((a) => a.name === 'EntryAbility');
      return entryAbility ? entryAbility.name : abilities[0].name;
    } catch (e) {
      console.warn(`Warning: Failed to parse ${moduleJsonPath}:`, e);
      return 'EntryAbility';
    }
  }

  public validateProduct(product: string): void {
    if (!/^[\da-zA-Z_-]+$/.test(product)) {
      throw new TraceError(
        `Invalid product name '${product}'. Product names must only contain letters, digits, underscores, and hyphens.`,
        'Invalid product name.'
      );
    }
    const productExists = this.profile.app.products?.some((p) => p.name === product);
    if (!productExists) {
      const availableProducts = this.profile.app.products?.map((p) => p.name).join(', ') || 'none';
      throw new TraceError(
        `Product '${product}' not found in project configuration. Available products: ${availableProducts}`,
        'Productnot found in project configuration.'
      );
    }
  }

  public getModuleDependencies(moduleName: string): string[] {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      return [];
    }

    // Prefer lock.json5 (dependencies/dynamicDependencies written by ohpm install).
    // Overrides are read from lock top-level and applied during graph walk.
    const lockDeps = this.readLockFinalLocalModuleDeps(moduleName);
    if (lockDeps !== null) {
      return lockDeps;
    }

    // Fallback to module source oh-package.json5 when no lock (first run)
    return this.readOhPackageLocalModuleDeps(moduleNode);
  }

  /**
   * Read lock.json5: return local module deps from dependencies +
   * dynamicDependencies. Apply top-level overrides (override-first).
   * Returns null if lock unavailable → caller falls back.
   */
  private readLockFinalLocalModuleDeps(moduleName: string): string[] | null {
    const lockPath = path.join(this.rootDir, ProjectConstants.LOCK_JSON5_PATH);
    if (!fs.existsSync(lockPath)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = json5.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch (e) {
      debugLog(`Failed to parse lock.json5: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const lockObj = parsed as { modules?: Record<string, unknown>; overrides?: Record<string, unknown> };
    const modules = lockObj?.modules;
    if (!modules || typeof modules !== 'object') {
      return null;
    }
    // lock modules keyed by relative path; value.name is the module name
    const moduleEntry = Object.values(modules).find(
      (v): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && (v as { name?: unknown }).name === moduleName
    );
    if (!moduleEntry) {
      return null;
    }
    const overrideMap = this.buildOverrideMap(lockObj.overrides);
    const deps: string[] = [];
    const seen = new Set<string>();
    for (const depKey of ['dependencies', 'dynamicDependencies'] as const) {
      const depRecord = moduleEntry[depKey];
      if (!depRecord || typeof depRecord !== 'object') {
        continue;
      }
      this.collectLocalDeps(
        depRecord as Record<string, unknown>,
        overrideMap,
        (dep) => this.resolveLockDepByVersion(dep),
        deps,
        seen,
      );
    }
    return deps;
  }

  /** Resolve a lock dep entry by its version field. */
  private resolveLockDepByVersion(dep: unknown): string | null {
    if (typeof dep !== 'object' || dep === null) {
      return null;
    }
    const version = (dep as { version?: unknown }).version;
    return typeof version === 'string' ? this.resolveLocalDepToModule(version) : null;
  }

  /**
   * Resolve a single dep to a local module. Override-first: if depName
   * matches an override, resolve via override target; otherwise fall back
   * to version/value.
   */
  private resolveDepModule(
    depName: string,
    overrideMap: Map<string, string> | null,
    resolveByValue: () => string | null,
  ): string | null {
    if (overrideMap?.has(depName)) {
      const target = overrideMap.get(depName);
      if (target) {
        const m = this.resolveLocalDepToModule(target);
        if (m) {
          return m;
        }
      }
    }
    return resolveByValue();
  }

  /** Build override Map from { depName: "file:target" } object. Null if empty. */
  private buildOverrideMap(overrides: unknown): Map<string, string> | null {
    if (!overrides || typeof overrides !== 'object') {
      return null;
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof v === 'string') {
        map.set(k, v);
      }
    }
    return map.size > 0 ? map : null;
  }

  /** Map a local dep value (relative-to-root or absolute) to a profile module name. */
  private resolveLocalDepToModule(value: string): string | null {
    const p = Project.stripLocalDep(value);
    if (!p) {
      return null;
    }
    // Normalize path separators (JSON may use forward slashes)
    const resolved = path.resolve(this.rootDir, p);
    let depDir: string;
    try {
      depDir = CommonUtils.ensurePathWithinRoot(this.rootDir, resolved);
    } catch {
      return null;
    }
    const depModule = this.profile.modules.find(
      (m) => path.resolve(this.rootDir, m.srcPath) === depDir
    );
    return depModule ? depModule.name : null;
  }

  /** Strip file: prefix. Returns null for registry versions (e.g. "1.0.25"). */
  private static stripLocalDep(value: string): string | null {
    if (!value.startsWith('file:') && !value.startsWith('.') && !value.startsWith('..')) {
      return null;
    }
    return value.startsWith('file:') ? value.substring(5) : value;
  }

  /**
   * Fallback: read module source oh-package.json5 deps + dynamicDeps +
   * root overrides. Used when no lock (first run).
   */
  private readOhPackageLocalModuleDeps(moduleNode: ModuleNode): string[] {
    const pkgPath = path.join(
      CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath),
      ProjectConstants.OH_PACKAGE_JSON5,
    );
    if (!fs.existsSync(pkgPath)) {
      return [];
    }
    const overrideMap = this.readRootOverrideMap();
    const deps: string[] = [];
    const seen = new Set<string>();
    try {
      const pkg = json5.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, unknown>;
        dynamicDependencies?: Record<string, unknown>;
      };
      // HSP source deps are typically in dynamicDependencies
      for (const depKey of ['dependencies', 'dynamicDependencies'] as const) {
        const depRecord = pkg?.[depKey];
        if (!depRecord || typeof depRecord !== 'object') {
          continue;
        }
        this.collectLocalDeps(
          depRecord,
          overrideMap,
          (value) => this.resolveOhPackageDepByValue(value, moduleNode),
          deps,
          seen,
        );
      }
    } catch (e) {
      debugLog(`Failed to get module dependencies: ${e instanceof Error ? e.message : String(e)}`);
    }
    return deps;
  }

  /** Read overrides from project root oh-package.json5. */
  private readRootOverrideMap(): Map<string, string> | null {
    const rootPkgPath = path.join(this.rootDir, ProjectConstants.OH_PACKAGE_JSON5);
    if (!fs.existsSync(rootPkgPath)) {
      return null;
    }
    try {
      const pkg = json5.parse(fs.readFileSync(rootPkgPath, 'utf-8')) as {
        overrides?: Record<string, unknown>;
      };
      return this.buildOverrideMap(pkg?.overrides);
    } catch {
      return null;
    }
  }

  /** Resolve an oh-package dep value (relative to module dir) to a module name. */
  private resolveOhPackageDepByValue(value: unknown, moduleNode: ModuleNode): string | null {
    return typeof value === 'string' ? this.resolveLocalDepModuleName(value, moduleNode) : null;
  }

  /** Iterate dep record, resolve each via resolveDepModule (override-first), dedup. */
  private collectLocalDeps(
    depRecord: Record<string, unknown>,
    overrideMap: Map<string, string> | null,
    resolveValue: (value: unknown) => string | null,
    deps: string[],
    seen: Set<string>,
  ): void {
    for (const [depName, value] of Object.entries(depRecord)) {
      const depModuleName = this.resolveDepModule(depName, overrideMap, () =>
        resolveValue(value),
      );
      if (depModuleName && !seen.has(depModuleName)) {
        seen.add(depModuleName);
        deps.push(depModuleName);
      }
    }
  }

  /** Map a local dep value (relative to module dir) to a profile module name. */
  private resolveLocalDepModuleName(value: string, moduleNode: ModuleNode): string | null {
    const relPath = Project.stripLocalDep(value);
    if (!relPath) {
      return null;
    }
    const combinedRelativePath = path.join(moduleNode.srcPath, relPath);
    const depDir = CommonUtils.resolvePathWithinRoot(this.rootDir, combinedRelativePath);
    const depModule = this.profile.modules.find(
      (m) => path.resolve(this.rootDir, m.srcPath) === depDir
    );
    return depModule ? depModule.name : null;
  }

  public collectNonHarDependentModuleList(module: string) {
    const dependentModules: string[] = [];
    const moduleQueue: string[] = [];
    const processedModules = new Set<string>();

    moduleQueue.push(module);
    processedModules.add(module);

    while (moduleQueue.length > 0) {
      const currentModule = moduleQueue.shift()!;
      const type = this.getModuleType(currentModule);
      if (type !== 'har') {
        dependentModules.push(currentModule);
      } 
      const deps = this.getModuleDependencies(currentModule);
      for (const depModule of deps) {
        if (!processedModules.has(depModule)) {
          moduleQueue.push(depModule);
          processedModules.add(depModule);
        }
      }
    }
    return dependentModules;
  }

  private resolveModuleMetadata(
    moduleName: string,
    target: string,
    product: string
  ): {
    moduleNode: { srcPath: string };
    isShared: boolean;
    metadataPath: string;
    metadata: ReturnType<Project['parseOutputMetadata']>;
  } {
    this.validateProduct(product);

    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      const available = this.getRunnableModuleNames();
      throw new TraceError(`Module '${moduleName}' not found. Available modules: ${available}`, 'Module not found.');
    }

    const isShared = this.getModuleType(moduleName) === 'shared';
    const metadataKey = isShared ? 'hspName' : 'hapName';

    const metadataPath = this.observedOutputPath('module-metadata', product, moduleNode.srcPath, target, isShared ? 'hsp' : 'hap') ??
      this.buildOutputPath(moduleNode.srcPath, product, [
      'intermediates',
      isShared ? 'hsp_metadata' : 'hap_metadata',
      target,
      'output_metadata.json',
    ]);

    if (!fs.existsSync(metadataPath)) {
      throw new TraceError(
        `Build metadata not found for module '${moduleName}' at ${metadataPath}. Build the project first.`,
        `Build metadata not found for module. Build the project first.`
      );
    }

    this.checkBuildFile(metadataPath);
    const metadata = this.parseOutputMetadata(metadataPath, metadataKey);

    return { moduleNode, isShared, metadataPath, metadata };
  }

  public findArtifactPath(
    moduleName: string,
    target: string,
    isEmulator: boolean,
    product = 'default'
  ): string {
    const { moduleNode, isShared, metadata } = this.resolveModuleMetadata(
      moduleName,
      target,
      product
    );
    const { packageName, isSigned } = metadata;
    let finalPackageName = packageName;

    // 优先获取签名包
    if (!isSigned) {
      const signedHapName = this.getSignedHapName(packageName, moduleNode.srcPath, product, target);
      if (signedHapName) {
        finalPackageName = signedHapName;
      }
    }

    const signedSuffix = isShared ? '-signed.hsp' : '-signed.hap';
    if (!isEmulator && !finalPackageName.endsWith(signedSuffix)) {
      throw new TraceError(
        `Target device is a real device, but the artifact for '${moduleName}' is not signed. Real devices cannot install unsigned packages.`,
        'Target device is a real device, but the artifact is not signed.'
      );
    }

    const packagePath = this.buildOutputPath(moduleNode.srcPath, product, [
      'outputs',
      target,
      finalPackageName,
    ]);

    if (!fs.existsSync(packagePath)) {
      throw new TraceError(`Generated package file not found in ${packagePath}.`, 
        'Generated package file not found.');
    }

    this.checkBuildFile(packagePath);
    return packagePath;
  }

  public findRemoteHspPaths(
    moduleName: string,
    target: string,
    product = 'default'
  ): string[] {
    const { moduleNode, metadata } = this.resolveModuleMetadata(
      moduleName,
      target,
      product
    );

    const result: string[] = [];
    const seen = new Set<string>();
    for (const { hspPath } of metadata.dependRemoteHsps) {
      this.checkBuildPathSegments(hspPath);
      if (seen.has(hspPath)) {
        continue;
      }
      seen.add(hspPath);

      const resolvedPath = path.isAbsolute(hspPath)
        ? hspPath
        : this.buildOutputPath(moduleNode.srcPath, product, ['outputs', target, hspPath]);

      if (!fs.existsSync(resolvedPath)) {
        throw new TraceError(
          `Remote HSP dependency not found: ${resolvedPath}`,
          'Remote HSP dependency not found.'
        );
      }
      this.checkBuildFile(resolvedPath);
      result.push(resolvedPath);
    }

    return result;
  }

  /**
   * For a whole-product build (assembleApp), resolve the correct
   * module@target specs by consulting the project-level build-profile.json5
   * `modules[].targets[]` and their `applyToProducts` filter.
   *
   * - Targets without `applyToProducts` apply to every product.
   * - Targets with `applyToProducts` only apply to listed products.
   * - Modules without project-level `targets` fall back to `<name>@default`.
   * - Modules whose targets all exclude the current product are skipped.
   */
  public resolveModuleSpecsForProduct(product: string): string[] {
    const specs: string[] = [];

    for (const moduleNode of this.profile.modules) {
      const targets = moduleNode.targets;

      if (!targets || targets.length === 0) {
        specs.push(`${moduleNode.name}@default`);
        continue;
      }

      const matching = targets.filter(
        (t) => !t.applyToProducts || t.applyToProducts.includes(product)
      );

      if (matching.length === 0) {
        continue;
      }

      for (const t of matching) {
        specs.push(`${moduleNode.name}@${t.name}`);
      }
    }

    return specs;
  }

  /**
   * After a build, list the artifact files (.hap/.hsp/.har) produced for each
   * module.  Returns absolute paths; a missing output directory simply
   * yields no entries for that module.
   *
   * @param moduleSpecs  module identifiers in `name` or `name@target` form.
   * @param product      product name used for the build (e.g. "default").
   */
  public listBuildArtifacts(moduleSpecs: string[], product: string): string[] {
    const artifacts: string[] = [];

    for (const moduleSpec of moduleSpecs) {
      const at = moduleSpec.indexOf('@');
      const moduleName = at !== -1 ? moduleSpec.substring(0, at) : moduleSpec;
      const target = at !== -1 ? moduleSpec.substring(at + 1) : 'default';

      const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
      if (!moduleNode) {
        continue;
      }

      const outputDir = this.buildOutputPath(moduleNode.srcPath, product, [
        'outputs',
        target,
      ]);

      if (!fs.existsSync(outputDir)) {
        continue;
      }

      for (const entry of fs.readdirSync(outputDir)) {
        if (
          entry.endsWith('.hap') ||
          entry.endsWith('.hsp') ||
          entry.endsWith('.har')
        ) {
          const file = path.join(outputDir, entry);
          this.checkBuildFile(file);
          artifacts.push(file);
        }
      }
    }

    return artifacts;
  }

  /**
   * For a whole-product build (assembleApp), list the project-level .app
   * package produced at `<rootDir>/build/outputs/<product>/`.  Returns
   * absolute paths for direct files only; a missing directory yields no entries.
   */
  public listProjectAppArtifacts(product: string): string[] {
    const outputsDir = this.observedOutputPath('product', product) ?? CommonUtils.ensurePathWithinRoot(
      this.rootDir,
      path.resolve(this.rootDir, 'build', 'outputs', product)
    );
    if (!fs.existsSync(outputsDir)) {
      return [];
    }

    this.checkBuildPath(outputsDir);
    return fs.readdirSync(outputsDir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => {
        const file = path.join(outputsDir, entry.name);
        this.checkBuildFile(file);
        return file;
      });
  }

  /**
   * Collect all build artifacts for a given build target.
   *
   * For a product build, `moduleSpecs` should be pre-resolved via
   * `resolveModuleSpecsForProduct`; the project-level `.app` package is
   * also collected.
   *
   * For a module build, `moduleSpecs` are the user-requested modules.
   * All other modules are also scanned (with `@default` target) because
   * hvigor may have built HSP/HAR dependencies; missing output dirs are
   * silently skipped.
   */
  public collectBuildArtifacts(
    isProductBuild: boolean,
    moduleSpecs: string[],
    product: string
  ): string[] {
    let specs = moduleSpecs;
    if (!isProductBuild) {
      const requested = new Set(moduleSpecs);
      specs = [
        ...moduleSpecs,
        ...this.profile.modules
          .map((m) => `${m.name}@default`)
          .filter((s) => !requested.has(s)),
      ];
    }

    const artifacts = this.listBuildArtifacts(specs, product);
    if (isProductBuild) {
      artifacts.push(...this.listProjectAppArtifacts(product));
    }
    return artifacts;
  }

  private getSignedHapName(
    packageName: string,
    srcPath: string,
    product: string,
    target: string
  ): string | null {
    let signedHapName: string | null = null;
    if (packageName.endsWith('-unsigned.hap')) {
      signedHapName = packageName.replace('-unsigned.hap', '-signed.hap');
    } else if (packageName.endsWith('-unsigned.hsp')) {
      signedHapName = packageName.replace('-unsigned.hsp', '-signed.hsp');
    }

    if (!signedHapName) {
      return null;
    }

    const signedPackagePath = this.buildOutputPath(srcPath, product, [
      'outputs',
      target,
      signedHapName,
    ]);

    if (fs.existsSync(signedPackagePath)) {
      this.checkBuildFile(signedPackagePath);
      return signedHapName;
    }
    return null;
  }

  private buildOutputPath(
    srcPath: string,
    product: string,
    segments: string[]
  ): string {
    const observed = segments[0] === 'outputs'
      ? this.observedOutputPath('module', product, srcPath, segments[1]) : undefined;
    const srcDir = CommonUtils.resolvePathWithinRoot(this.rootDir, srcPath);
    const finalPath = observed ? path.resolve(observed, ...segments.slice(2))
      : path.resolve(srcDir, 'build', product, ...segments);
    this.checkBuildPath(finalPath);
    return finalPath;
  }

  private observedOutputPath(
    scope: BuildOutputLayout['paths'][number]['scope'], product: string,
    srcPath?: string, target?: string, kind?: 'hap' | 'hsp',
  ): string | undefined {
    if (!this.outputLayout) { return undefined; }
    if (this.outputLayout.invalid || this.outputLayout.binding !== 'observed-partial') {
      throw new Error('Build output paths were not observed safely');
    }
    const modulePath = srcPath === undefined ? undefined
      : path.relative(this.rootDir, CommonUtils.resolvePathWithinRoot(this.rootDir, srcPath)).split(path.sep).join('/');
    const matches = this.outputLayout.paths.filter((item) => item.scope === scope && item.product === product &&
      (item.scope === 'product' || item.modulePath === modulePath && item.target === target) &&
      (item.scope !== 'module-metadata' || item.kind === kind));
    const names = [...new Set(matches.map((item) => item.path))];
    if (!names.length) { throw new Error(`Build output path not observed for ${modulePath ?? 'product'}@${target ?? product} (${scope})`); }
    if (names.length !== 1 || this.outputLayout.paths.some((item) => item.path === names[0] && item.scope === scope &&
      (item.product !== product || item.scope !== 'product' && (item.modulePath !== modulePath || item.target !== target)))) {
      throw new Error('Ambiguous build output path attribution');
    }
    const file = CommonUtils.resolvePathWithinRoot(this.rootDir, names[0]);
    this.checkBuildPath(file);
    return file;
  }

  private checkBuildPath(file: string): void {
    CommonUtils.ensurePathWithinRoot(this.rootDir, file);
    const relative = path.relative(this.rootDir, file), parts = relative.split(path.sep);
    this.checkBuildPathSegments(relative);
    let current = this.rootDir;
    for (const part of [null, ...parts]) {
      if (part !== null) { current = path.join(current, part); }
      try { if (fs.lstatSync(current).isSymbolicLink()) { throw new Error('Symlink build output path'); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { break; } throw error; }
    }
  }

  private checkBuildPathSegments(file: string): void {
    if (file.split(path.sep).some((part) => privateEvidenceName.test(part) || /^(?:local\.properties|\.ohpmrc)$/i.test(part) ||
      [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      throw new Error('Unsafe build output path');
    }
  }

  private checkBuildFile(file: string): void {
    this.checkBuildPath(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) { throw new Error('Build output must be a regular file'); }
    if (stat.nlink !== 1) { throw new Error('Hardlinked build output file'); }
  }

  private collectRemoteHsps(items: Record<string, unknown>[]): { hspName: string; hspPath: string }[] {
    return items.flatMap((item) => {
      const deps = item.dependRemoteHsps as { hspName?: string; hspPath?: string }[] | undefined;
      if (!Array.isArray(deps)) {
        return [];
      }
      return deps
        .filter((dep): dep is { hspName: string; hspPath: string } => Boolean(dep.hspName && dep.hspPath))
        .map((dep) => ({ hspName: dep.hspName, hspPath: dep.hspPath }));
    });
  }

  private parseOutputMetadata(
    metadataPath: string,
    metadataKey: string
  ): {
    packageName: string;
    isSigned: boolean;
    dependRemoteHsps: { hspName: string; hspPath: string }[];
  } {
    let parsed: Record<string, unknown>[] | Record<string, unknown>;
    try {
      const content = fs.readFileSync(metadataPath, 'utf-8');
      parsed = json5.parse(content) as Record<string, unknown>[] | Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Failed to parse output metadata at ${metadataPath}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    }

    let packageName: string | undefined;
    let isSigned = false;

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!packageName) {
        packageName = item[metadataKey] as string | undefined;
      }
      if (!isSigned) {
        isSigned = item.isSigned === true;
      }
    }

    if (!packageName) {
      throw new TraceError(
        `Could not find ${metadataKey} in output_metadata.json at ${metadataPath}`,
        'Could not find metadataKey in output_metadata.json at metadataPath.'
      );
    }

    this.validatePackageName(packageName);

    const dependRemoteHsps = this.collectRemoteHsps(items);

    return { packageName, isSigned, dependRemoteHsps };
  }

private validatePackageName(packageName: string): void {
    const basename = path.basename(packageName);
    
    if (basename !== packageName) {
      throw new TraceError(
        `Invalid traversal name: '${packageName}'. It must contain path characters.`,
        'Invalid traversal name.'
      );
    }
    
    if (!basename.endsWith('.hap') && !basename.endsWith('.hsp')) {
      throw new TraceError(
        `Invalid package name '${basename}'.It must be a .hap or .hsp file.`,
        'Invalid package name.'
      );
    }
  }
}
