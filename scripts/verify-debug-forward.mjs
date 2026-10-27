/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { on, once } from 'node:events';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm2-hdc-forward-built';
assert.match(label, /^[a-z0-9-]+$/);
const root = await mkdtemp('/private/tmp/ohmate-hdc-validation-'), home = join(root, 'home');
const studio = join(root, 'Fixture-Studio.app'), content = join(studio, 'Contents'), data = join(root, 'data');
const rules = join(root, 'rules'), calls = join(root, 'commands'), serial = 'owned-fixture-device';
const output = resolve('artifacts/validation', label);
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, OHMATE_DATA_DIR: data,
  DEVECO_CLI_STUDIO_PATH: studio, NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 40_000 });
  assert(!result.error, result.error?.message); return result;
}
function cli(args, expected = 0) {
  const result = run(process.execPath, [bin, ...args, '--format', 'json']);
  assert.equal(result.status, expected); return JSON.parse(result.stdout);
}
function pair(args, expected = 0) {
  const program = `import os,pty,select,subprocess,sys,time,json,errno
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
data=b''
deadline=time.monotonic()+35
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   if not chunk: break
   data+=chunk
  elif p.poll() is not None: break
 if p.poll() is None: p.wait(timeout=2)
 print(json.dumps({'exit':p.returncode,'text':data.decode()}))
finally:
 if p.poll() is None: p.kill(); p.wait()
 os.close(master)`;
  const result = run('python3', ['-c', program, process.execPath, bin, ...args]);
  assert.equal(result.status, 0);
  const capture = JSON.parse(result.stdout); assert.equal(capture.exit, expected);
  return capture.text.split(/\r?\n/).find((line) => line.startsWith('{"endpoint":'));
}
async function textFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? textFiles(join(path, entry.name)) :
    readFile(join(path, entry.name), 'utf8')))).join('');
}
async function waitForReleased(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const record = cli(['debug', 'show', id]).data;
    if (record.bridge.hdcForward?.state === 'released') { return record; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Forward cleanup was not observed');
}
async function fixture() {
  await mkdir(home, { mode: 0o700 });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  for (const path of ['Info.plist', 'tools/node/bin/node', 'tools/ohpm/bin/pm-cli.js', 'tools/hvigor/bin/hvigorw.js']) {
    const file = join(content, path); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, 'fixture');
  }
  const hdc = join(content, 'sdk/default/openharmony/toolchains/hdc');
  await mkdir(resolve(hdc, '..'), { recursive: true });
  await writeFile(rules, 'other-fixture tcp:12345 tcp:12345 [Reverse]\n');
  await writeFile(hdc, `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2), table=${JSON.stringify(rules)}, log=${JSON.stringify(calls)};
appendFileSync(log,JSON.stringify(args)+'\\n');
if(args.join(' ')==='list targets') { console.log('${serial}\\nother-fixture\\nunauthorized-fixture unauthorized'); }
else if(args.join(' ')==='fport ls') { console.log(readFileSync(table,'utf8')); }
else if(args[0]==='-t' && args[1]==='${serial}' && args[2]==='rport') {
 appendFileSync(table,args[1]+' '+args[3]+' '+args[4]+' [Reverse]\\n'); console.log('OK');
} else if(args[0]==='-t' && args[1]==='${serial}' && args[2]==='fport' && args[3]==='rm') {
 const row=args[1]+' '+args[4]+' '+args[5]+' [Reverse]';
 writeFileSync(table,readFileSync(table,'utf8').split('\\n').filter(line=>line!==row).join('\\n')); console.log('OK');
} else { process.exitCode=1; }
`, { mode: 0o700 });
}

let started = false, ws, channel, frames;
try {
  await fixture(); await mkdir(output, { recursive: true });
  const first = cli(['debug', 'start']); started = true;
  const args = ['debug', 'pair', '--buildId', 'fixture-build-unverified', '--device', 'opaque-fixture-device',
    '--process', 'fixture-process', '--sessionId', 'fixture-recorder', '--hdc-device', serial];
  assert.equal(cli(args, 5).data.code, 'PRIVATE_TTY_REQUIRED');
  assert.equal(pair([...args.slice(0, -1), 'absent-fixture'], 4), undefined);
  const envelope = JSON.parse(pair(args)), invitation = envelope.invitation;
  const status = cli(['debug', 'show', first.data.debugSession.id]).data;
  assert.equal(status.bridge.hdcForward.state, 'active');
  assert.equal(status.bridge.hdcForward.authentication, 'unverified');
  assert.equal(status.bridge.hdcForward.port, Number(new URL(envelope.endpoint).port));
  assert(!JSON.stringify(status).includes(serial));
  const require = createRequire(bin), runtimePath = require.resolve('@ohmate/cli-common');
  const api = await import(pathToFileURL(runtimePath).href);
  const { default: WebSocket } = await import(pathToFileURL(createRequire(runtimePath).resolve('ws')).href);
  const client = api.createPairingClient(invitation, { appConfirmed: true });
  ws = new WebSocket(envelope.endpoint, 'ohmate-readonly-v1'); frames = on(ws, 'message');
  await once(ws, 'open');
  const next = async () => JSON.parse((await frames.next()).value[0].toString());
  ws.send(JSON.stringify(client.request())); channel = client.finish(await next());
  const ready = channel.open(await next());
  ws.send(JSON.stringify(channel.seal(ready))); assert.equal(channel.open(await next()).type, 'connected');
  ws.close(); await once(ws, 'close'); await frames.return(); frames = undefined;
  const disconnected = await waitForReleased(first.data.debugSession.id);
  assert.equal(disconnected.bridge.state, 'disconnected');
  JSON.parse(pair(args));
  cli(['debug', 'stop']); started = false;
  assert.equal((await readFile(rules, 'utf8')).trim(), 'other-fixture tcp:12345 tcp:12345 [Reverse]');
  assert(!(await textFiles(data)).includes(invitation.oneTimeCode));
  const observed = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(observed.filter((args) => args.includes('rport')).length, 2);
  assert.equal(observed.filter((args) => args.includes('rm')).length, 2);
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', entry: bin, root,
    privateTty: true, fakeHdcOwnershipAndCleanup: true, unrelatedMappingRetained: true,
    encryptedNodeHandshake: true, actualDevice: false, arktsProducer: false, buildVerification: 'unverified',
    deviceProvenance: 'peer-asserted', commands: observed }, null, 2));
} finally {
  ws?.terminate(); await frames?.return(); channel?.close();
  if (started) { cli(['debug', 'stop']); }
}
