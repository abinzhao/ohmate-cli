/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  SignatureEndpoints,
  CertConstants,
  SignatureResponseSignals,
  SignatureHttpStatusCode,
} from './signature.js';
import { buildAutoSignCerName } from '../signature/cert-api.js';

describe('SignatureEndpoints', () => {
  it('uses a bare https origin as the base URL and API paths under /api/', () => {
    const base = new URL(SignatureEndpoints.BASE_URL);
    expect(base.protocol).toBe('https:');
    expect(base.origin).toBe(SignatureEndpoints.BASE_URL);
    for (const value of Object.values(SignatureEndpoints)) {
      if (value === SignatureEndpoints.BASE_URL) {
        continue;
      }
      expect(value.startsWith('/api/')).toBe(true);
    }
  });
});

describe('CertConstants.BUNDLE_NAME_REGEX', () => {
  it('accepts names starting with a letter followed by letters, digits, dots, underscores and hyphens', () => {
    expect(CertConstants.BUNDLE_NAME_REGEX.test('com.example.app')).toBe(true);
    expect(CertConstants.BUNDLE_NAME_REGEX.test('a')).toBe(true);
    expect(CertConstants.BUNDLE_NAME_REGEX.test('a-b_c.123')).toBe(true);
  });

  it('rejects names starting with a digit or containing separators/spaces', () => {
    expect(CertConstants.BUNDLE_NAME_REGEX.test('1com.example')).toBe(false);
    expect(CertConstants.BUNDLE_NAME_REGEX.test('com/example')).toBe(false);
    expect(CertConstants.BUNDLE_NAME_REGEX.test('com example')).toBe(false);
    expect(CertConstants.BUNDLE_NAME_REGEX.test('')).toBe(false);
  });
});

describe('CertConstants certificate patterns', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';

  it('matches a single PEM block with the non-global pattern', () => {
    const match = pem.match(CertConstants.CERT_PATTERN);
    expect(match?.[0]).toBe(pem);
  });

  it('matches both PEM blocks with the global pattern', () => {
    const two = `${pem}\n${pem}`;
    const matches = two.match(CertConstants.CERTIFICATE_PATTERN_GLOBAL);
    expect(matches?.length).toBe(2);
    expect(matches?.[0]).toBe(pem);
  });

  it('does not match text without PEM headers', () => {
    expect(CertConstants.CERT_PATTERN.test('no cert here')).toBe(false);
    expect(CertConstants.CERT_BEGIN_HEADER).toBe('-----BEGIN CERTIFICATE-----');
  });
});

describe('CertConstants misc values', () => {
  it('pins the cert name prefix and debug type', () => {
    expect(CertConstants.CERT_NAME_PREFIX).toBe('auto_debug_');
    expect(CertConstants.CERT_TYPE_DEBUG).toBe('1');
    expect(CertConstants.TARGET_FRIENDLY_NAME).toBe('debugKey');
  });

  it('pins the release cert name prefix and release type', () => {
    expect(CertConstants.CERT_NAME_PREFIX_RELEASE).toBe('auto_release_');
    expect(CertConstants.CERT_TYPE_RELEASE).toBe('2');
  });

  it('builds the cert save directory relative to the user home', () => {
    expect(CertConstants.CERT_SAVE_DIR).toBe(join('.ohos', 'config'));
  });

  it('replaces invalid team id characters via the character class', () => {
    expect('a/b:c.d\\e'.replace(CertConstants.TEAM_ID_INVALID_CHARS, '_')).toBe(
      'a_b_c_d_e'
    );
    expect('team01'.replace(CertConstants.TEAM_ID_INVALID_CHARS, '_')).toBe(
      'team01'
    );
  });
});

describe('signature response signals and status codes', () => {
  it('pins the cloud-side markers', () => {
    expect(SignatureResponseSignals.SUCCESS_MARKER).toBe('"code":0');
    expect(SignatureResponseSignals.SQUARE_BRACKETS).toBe('[]');
    expect(SignatureResponseSignals.CERT_LIMIT_CODE).toBe('205389872');
    expect(SignatureResponseSignals.USER_NOT_HARMONY_CODE).toBe('205389904');
    expect(SignatureResponseSignals.DEVICE_EXCEEDS_LIMIT_CODE).toBe(
      '205389859'
    );
    expect(SignatureResponseSignals.DEVICE_NAME_REPEAT_CODE).toBe('205389857');
    expect(SignatureResponseSignals.PROVISION_EXCEEDS_LIMIT_CODE).toBe(
      '205389938'
    );
    expect(SignatureResponseSignals.PROVISION_NAME_REPEAT_CODE).toBe(
      '205389830'
    );
  });

  it('pins the HTTP status codes', () => {
    expect(SignatureHttpStatusCode.FORBIDDEN).toBe(403);
    expect(SignatureHttpStatusCode.UNAUTHORIZED).toBe(401);
  });
});

describe('buildAutoSignCerName', () => {
  it('builds debug cert name by default', () => {
    expect(buildAutoSignCerName('team01')).toBe('auto_debug_team01.cer');
  });

  it('builds debug cert name when isRelease is false', () => {
    expect(buildAutoSignCerName('team01', false)).toBe('auto_debug_team01.cer');
  });

  it('builds release cert name when isRelease is true', () => {
    expect(buildAutoSignCerName('team01', true)).toBe(
      'auto_release_team01.cer'
    );
  });

  it('removes invalid characters from teamId for release', () => {
    expect(buildAutoSignCerName('a/b:c.d', true)).toBe('auto_release_abcd.cer');
  });
});
