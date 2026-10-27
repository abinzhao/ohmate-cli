/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Project } from './project.js';
import type { BuildOutputLayout } from '../quality/build-output-layout.js';
const tempRoots: string[] = [];
function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data));
}
function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ut-'));
  tempRoots.push(root);
  writeProjectMetadata(root);
  writeEntryModule(root);
  writeLibfeatureModule(root);
  writeSecondModule(root);
  fs.mkdirSync(path.join(root, 'bare'), { recursive: true });
  return root;
}
function writeProjectMetadata(root: string): void {
  fs.mkdirSync(path.join(root, 'AppScope'), { recursive: true });
  writeJson(path.join(root, 'AppScope', 'app.json5'), {
    app: {
      bundleName: 'com.example.myapplication',
      bundleType: 'atomicService',
    },
  });
  writeJson(path.join(root, 'build-profile.json5'), {
    app: {
      products: [
        { name: 'default' },
        { name: 'phone', bundleName: 'com.example.phone' },
      ],
      buildModeSet: [{ name: 'debug' }],
    },
    modules: [
      { name: 'entry', srcPath: './entry' },
      { name: 'libfeature', srcPath: './libfeature' },
      { name: 'bare', srcPath: './bare' },
      { name: 'second', srcPath: './second' },
    ],
  });
}
function writeEntryModule(root: string): void {
  fs.mkdirSync(path.join(root, 'entry', 'src', 'main'), { recursive: true });
  writeJson(path.join(root, 'entry', 'src', 'main', 'module.json5'), {
    module: {
      type: 'entry',
      abilities: [{ name: 'SecondAbility' }, { name: 'EntryAbility' }],
    },
  });
  writeJson(path.join(root, 'entry', 'oh-package.json5'), {
    dependencies: { libfeature: 'file:../libfeature', lodash: '4.17.21' },
  });
  writeJson(path.join(root, 'entry', 'build-profile.json5'), {
    targets: [{ name: 'default' }],
  });
}
function writeLibfeatureModule(root: string): void {
  fs.mkdirSync(path.join(root, 'libfeature', 'src', 'main'), {
    recursive: true,
  });
  writeJson(path.join(root, 'libfeature', 'src', 'main', 'module.json5'), {
    module: { type: 'har' },
  });
}
function writeSecondModule(root: string): void {
  fs.mkdirSync(path.join(root, 'second', 'src', 'main'), { recursive: true });
  writeJson(path.join(root, 'second', 'src', 'main', 'module.json5'), {
    module: { type: 'shared', abilities: [{ name: 'MainAbility' }] },
  });
  writeJson(path.join(root, 'second', 'oh-package.json5'), {
    dependencies: { remotelibrary: '1.0.0' },
  });
}
afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe('Project.discover', () => {
  it('finds the project root walking up from a nested directory', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(path.join(root, 'entry', 'src', 'main'));
    expect(project.rootDir).toBe(root);
    expect(project.profile.modules.map((m) => m.name)).toEqual([
      'entry',
      'libfeature',
      'bare',
      'second',
    ]);
  });
  it('throws when no build-profile.json5 exists up the tree', () => {
    const emptyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'project-ut-empty-')
    );
    tempRoots.push(emptyRoot);
    expect(() => Project.discover(emptyRoot)).toThrow(
      'Not in a valid project directory'
    );
  });
});
describe('Project.getModuleType', () => {
  it('reads the type from module.json5', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getModuleType('entry')).toBe('entry');
    expect(project.getModuleType('libfeature')).toBe('har');
    expect(project.getModuleType('second')).toBe('shared');
  });
  it('defaults to entry when module.json5 is missing', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getModuleType('bare')).toBe('entry');
  });
  it('throws for unknown modules', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.getModuleType('nope')).toThrow(
      "Module 'nope' not found"
    );
  });
});
describe('Project.findOwningModule', () => {
  it('maps file paths to their owning module', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(
      project.findOwningModule(path.join(root, 'entry', 'src', 'main', 'x.ts'))
    ).toBe('entry');
    expect(
      project.findOwningModule(path.join(root, 'libfeature', 'y.ts'))
    ).toBe('libfeature');
    expect(project.findOwningModule(path.join(root, 'entry'))).toBe('entry');
  });
  it('returns null for files outside any module', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.findOwningModule(path.join(root, 'README.md'))).toBeNull();
  });
});
describe('Project.getModuleProfile', () => {
  it('parses the module-level build profile', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getModuleProfile('entry')).toEqual({
      targets: [{ name: 'default' }],
    });
  });
  it('throws when the module build profile is missing', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.getModuleProfile('bare')).toThrow(
      "Build profile for module 'bare' not found"
    );
  });
});
describe('Project.getBundleName / isAtomicService', () => {
  it('reads the bundleName from AppScope/app.json5', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getBundleName()).toBe('com.example.myapplication');
  });
  it('prefers the per-product bundleName override', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getBundleName('phone')).toBe('com.example.phone');
  });
  it('falls back to AppScope for unknown products', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getBundleName('nosuch')).toBe('com.example.myapplication');
  });
  it('detects atomic services via bundleType', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.isAtomicService()).toBe(true);
  });
});
describe('Project.validateProduct', () => {
  it('accepts configured products', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.validateProduct('default')).not.toThrow();
    expect(() => project.validateProduct('phone')).not.toThrow();
  });
  it('rejects invalid characters', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.validateProduct('has space')).toThrow(
      'Invalid product name'
    );
  });
  it('rejects unknown products and lists the available ones', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.validateProduct('nosuch')).toThrow(/default, phone/);
  });
});
describe('Project.getMainAbility', () => {
  it('returns the explicit ability when given', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getMainAbility('entry', 'CustomAbility')).toBe(
      'CustomAbility'
    );
  });
  it('prefers EntryAbility among the declared abilities', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getMainAbility('entry')).toBe('EntryAbility');
  });
  it('falls back to the first declared ability when EntryAbility is absent', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getMainAbility('second')).toBe('MainAbility');
  });
  it('defaults to EntryAbility when metadata is missing', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getMainAbility('bare')).toBe('EntryAbility');
    expect(project.getMainAbility('nope')).toBe('EntryAbility');
  });
});
describe('Project.getModuleDependencies', () => {
  it('resolves local file: deps from the module oh-package and skips registry deps', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getModuleDependencies('entry')).toEqual(['libfeature']);
  });
  it('applies root overrides before the declared dep value', () => {
    const root = makeFixtureRoot();
    fs.writeFileSync(
      path.join(root, 'oh-package.json5'),
      JSON.stringify({ overrides: { libfeature: 'file:./second' } })
    );
    const project = Project.discover(root);
    expect(project.getModuleDependencies('entry')).toEqual(['second']);
  });
  it('returns an empty list for modules without dependencies', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.getModuleDependencies('bare')).toEqual([]);
    expect(project.getModuleDependencies('nope')).toEqual([]);
  });
  it('prefers lock.json5 dependencies when the lock exists', () => {
    const root = makeFixtureRoot();
    const lockDir = path.join(root, 'oh_modules', '.ohpm');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'lock.json5'),
      JSON.stringify({
        modules: {
          './entry': {
            name: 'entry',
            dependencies: { libfeature: { version: 'file:./libfeature' } },
            dynamicDependencies: { sharedlib: { version: 'file:./second' } },
          },
        },
      })
    );
    const project = Project.discover(root);
    expect(project.getModuleDependencies('entry')).toEqual([
      'libfeature',
      'second',
    ]);
  });
  it('applies lock-level overrides override-first', () => {
    const root = makeFixtureRoot();
    const lockDir = path.join(root, 'oh_modules', '.ohpm');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'lock.json5'),
      JSON.stringify({
        modules: {
          './entry': {
            name: 'entry',
            dependencies: { libfeature: { version: 'file:./libfeature' } },
          },
        },
        overrides: { libfeature: 'file:./second' },
      })
    );
    const project = Project.discover(root);
    expect(project.getModuleDependencies('entry')).toEqual(['second']);
  });
});
describe('Project.collectNonHarDependentModuleList', () => {
  it('walks the dependency graph and drops har modules', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.collectNonHarDependentModuleList('entry')).toEqual([
      'entry',
    ]);
    expect(project.collectNonHarDependentModuleList('second')).toEqual([
      'second',
    ]);
  });
});
describe('Project.findArtifactPath', () => {
  function writeBuildArtifacts(root: string): string {
    const metaDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'hap_metadata',
      'default'
    );
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'output_metadata.json'),
      JSON.stringify([
        {
          hapName: 'entry-default-unsigned.hap',
          isSigned: false,
          dependRemoteHsps: [
            { hspName: 'libfeature', hspPath: 'libfeature-default-signed.hsp' },
            { hspName: 'libfeature', hspPath: 'libfeature-default-signed.hsp' },
          ],
        },
      ])
    );
    const outDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'outputs',
      'default'
    );
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'entry-default-unsigned.hap'), '');
    return outDir;
  }
  it('returns the unsigned package for emulator targets', () => {
    const root = makeFixtureRoot();
    const outDir = writeBuildArtifacts(root);
    const project = Project.discover(root);
    expect(project.findArtifactPath('entry', 'default', true)).toBe(
      path.join(outDir, 'entry-default-unsigned.hap')
    );
  });
  it('rejects unsigned artifacts for real devices', () => {
    const root = makeFixtureRoot();
    writeBuildArtifacts(root);
    const project = Project.discover(root);
    expect(() => project.findArtifactPath('entry', 'default', false)).toThrow(
      /not signed/
    );
  });
  it('prefers the signed package for real devices once it exists', () => {
    const root = makeFixtureRoot();
    const outDir = writeBuildArtifacts(root);
    fs.writeFileSync(path.join(outDir, 'entry-default-signed.hap'), '');
    const project = Project.discover(root);
    expect(project.findArtifactPath('entry', 'default', false)).toBe(
      path.join(outDir, 'entry-default-signed.hap')
    );
  });
  it('throws when build metadata does not exist yet', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(() => project.findArtifactPath('entry', 'default', true)).toThrow(
      /Build the project first/
    );
  });
  it('rejects package names containing path traversal', () => {
    const root = makeFixtureRoot();
    writeBuildArtifacts(root);
    const metaPath = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'hap_metadata',
      'default',
      'output_metadata.json'
    );
    fs.writeFileSync(metaPath, JSON.stringify([{ hapName: '../evil.hap' }]));
    const project = Project.discover(root);
    expect(() => project.findArtifactPath('entry', 'default', true)).toThrow(
      /Invalid traversal name/
    );
  });
  it('rejects package names without a .hap/.hsp suffix', () => {
    const root = makeFixtureRoot();
    writeBuildArtifacts(root);
    const metaPath = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'hap_metadata',
      'default',
      'output_metadata.json'
    );
    fs.writeFileSync(
      metaPath,
      JSON.stringify([{ hapName: 'entry-default.txt' }])
    );
    const project = Project.discover(root);
    expect(() => project.findArtifactPath('entry', 'default', true)).toThrow(
      /Invalid package name/
    );
  });
});
describe('Project.findRemoteHspPaths', () => {
  it('resolves and deduplicates remote hsp entries from metadata', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'hap_metadata',
      'default'
    );
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'output_metadata.json'),
      JSON.stringify([
        {
          hapName: 'entry-default-signed.hap',
          isSigned: true,
          dependRemoteHsps: [
            { hspName: 'libfeature', hspPath: 'libfeature-default-signed.hsp' },
            { hspName: 'libfeature', hspPath: 'libfeature-default-signed.hsp' },
          ],
        },
      ])
    );
    const outputsDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'outputs',
      'default'
    );
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputsDir, 'libfeature-default-signed.hsp'),
      ''
    );
    const project = Project.discover(root);
    expect(project.findRemoteHspPaths('entry', 'default')).toEqual([
      path.join(outputsDir, 'libfeature-default-signed.hsp'),
    ]);
  });
  it('throws when a remote hsp file is missing', () => {
    const root = makeFixtureRoot();
    const metaDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'hap_metadata',
      'default'
    );
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'output_metadata.json'),
      JSON.stringify([
        {
          hapName: 'entry-default-signed.hap',
          isSigned: true,
          dependRemoteHsps: [{ hspName: 'gone', hspPath: 'missing.hsp' }],
        },
      ])
    );
    const project = Project.discover(root);
    expect(() => project.findRemoteHspPaths('entry', 'default')).toThrow(
      /Remote HSP dependency not found/
    );
  });
});

