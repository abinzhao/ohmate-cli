/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Real .ets owner; every host/native callback below is an explicit substitute.
export function registerSemanticReplayTests({ SemanticReplaySession, NodePort }) {
  const settle = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
  const step = () => ({ kind: 'action', actionId: 'test.marker', dataRef: 'test:marker',
    assertionId: 'test.marker-present', expected: 'test:present', waitMs: 1000 });
  function fixture(context) {
    assert.equal(typeof SemanticReplaySession, 'function', 'Actual ArkTS semantic replay owner must exist');
    const initial = Date.now();
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: initial });
    let source = { buildId: 'local-test-build', buildBinding: 'local-artifact', sourceHash: 'a'.repeat(64),
      binding: 'b'.repeat(64), windowId: 'page-main', deadline: initial + 60000 };
    let marker = '', held = '', fails = false;
    const calls = [];
    const host = {
      descriptors: () => [{ kind: 'action', actionId: 'test.marker', dataRefs: ['test:marker'],
        assertionId: 'test.marker-present', expectations: ['test:present'] }],
      prepare: (id) => { calls.push(['prepare', id]); held = id; return true; },
      execute: async (id, value) => {
        assert.equal(id, held); calls.push(['execute', id, value]); marker = 'test:present'; return true;
      },
      assert: async (id, assertionId, expected) => {
        assert.equal(id, held); calls.push(['assert', assertionId, expected]); return marker === expected;
      },
      restore: async (id) => {
        calls.push(['restore', id]); assert.equal(id, held);
        if (fails) throw Error('PRIVATE_HOST_FAILURE');
        marker = ''; held = ''; return true;
      },
    };
    const owner = new SemanticReplaySession(new NodePort(), () => source, host);
    context.after(async () => {
      fails = false; owner.dispose(); await settle();
      if (owner.status().pendingCleanup) await owner.retryRestore();
    });
    return { owner, host, calls, initial, marker: () => marker, held: () => held,
      source: (value) => { source = value; }, currentSource: () => source,
      fail: (value) => { fails = value; }, time: (value) => context.mock.timers.setTime(value),
      review: (value = step()) => owner.review(value, 'local-test-build') };
  }
  test('semantic replay binds one explicit ordinary step and requires independent consent and assertion', async (context) => {
    const f = fixture(context), input = step(), review = f.review(input);
    assert.equal(review.scope, 'replay.step'); assert.equal(review.risk, 'R3');
    assert.equal(review.idempotencyKey, review.commandId); assert.match(review.planHash, /^[a-f0-9]{64}$/);
    assert.equal(review.expiresAt, f.initial + 30000);
    input.dataRef = 'test:changed'; review.planHash = 'tampered';
    const hash = f.owner.status().planHash;
    assert.equal(f.owner.confirm(review.planHash), false); assert.equal(await f.owner.apply(hash), false);
    assert.deepEqual(f.calls, []); assert.equal(f.owner.confirm(hash), true);
    assert.equal(await f.owner.apply(hash), true); assert.equal(f.marker(), 'test:present');
    assert.deepEqual(f.calls[1][2], step()); assert.deepEqual(f.calls[2], ['assert', 'test.marker-present', 'test:present']);
    assert.equal(f.owner.status().assertion, 'passed'); assert.equal(f.owner.status().phase, 'asserted');
    assert.equal(await f.owner.apply(hash), false); assert.equal(f.owner.confirm(hash), false);
    f.owner.cancel(); await settle(); assert.equal(f.marker(), ''); assert.equal(f.owner.status().pendingCleanup, 0);
  });
  for (const invalid of [
    { ...step(), kind: 'payment' }, { ...step(), actionId: 'delete.real' },
    { ...step(), input: 'PRIVATE_RAW_INPUT' }, { ...step(), dataRef: 'PRIVATE_RAW_INPUT' },
    { ...step(), assertionId: '' }, { ...step(), expected: 'PRIVATE_RAW_OUTPUT' },
    { ...step(), waitMs: 3001 }, { ...step(), waitMs: 0 },
    { ...step(), actionId: 'test.unregistered' }, { ...step(), dataRef: 'test:unregistered' },
  ]) {
    test('semantic replay rejects unregistered, sensitive, raw or unbounded steps before host calls', (context) => {
      const f = fixture(context); assert.throws(() => f.review(invalid)); assert.deepEqual(f.calls, []);
      assert(!JSON.stringify(f.owner.status()).includes('PRIVATE_RAW'));
    });
  }
  test('semantic replay absent Adapter and unverified or mismatched local build remain manual-only', (context) => {
    const f = fixture(context), missing = new SemanticReplaySession(new NodePort(), f.currentSource);
    context.after(() => missing.dispose());
    assert.throws(() => missing.review(step(), 'local-test-build'));
    f.source({ ...f.currentSource(), buildBinding: 'unverified' }); assert.throws(() => f.review());
    f.source({ ...f.currentSource(), buildBinding: 'local-artifact' });
    assert.throws(() => f.owner.review(step(), 'different-build'));
    assert.deepEqual(f.calls, []);
  });
  test('semantic replay registers recovery before preparation can throw and keeps error text private', async (context) => {
    const f = fixture(context), review = f.review();
    f.host.prepare = (id) => {
      assert.equal(f.owner.status().pendingCleanup, 1); f.calls.push(['prepare', id]);
      throw Error('PRIVATE_HOST_FAILURE');
    };
    f.host.restore = async (id) => { f.calls.push(['restore', id]); return true; };
    f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash), false);
    assert.equal(f.calls[1][0], 'restore'); assert.equal(f.owner.status().pendingCleanup, 0);
    assert(!JSON.stringify(f.owner.status()).includes('PRIVATE_HOST_FAILURE'));
  });
  test('semantic replay failed per-step assertion aborts and restores exact command without another action', async (context) => {
    const f = fixture(context), review = f.review();
    f.host.assert = async () => false; f.owner.confirm(review.planHash);
    assert.equal(await f.owner.apply(review.planHash), false);
    assert.equal(f.owner.status().assertion, 'failed'); assert.equal(f.marker(), '');
    assert.equal(f.calls.filter(([name]) => name === 'execute').length, 1);
    assert.equal(f.calls.at(-1)[0], 'restore'); assert.equal(f.owner.confirm(review.planHash), false);
  });
  for (const stage of ['execute', 'assert']) {
    test(`semantic replay cancel while ${stage} pending holds ownership and rejects late completion`, async (context) => {
      const f = fixture(context), original = f.host[stage], review = f.review();
      let finish;
      f.host[stage] = (...args) => new Promise((resolve) => { finish = () => resolve(original(...args)); });
      f.owner.confirm(review.planHash); const operation = f.owner.apply(review.planHash); await settle();
      assert.equal(typeof finish, 'function'); f.owner.cancel();
      assert.equal(await operation, false); assert.equal(f.owner.status().nativePending, true);
      assert.equal(f.owner.status().pendingCleanup, 1); assert.equal(await f.owner.retryRestore(), false);
      assert.throws(() => f.review()); finish(); await settle();
      assert.equal(f.owner.status().nativePending, false); assert.equal(f.owner.status().pendingCleanup, 0);
      assert.equal(f.marker(), ''); assert.equal(f.owner.status().assertion, 'not-run');
    });
    test(`semantic replay bounded wait while ${stage} pending cannot certify preemption`, async (context) => {
      const f = fixture(context), original = f.host[stage], review = f.review();
      let finish;
      f.host[stage] = (...args) => new Promise((resolve) => { finish = () => resolve(original(...args)); });
      f.owner.confirm(review.planHash); const operation = f.owner.apply(review.planHash); await settle();
      context.mock.timers.tick(1000); assert.equal(await operation, false);
      assert.equal(f.owner.status().reason, 'REPLAY_TIMEOUT'); assert.equal(f.owner.status().nativePending, true);
      finish(); await settle(); assert.equal(f.marker(), ''); assert.equal(f.owner.status().pendingCleanup, 0);
    });
  }
  test('semantic replay recovery failure is retained across dispose and retried only explicitly', async (context) => {
    const f = fixture(context), review = f.review(); f.fail(true); f.host.assert = async () => false;
    f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash), false);
    assert.equal(f.owner.status().pendingCleanup, 1); assert.equal(f.owner.status().revocation, 'cleanup-failed');
    const count = f.calls.length; f.owner.status(); f.owner.cancel(); f.owner.dispose(); await settle();
    assert.equal(f.calls.length, count); assert.equal(f.owner.host, f.host);
    f.fail(false); assert.equal(await f.owner.retryRestore(), true); assert.equal(f.owner.host, undefined);
    assert.throws(() => f.review());
  });
  test('semantic replay recovery timeout retains native owner and cannot trust late restoration', async (context) => {
    const f = fixture(context), review = f.review(), original = f.host.restore;
    let finish;
    f.host.restore = (...args) => new Promise((resolve) => { finish = () => resolve(original(...args)); });
    f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash), true);
    f.owner.cancel(); await settle(); context.mock.timers.tick(3000); await settle();
    assert.equal(f.owner.status().nativePending, true); assert.equal(f.owner.status().pendingCleanup, 1);
    finish(); await settle(); assert.equal(f.owner.status().pendingCleanup, 1);
    f.host.restore = async () => true; assert.equal(await f.owner.retryRestore(), true);
    assert.equal(f.owner.status().pendingCleanup, 0);
  });
  for (const key of ['sourceHash', 'binding', 'windowId', 'buildId', 'deadline']) {
    test(`semantic replay ${key} drift permanently forbids effects and wrong-source recovery`, async (context) => {
      const f = fixture(context), original = f.currentSource(), review = f.review();
      f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash), true);
      f.source({ ...original, [key]: key === 'deadline' ? original.deadline - 1 : 'changed' });
      assert.equal(f.owner.status().pendingCleanup, 1); assert.equal(f.owner.status().revocation, 'source-invalid');
      f.source(original); assert.equal(await f.owner.retryRestore(), false);
      assert.equal(f.calls.filter(([name]) => name === 'restore').length, 0);
      assert.equal(f.owner.confirm(review.planHash), false); assert.throws(() => f.review());
    });
  }
  test('semantic replay review expiry, clock rollback and rate/budget limits do not renew a consumed command', async (context) => {
    const f = fixture(context), first = f.review(); f.owner.confirm(first.planHash);
    assert.equal(await f.owner.apply(first.planHash), true); f.owner.cancel(); await settle();
    const next = f.review(); f.owner.confirm(next.planHash); assert.equal(await f.owner.apply(next.planHash), false);
    f.time(f.initial + 30000); assert.equal(f.owner.confirm(next.planHash), false);
    const third = f.review(); f.time(f.initial + 29999); assert.equal(f.owner.confirm(third.planHash), false);
    f.time(f.initial + 31000); assert.throws(() => f.review());
  });
  test('semantic replay 256 attempts and duplicate tombstones never evict old commands', (context) => {
    const f = fixture(context), first = f.review(); f.owner.cancel();
    for (let index = 1; index < 256; index++) assert.throws(() => f.review({ ...step(), waitMs: 3001 }));
    assert.throws(() => f.review()); assert.equal(f.owner.confirm(first.planHash), false);
  });
  test('semantic replay status callback source drift cannot leave a successful returned assertion', async (context) => {
    const f = fixture(context), review = f.review();
    f.owner.changed = () => {
      if (f.owner.phase === 'asserted') f.source(undefined);
      f.owner.status();
    };
    f.owner.confirm(review.planHash);
    assert.equal(await f.owner.apply(review.planHash), false, 'Result must recheck current source after completion callbacks');
    assert.equal(f.owner.status().phase, 'aborted');
    assert.equal(f.owner.status().pendingCleanup, 1);
  });
  test('semantic replay one shared wait budget includes both action and assertion', async (context) => {
    const f = fixture(context), review = f.review();
    let effect, assertion;
    f.host.execute = () => new Promise((resolve) => { effect = resolve; });
    f.host.assert = () => new Promise((resolve) => { assertion = resolve; });
    f.owner.confirm(review.planHash); const operation = f.owner.apply(review.planHash); await settle();
    context.mock.timers.tick(900); effect(true); await settle();
    assert.equal(typeof assertion, 'function');
    context.mock.timers.tick(100); assert.equal(await operation, false);
    assertion(true); await settle(); assert.equal(f.owner.status().assertion, 'not-run');
  });
  test('semantic replay observed descriptor drift revokes even if host returns its former descriptor', (context) => {
    const f = fixture(context), review = f.review(), descriptors = f.host.descriptors;
    f.host.descriptors = () => [];
    assert.equal(f.owner.confirm(review.planHash), false); f.host.descriptors = descriptors;
    assert.throws(() => f.review()); assert.deepEqual(f.calls, []);
  });
  test('semantic replay timer revokes source loss without a caller status read', async (context) => {
    const f = fixture(context), review = f.review();
    f.owner.confirm(review.planHash); await f.owner.apply(review.planHash);
    f.source(undefined); context.mock.timers.tick(250); await settle();
    assert.equal(f.owner.phase, 'aborted'); assert.equal(f.owner.revocation, 'source-invalid');
  });
  test('semantic replay deferred restoration must recheck source before invoking host', async (context) => {
    const f = fixture(context), review = f.review(), original = f.currentSource();
    f.owner.confirm(review.planHash); await f.owner.apply(review.planHash);
    f.owner.cancel(); f.source(undefined); await settle(); f.source(original);
    assert.equal(f.calls.filter(([name]) => name === 'restore').length, 0);
    assert.equal(await f.owner.retryRestore(), false);
  });
}

