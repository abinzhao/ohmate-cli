/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { extractArkDocJson, normalizeArkDoc } from './api-model.js';
const declaration = () => ({ kind: 'Class', name: 'Api', signature: { label: 'class Api' }, tags: [
  { kind: 'Since', id: Math.random(), details: [{ kind: 'string', description: '22' }] },
] });
it('does not accept a different relative source merely because the basename matches', () => {
  expect(() => normalizeArkDoc({ fileKind: 'file', filePath: 'other/Api.ts', jsDoc: [declaration()] },
    'entry/src/main/ets/Api.ts', new Set(['Api']))).toThrow('outside');
});
it('drops generated identifiers from tags while preserving their public documentation', () => {
  const model = () => normalizeArkDoc({ fileKind: 'file', filePath: 'Api.ts', jsDoc: [declaration()] },
    'entry/src/main/ets/Api.ts', new Set(['Api']));
  expect(model()).toEqual(model());
  expect(model()[0].tags).toEqual([{ kind: 'Since', details: [{ kind: 'string', description: '22' }] }]);
});
it('rejects executable or duplicate embedded model wrappers without evaluation', () => {
  expect(() => extractArkDocJson('<script>window.getArkDocInfo = function() { return malicious(); };</script>')).toThrow();
  const html = '<script>window.getArkDocInfo = function() { return {}; };</script>';
  expect(() => extractArkDocJson(html + html)).toThrow('one official');
});
