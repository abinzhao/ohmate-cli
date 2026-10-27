/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { buildAutoSignCerName, mapCloudError } from './cert-api.js';
import {
  SignatureErrorMessages,
  SignatureResponseSignals,
} from '../config/signature.js';

describe('buildAutoSignCerName', () => {
  it('prefixes the sanitized team id and appends .cer', () => {
    expect(buildAutoSignCerName('team123')).toBe('auto_debug_team123.cer');
  });

  it('strips characters that are invalid in certificate names', () => {
    expect(buildAutoSignCerName('team/1.2:3\\4')).toBe(
      'auto_debug_team1234.cer'
    );
  });

  it('keeps case and allowed punctuation', () => {
    expect(buildAutoSignCerName('TEAM_id-01')).toBe(
      'auto_debug_TEAM_id-01.cer'
    );
  });

  it('uses the release prefix when isRelease is true', () => {
    expect(buildAutoSignCerName('team123', true)).toBe(
      'auto_release_team123.cer'
    );
  });
});

describe('mapCloudError', () => {
  it('maps a 403 Openproxy reason phrase to the network error', () => {
    const err = mapCloudError(
      403,
      SignatureResponseSignals.OPENPROXY_BLOCKED_URL,
      ''
    );
    expect(err.message).toBe(SignatureErrorMessages.ERR_CERT_NETWORK_ERROR);
  });

  it('maps other 403 responses to the AGC permission error', () => {
    const err = mapCloudError(403, 'Forbidden', '');
    expect(err.message).toBe(SignatureErrorMessages.ERR_FORBIDDEN);
  });

  it('maps 401 to the invalid-token error', () => {
    expect(mapCloudError(401, '', '').message).toBe(
      SignatureErrorMessages.ERR_UNAUTHORIZED
    );
  });

  it('prefers the status code over body signals', () => {
    const err = mapCloudError(
      403,
      'Forbidden',
      `{"ret":{"code":${SignatureResponseSignals.CERT_LIMIT_CODE}}}`
    );
    expect(err.message).toBe(SignatureErrorMessages.ERR_FORBIDDEN);
  });

  it('maps the not-in-harmony-allow-list body signal', () => {
    const err = mapCloudError(
      200,
      '',
      `{"ret":{"code":${SignatureResponseSignals.USER_NOT_HARMONY_CODE}}}`
    );
    expect(err.message).toBe(SignatureErrorMessages.ERR_USER_NOT_HARMONY);
  });

  it('maps the certificate limit body signal', () => {
    const err = mapCloudError(
      200,
      '',
      `{"ret":{"code":${SignatureResponseSignals.CERT_LIMIT_CODE}}}`
    );
    expect(err.message).toBe(SignatureErrorMessages.ERR_CERT_LIMIT_REACHED);
  });

  it('extracts ret.msg when ret is an object', () => {
    expect(
      mapCloudError(200, '', '{"ret":{"code":1,"msg":"boom"}}').message
    ).toBe('boom');
  });

  it('extracts ret.msg when ret is a JSON string', () => {
    expect(
      mapCloudError(
        200,
        '',
        '{"ret":"{\\"code\\":1,\\"msg\\":\\"str boom\\"}"}'
      ).message
    ).toBe('str boom');
  });

  it('falls back to the generic download error without a usable ret.msg', () => {
    expect(mapCloudError(200, '', '{"ret":{"code":1,"msg":""}}').message).toBe(
      SignatureErrorMessages.ERR_DOWNLOAD_CER
    );
    expect(mapCloudError(200, '', '{"ret":{"code":1}}').message).toBe(
      SignatureErrorMessages.ERR_DOWNLOAD_CER
    );
    expect(mapCloudError(200, '', 'not json').message).toBe(
      SignatureErrorMessages.ERR_DOWNLOAD_CER
    );
    expect(mapCloudError(undefined, '', '').message).toBe(
      SignatureErrorMessages.ERR_DOWNLOAD_CER
    );
  });
});