export function registerSemanticReplayControllerTests({ connectSnapshot, NodePort }) {
  const step = { kind: 'action', actionId: 'test.marker', dataRef: 'test:marker',
    assertionId: 'test.marker-present', expected: 'test:present', waitMs: 1000 };
  function host() {
    let held = '';
    return { descriptors: () => [{ kind: 'action', actionId: step.actionId, dataRefs: [step.dataRef],
      assertionId: step.assertionId, expectations: [step.expected] }],
    prepare: (id) => { held = id; return true; },
    execute: async (id) => id === held,
    assert: async (id) => id === held,
    restore: async (id) => { if (id !== held) return false; held = ''; return true; } };
  }
  test('semantic replay controller remains manual-only for actual unverified Producer build even with host', async (context) => {
    const f = await connectSnapshot(context);
    assert.equal(typeof f.controller.registerReplay, 'function');
    assert.throws(() => f.controller.registerReplay(host()), 'Registration during connection must be refused');
    await f.controller.stop();
    f.controller.registerReplay(host());
    assert.equal(f.controller.replayAvailable(), false);
    assert.throws(() => f.controller.reviewReplay(step, 'unverified:dev.ohmate.kitproducer:1'));
  });
  for (const cancel of [false, true]) {
    test(`semantic replay controller ${cancel ? 'cancel' : 'assert'} revokes snapshots and holds collection ownership`, async (context) => {
      const f = await connectSnapshot(context), controller = f.controller, adapter = host();
      assert.equal(typeof controller.registerReplay, 'function');
      // Test-only source substitution does not authenticate the actual app build.
      const source = { buildId: 'local-test-build', buildBinding: 'local-artifact', sourceHash: 'a'.repeat(64),
        binding: 'b'.repeat(64), windowId: 'page-main', deadline: Date.now() + 60000 };
      controller.replaySource = () => source;
      controller.replay = new globalThis.__kitTest.SemanticReplaySession(new NodePort(), () => controller.replaySource(), adapter);
      controller.replayHost = adapter;
      const review = controller.reviewReplay(step, 'local-test-build');
      assert.equal(await controller.executeReplay(review.planHash), false);
      assert.equal(controller.confirmReplay(review.planHash), true);
      controller.uiSample = 'PRIVATE_OLD_SAMPLE'; controller.state.uiNodes = 1;
      controller.state.screenshotData = 'PRIVATE_OLD_PREVIEW';
      controller.webDomSample = 'PRIVATE_OLD_DOM'; controller.storageSample = 'PRIVATE_OLD_STORAGE';
      controller.exportBytes = Uint8Array.from([1, 2, 3]); const bytes = controller.exportBytes;
      const sent = f.socket.sent.length;
      let finish;
      if (cancel) adapter.execute = () => new Promise((resolve) => { finish = resolve; });
      const operation = controller.executeReplay(review.planHash);
      for (let index = 0; index < 40; index++) await Promise.resolve();
      assert.equal(controller.uiSample, ''); assert.equal(controller.state.screenshotData, '');
      assert.equal(controller.webDomSample, ''); assert.equal(controller.storageSample, '');
      assert(bytes.every((byte) => byte === 0)); assert.equal(await controller.captureUi(), false);
      assert.equal(await controller.captureCpu(), false); assert.equal(await controller.captureWebStorage(), false);
      assert.equal(f.socket.sent.length, sent);
      if (cancel) {
        controller.cancelReplay(); assert.equal(await operation, false);
        assert.equal(controller.replayStatus().nativePending, true);
        assert.throws(() => controller.registerReplay(host()));
        finish(true); for (let index = 0; index < 40; index++) await Promise.resolve();
      } else {
        assert.equal(await operation, true); controller.cancelReplay();
        for (let index = 0; index < 40; index++) await Promise.resolve();
      }
      assert.equal(controller.replayStatus().pendingCleanup, 0);
    });
  }
}

