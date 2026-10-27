/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

export function registerResourceStreamTests({ WebResourceOverride, WebResourceStream, NodePort }) {
  const page = 'http://127.0.0.1:12345/kit-readonly.html';
  const resourceUrl = page.replace('.html', '.css');
  const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  function fixture(body = '界'.repeat(3000)) {
    const calls = []; let scheme; let active = true; let failClear = false;
    const native = {
      WebResourceType: { STYLE_SHEET: 2, XHR: 13 }, WebNetErrorList: { ERR_ABORTED: -3 },
      WebSchemeHandler: class {
        constructor() { scheme = this; }
        onRequestStart(callback) { this.start = callback; }
        onRequestStop(callback) { this.stop = callback; }
      },
      WebSchemeHandlerResponse: class {
        setUrl(value) { this.url = value; } setStatus(value) { this.status = value; }
        setStatusText(value) { this.statusText = value; } setMimeType(value) { this.mime = value; }
        setEncoding(value) { this.encoding = value; }
        setHeaderByName(...args) { (this.headers ??= []).push(args); }
      },
    };
    globalThis.__kitTest.resourceStreamWebview = native;
    const controller = {
      setWebSchemeHandler(name, handler) { calls.push(['attach', name]); assert.equal(handler, scheme); },
      clearWebSchemeHandler() { calls.push(['clear']); if (failClear) throw Error('private-clear'); },
    };
    const port = new NodePort();
    const resources = new WebResourceOverride(port, page,
      [{ url: resourceUrl, mimeType: 'text/css', body, sensitivity: 'ordinary' }], () => active, true);
    const stream = new WebResourceStream(port, controller, resources, () => active);
    const request = (changes = {}) => ({
      getRequestUrl: () => resourceUrl, getRequestMethod: () => 'GET', isMainFrame: () => false,
      getFrameUrl: () => page, getReferrer: () => '', getHttpBodyStream: () => null,
      getRequestResourceType: () => 13,
      getHeader: () => [{ headerKey: 'Accept', get headerValue() { throw Error('must not read header value'); } }],
      ...changes,
    });
    function approve() {
      const resource = resources.catalog()[0];
      const review = resources.review(JSON.stringify({ version: '1', targetId: 'web-main',
        resourceId: resource.resourceId, url: resourceUrl, method: 'GET' }), '[]', 'test-binding', Date.now() + 30000, 30000);
      assert.equal(resources.confirm(review.planHash), true); return review;
    }
    const handler = () => ({
      response: undefined, buffers: [], ends: [],
      didReceiveResponse(value) { this.response = value; calls.push(['response']); },
      didReceiveResponseBody(buffer) { this.buffers.push(buffer); calls.push(['chunk', buffer.byteLength]); },
      didFinish() { this.ends.push('finish'); calls.push(['finish']); },
      didFail(code, complete) { assert.equal(code, -3); assert.equal(complete, true); this.ends.push('fail'); calls.push(['fail']); },
    });
    return { stream, resources, native, controller, calls, request, handler, approve,
      scheme: () => scheme, stopSource: () => { active = false; }, failClear: (value) => { failClear = value; } };
  }
  test('ArkTS resource stream attaches exact owned HTTP handler and sends bounded ordered buffers until finish', async () => {
    const f = fixture(); const review = f.approve();
    assert.match(review.coverage, /scheme-handler;frame-type-checked;redirect-unverified/);
    assert.equal(f.stream.attach(), true);
    const request = f.request(); const handler = f.handler();
    assert.equal(f.scheme().start(request, handler), true); await flush();
    assert.deepEqual(handler.ends, ['finish']);
    assert.equal(Buffer.concat(handler.buffers.map((item) => Buffer.from(item))).toString('utf8'), '界'.repeat(3000));
    assert.ok(handler.buffers.every((item) => item.byteLength <= 4096));
    assert.equal(handler.response.status, 200); assert.equal(handler.response.encoding, 'UTF-8');
    assert.deepEqual(handler.response.headers.slice(0, 2),
      [['Cache-Control', 'no-store', true], ['X-Content-Type-Options', 'nosniff', true]]);
    assert.equal(f.stream.pending(), true);
    const buffers = [...handler.buffers];
    f.scheme().stop(request);
    assert.equal(f.stream.pending(), false);
    assert.ok(buffers.every((item) => new Uint8Array(item).every((byte) => byte === 0)));
    assert.equal(f.stream.close(), true);
    assert.equal(f.stream.pending(), false);
  });
  test('ArkTS resource stream remains closed before confirmation and never uses one-shot response path', () => {
    const f = fixture(); f.stream.attach();
    const request = f.request(); const handler = f.handler();
    assert.equal(f.scheme().start(request, handler), false);
    f.approve();
    assert.equal(f.resources.resolve({ getRequestUrl: () => resourceUrl }), undefined);
    assert.equal(f.stream.close(), true);
  });
  for (const [name, changes] of [
    ['wrong URL', { getRequestUrl: () => 'http://127.0.0.1:12345/login' }],
    ['POST', { getRequestMethod: () => 'POST' }],
    ['main frame', { isMainFrame: () => true }],
    ['wrong frame', { getFrameUrl: () => 'http://127.0.0.1:12345/other.html' }],
    ['unexpected referrer', { getReferrer: () => page }],
    ['script', { getRequestResourceType: () => 3 }],
    ['body stream', { getHttpBodyStream: () => ({ initialize() { throw Error('must not initialize'); } }) }],
    ['credential header', { getHeader: () => [{ headerKey: 'Cookie' }] }],
    ['duplicate header', { getHeader: () => [{ headerKey: 'Accept' }, { headerKey: 'accept' }] }],
  ]) {
    test(`ArkTS resource stream leaves ${name} requests unselected without native response or body reads`, () => {
      const f = fixture(); f.stream.attach(); f.approve();
      const handler = f.handler(); assert.equal(f.scheme().start(f.request(changes), handler), false);
      assert.deepEqual(handler.ends, []); assert.deepEqual(handler.buffers, []);
      assert.equal(f.resources.status().hits, 0); assert.equal(f.stream.close(), true);
    });
  }
  test('ArkTS resource stream cancellation before dispatch retains ownership and never sends headers or chunks', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler();
    assert.equal(f.scheme().start(request, handler), true); f.stream.cancel(); await flush();
    assert.equal(handler.response, undefined); assert.deepEqual(handler.buffers, []);
    assert.deepEqual(handler.ends, ['fail']); assert.equal(f.stream.pending(), true);
    f.scheme().stop(request); assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream source drift between chunks stops delivery and retains buffers until request stop', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler();
    const receive = handler.didReceiveResponseBody;
    handler.didReceiveResponseBody = function(buffer) { receive.call(this, buffer); f.stopSource(); };
    f.scheme().start(request, handler); await flush();
    assert.equal(handler.buffers.length, 1); assert.deepEqual(handler.ends, ['fail']);
    assert.ok(new Uint8Array(handler.buffers[0]).some((byte) => byte !== 0));
    f.scheme().stop(request); assert.ok(new Uint8Array(handler.buffers[0]).every((byte) => byte === 0));
    assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream successful finish or failed abort cannot certify stop and only exact request releases', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler();
    f.scheme().start(request, handler); await flush();
    f.scheme().stop(f.request()); assert.equal(f.stream.pending(), true);
    assert.equal(f.stream.close(), false); assert.equal(f.stream.pending(), true);
    f.scheme().stop(request); assert.equal(f.stream.close(), true);
    assert.deepEqual(handler.ends, ['finish']);
  });
  test('ArkTS resource stream retains failed native cancellation and retries only explicitly', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler(); let failures = 0;
    handler.didFail = () => { failures++; throw Error('private-abort'); };
    f.scheme().start(request, handler); f.stream.cancel(); await flush();
    assert.equal(failures, 1);
    await flush(); assert.equal(failures, 1);
    assert.equal(f.stream.close(), false); assert.equal(failures, 2);
    f.scheme().stop(request); assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream clear failures preserve controller lease and prevent another attach', () => {
    const f = fixture(); f.stream.attach(); f.failClear(true);
    assert.equal(f.stream.close(), false); assert.equal(f.stream.pending(), true);
    assert.equal(f.stream.attach(), false);
    f.failClear(false); assert.equal(f.stream.close(), true);
    assert.deepEqual(f.calls.filter(([name]) => name === 'attach'), [['attach', 'http']]);
  });
  test('ArkTS resource stream repeated background close cannot retry native failure without explicit action', () => {
    const f = fixture(); f.stream.attach(); f.failClear(true);
    assert.equal(f.stream.close(false), false);
    assert.equal(f.stream.close(false), false);
    assert.equal(f.calls.filter(([name]) => name === 'clear').length, 1);
    f.failClear(false);
    assert.equal(f.stream.close(false), false);
    assert.equal(f.stream.close(true), true);
    assert.equal(f.calls.filter(([name]) => name === 'clear').length, 2);
  });
  test('ArkTS resource stream reentrant native stop makes later body and finish calls impossible', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler();
    handler.didReceiveResponse = () => f.scheme().stop(request);
    f.scheme().start(request, handler); await flush();
    assert.deepEqual(handler.buffers, []); assert.deepEqual(handler.ends, []);
    assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream request stop inside native chunk waits for native return before scrubbing', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler(); let delivered; let heldDuringNative = false;
    handler.didReceiveResponseBody = (buffer) => {
      delivered = buffer; f.scheme().stop(request);
      heldDuringNative = new Uint8Array(buffer).some((byte) => byte !== 0);
    };
    f.scheme().start(request, handler); await flush();
    assert.equal(heldDuringNative, true, 'native call still owns its buffer');
    assert.ok(new Uint8Array(delivered).every((byte) => byte === 0));
    assert.deepEqual(handler.ends, []); assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream native errors remain selected, end once and never escape into fallback', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const request = f.request(); const handler = f.handler();
    handler.didReceiveResponse = () => { throw Error('private-response'); };
    assert.equal(f.scheme().start(request, handler), true); await flush();
    assert.deepEqual(handler.ends, ['fail']);
    f.scheme().stop(request); assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream fourth concurrent request fills budget and fifth is aborted without bytes', async () => {
    const f = fixture(); f.stream.attach(); f.approve();
    const requests = Array.from({ length: 5 }, () => f.request());
    const handlers = requests.map(() => f.handler());
    requests.forEach((request, index) => assert.equal(f.scheme().start(request, handlers[index]), true));
    await flush();
    assert.equal(handlers[4].buffers.length, 0); assert.deepEqual(handlers[4].ends, ['fail']);
    assert.equal(f.resources.status().phase, 'idle');
    requests.forEach((request) => f.scheme().stop(request));
    assert.equal(f.stream.close(), true);
  });
  test('ArkTS resource stream failed attachment remains owned until exact controller clear succeeds', () => {
    const f = fixture(); f.controller.setWebSchemeHandler = () => { throw Error('applied-then-threw'); };
    assert.equal(f.stream.attach(), false); assert.equal(f.stream.pending(), true);
    assert.equal(f.stream.attach(), false);
    assert.equal(f.stream.close(), true); assert.deepEqual(f.calls, [['clear']]);
  });
}
