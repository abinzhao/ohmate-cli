/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual platform-independent ETS with a private Node file host. Not device evidence.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(tmpdir(), 'ohmate-public-core-test-'));
const subjects = [];
after(async () => {
  for (const item of subjects) {
    item.host.pending?.resolve(); item.host.recoverPending?.resolve();
    item.host.problemPending?.resolve(); await item.core.dispose();
  }
});
after(() => rm(temporary, { recursive: true, force: true }));
const entry = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/core.ets', import.meta.url));
let api;
const intervalOwners = new Map();
const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, delay) => {
  const timer = nativeSetInterval(callback, delay); intervalOwners.set(timer, { callback, delay }); return timer;
};
globalThis.clearInterval = timer => { intervalOwners.delete(timer); nativeClearInterval(timer); };
after(() => {
  globalThis.setInterval = nativeSetInterval; globalThis.clearInterval = nativeClearInterval;
  assert.equal(intervalOwners.size, 0, 'every Core interval owner must be disposed');
});
try {
  await build({ entryPoints: [entry], outfile: path.join(temporary, 'core.mjs'), bundle: true,
    platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  api = await import(pathToFileURL(path.join(temporary, 'core.mjs')));
} catch (error) {
  test('the single OHPM package exposes its independent Core API', () => {
    assert.fail(`public Core missing: ${error.errors?.[0]?.text ?? error.message}`);
  });
}

if (api) {
  const { OHMateCore, CoreOptions } = api;
  class FileHost {
    tick = 100; randomValue = 0; appends = 0; segmentTexts = []; problemTexts = [];
    storageFailure = false; pending = undefined; history = [];
    savedProblems = []; problemOutcome = 'synced'; problemPending = undefined;
    constructor(directory) { this.directory = directory; }
    now() { return { clockId: 'test-monotonic', bootId: 'test-boot', monotonicNs: this.tick * 1000000,
      wallTimeUtc: '2026-10-25T00:00:00.000Z' }; }
    random() { return this.randomValue; }
    sessionId() { return 'test-session'; }
    hash(text) { return createHash('sha256').update(text).digest('hex'); }
    byteLength(text) { return Buffer.byteLength(text); }
    async recover() { if (this.recoverPending) { await this.recoverPending.promise; } return this.history; }
    async recoverProblems() { return this.savedProblems; }
    appendKey(text) {
      try {
        const segment = JSON.parse(JSON.parse(text).payload);
        return `${segment.sessionId}#${segment.firstSequence}`;
      } catch (_) { return undefined; }
    }
    async append(text) {
      this.appends++;
      if (this.pending) { await this.pending.promise; }
      if (this.storageFailure) { throw Error('must not retain filesystem exception text'); }
      const file = await open(path.join(this.directory, `segment-${this.appends}.seg`), 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      // The sandbox host replaces a same-first-sequence prefix extension; keep one text per segment.
      const key = this.appendKey(text), index = this.segmentTexts.findIndex(previous => this.appendKey(previous) === key);
      if (index >= 0) { this.segmentTexts[index] = text; } else { this.segmentTexts.push(text); }
      return 'synced';
    }
    // Mirrors the sandbox host's optional rolling extension for the portable Core contract.
    async extendSegment(text) { return this.append(text); }
    async saveProblem(id, text) {
      if (this.problemPending) { await this.problemPending.promise; }
      const file = await open(path.join(this.directory, `${id}.json`), 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      this.problemTexts.push(text); return this.problemOutcome;
    }
    async deleteProblem(id) { await rm(path.join(this.directory, `${id}.json`)); return true; }
  }
  const options = changes => Object.assign(new CoreOptions(), { sampling: 1, maxRecords: 8,
    maxBufferBytes: 8192, criticalReserveRecords: 2, criticalReserveBytes: 2048, flushIntervalMs: 60000 }, changes);
  async function subject(changes = {}) {
    const directory = await mkdtemp(path.join(temporary, 'subject-'));
    const host = new FileHost(directory), core = new OHMateCore(host);
    const registered = core.registerSchema({ name: 'test.mark', fields: [
      { key: 'result', kind: 'enum', values: ['ok', 'failed'] },
      { key: 'count', kind: 'number', minimum: 0, maximum: 100 },
      { key: 'ready', kind: 'boolean', values: [] },
    ] });
    assert.equal(registered.code, 'REGISTERED');
    subjects.push({ core, host });
    await core.start(options(changes));
    return { core, host };
  }
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const payloads = host => host.segmentTexts.map(text => JSON.parse(JSON.parse(text).payload));

  test('start is idempotent and conflicting options cannot reinitialize the session', async () => {
    const { core, host } = await subject();
    assert.equal((await core.start(options())).code, 'ALREADY_STARTED');
    assert.equal((await core.start(options({ sampling: 0 }))).code, 'START_OPTIONS_CONFLICT');
    assert.equal(host.appends, 1);
    assert.equal(core.getHealth().buildVerification, 'unverified-build');
    await core.dispose();
  });
  test('ordinary sampling never samples Critical events', async () => {
    const { core, host } = await subject({ sampling: 0 });
    assert.equal(core.mark('test.mark', { count: 1 }).code, 'SAMPLED');
    assert.equal(core.recordFault('oom').code, 'RECORDED');
    await core.flush();
    assert.equal(payloads(host).flatMap(p => p.events).filter(e => e.name === 'oom').length, 1);
    assert.equal(core.getHealth().criticalDropped, 0);
    await core.dispose();
  });
  test('only primitive registered fields persist and unknown fields are counted', async () => {
    const { core, host } = await subject();
    core.mark('test.mark', { result: 'ok', count: 2, ready: true, token: 'secret-token',
      cookie: 'session-secret', body: 'private-input', email: 'private@example.test' });
    core.mark('test.mark', { result: 'private-input', count: NaN, ready: 'secret-token' });
    core.mark('unknown.mark', { count: 1 });
    await core.flush();
    const persisted = host.segmentTexts.join('');
    for (const value of ['secret-token', 'session-secret', 'private-input', 'private@example.test']) {
      assert(!persisted.includes(value));
    }
    assert.equal(core.getHealth().rejectedFields, 7);
    assert.equal(core.getHealth().unknownEvents, 1);
    await core.dispose();
  });
  test('schema registration is bounded and cannot allow sensitive keys or free text', async () => {
    const { core } = await subject();
    assert.equal(core.registerSchema({ name: 'test.late', fields: [] }).code, 'SCHEMA_REGISTRATION_CLOSED');
    await core.dispose();
    const host = new FileHost(temporary), fresh = new OHMateCore(host);
    for (const key of ['password', 'token', 'cookie', 'body', 'phone', 'deviceId', 'input']) {
      assert.equal(fresh.registerSchema({ name: 'test.schema', fields: [{ key, kind: 'enum', values: ['ok'] }] }).code,
        'SCHEMA_INVALID');
    }
    assert.equal(fresh.registerSchema({ name: 'test.schema', fields: [{ key: 'text', kind: 'string', values: [] }] }).code,
      'SCHEMA_INVALID');
    for (let i = 0; i < 64; i++) { assert.equal(fresh.registerSchema({ name: `event-${i}`, fields: [] }).code, 'REGISTERED'); }
    assert.equal(fresh.registerSchema({ name: 'event-extra', fields: [] }).code, 'SCHEMA_QUOTA');
  });
  test('pause rejects ordinary events while recording Critical and pause interval markers', async () => {
    const { core, host } = await subject();
    core.pause(); core.mark('test.mark', { count: 1 }); core.recordFault('freeze');
    host.tick += 10; core.resume(); await core.flush();
    assert.equal(core.getHealth().pausedDropped, 1);
    const names = payloads(host).flatMap(p => p.events).map(e => e.name);
    assert(names.includes('pause') && names.includes('resume') && names.includes('freeze'));
    await core.dispose();
  });
  test('buffer reserves Critical slots and reports all priority losses in the next commit', async () => {
    const { core, host } = await subject();
    for (let i = 0; i < 20; i++) { core.mark('test.mark', { count: i }); }
    core.recordFault('crash'); core.recordFault('oom');
    const health = core.getHealth();
    assert(health.bufferRecords <= 8 && health.bufferBytes <= 8192);
    assert.equal(health.criticalDropped, 0); assert(health.dropped > 0);
    await core.flush();
    const tail = payloads(host).at(-1);
    assert.equal(tail.loss.dropped, health.dropped);
    assert(tail.loss.firstSequence <= tail.loss.lastSequence);
    assert.equal(tail.loss.rangeKind, 'envelope');
    assert.equal(tail.events.filter(e => e.priority === 'critical').length, 2);
    await core.dispose();
  });
  test('Critical hard overflow is visible instead of claimed lossless', async () => {
    const { core, host } = await subject();
    for (let i = 0; i < 20; i++) { core.recordFault('oom'); }
    assert(core.getHealth().criticalDropped > 0);
    await core.flush();
    assert.equal(payloads(host).at(-1).loss.criticalDropped, core.getHealth().criticalDropped);
    await core.dispose();
  });
  test('failed file writes retain the bounded batch and only explicit flush retries', async () => {
    const { core, host } = await subject();
    host.storageFailure = true; core.recordFault('crash');
    const failed = await core.flush(); assert.equal(failed.code, 'STORAGE_DEGRADED');
    const attempts = host.appends; core.getHealth(); core.getHealth();
    assert.equal(host.appends, attempts); assert.equal(core.getHealth().pendingRecords, 1);
    assert(!JSON.stringify(core.getHealth()).includes('exception'));
    host.storageFailure = false; await core.flush();
    assert.equal(core.getHealth().pendingRecords, 0);
    assert(payloads(host).flatMap(p => p.events).some(e => e.name === 'crash'));
    await core.dispose();
  });
  test('in-flight ownership survives timeout and cannot duplicate append or claim a durable close', async () => {
    const { core, host } = await subject({ closeTimeoutMs: 10 });
    host.pending = deferred(); core.recordFault('crash');
    const first = core.flush(); await Promise.resolve();
    const attempts = host.appends;
    const close = await core.stopNormally();
    assert.equal(close.code, 'CLOSE_UNCERTAIN');
    assert.equal(core.getHealth().state, 'close_uncertain');
    assert(core.getHealth().pendingRecords > 0);
    await core.stopNormally(); assert.equal(host.appends, attempts);
    host.pending.resolve(); await first;
    assert.equal(core.getHealth().state, 'close_uncertain');
    assert.equal((await core.dispose()).code, 'CLOSE_UNCERTAIN');
  });
  test('healthy normal close syncs a checksummed close marker', async () => {
    const { core, host } = await subject();
    core.mark('test.mark', { result: 'ok' });
    assert.equal((await core.stopNormally()).code, 'CLOSED');
    assert.equal(core.getHealth().durability, 'host-reported-synced');
    const envelope = JSON.parse(host.segmentTexts.at(-1));
    assert.equal(envelope.sha256, host.hash(envelope.payload));
    assert.equal(envelope.bytes, host.byteLength(envelope.payload));
    assert.equal(JSON.parse(envelope.payload).events.at(-1).name, 'close');
    assert.equal(core.mark('test.mark', {}).code, 'NOT_ACTIVE');
  });
  test('backward clocks permanently stop recording and never revive after recovery', async () => {
    const { core, host } = await subject();
    host.tick -= 1; assert.equal(core.mark('test.mark', {}).code, 'CLOCK_INVALID');
    host.tick += 10; core.resume();
    assert.equal(core.recordFault('crash').code, 'CLOCK_INVALID');
    assert.equal(core.getHealth().clockValid, false);
    await core.dispose();
  });
  test('unclosed prior session is uncertain exit without an invented Crash diagnosis', async () => {
    const { core, host } = await subject();
    core.mark('test.mark', {}); await core.flush();
    const history = host.segmentTexts.slice(); await core.dispose();
    const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'recovery-')));
    nextHost.history = history;
    const next = new OHMateCore(nextHost); subjects.push({ core: next, host: nextHost });
    assert.equal(next.registerSchema({ name: 'test.mark', fields: [
      { key: 'count', kind: 'number', minimum: 0, maximum: 100 },
    ] }).code, 'REGISTERED');
    await next.start(options());
    assert.equal(next.getHealth().recovery, 'uncertain-exit');
    assert.equal(next.getHealth().recoveredFault, 'unknown');
    await next.dispose();
  });
  test('corrupt prior segment is rejected without preventing startup or leaking its content', async () => {
    const host = new FileHost(await mkdtemp(path.join(temporary, 'corrupt-')));
    host.history = ['private corrupt contents'];
    const core = new OHMateCore(host); assert.equal((await core.start(options())).code, 'STARTED');
    assert.equal(core.getHealth().recovery, 'corrupt');
    assert(!JSON.stringify(core.getHealth()).includes('private'));
    await core.dispose();
  });
  test('problem snapshot is bounded, immutable, local and manual-only without authenticated build', async () => {
    const { core, host } = await subject({ buildId: 'declared-build' });
    core.mark('test.mark', { count: 1 }); await core.flush();
    const problem = await core.createProblem();
    assert.equal(problem.code, 'PROBLEM_CREATED');
    const exported = core.exportProblem(problem.problemId);
    assert.equal(exported.code, 'EXPORT_REVIEW_REQUIRED');
    const reviewed = core.reviewExport(problem.problemId);
    assert.equal(core.exportProblem(problem.problemId, 'wrong').code, 'EXPORT_REVIEW_REQUIRED');
    const saved = core.exportProblem(problem.problemId, reviewed.reviewHash);
    assert.equal(saved.code, 'EXPORTED');
    const document = JSON.parse(saved.text);
    assert.equal(document.buildVerification, 'unverified-build');
    assert.equal(document.replay, 'manual-only'); assert.equal(document.attachments.length, 0);
    assert.equal(document.events.find(e => e.name === 'test.mark').fields.count, 1);
    core.mark('test.mark', { count: 2 });
    assert.equal(core.exportProblem(problem.problemId, reviewed.reviewHash).text, saved.text);
    assert.equal(await readFile(path.join(host.directory, `${problem.problemId}.json`), 'utf8'), saved.text);
    await core.dispose();
  });
  test('problem quota cannot silently evict existing problems or revive deleted export reviews', async () => {
    const { core } = await subject({ maxProblems: 2 });
    const a = await core.createProblem(), b = await core.createProblem();
    assert.equal((await core.createProblem()).code, 'PROBLEM_QUOTA');
    assert.equal(core.listProblems().length, 2);
    const review = core.reviewExport(a.problemId);
    assert.equal((await core.deleteProblem(a.problemId)).code, 'PROBLEM_DELETED');
    assert.equal(core.exportProblem(a.problemId, review.reviewHash).code, 'PROBLEM_NOT_FOUND');
    assert.equal(core.getProblem(b.problemId).problemId, b.problemId);
    await core.dispose();
  });
  test('invalid budgets fail before any storage effects and do not start timers', async () => {
    for (const change of [{ maxRecords: 1 }, { sampling: NaN }, { maxBufferBytes: 0 },
      { maxStorageBytes: 5242881 }, { maxProblems: 21 }, { retentionDays: 8 },
      { criticalReserveRecords: 9 }, { closeTimeoutMs: Infinity }]) {
      const host = new FileHost(temporary), core = new OHMateCore(host);
      assert.equal((await core.start(options(change))).code, 'OPTIONS_INVALID');
      assert.equal(host.appends, 0);
      await core.dispose();
    }
  });
  test('dispose during delayed startup prevents late lease writes and timer revival', async () => {
    const host = new FileHost(await mkdtemp(path.join(temporary, 'delayed-')));
    host.recoverPending = deferred();
    const core = new OHMateCore(host); subjects.push({ core, host });
    const started = core.start(options());
    assert.equal((await core.dispose()).code, 'START_CANCELLED');
    host.recoverPending.resolve();
    assert.equal((await started).code, 'START_CANCELLED');
    assert.equal(host.appends, 0);
    assert.equal(core.getHealth().state, 'disposed');
    assert.equal((await core.start(options())).code, 'DISPOSED');
  });
  test('same semantic options are idempotent regardless of property insertion order', async () => {
    const { core } = await subject();
    const reordered = Object.fromEntries(Object.entries(options()).reverse());
    assert.equal((await core.start(reordered)).code, 'ALREADY_STARTED');
    await core.dispose();
  });
  test('unknown or sensitive option keys are rejected before any storage or hashing', async () => {
    const host = new FileHost(temporary), core = new OHMateCore(host);
    subjects.push({ core, host });
    assert.equal((await core.start(options({ token: 'private-token' }))).code, 'OPTIONS_INVALID');
    assert.equal(host.appends, 0);
  });
  test('pending native batch and ring share the same record and byte budget', async () => {
    const { core, host } = await subject();
    host.pending = deferred(); core.recordFault('crash');
    const pending = core.flush();
    for (let i = 0; i < 100; i++) { core.recordFault('oom'); }
    const health = core.getHealth();
    assert(health.bufferRecords + health.pendingRecords <= 8);
    assert(health.bufferBytes + health.pendingBytes <= 8192);
    const attempts = host.appends;
    const duplicate = core.flush(); assert.equal(duplicate, pending); assert.equal(host.appends, attempts);
    host.pending.resolve(); await duplicate; await core.dispose();
  });
  test('pause and resume cannot mutate state after clock drift', async () => {
    const { core, host } = await subject();
    host.tick -= 1;
    assert.equal(core.pause().code, 'CLOCK_INVALID');
    assert.equal(core.resume().code, 'CLOCK_INVALID');
    assert.equal(core.getHealth().state, 'active');
    await core.dispose();
  });
  test('recovery rejects self-checksummed forged close events with invalid fields or ordering', async () => {
    const { core, host } = await subject();
    await core.stopNormally();
    const envelope = JSON.parse(host.segmentTexts.at(-1)), segment = JSON.parse(envelope.payload);
    const variants = [
      p => { p.events.at(-1).source = 'forged'; },
      p => { p.events.at(-1).sequence = -1; },
      p => { p.events.at(-1).clock.monotonicNs = 'private'; },
      p => { p.events.at(-1).fields = { token: 'private-token' }; },
      p => { p.lastSequence += 1; },
      p => { p.events.push(p.events.at(-1)); },
    ];
    for (const mutate of variants) {
      const altered = structuredClone(segment); mutate(altered);
      const payload = JSON.stringify(altered);
      const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'invalid-close-')));
      nextHost.history = [JSON.stringify({ schemaVersion: '1.0', bytes: nextHost.byteLength(payload),
        sha256: nextHost.hash(payload), payload })];
      const next = new OHMateCore(nextHost); subjects.push({ core: next, host: nextHost });
      await next.start(options());
      assert.equal(next.getHealth().recovery, 'corrupt');
      await next.dispose();
    }
  });
  test('problem and health getters return detached data that cannot change export content', async () => {
    const { core } = await subject();
    core.mark('test.mark', { result: 'ok' });
    const result = await core.createProblem(), review = core.reviewExport(result.problemId);
    const original = core.exportProblem(result.problemId, review.reviewHash).text;
    const problem = core.getProblem(result.problemId), health = core.getHealth(), list = core.listProblems();
    problem.events[0].fields.token = 'private'; list[0].buildVerification = 'certified'; health.state = 'closed';
    assert.equal(core.exportProblem(result.problemId, review.reviewHash).text, original);
    assert.equal(core.getHealth().state, 'active');
    await core.dispose();
  });
  test('valid persisted problems recover after restart and require a fresh export review', async () => {
    const { core, host } = await subject();
    core.recordFault('freeze');
    const made = await core.createProblem();
    await core.dispose();
    const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'problem-restart-')));
    nextHost.savedProblems = host.problemTexts;
    const next = new OHMateCore(nextHost); subjects.push({ core: next, host: nextHost });
    await next.start(options());
    assert.equal(next.listProblems().length, 1);
    assert.equal(next.getProblem(made.problemId).triage.fault, 'freeze');
    assert.equal(next.exportProblem(made.problemId).code, 'EXPORT_REVIEW_REQUIRED');
    assert.equal(next.getHealth().problemRecovery, 'recovered');
    await next.dispose();
  });
  test('problem recovery rejects unregistered schemas, private fields and forged triage', async () => {
    const { core, host } = await subject();
    core.mark('test.mark', { result: 'ok' });
    await core.createProblem(); await core.dispose();
    const original = JSON.parse(host.problemTexts[0]);
    const variants = [
      p => { p.events.at(-1).fields.token = 'private-token'; },
      p => { p.triage.confidence = 'certain'; },
      p => { p.attachments = ['../../private-file']; },
      p => { p.loss.criticalDropped = -1; },
      p => { p.problemId = '../escape'; },
    ];
    for (const mutate of variants) {
      const p = structuredClone(original); mutate(p);
      const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'problem-invalid-')));
      nextHost.savedProblems = [JSON.stringify(p)];
      const next = new OHMateCore(nextHost); subjects.push({ core: next, host: nextHost });
      await next.start(options());
      assert.equal(next.listProblems().length, 0);
      assert.equal(next.getHealth().problemRecovery, 'corrupt');
      await next.dispose();
    }
  });
  test('uncertain problem writes retain quota and never become exportable in the same session', async () => {
    const { core, host } = await subject({ maxProblems: 1 });
    host.problemOutcome = 'uncertain';
    const made = await core.createProblem();
    assert.equal(made.code, 'PROBLEM_DURABILITY_UNCERTAIN');
    assert.equal(core.listProblems().length, 0);
    assert.equal((await core.createProblem()).code, 'PROBLEM_QUOTA');
    assert.equal(host.problemTexts.length, 1);
    assert(core.getHealth().problemBytes > 0);
    await core.dispose();
  });
  test('heartbeat maintenance prunes only after an idle interval and cannot revive after disposal', async () => {
    const { core, host } = await subject();
    const made = await core.createProblem(), timer = [...intervalOwners.values()].at(-1);
    let entered;
    const pruned = new Promise(resolve => { entered = resolve; });
    host.prune = async () => {
      entered(); return { code:'PRUNED', segmentBytes:0, deletedProblems:[made.problemId] };
    };
    try {
      assert.equal(timer.delay, 60000);
      timer.callback();
      await Promise.race([pruned, new Promise((_, reject) => {
        const timeout = nativeSetInterval(() => { clearInterval(timeout); reject(Error('idle maintenance not entered')); }, 500);
        pruned.then(() => clearInterval(timeout));
      })]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(core.getProblem(made.problemId), undefined);
      assert.equal(core.getHealth().problemBytes, 0);
      await core.dispose();
      const appends = host.appends;
      timer.callback(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(host.appends, appends);
    } finally { await core.dispose(); }
  });
  test('summary export cannot renew approval during prune or after disposal', async () => {
    const { core, host } = await subject(), made = await core.createProblem();
    const review = core.reviewExport(made.problemId), gate = deferred();
    host.prune = async () => {
      await gate.promise; return { code:'PRUNED', segmentBytes:0, deletedProblems:[] };
    };
    const operation = core.prune();
    try {
      assert.equal(core.reviewExport(made.problemId).code, 'EXPORT_UNAVAILABLE');
      assert.equal(core.exportProblem(made.problemId, review.reviewHash).code, 'EXPORT_UNAVAILABLE');
    } finally { gate.resolve(); await operation; }
    const next = core.reviewExport(made.problemId);
    assert.equal(next.code, 'EXPORT_REVIEWED');
    await core.dispose();
    assert.equal(core.reviewExport(made.problemId).code, 'EXPORT_UNAVAILABLE');
    assert.equal(core.exportProblem(made.problemId, next.reviewHash).code, 'EXPORT_UNAVAILABLE');
  });
  test('late problem completion after disposal cannot publish a problem or erase its reserved bytes', async () => {
    const { core, host } = await subject();
    host.problemPending = deferred();
    const made = core.createProblem();
    await core.dispose();
    const reserved = core.getHealth().problemBytes;
    host.problemPending.resolve();
    assert.equal((await made).code, 'PROBLEM_CANCELLED');
    assert.equal(core.listProblems().length, 0);
    assert.equal(core.getHealth().problemBytes, reserved);
  });
  test('problem creation reserves against an in-flight segment before native commit', async () => {
    const { core, host } = await subject({ maxStorageBytes: 65536 });
    host.byteLength = text => Buffer.byteLength(text) + (text.includes('"payload":') ? 32000 : 0);
    core.recordFault('crash'); host.pending = deferred();
    const flush = core.flush();
    assert.equal((await core.createProblem()).code, 'STORAGE_QUOTA');
    assert.equal(host.problemTexts.length, 0);
    host.pending.resolve(); await flush; await core.dispose();
  });
  test('failed native segment completion keeps its disk reservation until explicit reconciliation', async () => {
    const { core, host } = await subject({ maxStorageBytes:65536 });
    host.byteLength = text => Buffer.byteLength(text) + (text.includes('"payload":') ? 32000 : 0);
    host.storageFailure = true; core.recordFault('crash');
    assert.equal((await core.flush()).code, 'STORAGE_DEGRADED');
    assert.equal((await core.createProblem()).code, 'STORAGE_QUOTA');
    assert.equal(host.problemTexts.length, 0);
    host.storageFailure = false; await core.flush(); await core.dispose();
  });
  test('closed sessions cannot conceal other uncertain exits or reset another session sequence', async () => {
    const { core, host } = await subject();
    // Capture the active-only segment before dispose extends it with the close marker.
    const active = host.segmentTexts[0]; await core.dispose();
    const closed = host.segmentTexts.at(-1);
    const envelope = JSON.parse(active), segment = JSON.parse(envelope.payload);
    segment.sessionId = 'other-session'; segment.events.forEach(event => { event.sessionId = 'other-session'; });
    const payload = JSON.stringify(segment);
    const other = JSON.stringify({ schemaVersion:'1.0', bytes:host.byteLength(payload), sha256:host.hash(payload), payload });
    const cases = [
      { history:[other, ...host.segmentTexts], expected:'uncertain-exit' },
      { history:[...host.segmentTexts, other], expected:'uncertain-exit' },
      { history:[closed, other, closed], expected:'corrupt' },
    ];
    for (const { history, expected } of cases) {
      const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'multi-session-'))); nextHost.history = history;
      const next = new OHMateCore(nextHost); subjects.push({ core:next, host:nextHost }); await next.start(options());
      assert.equal(next.getHealth().recovery, expected);
      await next.dispose();
    }
  });
  test('recovery rejects forged loss summaries even with valid checksums', async () => {
    const { core, host } = await subject(); await core.dispose();
    const segment = JSON.parse(JSON.parse(host.segmentTexts[0]).payload); segment.loss.criticalDropped = 999;
    const payload = JSON.stringify(segment);
    const nextHost = new FileHost(await mkdtemp(path.join(temporary, 'loss-invalid-')));
    nextHost.history = [JSON.stringify({ schemaVersion:'1.0', bytes:host.byteLength(payload), sha256:host.hash(payload), payload })];
    const next = new OHMateCore(nextHost); subjects.push({ core:next, host:nextHost }); await next.start(options());
    assert.equal(next.getHealth().recovery, 'corrupt'); await next.dispose();
  });
}
