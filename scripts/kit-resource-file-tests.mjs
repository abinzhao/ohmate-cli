/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

// Native calls are explicit substitutes; these tests do not run on Phone.
export function registerResourceFileTests({ WebResourceFiles, NodePort }) {
  const page = 'http://127.0.0.1:12345/kit-readonly.html';
  const body = Buffer.from('/* ohmate-local-file; 界 */\n');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = (changes = {}) => ({ name: 'ohmate-resources/readonly.css',
    url: page.replace('.html', '.css'), mimeType: 'text/css', sensitivity: 'ordinary',
    bytes: body.length, sha256: hash(body), ...changes });
  function fixture(entries = [manifest()], bytes = body) {
    const calls = []; let active = true; let position = 99; let closeFails = false;
    const manager = {
      getRawFdSync(name) { calls.push(['open', name]); return { fd: 7, offset: 17, length: bytes.length }; },
      closeRawFdSync(name) { calls.push(['close', name]); if (closeFails) throw Error('private-close'); },
    };
    const io = {
      WhenceType: { SEEK_SET: 0 },
      lseek(fd, offset, whence) { calls.push(['seek', fd, offset, whence]); position = offset; return position; },
      readSync(fd, buffer, options) {
        calls.push(['read', fd, options.length]);
        assert.ok(options.length <= 4096);
        assert.equal(options.offset, undefined);
        const start = position - 17; const count = Math.min(3, options.length, bytes.length - start);
        new Uint8Array(buffer).set(bytes.subarray(start, start + count));
        position += count; return count;
      },
    };
    const port = new NodePort();
    const owner = new WebResourceFiles(port, manager, page, entries, () => active);
    globalThis.__kitTest.resourceFileIo = io;
    return { owner, calls, io, manager, port, stop: () => { active = false; },
      closeFails: (value) => { closeFails = value; } };
  }
  test('ArkTS resource files read exact bounded rawfile bytes and close before returning', () => {
    const f = fixture(); const result = f.owner.read();
    assert.deepEqual(result, [{ url: manifest().url, mimeType: 'text/css',
      sensitivity: 'ordinary', body: body.toString('utf8') }]);
    assert.equal(f.owner.needsClose(), false);
    assert.deepEqual(f.calls[0], ['open', manifest().name]);
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_UNAVAILABLE/);
    assert.ok(f.calls.filter(([name]) => name === 'read').length > 1);
  });
  for (const name of ['../readonly.css', '/ohmate-resources/a.css', 'ohmate-resources/../a.css',
    'ohmate-resources/a%2Ecss', 'ohmate-resources/nested/a.css', 'ohmate-resources/auth.css',
    'ohmate-resources/readonly.js']) {
    test(`ArkTS resource files reject unsafe manifest path ${name} before native access`, () => {
      assert.throws(() => fixture([manifest({ name })]), /RESOURCE_FILE_INVALID/);
    });
  }
  for (const changes of [{ bytes: 65537 }, { bytes: -1 }, { bytes: 1.5 }, { sha256: '0' },
    { mimeType: 'text/html' }, { sensitivity: 'sensitive' }, { url: 'http://example.com/a.css' },
    { url: page }, { extra: true }]) {
    test(`ArkTS resource files reject invalid manifest ${JSON.stringify(changes)}`, () => {
      assert.throws(() => fixture([manifest(changes)]), /RESOURCE_FILE_INVALID/);
    });
  }
  test('ArkTS resource files reject duplicate names, duplicate URLs and aggregate quota', () => {
    for (const entries of [[manifest(), manifest()], [manifest(), manifest({ name: 'ohmate-resources/second.css' })],
      Array.from({ length: 5 }, (_, i) => manifest({ name: `ohmate-resources/a${i}.css`,
        url: `http://127.0.0.1:12345/a${i}.css`, bytes: 65536 })),
      Array.from({ length: 33 }, (_, i) => manifest({ name: `ohmate-resources/a${i}.css`,
        url: `http://127.0.0.1:12345/a${i}.css`, bytes: 0 }))]) {
      assert.throws(() => fixture(entries), /RESOURCE_FILE_INVALID/);
    }
  });
  test('ArkTS resource files refuse oversized descriptors without reading and still close', () => {
    const f = fixture();
    f.manager.getRawFdSync = (name) => { f.calls.push(['open', name]); return { fd: 7, offset: 17, length: 65537 }; };
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
    assert.equal(f.calls.some(([name]) => name === 'read'), false);
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
  });
  test('ArkTS resource files reject byte hash drift and noncanonical UTF-8 and scrub read buffers', () => {
    for (const bytes of [Buffer.from('different'), Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x61])]) {
      const f = fixture([manifest({ bytes: bytes.length, sha256: hash(bytes) === hash(body) ? '0'.repeat(64) : hash(body) })], bytes);
      const buffers = []; const read = f.io.readSync;
      f.io.readSync = (...args) => { buffers.push(args[1]); return read(...args); };
      assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
      assert.ok(buffers.every((value) => new Uint8Array(value).every((byte) => byte === 0)));
      assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
    }
  });
  for (const ignoreBOM of [false, true]) {
    test(`ArkTS resource files reject correctly hashed leading BOM with decoder ignoreBOM=${ignoreBOM}`, () => {
      for (const bytes of [Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xef, 0xbb, 0xbf, 0x61])]) {
        const f = fixture([manifest({ bytes: bytes.length, sha256: hash(bytes) })], bytes);
        f.port.decode = (value) => new TextDecoder('utf-8', { fatal: true, ignoreBOM }).decode(value);
        const decoded = f.port.decode(bytes);
        assert.equal(decoded.startsWith('\ufeff'), ignoreBOM);
        const buffers = []; const read = f.io.readSync;
        f.io.readSync = (...args) => { buffers.push(args[1]); return read(...args); };
        assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
        assert.ok(buffers.every((value) => new Uint8Array(value).every((byte) => byte === 0)));
        assert.equal(f.owner.needsClose(), false);
        assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
      }
    });
  }
  test('ArkTS resource files preserve correctly hashed embedded U+FEFF text', () => {
    const bytes = Buffer.from('a\ufeffb', 'utf8');
    const f = fixture([manifest({ bytes: bytes.length, sha256: hash(bytes) })], bytes);
    assert.equal(f.owner.read()[0].body, 'a\ufeffb');
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
  });
  test('ArkTS resource files scrub and fail short/invalid reads without exposing native errors', () => {
    for (const value of [0, -1, 4097, 0.5, NaN]) {
      const f = fixture(); f.io.readSync = () => value;
      assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
      assert.equal(f.owner.needsClose(), false);
    }
    const f = fixture(); f.io.readSync = () => { throw Error('sensitive-native-path'); };
    assert.throws(() => f.owner.read(), (error) => error.message === 'RESOURCE_FILE_FAILED');
  });
  test('ArkTS resource files retain failed close responsibility until explicit retry', () => {
    const f = fixture(); f.closeFails(true);
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_CLOSE_REQUIRED/);
    assert.equal(f.owner.needsClose(), true);
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_UNAVAILABLE/);
    assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
    f.closeFails(false); f.owner.retryClose();
    assert.equal(f.owner.needsClose(), false);
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
  });
  test('ArkTS resource files invalidate on source change during read and close without output', () => {
    const f = fixture(); const read = f.io.readSync;
    f.io.readSync = (...args) => { const result = read(...args); f.stop(); return result; };
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_UNAVAILABLE/);
  });
  test('ArkTS resource files close all earlier resources before a later open fails', () => {
    const f = fixture([manifest(), manifest({ name: 'ohmate-resources/second.css',
      url: 'http://127.0.0.1:12345/second.css' })]);
    const open = f.manager.getRawFdSync;
    f.manager.getRawFdSync = (name) => { if (name.endsWith('second.css')) throw Error('private-open'); return open(name); };
    assert.throws(() => f.owner.read(), /RESOURCE_FILE_FAILED/);
    assert.equal(f.owner.needsClose(), false);
    assert.deepEqual(f.calls.at(-1), ['close', manifest().name]);
  });
}
