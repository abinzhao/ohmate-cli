/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual portable ETS → real ZIP → CLI verifier, with private files. No device claims.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { verifyProblemPackage, problemHash } from '../packages/cli/src/problem-package/package.ts';
import { storedProblemZip, readProblemZip } from '../packages/cli/src/problem-package/zip.ts';
import { importProblem, readProblem } from '../packages/cli/src/problem-package/service.ts';

const temporary = await mkdtemp(path.join(tmpdir(), 'ohmate-core-archive-'));
const owners = [];
after(async () => {
  for (const owner of owners) await owner.core.dispose();
  await rm(temporary, { recursive:true, force:true });
});
const entry = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/core.ets', import.meta.url));
await build({ entryPoints:[entry], outfile:path.join(temporary,'core.mjs'), bundle:true,
  platform:'node', format:'esm', loader:{ '.ets':'ts' }, resolveExtensions:['.ets','.ts','.js'] });
const { OHMateCore, CoreOptions } = await import(pathToFileURL(path.join(temporary,'core.mjs')));
async function subject() {
  const directory = await mkdtemp(path.join(temporary,'subject-'));
  const host = {
    hash:text => createHash('sha256').update(text).digest('hex'),
    hashBytes:bytes => createHash('sha256').update(bytes).digest('hex'),
    byteLength:text => Buffer.byteLength(text),
    monotonicNs:1000,
    now:function() { return { clockId:'test-clock', bootId:'test-session', monotonicNs:this.monotonicNs,
      wallTimeUtc:'2026-10-25T00:00:00.000Z' }; },
    random:() => 0, sessionId:() => 'test-session',
    recover:async () => [], recoverProblems:async () => [],
    append:async () => 'synced', outcome:'synced',
    saveProblem:async function(id,text) {
      const file = await open(path.join(directory,id+'.json'),'wx',0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      return this.outcome;
    },
    deleteProblem:async id => { await rm(path.join(directory,id+'.json')); return true; },
  };
  const core = new OHMateCore(host); owners.push({ core,host });
  assert.equal(core.registerSchema({ name:'test.event', fields:[
    { key:'result', kind:'enum', values:['ok','failed'] },
    { key:'count', kind:'number', minimum:0, maximum:100 },
  ] }).code,'REGISTERED');
  await core.start(Object.assign(new CoreOptions(),{ sampling:1,flushIntervalMs:60000,buildId:'declared-build' }));
  core.mark('test.event',{ result:'ok',count:5,token:'private-token',body:'private-body' });
  core.recordFault('freeze');
  const made = await core.createProblem();
  return { core,host,directory,id:made.problemId };
}
function reviewed(core,id) {
  assert.equal(typeof core.reviewArchive,'function','independent Core must expose archive review');
  assert.equal(typeof core.exportArchive,'function','independent Core must expose reviewed ZIP bytes');
  const review = core.reviewArchive(id);
  assert.equal(review.code,'ARCHIVE_REVIEWED');
  return { review,output:core.exportArchive(id,review.reviewHash) };
}
function changed(bytes,mutate) {
  const files = new Map([...readProblemZip(Buffer.from(bytes))].map(([name,file]) => [name,file.read()]));
  const manifest = JSON.parse(files.get('manifest.json'));
  const document = JSON.parse(files.get('core-summary.json'));
  mutate(document,manifest,files);
  files.set('core-summary.json',Buffer.from(JSON.stringify(document)));
  manifest.files = manifest.files.map(file => ({ ...file,size:files.get(file.path).length,sha256:problemHash(files.get(file.path)) }));
  files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));
  return storedProblemZip(files);
}
test('Core review describes the exact ZIP and full readonly evidence survives unzip and CLI import',async () => {
  const { core,id,directory } = await subject();
  const { review,output } = reviewed(core,id);
  assert.equal(output.code,'ARCHIVE_EXPORTED');
  const bytes = Buffer.from(output.archive), preview = JSON.parse(review.text);
  assert.equal(bytes.readUInt32LE(),0x04034b50);
  assert.equal(output.fileName,id+'.ohmate-problem.zip');
  assert.equal(problemHash(bytes),review.reviewHash);
  assert.equal(preview.archiveBytes,bytes.length);
  assert.equal(preview.attachments,'none');
  assert(preview.retainedRisks.includes('unverified-build'));
  assert.equal(preview.replay,'manual-only');
  const result = verifyProblemPackage(bytes);
  assert.equal(result.payloadIntegrity,'verified');
  assert.equal(result.manifest.content,'core-readonly');
  assert.equal(result.core.summary.triage.fault,'freeze');
  assert.equal(result.core.summary.buildVerification,'unverified-build');
  assert.equal(result.core.summary.events.find(event => event.name==='test.event').fields.count,5);
  for (const secret of ['private-token','private-body']) assert(!bytes.includes(Buffer.from(secret)));
  const zip = path.join(directory,output.fileName);
  await writeFile(zip,bytes,{ flag:'wx',mode:0o600 });
  const unpacked = path.join(directory,'unpacked');
  await promisify(execFile)('/usr/bin/unzip',['-t',zip],{ env:{ PATH:'/usr/bin:/bin' } });
  await promisify(execFile)('/usr/bin/unzip',['-q',zip,'-d',unpacked],{ env:{ PATH:'/usr/bin:/bin' } });
  const manifest = JSON.parse(await readFile(path.join(unpacked,'manifest.json'),'utf8'));
  for (const file of manifest.files) {
    const actual = await readFile(path.join(unpacked,file.path));
    assert.equal(actual.length,file.size); assert.equal(problemHash(actual),file.sha256);
  }
  const context = { cwd:directory,abortSignal:new AbortController().signal };
  const imported = await importProblem({ path:zip },context);
  assert.equal(imported.exitCode,0); assert.equal(imported.data.access,'read-only');
  assert.equal(imported.data.count,result.core.summary.events.length);
  const opened = await readProblem({ path:zip },context);
  assert.equal(opened.data.core.summary.problemId,id);
  await core.dispose();
});
test('ZIP review cannot be replaced by summary review or survive deletion',async () => {
  const { core,id } = await subject();
  const summary = core.reviewExport(id);
  assert.equal(typeof core.exportArchive,'function','Core must implement independent archive review');
  assert.equal(core.exportArchive(id,summary.reviewHash).code,'EXPORT_REVIEW_REQUIRED');
  const { review,output } = reviewed(core,id);
  assert.equal(output.code,'ARCHIVE_EXPORTED');
  output.archive[0]=0;
  assert.equal(problemHash(Buffer.from(core.exportArchive(id,review.reviewHash).archive)),review.reviewHash);
  await core.deleteProblem(id);
  assert.equal(core.exportArchive(id,review.reviewHash).code,'PROBLEM_NOT_FOUND');
});
test('CLI rejects checksum-valid Core packages with private fields, false diagnosis, ordering or provenance',async () => {
  const { core,id } = await subject(), { output } = reviewed(core,id);
  for (const mutate of [
    value => { value.summary.events.find(event => event.name==='test.event').fields.token='private'; },
    value => { value.summary.triage.confidence='certain'; },
    value => { value.summary.buildVerification='verified'; },
    value => { value.summary.events[1].sequence=value.summary.events[0].sequence; },
    value => { value.summary.loss.criticalDropped=1000; },
    value => { value.schemas[0].fields[0].key='password'; },
    value => { value.summary.attachments=['../../private']; },
    (value,manifest) => { manifest.problemId='problem-wrong'; },
    value => { value.authentication='verified'; },
  ]) assert.throws(() => verifyProblemPackage(changed(output.archive,mutate)));
});
test('Core archives reject missing files, hash changes and weakened embedded schemas',async () => {
  const { core,id } = await subject(), { output } = reviewed(core,id);
  for (const mutate of [
    (value,manifest,files) => { files.set('schemas/core-summary.schema.json',Buffer.from('{}')); },
    (value,manifest,files) => { files.set('unexpected.json',Buffer.from('{}')); },
  ]) assert.throws(() => verifyProblemPackage(changed(output.archive,mutate)));
  const files = new Map([...readProblemZip(Buffer.from(output.archive))].map(([name,file]) => [name,file.read()]));
  files.set('core-summary.json',Buffer.from('{}'));
  assert.throws(() => verifyProblemPackage(storedProblemZip(files)),'checksum changes must be rejected');
});
test('same-major Core minor additions preserve known evidence and report omitted fields',async () => {
  const { core,id } = await subject(), { output } = reviewed(core,id);
  const bytes = changed(output.archive,(value,manifest,files) => {
    manifest.schemaVersion='1.9'; manifest.futureNote='OMITTED_MINOR_NOTE';
    value.summary.futureNote='OMITTED_MINOR_NOTE';
    value.summary.events[0].futureNote='OMITTED_MINOR_NOTE';
    for (const name of ['schemas/manifest.schema.json','schemas/core-summary.schema.json']) {
      const schema = JSON.parse(files.get(name));
      if (name.includes('core-summary')) {
        schema.properties.summary.properties.futureNote={ type:'string' };
        schema.properties.summary.properties.events.items.properties.futureNote={ type:'string' };
      } else schema.properties.futureNote={ type:'string' };
      files.set(name,Buffer.from(JSON.stringify(schema)));
    }
  });
  const result=verifyProblemPackage(bytes);
  assert.equal(result.compatibility,'compatible');
  assert.equal(result.fieldCoverage,'known-fields-only'); assert.equal(result.ignoredFields,3);
  assert.equal(result.core.summary.triage.fault,'freeze');
  assert(!JSON.stringify(result).includes('OMITTED_MINOR_NOTE'));
  for (const mutate of [
    value => { value.summary.authentication='verified'; },
    value => { value.summary.events[0].password='private'; },
    (value,manifest) => { manifest.buildVerification='verified'; },
    (value,manifest,files) => {
      const schema=JSON.parse(files.get('schemas/core-summary.schema.json'));
      schema.properties.summary.properties.buildVerification.const='verified';
      files.set('schemas/core-summary.schema.json',Buffer.from(JSON.stringify(schema)));
    },
  ]) assert.throws(() => verifyProblemPackage(changed(bytes,mutate)), 'minor projection must not erase private or authentication claims');
  const future=verifyProblemPackage(changed(output.archive,(value,manifest) => { manifest.schemaVersion='2.0'; }));
  assert.equal(future.compatibility,'manifest-only'); assert.equal(future.core,undefined);
});
test('uncertain stored problems cannot produce a ZIP or export review',async () => {
  const { core,host } = await subject();
  host.outcome='uncertain';
  const uncertain = await core.createProblem();
  assert.equal(uncertain.code,'PROBLEM_DURABILITY_UNCERTAIN');
  assert.equal(typeof core.reviewArchive,'function','Core must gate archive review by durability');
  const guessed = 'problem-test-session-2';
  assert.equal(core.reviewArchive(guessed).code,'PROBLEM_NOT_FOUND');
  assert.equal(core.exportArchive(guessed,'0'.repeat(64)).code,'PROBLEM_NOT_FOUND');
});
test('byte hashing is mandatory and a changed hash implementation invalidates approval',async () => {
  const { core,host,id } = await subject(), hash = host.hashBytes;
  host.hashBytes=undefined;
  assert.equal(core.reviewArchive(id).code,'ARCHIVE_UNAVAILABLE');
  host.hashBytes=hash;
  const { review } = reviewed(core,id);
  host.hashBytes=() => '0'.repeat(64);
  assert.equal(core.exportArchive(id,review.reviewHash).code,'EXPORT_REVIEW_REQUIRED');
  host.hashBytes=hash;
  assert.equal(core.exportArchive(id,review.reviewHash).code,'EXPORT_REVIEW_REQUIRED');
});
test('clock invalidation, prune and disposal revoke existing ZIP reviews',async () => {
  const first = await subject(), { review } = reviewed(first.core,first.id);
  first.host.monotonicNs=999;
  assert.equal(first.core.exportArchive(first.id,review.reviewHash).code,'ARCHIVE_UNAVAILABLE');
  const next = await subject(), approval = reviewed(next.core,next.id).review;
  next.host.prune=async () => ({ code:'PRUNED',segmentBytes:0,deletedProblems:[] });
  assert.equal((await next.core.prune()).code,'PRUNED');
  assert.equal(next.core.exportArchive(next.id,approval.reviewHash).code,'EXPORT_REVIEW_REQUIRED');
  const final = reviewed(next.core,next.id).review;
  await next.core.dispose();
  assert.equal(next.core.exportArchive(next.id,final.reviewHash).code,'ARCHIVE_UNAVAILABLE');
});
test('export revalidates saved fields and never exports corrupt evidence after review',async () => {
  const { core,id } = await subject(), { review } = reviewed(core,id);
  const stored = core.problems.records.find(record => record.problem.problemId===id);
  const value = JSON.parse(stored.text);
  value.events.find(event => event.name==='test.event').fields.password='private';
  stored.text=JSON.stringify(value);
  assert.equal(core.exportArchive(id,review.reviewHash).code,'ARCHIVE_UNAVAILABLE');
  assert.equal(core.reviewArchive(id).code,'ARCHIVE_UNAVAILABLE');
});
if (process.argv.includes('--built-cli')) {
  test('fresh built CLI imports and verifies the actual Core ZIP through public commands',async () => {
    const { core,id,directory } = await subject(), { output } = reviewed(core,id);
    const zip = path.join(directory,output.fileName);
    await writeFile(zip,output.archive,{ flag:'wx',mode:0o600 });
    const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js',import.meta.url));
    for (const command of ['import','verify']) {
      const { stdout } = await promisify(execFile)(process.execPath,[cli,'replay',command,
        '--path',zip,'--build-id','declared-build','--format','json','--non-interactive'],
      { cwd:directory,timeout:10000,maxBuffer:262144 });
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.exitCode,0);
      assert.equal(receipt.data.core.summary.problemId,id);
      assert.equal(receipt.data.authentication,'not-restored');
      assert.equal(receipt.data.replay,'not-performed');
    }
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'replay','verify',
      '--path',zip,'--build-id','wrong-build','--format','json'],{ cwd:directory,timeout:10000 }));
    const invalid = changed(output.archive,value => { value.summary.events[0].fields.token='private'; });
    const bad = path.join(directory,'invalid.ohmate-problem.zip');
    await writeFile(bad,invalid,{ flag:'wx',mode:0o600 });
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'replay','import',
      '--path',bad,'--format','json'],{ cwd:directory,timeout:10000 }));
  });
}
