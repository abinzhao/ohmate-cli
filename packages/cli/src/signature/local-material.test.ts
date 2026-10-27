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
import {
  checkCertificateValidate,
  deleteLocalSignFiles,
  resolveSignatureFilePaths,
} from './local-material.js';
import { SignatureErrorMessages } from '../config/signature.js';

const getAutoSignFilePathMock = vi.hoisted(() => vi.fn());

vi.mock('./signature-tool.js', () => ({
  getAutoSignFilePath: getAutoSignFilePathMock,
}));

const tempRoots: string[] = [];
let configDir: string;

function makeConfigDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-material-ut-'));
  tempRoots.push(root);
  return root;
}

beforeEach(() => {
  configDir = makeConfigDir();
  getAutoSignFilePathMock.mockImplementation(
    async (_productName: string, _projectRoot: string, suffix: string) =>
      path.join(configDir, `auto_sign.${suffix}`)
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('deleteLocalSignFiles', () => {
  it('deletes the p12, cer, csr and p7b material files', async () => {
    for (const suffix of ['p12', 'cer', 'csr', 'p7b']) {
      fs.writeFileSync(path.join(configDir, `auto_sign.${suffix}`), 'x');
    }

    const projectRoot = path.join(configDir, 'project');
    await deleteLocalSignFiles('default', projectRoot);

    for (const suffix of ['p12', 'cer', 'csr', 'p7b']) {
      expect(fs.existsSync(path.join(configDir, `auto_sign.${suffix}`))).toBe(
        false
      );
    }

    const suffixes = ['p12', 'cer', 'csr', 'p7b'];
    expect(getAutoSignFilePathMock).toHaveBeenCalledTimes(4);
    suffixes.forEach((suffix, index) => {
      expect(getAutoSignFilePathMock).toHaveBeenNthCalledWith(
        index + 1,
        'default',
        projectRoot,
        suffix,
        undefined
      );
    });
  });

  it('passes the release type through to getAutoSignFilePath', async () => {
    const projectRoot = path.join(configDir, 'project');

    await deleteLocalSignFiles('default', projectRoot, 'release');

    const suffixes = ['p12', 'cer', 'csr', 'p7b'];
    expect(getAutoSignFilePathMock).toHaveBeenCalledTimes(4);
    suffixes.forEach((suffix, index) => {
      expect(getAutoSignFilePathMock).toHaveBeenNthCalledWith(
        index + 1,
        'default',
        projectRoot,
        suffix,
        'release'
      );
    });
  });

  it('does not fail when the material files are already absent', async () => {
    await expect(
      deleteLocalSignFiles('default', path.join(configDir, 'project'))
    ).resolves.toBeUndefined();
  });
});

describe('resolveSignatureFilePaths', () => {
  it('resolves the four signature material paths', async () => {
    const projectRoot = path.join(configDir, 'project');
    const paths = await resolveSignatureFilePaths('default', projectRoot);

    expect(paths.certPath).toBe(path.join(configDir, 'auto_sign.cer'));
    expect(paths.csrPath).toBe(path.join(configDir, 'auto_sign.csr'));
    expect(paths.p12Path).toBe(path.join(configDir, 'auto_sign.p12'));
    expect(paths.profilePath).toBe(path.join(configDir, 'auto_sign.p7b'));

    const suffixOrder = ['cer', 'csr', 'p12', 'p7b'];
    suffixOrder.forEach((suffix, index) => {
      expect(getAutoSignFilePathMock).toHaveBeenNthCalledWith(
        index + 1,
        'default',
        projectRoot,
        suffix,
        undefined
      );
    });
  });

  it('passes the release type through to getAutoSignFilePath', async () => {
    const projectRoot = path.join(configDir, 'project');

    await resolveSignatureFilePaths('default', projectRoot, 'release');

    const suffixOrder = ['cer', 'csr', 'p12', 'p7b'];
    expect(getAutoSignFilePathMock).toHaveBeenCalledTimes(4);
    suffixOrder.forEach((suffix, index) => {
      expect(getAutoSignFilePathMock).toHaveBeenNthCalledWith(
        index + 1,
        'default',
        projectRoot,
        suffix,
        'release'
      );
    });
  });
});

describe('checkCertificateValidate', () => {
  it('accepts a cer file wrapped in PEM markers', () => {
    const cerPath = path.join(configDir, 'material.cer');
    fs.writeFileSync(
      cerPath,
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      'utf-8'
    );
    expect(() => checkCertificateValidate(cerPath)).not.toThrow();
  });

  it('rejects a cer file without PEM markers', () => {
    const cerPath = path.join(configDir, 'broken.cer');
    fs.writeFileSync(cerPath, 'garbage content', 'utf-8');
    expect(() => checkCertificateValidate(cerPath)).toThrow(
      SignatureErrorMessages.ERR_CERT_INVALIDATE
    );
  });

  it('rejects a missing cer file', () => {
    expect(() =>
      checkCertificateValidate(path.join(configDir, 'absent.cer'))
    ).toThrow(SignatureErrorMessages.ERR_CERT_INVALIDATE);
  });
});