describe('Project observed build paths', () => {
  function fixture(shared = false) {
    const root = makeFixtureRoot(), moduleName = shared ? 'second' : 'entry';
    const output = path.join(root, 'build', 'relocated', moduleName, 'packages');
    const metadata = path.join(root, 'build', 'cache', moduleName, 'output_metadata.json');
    const appOutput = path.join(root, 'build', 'relocated', 'product');
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    fs.mkdirSync(appOutput, { recursive: true });
    const suffix = shared ? 'hsp' : 'hap', unsigned = `${moduleName}-unsigned.${suffix}`;
    writeJson(metadata, [{ [shared ? 'hspName' : 'hapName']: unsigned, isSigned: false,
      dependRemoteHsps: [{ hspName: 'remote', hspPath: 'remote-signed.hsp' }] }]);
    fs.writeFileSync(path.join(output, unsigned), 'current artifact');
    fs.writeFileSync(path.join(output, 'remote-signed.hsp'), 'current remote');
    fs.writeFileSync(path.join(appOutput, 'current.app'), 'current product');
    const layout: BuildOutputLayout = { binding: 'observed-partial', invalid: false, missing: ['full-final-output-layout'],
      paths: [
        { scope: 'module', modulePath: moduleName, target: 'default', product: 'default', path: path.relative(root, output) },
        { scope: 'module-metadata', modulePath: moduleName, target: 'default', product: 'default',
          kind: shared ? 'hsp' : 'hap', path: path.relative(root, metadata) },
        { scope: 'product', product: 'default', path: path.relative(root, appOutput) },
      ] };
    return { root, moduleName, output, metadata, appOutput, layout, unsigned };
  }
  it.each([false, true])('uses independently observed output and metadata paths (shared=%s)', (shared) => {
    const f = fixture(shared);
    const project = Project.discover(f.root, f.layout);
    expect(project.findArtifactPath(f.moduleName, 'default', true)).toBe(path.join(f.output, f.unsigned));
    expect(project.findRemoteHspPaths(f.moduleName, 'default')).toEqual([path.join(f.output, 'remote-signed.hsp')]);
    expect(project.listBuildArtifacts([f.moduleName], 'default')).toEqual(
      [path.join(f.output, f.unsigned), path.join(f.output, 'remote-signed.hsp')].sort());
  });
  it('prefers the signed file only in the observed output directory', () => {
    const f = fixture(), signed = 'entry-signed.hap';
    fs.writeFileSync(path.join(f.output, signed), 'current signed artifact');
    expect(Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', false)).toBe(path.join(f.output, signed));
  });
  it('rejects unsigned output for a real device with an observed layout', () => {
    const f = fixture();
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', false)).toThrow(/not signed/);
  });
  it('does not fall back to stale default metadata when the requested facet was not observed', () => {
    const f = fixture();
    const legacy = path.join(f.root, 'entry/build/default/intermediates/hap_metadata/default');
    fs.mkdirSync(legacy, { recursive: true });
    writeJson(path.join(legacy, 'output_metadata.json'), [{ hapName: 'stale-signed.hap', isSigned: true }]);
    fs.mkdirSync(path.join(f.root, 'entry/build/default/outputs/default'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'entry/build/default/outputs/default/stale-signed.hap'), 'stale');
    f.layout.paths = f.layout.paths.map(item => item.scope === 'product' ? item : { ...item, target: 'other' });
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', true)).toThrow(/not observed/);
  });
  it('rejects ambiguous paths for the same facet', () => {
    const f = fixture();
    f.layout.paths.push({ ...f.layout.paths[0], path: 'build/other' });
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', true)).toThrow(/Ambiguous/);
  });
  it('rejects an output directory attributed to another target as well', () => {
    const f = fixture();
    f.layout.paths.push({ ...f.layout.paths[0], scope: 'module', modulePath: 'second', target: 'default' });
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', true)).toThrow(/Ambiguous/);
  });
  it.each([false, true])('rejects sensitive remote path segments before normalization (absolute=%s)', (absolute) => {
    const f = fixture();
    const raw = '.ssh/../remote-signed.hsp';
    const hspPath = absolute ? `${f.output}/${raw}` : raw;
    writeJson(f.metadata, [{ hapName: f.unsigned, isSigned: false,
      dependRemoteHsps: [{ hspName: 'remote', hspPath }] }]);
    expect(() => Project.discover(f.root, f.layout).findRemoteHspPaths('entry', 'default')).toThrow(/Unsafe/);
  });
  it.each(['escape', 'symlink', 'hardlink', 'directory'])('rejects unsafe remote HSP files (%s)', (kind) => {
    const f = fixture(), file = path.join(f.output, 'remote-signed.hsp');
    if (kind === 'escape') {
      writeJson(f.metadata, [{ hapName: f.unsigned,
        dependRemoteHsps: [{ hspName: 'remote', hspPath: '../'.repeat(8) + 'outside.hsp' }] }]);
    } else {
      fs.renameSync(file, file + '.original');
      if (kind === 'symlink') { fs.symlinkSync(file + '.original', file); }
      if (kind === 'hardlink') { fs.linkSync(file + '.original', file); }
      if (kind === 'directory') { fs.mkdirSync(file); }
    }
    expect(() => Project.discover(f.root, f.layout).findRemoteHspPaths('entry', 'default')).toThrow(
      /escapes|Symlink|Hardlinked|regular file/);
  });
  it('lists only direct product artifacts without following symbol subtrees', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.appOutput, 'unobserved'), { recursive: true });
    fs.writeFileSync(path.join(f.appOutput, 'unobserved', 'foreign.app'), 'foreign');
    fs.symlinkSync(path.join(f.root, 'entry'), path.join(f.appOutput, 'symbols'));
    expect(Project.discover(f.root, f.layout).listProjectAppArtifacts('default')).toEqual([path.join(f.appOutput, 'current.app')]);
  });
  it.each(['escape', 'sensitive', 'symlink', 'hardlink'])('rejects unsafe observed metadata (%s)', (kind) => {
    const f = fixture();
    if (kind === 'escape') { f.layout.paths[1].path = '../outside/output_metadata.json'; }
    if (kind === 'sensitive') { f.layout.paths[1].path = '.ssh/output_metadata.json'; }
    if (kind === 'symlink') {
      fs.renameSync(f.metadata, f.metadata + '.original');
      fs.symlinkSync(f.metadata + '.original', f.metadata);
    }
    if (kind === 'hardlink') { fs.linkSync(f.metadata, f.metadata + '.alias'); }
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', true)).toThrow(
      /Unsafe|Symlink|Hardlinked|escapes/);
  });
  it.each(['symlink', 'hardlink', 'directory'])('rejects an unsafe artifact (%s)', (kind) => {
    const f = fixture(), file = path.join(f.output, f.unsigned);
    fs.renameSync(file, file + '.original');
    if (kind === 'symlink') { fs.symlinkSync(file + '.original', file); }
    if (kind === 'hardlink') { fs.linkSync(file + '.original', file); }
    if (kind === 'directory') { fs.mkdirSync(file); }
    expect(() => Project.discover(f.root, f.layout).findArtifactPath('entry', 'default', true)).toThrow(
      /Symlink|Hardlinked|regular file/);
  });
});

