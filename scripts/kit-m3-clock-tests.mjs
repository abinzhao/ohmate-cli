/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Actual ArkTS owners, explicit HTTP/Web substitutes. No native effects or
// authenticated capture are established by these tests.
export function registerM3ClockTests({ NetworkMock, WebResourceOverride, NodePort }) {
  const initial = 1800000000000;
  const page = 'http://127.0.0.1:12345/kit-readonly.html';
  const resource = 'http://127.0.0.1:12345/kit-readonly.css';
  const mockUrl = 'http://127.0.0.1:12345/ohmate-mock-sample';
  const options = { method: 'GET', expectDataType: 0, maxLimit: 1024 };
  class Response {
    setResponseData(body) { this.body = body; }
    setResponseEncoding() {}
    setResponseMimeType() {}
    setResponseCode() {}
    setReasonMessage() {}
    setResponseHeader() {}
    setResponseIsReady() {}
  }
  function fixture(context, kind, delayMs = 0) {
    let time = initial;
    context.mock.method(Date, 'now', () => time);
    const originalResponse = globalThis.WebResourceResponse;
    const originalScheme = globalThis.__kitTest.resourceStreamWebview;
    globalThis.WebResourceResponse = Response;
    globalThis.__kitTest.resourceStreamWebview = { WebResourceType: { STYLE_SHEET: 2, XHR: 13 } };
    context.after(() => {
      if (originalResponse === undefined) delete globalThis.WebResourceResponse;
      else globalThis.WebResourceResponse = originalResponse;
      globalThis.__kitTest.resourceStreamWebview = originalScheme;
    });
    const port = new NodePort();
    const owner = kind === 'network' ? new NetworkMock(port, 'network-main', () => true) :
      new WebResourceOverride(port, page, [{ url: resource, mimeType: 'text/css',
        body: '/* test-only */', sensitivity: 'ordinary' }], () => true, kind === 'stream');
    context.after(() => owner.cancel());
    const text = kind === 'network' ? JSON.stringify({ version: '1', targetId: 'network-main', rules: [{
      ruleId: 'test-rule', priority: 1, origin: 'http://127.0.0.1:12345', method: 'GET',
      path: '/ohmate-mock-sample', headers: {}, resourceType: 'fetch',
      response: { kind: 'fixed', status: 202, headers: {}, body: 'test-only', delayMs },
    }] }) : JSON.stringify({ version: '1', targetId: 'web-main',
      resourceId: owner.catalog()[0].resourceId, url: resource, method: 'GET' });
    const review = () => owner.review(text, '[]', 'test-binding', initial + 600000, 30000);
    const request = {
      getRequestUrl: () => resource, getRequestMethod: () => 'GET', isMainFrame: () => false,
      isRedirect: () => false, getRequestHeader: () => [], getHeader: () => [],
      getFrameUrl: () => page, getReferrer: () => '', getHttpBodyStream: () => null,
      getRequestResourceType: () => 2,
    };
    let deliveries = 0;
    const effect = () => kind === 'network' ? owner.resolve(mockUrl, options, 'ordinary', 'fetch') :
      kind === 'stream' ? owner.dispatchScheme(request, () => { deliveries++; }) : owner.resolve(request);
    return { owner, review, effect, deliveries: () => deliveries, time: value => { time = value; },
      unavailable: kind === 'network' ? /MOCK_UNAVAILABLE/ : /RESOURCE_UNAVAILABLE/ };
  }
  const invalidTimes = [
    ['rollback', initial - 1], ['NaN', NaN], ['infinity', Infinity],
    ['negative infinity', -Infinity], ['fractional', initial + 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const kind of ['network', 'response', 'stream']) {
    for (const [name, invalid] of invalidTimes) {
      for (const trigger of ['status', 'confirm', 'review', 'effect']) {
        test(`M3 clock ${kind} ${name} observed by ${trigger} permanently rejects this owner`, async context => {
          const f = fixture(context, kind);
          const review = f.review();
          assert.equal(f.owner.confirm(review.planHash), true);
          f.time(invalid);
          if (trigger === 'review') assert.throws(f.review, f.unavailable);
          else if (trigger === 'confirm') assert.equal(f.owner.confirm(review.planHash), false);
          else if (trigger === 'status') assert.equal(f.owner.status().phase, 'idle');
          else assert.equal(f.effect(), kind === 'stream' ? false : undefined);
          f.time(initial + 1000);
          f.owner.cancel();
          assert.equal(f.owner.status().phase, 'idle');
          assert.equal(f.owner.confirm(review.planHash), false);
          assert.throws(f.review, f.unavailable);
          assert.equal(f.effect(), kind === 'stream' ? false : undefined);
          assert.equal(f.deliveries(), 0);
        });
      }
    }
    test(`M3 clock ${kind} normal cancel and TTL do not permanently close a valid owner`, async context => {
      const f = fixture(context, kind);
      const first = f.review(); assert.equal(f.owner.confirm(first.planHash), true);
      f.owner.cancel();
      const second = f.review(); assert.notEqual(second.planHash, first.planHash);
      assert.equal(f.owner.confirm(first.planHash), false);
      assert.equal(f.owner.confirm(second.planHash), true);
      f.time(second.expiresAt - 1); assert.equal(f.owner.confirm(second.planHash), true);
      f.time(second.expiresAt); assert.equal(f.owner.confirm(second.planHash), false);
      const next = f.review();
      assert.equal(next.expiresAt, second.expiresAt + 30000);
      assert.equal(f.owner.confirm(next.planHash), true);
      const result = await f.effect();
      if (kind === 'network') assert.equal(result.result, 'test-only');
      else if (kind === 'response') assert.equal(result.body, '/* test-only */');
      else { assert.equal(result, true); assert.equal(f.deliveries(), 1); }
    });
    test(`M3 clock ${kind} a new explicit owner has an independent clock lifetime`, async context => {
      const f = fixture(context, kind), review = f.review();
      f.owner.confirm(review.planHash); f.time(initial - 1); f.owner.status();
      f.time(initial + 1000);
      assert.throws(f.review, f.unavailable);
      const fresh = fixture(context, kind), next = fresh.review();
      assert.equal(fresh.owner.confirm(next.planHash), true);
      const result = await fresh.effect();
      assert.notEqual(result, undefined);
      assert.notEqual(result, false);
    });
  }
  for (const [name, invalid] of invalidTimes) {
    test(`M3 clock delayed HTTP observes ${name} at completion without native fallback`, async context => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(context, 'network', 25), review = f.review();
      assert.equal(f.owner.confirm(review.planHash), true);
      const operation = f.effect();
      const rejected = assert.rejects(operation, /MOCK_CANCELLED/);
      assert.equal(f.owner.status().pending, 1);
      f.time(invalid); context.mock.timers.tick(25);
      await rejected;
      f.time(initial + 1000);
      assert.equal(f.owner.status().pending, 0);
      assert.throws(f.review, /MOCK_UNAVAILABLE/);
    });
  }
  test('M3 clock invalidation rejects pending delays before their timers fire', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(context, 'network', 25), review = f.review();
    f.owner.confirm(review.planHash);
    const first = f.effect(), second = f.effect();
    const rejections = [assert.rejects(first, /MOCK_CANCELLED/), assert.rejects(second, /MOCK_CANCELLED/)];
    assert.equal(f.owner.status().pending, 2);
    f.time(initial - 1);
    assert.equal(f.owner.status().pending, 0);
    await Promise.all(rejections);
    context.mock.timers.tick(25); f.time(initial + 1000);
    assert.throws(f.review, /MOCK_UNAVAILABLE/);
  });
}
