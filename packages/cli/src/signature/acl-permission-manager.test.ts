/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getAutoSignProjectReqPermissions } from './acl-permission-manager.js';
import { AclPermissionInfo } from './acl-permission-config.js';
import { ACL_PERMISSIONS_MSG } from './acl-permission-message.js';
import { Project } from '../utils/project.js';
import type { ToolProvider } from '../toolchain/index.js';

const handleSpecificAclPermissionsMock = vi.hoisted(() => vi.fn());
const initAclPermissionMock = vi.hoisted(() => vi.fn());
const getAclPermissionInfosMock = vi.hoisted(() => vi.fn());
const getApiVersionFromFileMock = vi.hoisted(() => vi.fn());

vi.mock('./acl-permission-config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AclPermissionConfig: {
      handleSpecificAclPermissions: handleSpecificAclPermissionsMock,
      initAclPermission: initAclPermissionMock,
      getAclPermissionInfos: getAclPermissionInfosMock,
    },
  };
});

vi.mock('./sdk-config.js', () => ({
  getApiVersionFromFile: getApiVersionFromFileMock,
}));

const toolProvider = { sdkPath: '/sdk' } as ToolProvider;

const tempRoots: string[] = [];

function info(init: object): AclPermissionInfo {
  return new AclPermissionInfo(init);
}

function makeProject(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-manager-ut-'));
  tempRoots.push(root);
  fs.writeFileSync(
    path.join(root, 'build-profile.json5'),
    JSON.stringify({
      app: { products: [] },
      modules: [{ name: 'entry', srcPath: 'entry' }],
    }),
    'utf-8'
  );
  return Project.discover(root);
}

function writeModuleJson(
  project: Project,
  configRelativePath: string,
  data: object
): void {
  const filePath = path.join(
    project.rootDir,
    'entry',
    configRelativePath,
    'module.json5'
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

beforeEach(() => {
  getApiVersionFromFileMock.mockReturnValue(12);
  getAclPermissionInfosMock.mockReturnValue([
    info({
      permissionName: 'ohos.permission.LOCATION',
      permissionDisplayName: 'LOCATION',
      minSupportApiLevel: '9',
    }),
    info({
      permissionName: 'ohos.permission.CAMERA',
      permissionDisplayName: 'CAMERA',
      minSupportApiLevel: '11',
    }),
    info({
      permissionName: 'ohos.permission.MOCK_FUTURE',
      permissionDisplayName: 'MOCK_FUTURE',
      minSupportApiLevel: '20',
    }),
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('getAutoSignProjectReqPermissions', () => {
  it('initializes the acl permission config before reading permission infos', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: { requestPermissions: [{ name: 'ohos.permission.LOCATION' }] },
    });

    getAutoSignProjectReqPermissions(project, toolProvider);

    expect(handleSpecificAclPermissionsMock).toHaveBeenCalledTimes(1);
    expect(initAclPermissionMock).toHaveBeenCalledTimes(1);
    expect(initAclPermissionMock).toHaveBeenCalledWith(project, toolProvider);
    expect(
      handleSpecificAclPermissionsMock.mock.invocationCallOrder[0]
    ).toBeLessThan(initAclPermissionMock.mock.invocationCallOrder[0]);
    expect(initAclPermissionMock.mock.invocationCallOrder[0]).toBeLessThan(
      getAclPermissionInfosMock.mock.invocationCallOrder[0]
    );
  });

  it('keeps acl permissions and filters permissions outside the acl list', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: {
        requestPermissions: [
          { name: 'ohos.permission.LOCATION' },
          { name: 'ohos.permission.INTERNET' },
        ],
      },
    });

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(Array.from(result)).toEqual(['ohos.permission.LOCATION']);
  });

  it('filters acl permissions above the compile sdk version', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: {
        requestPermissions: [
          { name: 'ohos.permission.MOCK_FUTURE' },
          { name: 'ohos.permission.CAMERA' },
        ],
      },
    });

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(Array.from(result)).toEqual(['ohos.permission.CAMERA']);
  });

  it('merges permissions from src/main and src/ohosTest', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: { requestPermissions: [{ name: 'ohos.permission.LOCATION' }] },
    });
    writeModuleJson(project, path.join('src', 'ohosTest'), {
      module: { requestPermissions: [{ name: 'ohos.permission.CAMERA' }] },
    });

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(Array.from(result)).toEqual([
      'ohos.permission.LOCATION',
      'ohos.permission.CAMERA',
    ]);
  });

  it('throws when the same permission repeats inside one module', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: {
        requestPermissions: [
          { name: 'ohos.permission.LOCATION' },
          { name: 'ohos.permission.LOCATION' },
        ],
      },
    });

    expect(() =>
      getAutoSignProjectReqPermissions(project, toolProvider)
    ).toThrow(ACL_PERMISSIONS_MSG.DUPLICATE_PERMISSION);
  });

  it('returns an empty set when module.json5 has no requestPermissions', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), { module: {} });

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(result.size).toBe(0);
  });

  it('returns an empty set when module.json5 is missing', () => {
    const project = makeProject();

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(result.size).toBe(0);
  });

  it('ignores requestPermissions entries without a name field', () => {
    const project = makeProject();
    writeModuleJson(project, path.join('src', 'main'), {
      module: {
        requestPermissions: [
          { reason: 'no name' },
          { name: 'ohos.permission.CAMERA' },
        ],
      },
    });

    const result = getAutoSignProjectReqPermissions(project, toolProvider);

    expect(Array.from(result)).toEqual(['ohos.permission.CAMERA']);
  });
});