describe('Project.listBuildArtifacts', () => {
  function writeOutputFiles(
    root: string,
    moduleName: string,
    product: string,
    target: string,
    files: string[]
  ): string {
    const outDir = path.join(root, moduleName, 'build', product, 'outputs', target);
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(path.join(outDir, file), '');
    }
    return outDir;
  }
  function sorted(arr: string[]): string[] {
    return [...arr].sort();
  }

  it('lists .hap files for entry modules', () => {
    const root = makeFixtureRoot();
    const outDir = writeOutputFiles(root, 'entry', 'default', 'default', [
      'entry-default-unsigned.hap',
      'entry-default-signed.hap',
    ]);
    const project = Project.discover(root);
    expect(
      sorted(project.listBuildArtifacts(['entry@default'], 'default'))
    ).toEqual(
      sorted([
        path.join(outDir, 'entry-default-unsigned.hap'),
        path.join(outDir, 'entry-default-signed.hap'),
      ])
    );
  });

  it('lists .hsp files for shared modules', () => {
    const root = makeFixtureRoot();
    const outDir = writeOutputFiles(root, 'second', 'default', 'default', [
      'second-default-signed.hsp',
    ]);
    const project = Project.discover(root);
    expect(project.listBuildArtifacts(['second@default'], 'default')).toEqual([
      path.join(outDir, 'second-default-signed.hsp'),
    ]);
  });

  it('lists .har files for har modules', () => {
    const root = makeFixtureRoot();
    const outDir = writeOutputFiles(root, 'libfeature', 'default', 'default', [
      'libfeature-default.har',
    ]);
    const project = Project.discover(root);
    expect(
      project.listBuildArtifacts(['libfeature@default'], 'default')
    ).toEqual([path.join(outDir, 'libfeature-default.har')]);
  });

  it('returns empty array when output directory does not exist', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.listBuildArtifacts(['entry@default'], 'default')).toEqual(
      []
    );
  });

  it('handles multiple modules in one call', () => {
    const root = makeFixtureRoot();
    const entryOut = writeOutputFiles(root, 'entry', 'default', 'default', [
      'entry-default-unsigned.hap',
    ]);
    const secondOut = writeOutputFiles(root, 'second', 'default', 'default', [
      'second-default-signed.hsp',
    ]);
    const project = Project.discover(root);
    expect(
      project.listBuildArtifacts(
        ['entry@default', 'second@default'],
        'default'
      )
    ).toEqual([
      path.join(entryOut, 'entry-default-unsigned.hap'),
      path.join(secondOut, 'second-default-signed.hsp'),
    ]);
  });

  it('defaults to "default" target when module spec has no @target', () => {
    const root = makeFixtureRoot();
    const outDir = writeOutputFiles(root, 'entry', 'default', 'default', [
      'entry-default-unsigned.hap',
    ]);
    const project = Project.discover(root);
    expect(project.listBuildArtifacts(['entry'], 'default')).toEqual([
      path.join(outDir, 'entry-default-unsigned.hap'),
    ]);
  });

  it('skips non-artifact files in the output directory', () => {
    const root = makeFixtureRoot();
    writeOutputFiles(root, 'entry', 'default', 'default', [
      'entry-default-unsigned.hap',
      'output_metadata.json',
      'some-log.txt',
    ]);
    const project = Project.discover(root);
    expect(project.listBuildArtifacts(['entry@default'], 'default')).toEqual([
      path.join(
        root,
        'entry',
        'build',
        'default',
        'outputs',
        'default',
        'entry-default-unsigned.hap'
      ),
    ]);
  });

  it('skips unknown modules silently', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(
      project.listBuildArtifacts(['nonexistent@default'], 'default')
    ).toEqual([]);
  });
});

