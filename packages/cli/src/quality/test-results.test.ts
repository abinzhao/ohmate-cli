/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { parseTestResults } from './test-results.js';

const observed = 'class=Acceptance\ntest=addition\nresult=Success\ntest=unicode\nresult=Success\nTests run: 2, Failure: 0, Error: 0, Pass: 2, Ignore: 0\n';
it('parses the actual DevEco 26 Local Test report including its unchanged class record', () => {
  expect(parseTestResults(observed)).toMatchObject({ format: 'official-key-value', complete: true,
    passed: 2, failed: 0, ignored: 0, cases: ['Acceptance#addition', 'Acceptance#unicode'] });
});
it('preserves failure, error and ignored cases instead of treating tool exit zero as test success', () => {
  const text = 'class=Suite\ntest=failing\nresult=Failure\ntest=error\nresult=Error\ntest=ignored\nresult=Ignore\nTests run: 3, Failure: 1, Error: 1, Pass: 0, Ignore: 1\n';
  expect(parseTestResults(text)).toMatchObject({ complete: true, passed: 0, failed: 2, ignored: 1,
    cases: ['Suite#failing', 'Suite#error', 'Suite#ignored'] });
});
it.each([
  observed.replace('Tests run: 2', 'Tests run: 3'),
  observed.replace('Pass: 2', 'Pass: 1'),
  observed.split('Tests run:')[0],
  observed.replace('test=unicode', 'test=addition'),
  observed.replace('result=Success', 'result=Unknown'),
  observed.replace('class=Acceptance\n', ''),
  observed.replace('test=unicode\nresult=Success', 'test=unicode'),
])('rejects incomplete, contradictory, duplicate or unrecognized case records', (text) => {
  expect(parseTestResults(text).complete).toBe(false);
});
it('keeps explicit bracket records supported but rejects mixed formats and duplicate identities', () => {
  expect(parseTestResults('[pass] Suite#one\n[fail] Suite#two\n')).toMatchObject({ complete: true, passed: 1, failed: 1 });
  expect(parseTestResults('[pass] Suite#one\n[fail] Suite#one\n').complete).toBe(false);
  expect(parseTestResults('[pass] Suite#one\n[pass] malformed\n').complete).toBe(false);
  expect(parseTestResults(observed + '[pass] Suite#extra\n').complete).toBe(false);
  expect(parseTestResults('BUILD SUCCESSFUL').complete).toBe(false);
});
