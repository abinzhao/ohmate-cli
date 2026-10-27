/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChangedFileListWriter } from './changed-file-list-writer.js';
import type { ModuleNode } from '../utils/project.js';

const tempRoots: string[] = [];
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cflw-ut-'));
  tempRoots.push(root);
  return root;
}
function writeJson(filePath: string, data: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}
function makeProject(): string {
  const root = makeRoot();
  writeJson(path.join(root, 'build-profile.json5'), {
    modules: [
      { name: 'entry', srcPath: './entry' },
      { name: 'libfeature', srcPath: './libfeature' },
      { name: 'feature', srcPath: './feature' },
    ],
  });
  writeJson(path.join(root, 'entry', 'src', 'main', 'module.json5'), {
    module: { type: 'entry' },
  });
  writeJson(path.join(root, 'entry', 'oh-package.json5'), {
    dependencies: { libfeature: 'file:../libfeature' },
  });
  writeJson(path.join(root, 'libfeature', 'src', 'main', 'module.json5'), {
    module: { type: 'har' },
  });
  writeJson(path.join(root, 'feature', 'src', 'main', 'module.json5'), {
    module: { type: 'shared' },
  });
  return root;
}
function hotReloadPath(
  root: string,
  moduleSrcPath: string,
  product = 'default'
): string {
  return path.join(
    root,
    moduleSrcPath,
    'build',
    product,
    'intermediates',
    'hotReload',
    'changedFileList.json'
  );
}
function patchPath(
  root: string,
  moduleSrcPath: string,
  product = 'default'
): string {
  return path.join(
    root,
    moduleSrcPath,
    'build',
    product,
    'intermediates',
    'patch',
    'default',
    'changedFileList.json'
  );
}
function readJson(filePath: string): Record<string, object> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
    string,
    object
  >;
}
afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe('ChangedFileListWriter.writeChangedFileLists', () => {
  it('routes ets changes of an entry module to its own collectors', () => {
    const root = makeProject();
    const ets = path.join(root, 'entry', 'src', 'main', 'ets', 'Index.ets');

    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [ets]
    );
    expect(result).toEqual({ writtenModules: ['entry'], skippedFiles: [] });
    expect(readJson(hotReloadPath(root, 'entry'))).toEqual({
      modifiedFilesV2: [{ filePath: ets, belongProjectPath: root }],
    });
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['Index.ets'],
    });
  });
  it('routes ets changes of a har module to its top-level consumers', () => {
    const root = makeProject();
    const util = path.join(
      root,
      'libfeature',
      'src',
      'main',
      'ets',
      'util.ets'
    );
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [util]
    );
    expect(result).toEqual({ writtenModules: ['entry'], skippedFiles: [] });
    expect(readJson(hotReloadPath(root, 'entry'))).toEqual({
      modifiedFilesV2: [{ filePath: util, belongProjectPath: root }],
    });
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['../../../../libfeature/src/main/ets/util.ets'],
    });
    expect(fs.existsSync(hotReloadPath(root, 'libfeature'))).toBe(false);
  });
  it('skips files with an unknown extension without writing anything', () => {
    const root = makeProject();
    const readme = path.join(root, 'entry', 'docs', 'README.md');
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [readme]
    );
    expect(result).toEqual({ writtenModules: [], skippedFiles: [readme] });
    expect(fs.existsSync(hotReloadPath(root, 'entry'))).toBe(false);
    expect(fs.existsSync(patchPath(root, 'entry'))).toBe(false);
  });
  it('skips known-extension files that live outside every module', () => {
    const root = makeProject();
    const loose = path.join(root, 'loose.ts');
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [loose]
    );
    expect(result).toEqual({ writtenModules: [], skippedFiles: [loose] });
    expect(fs.existsSync(patchPath(root, 'entry'))).toBe(false);
  });
  it('classifies rawfile and resfile resources into the patch resource buckets', () => {
    const root = makeProject();
    const raw = path.join(
      root,
      'entry',
      'src',
      'main',
      'resources',
      'rawfile',
      'data.txt'
    );
    const res = path.join(
      root,
      'entry',
      'src',
      'main',
      'resources',
      'resfile',
      'sheet.csv'
    );
    const resourceDir = path.join(root, 'entry', 'src', 'main', 'resources');
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [raw, res]
    );
    expect(result).toEqual({ writtenModules: ['entry'], skippedFiles: [] });
    expect(fs.existsSync(hotReloadPath(root, 'entry'))).toBe(false);
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: {
        rawFile: [{ filePath: raw, resourcePath: resourceDir }],
        resFile: [{ filePath: res, resourcePath: resourceDir }],
      },
      modifiedFiles: [],
    });
  });
  it('suppresses the hotReload file for modules other than the active one', () => {
    const root = makeProject();
    const ets = path.join(root, 'entry', 'src', 'main', 'ets', 'Index.ets');
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [ets],
      'other'
    );
    expect(result).toEqual({ writtenModules: ['entry'], skippedFiles: [] });
    expect(fs.existsSync(hotReloadPath(root, 'entry'))).toBe(false);
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['Index.ets'],
    });
  });
  it('merges new entries into an existing list and deduplicates by filePath', () => {
    const root = makeProject();
    const ets = path.join(root, 'entry', 'src', 'main', 'ets', 'Index.ets');
    writeJson(hotReloadPath(root, 'entry'), {
      modifiedFilesV2: [{ filePath: 'old.ets', belongProjectPath: 'old-root' }],
    });
    writeJson(patchPath(root, 'entry'), {
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['Old.ets'],
    });
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [ets, ets]
    );
    expect(result).toEqual({ writtenModules: ['entry'], skippedFiles: [] });
    expect(readJson(hotReloadPath(root, 'entry'))).toEqual({
      modifiedFilesV2: [
        { filePath: 'old.ets', belongProjectPath: 'old-root' },
        { filePath: ets, belongProjectPath: root },
      ],
    });
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['Old.ets', 'Index.ets'],
    });
  });
  it('returns every file as skipped when the project has no build profile', () => {
    const root = makeRoot();
    const loose = path.join(root, 'entry', 'src', 'main', 'ets', 'Index.ets');
    const result = ChangedFileListWriter.writeChangedFileLists(
      root,
      'default',
      [loose]
    );
    expect(result).toEqual({ writtenModules: [], skippedFiles: [loose] });
  });
});
describe('ChangedFileListWriter.initEmptyChangedFileLists', () => {
  it('creates empty patch lists for entry and shared modules and skips har modules', () => {
    const root = makeProject();
    const initialized = ChangedFileListWriter.initEmptyChangedFileLists(
      root,
      'default'
    );
    expect(initialized).toEqual(['entry', 'feature']);
    expect(readJson(patchPath(root, 'entry'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: [],
    });
    expect(readJson(patchPath(root, 'feature'))).toEqual({
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: [],
    });
    expect(readJson(hotReloadPath(root, 'entry'))).toEqual({
      modifiedFilesV2: [],
    });
    expect(readJson(hotReloadPath(root, 'feature'))).toEqual({
      modifiedFilesV2: [],
    });
    expect(fs.existsSync(patchPath(root, 'libfeature'))).toBe(false);
    expect(fs.existsSync(hotReloadPath(root, 'libfeature'))).toBe(false);
  });
  it('creates the hotReload list only for the active module', () => {
    const root = makeProject();
    const initialized = ChangedFileListWriter.initEmptyChangedFileLists(
      root,
      'default',
      'entry'
    );
    expect(initialized).toEqual(['entry', 'feature']);
    expect(fs.existsSync(hotReloadPath(root, 'entry'))).toBe(true);
    expect(fs.existsSync(hotReloadPath(root, 'feature'))).toBe(false);
    expect(fs.existsSync(patchPath(root, 'feature'))).toBe(true);
  });
  it('does not overwrite pre-existing lists', () => {
    const root = makeProject();
    const existing = {
      resources: { resFile: [], rawFile: [] },
      modifiedFiles: ['Keep.ets'],
    };
    writeJson(patchPath(root, 'entry'), existing);
    ChangedFileListWriter.initEmptyChangedFileLists(root, 'default');
    expect(readJson(patchPath(root, 'entry'))).toEqual(existing);
  });
  it('returns an empty list when the project has no build profile', () => {
    const root = makeRoot();
    expect(
      ChangedFileListWriter.initEmptyChangedFileLists(root, 'default')
    ).toEqual([]);
  });
});
describe('ChangedFileListWriter.loadBuildProfile', () => {
  it('returns null when the profile is missing', () => {
    const root = makeRoot();
    expect(ChangedFileListWriter.loadBuildProfile(root)).toBeNull();
  });
  it('returns null on malformed profile content', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'build-profile.json5'), '{{{', 'utf-8');
    expect(ChangedFileListWriter.loadBuildProfile(root)).toBeNull();
  });
  it('parses the runnable module list', () => {
    const root = makeProject();
    const profile = ChangedFileListWriter.loadBuildProfile(root);
    expect(profile).not.toBeNull();
    expect(
      (profile as { modules: ModuleNode[] }).modules.map(
        (m: ModuleNode) => m.name
      )
    ).toEqual(['entry', 'libfeature', 'feature']);
  });
});
describe('ChangedFileListWriter.findModuleByFilePath', () => {
  it('matches the module owning the file path', () => {
    const root = makeProject();
    const profile = ChangedFileListWriter.loadBuildProfile(root) as {
      modules: ModuleNode[];
    };
    const found = ChangedFileListWriter.findModuleByFilePath(
      path.join(root, 'entry', 'src', 'main', 'ets', 'Index.ets'),
      root,
      profile.modules
    );
    expect((found as ModuleNode).name).toBe('entry');
  });
  it('treats the module directory itself as part of the module', () => {
    const root = makeProject();
    const profile = ChangedFileListWriter.loadBuildProfile(root) as {
      modules: ModuleNode[];
    };
    const found = ChangedFileListWriter.findModuleByFilePath(
      path.join(root, 'entry'),
      root,
      profile.modules
    );
    expect((found as ModuleNode).name).toBe('entry');
  });
  it('does not match a directory whose name merely starts with a module name', () => {
    const root = makeProject();
    const profile = ChangedFileListWriter.loadBuildProfile(root) as {
      modules: ModuleNode[];
    };
    const found = ChangedFileListWriter.findModuleByFilePath(
      path.join(root, 'entry_extra', 'x.ts'),
      root,
      profile.modules
    );
    expect(found).toBeNull();
  });
});
describe('ChangedFileListWriter.getModuleType', () => {
  it('reads the type from module.json5', () => {
    const root = makeProject();
    expect(ChangedFileListWriter.getModuleType(root, 'entry')).toBe('entry');
    expect(ChangedFileListWriter.getModuleType(root, 'libfeature')).toBe('har');
    expect(ChangedFileListWriter.getModuleType(root, 'feature')).toBe('shared');
  });
  it('falls back to entry when module.json5 is missing or malformed', () => {
    const root = makeProject();
    expect(ChangedFileListWriter.getModuleType(root, 'no-such-module')).toBe(
      'entry'
    );
    fs.mkdirSync(path.join(root, 'broken', 'src', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'broken', 'src', 'main', 'module.json5'),
      '{{{',
      'utf-8'
    );
    expect(ChangedFileListWriter.getModuleType(root, 'broken')).toBe('entry');
  });
});