describe('Project.resolveModuleSpecsForProduct', () => {
  function writeProjectProfileWithTargets(
    root: string,
    modules: Array<{
      name: string;
      srcPath: string;
      targets?: Array<{ name: string; applyToProducts?: string[] }>;
    }>
  ): void {
    writeJson(path.join(root, 'build-profile.json5'), {
      app: {
        products: [{ name: 'default' }, { name: 'phone' }],
        buildModeSet: [{ name: 'debug' }],
      },
      modules,
    });
  }

  it('includes targets without applyToProducts for any product', () => {
    const root = makeFixtureRoot();
    writeProjectProfileWithTargets(root, [
      {
        name: 'entry',
        srcPath: './entry',
        targets: [{ name: 'default' }],
      },
      { name: 'libfeature', srcPath: './libfeature' },
    ]);
    const project = Project.discover(root);
    expect(
      project.resolveModuleSpecsForProduct('default')
    ).toContain('entry@default');
    expect(
      project.resolveModuleSpecsForProduct('phone')
    ).toContain('entry@default');
  });

  it('includes targets whose applyToProducts matches the product', () => {
    const root = makeFixtureRoot();
    writeProjectProfileWithTargets(root, [
      {
        name: 'entry',
        srcPath: './entry',
        targets: [
          { name: 'default' },
          { name: 'phone', applyToProducts: ['phone'] },
        ],
      },
    ]);
    const project = Project.discover(root);
    const phoneSpecs = project.resolveModuleSpecsForProduct('phone');
    expect(phoneSpecs).toContain('entry@default');
    expect(phoneSpecs).toContain('entry@phone');

    const defaultSpecs = project.resolveModuleSpecsForProduct('default');
    expect(defaultSpecs).toContain('entry@default');
    expect(defaultSpecs).not.toContain('entry@phone');
  });

  it('skips modules whose targets all exclude the product', () => {
    const root = makeFixtureRoot();
    writeProjectProfileWithTargets(root, [
      {
        name: 'entry',
        srcPath: './entry',
        targets: [{ name: 'phone', applyToProducts: ['phone'] }],
      },
    ]);
    const project = Project.discover(root);
    const specs = project.resolveModuleSpecsForProduct('default');
    expect(specs).not.toContain('entry@phone');
    expect(specs).not.toContain('entry@default');
  });

  it('falls back to @default when module has no project-level targets', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    // Default fixture: modules have no project-level targets field
    expect(
      project.resolveModuleSpecsForProduct('default')
    ).toContain('libfeature@default');
    expect(
      project.resolveModuleSpecsForProduct('default')
    ).toContain('second@default');
  });

  it('falls back to @default when module has empty targets', () => {
    const root = makeFixtureRoot();
    writeProjectProfileWithTargets(root, [
      { name: 'entry', srcPath: './entry', targets: [] },
    ]);
    const project = Project.discover(root);
    expect(
      project.resolveModuleSpecsForProduct('default')
    ).toContain('entry@default');
  });
});

