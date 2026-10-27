/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Actual ArkTS consent owners with explicit platform substitutes. Local consent
// and native-call counts do not authenticate a device or prove script preemption.
export function registerM3ConsentTests({ NetworkBodyCapture, WebConsoleSession, NodePort }) {
  const initial = 1800000000000;
  const requestUrl = 'http://127.0.0.1:12345/ohmate-body-sample';
  const options = { method: 'GET', maxRedirects: 0, usingCache: false };
  const rule = JSON.stringify({ version: '1', targetId: 'network-main',
    origin: 'http://127.0.0.1:12345', path: '/ohmate-body-sample',
    contentTypes: ['application/json'], maxBytes: 1024, maxTotalBytes: 2048, ttlMs: 30000 });
  const response = () => ({ responseCode: 200, resultType: 0,
    result: '{"count":2,"label":"TEST_ONLY"}', header: { 'content-type': 'application/json' },
    connectionExtraInfo: { redirectCount: 0 } });
  const invalidTimes = [['rollback', initial - 1], ['NaN', NaN], ['infinity', Infinity],
    ['negative infinity', -Infinity], ['fractional', initial + 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1]];
  function clock(context) {
    let value = initial;
    context.mock.method(Date, 'now', () => value);
    return next => { value = next; };
  }
  function body(context) {
    const time = clock(context);
    const owner = new NetworkBodyCapture(new NodePort(), 'network-main', () => true);
    context.after(() => owner.cancel());
    const review = () => owner.review(rule, 'test-binding', initial + 600000);
    const begin = id => owner.begin(id, requestUrl, options, 'ordinary');
    return { owner, time, review, begin };
  }
  for (const [name, invalid] of invalidTimes) {
    for (const trigger of ['review', 'confirm', 'status', 'preview', 'begin', 'complete']) {
      test(`M3 consent Body ${name} at ${trigger} clears old consent and late tickets`, context => {
        const f = body(context), first = f.review();
        assert.equal(f.owner.confirm(first.planHash), true);
        const ticket = f.begin('test-before');
        assert.ok(ticket);
        f.owner.complete(ticket, response());
        assert.equal(f.owner.preview().body, '{"count":2,"label":"[redacted]"}');
        f.time(invalid);
        if (trigger === 'review') assert.throws(f.review, /BODY_CAPTURE_UNAVAILABLE/);
        if (trigger === 'confirm') assert.equal(f.owner.confirm(first.planHash), false);
        if (trigger === 'status') assert.equal(f.owner.status(), 'idle');
        if (trigger === 'preview') assert.equal(f.owner.preview(), undefined);
        if (trigger === 'begin') assert.equal(f.begin('test-invalid'), undefined);
        if (trigger === 'complete') {
          const guarded = response();
          let reads = 0;
          Object.defineProperty(guarded, 'result', { get() { reads++; return 'TEST_ONLY'; } });
          f.owner.complete(ticket, guarded);
          assert.equal(reads, 0, 'revoked native body is not read even if projection would catch an error');
        }
        f.time(initial + 1000);
        assert.equal(f.owner.status(), 'idle');
        assert.equal(f.owner.preview(), undefined);
        assert.equal(f.owner.confirm(first.planHash), false);
        assert.equal(f.begin('test-no-consent'), undefined);
        const next = f.review();
        assert.notEqual(next.planHash, first.planHash);
        assert.equal(f.begin('test-review-only'), undefined);
        assert.equal(f.owner.confirm(first.planHash), false);
        assert.equal(f.owner.confirm(next.planHash), true);
        f.owner.complete(ticket, response());
        assert.equal(f.owner.preview(), undefined, 'new consent cannot admit an old ticket');
        const fresh = f.begin('test-fresh');
        assert.ok(fresh);
        f.owner.complete(fresh, response());
        assert.equal(f.owner.preview().capturedBytes, 31);
      });
    }
  }
  test('M3 consent Body invalid reading cannot poison the subsequent backward-clock check', context => {
    const f = body(context), first = f.review();
    f.owner.confirm(first.planHash);
    f.time(NaN);
    assert.equal(f.owner.status(), 'idle');
    f.time(initial - 1);
    assert.throws(f.review, /BODY_CAPTURE_UNAVAILABLE/);
    f.time(initial + 1000);
    const next = f.review();
    f.owner.confirm(next.planHash);
    f.time(initial + 999);
    assert.equal(f.owner.status(), 'idle');
    assert.equal(f.owner.confirm(next.planHash), false);
  });
  test('M3 consent Body repeated confirmation never renews TTL or resets bytes', context => {
    const f = body(context), review = f.review();
    f.owner.confirm(review.planHash);
    f.owner.complete(f.begin('test-one'), response());
    f.time(review.expiresAt - 1);
    assert.equal(f.owner.confirm(review.planHash), true);
    f.owner.complete(f.begin('test-two'), response());
    assert.equal(f.owner.preview().capturedBytes, 62);
    f.time(review.expiresAt);
    assert.equal(f.owner.confirm(review.planHash), false);
    assert.equal(f.owner.preview(), undefined);
    const next = f.review();
    f.owner.confirm(next.planHash);
    f.owner.complete(f.begin('test-three'), response());
    assert.equal(f.owner.preview().capturedBytes, 31);
  });
  function consoleOwner(context) {
    const time = clock(context);
    let busy = false, calls = 0, cancelled = 0, finish, active, project;
    const owner = new WebConsoleSession(new NodePort(), () => true, () => busy, () => { cancelled++; });
    context.after(() => owner.cancel());
    const review = () => owner.review('1 + 1', 'test-binding', initial + 600000, 30000);
    const execute = hash => owner.execute(hash, (code, current, projection) => {
      assert.equal(code, '1 + 1'); calls++; busy = true; active = current; project = projection;
      return new Promise(resolve => { finish = resolve; });
    });
    const settle = () => {
      busy = false;
      const result = active() ? project({ getType: () => 2, getNumber: () => 2 }) :
        { resultType: 'unsupported', bytes: 0, summary: '[MEMORY_ONLY]' };
      finish(result);
    };
    return { owner, time, review, execute, settle, calls: () => calls, cancelled: () => cancelled };
  }
  for (const [name, invalid] of invalidTimes) {
    for (const trigger of ['confirm', 'status', 'execute']) {
      test(`M3 consent Console ${name} at ${trigger} rejects stale execution after clock recovery`, async context => {
        const f = consoleOwner(context), review = f.review();
        f.owner.confirm(review.planHash); f.time(invalid);
        if (trigger === 'confirm') assert.equal(f.owner.confirm(review.planHash), false);
        if (trigger === 'status') assert.equal(f.owner.status().phase, 'idle');
        if (trigger === 'execute') assert.equal(await f.execute(review.planHash), false);
        f.time(initial + 1000);
        assert.equal(f.owner.confirm(review.planHash), false);
        assert.equal(await f.execute(review.planHash), false);
        assert.equal(f.calls(), 0);
        const next = f.review();
        assert.notEqual(next.commandId, review.commandId);
        assert.equal(await f.execute(next.planHash), false, 'review is not execution consent');
        f.owner.confirm(next.planHash);
        const pending = f.execute(next.planHash);
        assert.equal(f.calls(), 1);
        f.settle(); assert.equal(await pending, true);
        assert.equal(await f.execute(next.planHash), false);
        assert.equal(f.calls(), 1);
      });
    }
    test(`M3 consent Console pending ${name} keeps native ownership and rejects late results`, async context => {
      const f = consoleOwner(context), review = f.review();
      f.owner.confirm(review.planHash);
      const operation = f.execute(review.planHash);
      assert.equal(f.calls(), 1);
      f.time(invalid);
      assert.equal(f.owner.status().phase, 'idle');
      assert.equal(f.owner.status().nativePending, true);
      f.time(initial + 1000);
      assert.throws(f.review, /CONSOLE_CAPTURE_BUSY/);
      assert.equal(await f.execute(review.planHash), false);
      f.settle(); assert.equal(await operation, false);
      assert.equal(f.owner.status().nativePending, false);
      assert.equal(f.owner.status().resultType, '');
      assert.ok(f.cancelled() > 0);
      const next = f.review();
      f.owner.confirm(next.planHash);
      const fresh = f.execute(next.planHash);
      f.settle(); assert.equal(await fresh, true);
      assert.equal(f.calls(), 2);
    });
  }
  test('M3 consent Console concurrent and later duplicates invoke the executor only once', async context => {
    const f = consoleOwner(context), review = f.review();
    assert.equal(f.owner.confirm(review.planHash), true);
    const first = f.execute(review.planHash);
    assert.equal(await f.execute(review.planHash), false);
    assert.equal(f.owner.confirm(review.planHash), false);
    assert.equal(f.calls(), 1);
    f.settle(); assert.equal(await first, true);
    const status = f.owner.status();
    assert.equal(status.phase, 'completed');
    assert.equal(status.commandId, review.commandId);
    assert.equal(await f.execute(review.planHash), false);
    assert.deepEqual(f.owner.status(), status);
    f.time(initial + 1000);
    assert.equal(await f.execute(review.planHash), false);
    assert.equal(f.calls(), 1);
  });
}