export function registerSemanticReplayPageTests({ ProducerPage, setProducer }) {
  test('semantic replay page Adapter uses one reversible fixed marker and exact ownership', async () => {
    globalThis.NavPathStack = class {};
    try {
      setProducer({ state: { phase: 'connected' } });
      const page = new ProducerPage();
      assert.equal(typeof page.replayAdapter, 'function', 'Actual page replay Adapter must exist');
      const host = page.replayAdapter(), step = { kind: 'action', actionId: 'test.marker', dataRef: 'test:marker',
        assertionId: 'test.marker-present', expected: 'test:present', waitMs: 1000 };
      assert.equal(page.replayMarker, false); assert.equal(host.prepare('one'), true);
      assert.equal(host.prepare('two'), false); assert.equal(await host.execute('two', step), false);
      assert.equal(await host.execute('one', { ...step, actionId: 'test.foreign' }), false);
      assert.equal(await host.execute('one', step), true); assert.equal(page.replayMarker, true);
      assert.equal(await host.assert('one', step.assertionId, step.expected), true);
      assert.equal(await host.restore('two'), false); assert.equal(await host.restore('one'), true);
      assert.equal(page.replayMarker, false);
      assert.equal(host.prepare('three'), true);
      assert.equal(await host.restore('three'), true, 'Prepared but rejected effect must release unchanged owned state');
      assert.equal(page.replayMarker, false);
    } finally { setProducer(undefined); delete globalThis.NavPathStack; }
  });
  test('semantic replay page review confirm execute cancel remain distinct ordinary methods', async () => {
    globalThis.NavPathStack = class {};
    const calls = [];
    try {
      setProducer({ state: { phase: 'connected' }, replayBuildId: () => 'local-test-build',
        reviewReplay: (step, buildId) => { calls.push(['review', step, buildId]); return { planHash: 'plan' }; },
        confirmReplay: (hash) => { calls.push(['confirm', hash]); return true; },
        executeReplay: async (hash) => { calls.push(['execute', hash]); return true; },
        cancelReplay: () => { calls.push(['cancel']); } });
      const page = new ProducerPage();
      assert.equal(typeof page.reviewReplay, 'function'); page.reviewReplay();
      assert.equal(calls.length, 1); page.confirmReplay(); assert.equal(calls.length, 2);
      await page.executeReplay(); assert.equal(calls.length, 3); page.cancelReplay();
      assert.deepEqual(calls.map(([name]) => name), ['review', 'confirm', 'execute', 'cancel']);
      assert.equal(page.replayReview, undefined);
    } finally { setProducer(undefined); delete globalThis.NavPathStack; }
  });
}