describe('Project.listProjectAppArtifacts', () => {
  it('finds .app files in the project-level outputs directory', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'build', 'outputs', 'default');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'myapp-default-signed.app'), '');
    const project = Project.discover(root);
    expect(project.listProjectAppArtifacts('default')).toEqual([
      path.join(outDir, 'myapp-default-signed.app'),
    ]);
  });

  it('does not attribute .app files in unobserved subdirectories', () => {
    const root = makeFixtureRoot();
    const subDir = path.join(
      root,
      'build',
      'outputs',
      'default',
      'default'
    );
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'myapp-default-signed.app'),
      ''
    );
    const project = Project.discover(root);
    expect(project.listProjectAppArtifacts('default')).toEqual([]);
  });

  it('returns empty when no .app files exist', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'build', 'outputs', 'default');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'some-other-file.txt'), '');
    const project = Project.discover(root);
    expect(project.listProjectAppArtifacts('default')).toEqual([]);
  });

  it('returns empty when the outputs directory does not exist', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(project.listProjectAppArtifacts('default')).toEqual([]);
  });

  it('ignores non-.app files', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'build', 'outputs', 'default');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'entry-default-unsigned.hap'),
      ''
    );
    fs.writeFileSync(path.join(outDir, 'myapp-default-signed.app'), '');
    const project = Project.discover(root);
    expect(project.listProjectAppArtifacts('default')).toEqual([
      path.join(outDir, 'myapp-default-signed.app'),
    ]);
  });
});