export function registerM3ControllerConsentTests({
  connectConsole, connectNetwork, bodyRule, bodyOptions, bodyResponse, bodyUrl, now, settle,
}) {
  test('M3 consent controller Body fractional clock revokes UI and old tickets before recovery', async context => {
    await settle();
    let finish, value = now;
    const { controller } = await connectNetwork(context, {
      request: () => new Promise(resolve => { finish = resolve; }),
    });
    context.mock.method(Date, 'now', () => value);
    const first = controller.reviewNetworkBody(JSON.stringify(bodyRule()));
    assert.equal(controller.confirmNetworkBody(first.planHash), true);
    const pending = controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
    assert.equal(typeof finish, 'function');
    value = now + 0.5;
    assert.equal(controller.networkBodyPreview(), undefined);
    assert.equal(controller.state.networkBodyPhase, 'idle');
    assert.equal(controller.state.networkBodyPlanHash, '');
    value = now + 1;
    const next = controller.reviewNetworkBody(JSON.stringify(bodyRule()));
    assert.equal(controller.confirmNetworkBody(first.planHash), false);
    assert.equal(controller.confirmNetworkBody(next.planHash), true);
    const response = bodyResponse();
    finish(response); assert.equal(await pending, response);
    assert.equal(controller.networkBodyPreview(), undefined);
  });
  for (const action of ['source', 'debug', 'build', 'identity', 'navigation']) {
    test(`M3 consent controller Console ${action} drift cannot revive the old plan`, async context => {
      await settle();
      const f = await connectConsole(context), review = f.controller.reviewConsole('1 + 1');
      f.controller.confirmConsole(review.planHash);
      const originalUrl = f.source.controller.getUrl;
      const identity = f.controller.session.negotiated.identity;
      const originalIdentity = { ...identity };
      if (action === 'source') f.source.controller.getUrl = () => 'https://example.invalid/login';
      if (action === 'debug') globalThis.__kitTest.debug = false;
      if (action === 'build') identity.buildId = 'unverified:test-only-changed';
      if (action === 'identity') identity.device = 'test-only-changed';
      if (action === 'navigation') {
        const url = originalUrl();
        f.controller.webPageBegin(url); f.controller.webPageEnd(url);
      }
      assert.equal(f.controller.consoleStatus().phase, 'idle');
      f.source.controller.getUrl = originalUrl;
      globalThis.__kitTest.debug = true;
      Object.assign(identity, originalIdentity);
      assert.equal(f.controller.confirmConsole(review.planHash), false);
      assert.equal(await f.controller.executeConsole(review.planHash), false);
      assert.equal(f.calls.length, 0);
      const next = f.controller.reviewConsole('1 + 1');
      assert.notEqual(next.commandId, review.commandId);
      f.controller.confirmConsole(next.planHash);
      assert.equal(await f.controller.executeConsole(next.planHash), true);
      assert.deepEqual(f.calls, ['1 + 1']);
    });
  }
  for (const reason of ['CONNECTION_CLOSED', 'BACKGROUND', 'BUILD_CHANGED']) {
    test(`M3 consent controller Console pending ${reason} retains the native lock until settlement`, async context => {
      await settle();
      const f = await connectConsole(context);
      let finish;
      f.result(() => new Promise(resolve => { finish = resolve; }));
      const review = f.controller.reviewConsole('1 + 1');
      f.controller.confirmConsole(review.planHash);
      const pending = f.controller.executeConsole(review.planHash);
      await settle();
      assert.equal(f.calls.length, 1);
      const closing = f.controller.stop(reason);
      assert.equal(f.controller.state.consolePlanHash, '');
      assert.equal(f.controller.confirmConsole(review.planHash), false);
      assert.equal(f.controller.consoleStatus().nativePending, true);
      assert.equal(await pending, false);
      await closing;
      assert.equal(f.controller.consoleStatus().nativePending, true);
      assert.throws(() => f.controller.review(f.text), /WEB_CAPTURE_BUSY/);
      let reads = 0;
      finish({ getType() { reads++; return 2; }, getNumber() { reads++; return 2; } });
      await settle();
      assert.equal(reads, 0, 'revoked result getters are never invoked');
      assert.equal(f.controller.consoleStatus().nativePending, false);
      assert.equal(f.controller.consoleStatus().resultType, '');
      assert.equal(f.calls.length, 1);
    });
  }
}