describe('Project.collectBuildArtifacts', () => {
  function writeModuleArtifacts(
    root: string,
    moduleName: string,
    product: string,
    target: string,
    files: string[]
  ): string {
    const outDir = path.join(
      root,
      moduleName,
      'build',
      product,
      'outputs',
      target
    );
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(path.join(outDir, file), '');
    }
    return outDir;
  }
  function writeProjectApp(
    root: string,
    product: string,
    files: string[]
  ): string {
    const outDir = path.join(root, 'build', 'outputs', product);
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(path.join(outDir, file), '');
    }
    return outDir;
  }

  it('product build collects module artifacts and project-level .app', () => {
    const root = makeFixtureRoot();
    const entryOut = writeModuleArtifacts(
      root,
      'entry',
      'default',
      'default',
      ['entry-default-unsigned.hap']
    );
    const appOut = writeProjectApp(root, 'default', [
      'myapp-default-signed.app',
    ]);
    const project = Project.discover(root);
    const specs = project.resolveModuleSpecsForProduct('default');
    const artifacts = project.collectBuildArtifacts(true, specs, 'default');
    expect(artifacts).toContain(
      path.join(entryOut, 'entry-default-unsigned.hap')
    );
    expect(artifacts).toContain(
      path.join(appOut, 'myapp-default-signed.app')
    );
  });

  it('module build collects requested and dependent module artifacts', () => {
    const root = makeFixtureRoot();
    const entryOut = writeModuleArtifacts(
      root,
      'entry',
      'default',
      'default',
      ['entry-default-unsigned.hap']
    );
    const secondOut = writeModuleArtifacts(
      root,
      'second',
      'default',
      'default',
      ['second-default-signed.hsp']
    );
    const project = Project.discover(root);
    const artifacts = project.collectBuildArtifacts(
      false,
      ['entry@default'],
      'default'
    );
    expect(artifacts).toContain(
      path.join(entryOut, 'entry-default-unsigned.hap')
    );
    expect(artifacts).toContain(
      path.join(secondOut, 'second-default-signed.hsp')
    );
  });

  it('module build does not collect project-level .app', () => {
    const root = makeFixtureRoot();
    writeModuleArtifacts(root, 'entry', 'default', 'default', [
      'entry-default-unsigned.hap',
    ]);
    writeProjectApp(root, 'default', ['myapp-default-signed.app']);
    const project = Project.discover(root);
    const artifacts = project.collectBuildArtifacts(
      false,
      ['entry@default'],
      'default'
    );
    expect(artifacts.every((a) => !a.endsWith('.app'))).toBe(true);
  });

  it('returns empty when no artifacts exist', () => {
    const root = makeFixtureRoot();
    const project = Project.discover(root);
    expect(
      project.collectBuildArtifacts(false, ['entry@default'], 'default')
    ).toEqual([]);
  });
});
