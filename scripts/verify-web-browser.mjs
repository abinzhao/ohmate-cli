/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// agent-browser's command daemon stalled after its first click. This uses its
// test-owned Chrome target directly; no user's Chrome profile or session is used.
const discovery = JSON.parse(await readFile(process.env.OHMATE_BROWSER_DISCOVERY ?? '/tmp/ohmate-web-cdp.json', 'utf8'));
const tab = discovery.tabs.find((tab) => tab.type === 'page' && tab.url.startsWith('http://127.0.0.1:'));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') { errors.push(data.params.exceptionDetails.text); }
  const request = pending.get(data.id);
  if (request) { pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(data.error) : request.resolve(data.result); }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 8000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  const deadline = Date.now() + 8000;
  while (!(await evaluate(expression))) {
    assert.ok(Date.now() < deadline, `Browser condition timed out: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function click(selector) {
  const position = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error("Missing element");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}
async function touch(selector) {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(x,y));})()`);
  const position = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error("Missing element");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.synthesizeTapGesture', { ...position, duration: 50, tapCount: 1, gestureSourceType: 'touch' });
}
async function probeTouch(selector) {
  const position = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error("Missing element");const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const point = { ...position, radiusX: 1, radiusY: 1, force: 1, id: 1 };
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function clickText(text, scope = 'document') {
  return evaluate(`(()=>{const e=[...${scope}.querySelectorAll("button")].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error("Missing button: "+${JSON.stringify(text)});e.click();})()`);
}
async function fill(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event("input",{bubbles:true}));})()`);
}
const touchMode = process.argv.includes('--touch');
const target = process.env.OHMATE_BROWSER_ARTIFACTS ?? (touchMode ? join(tmpdir(), 'ohmate-web-touch') :
  process.argv.includes('--patch') ? 'artifacts/validation/m1-patch-browser' : 'artifacts/validation/m1-web-browser');
await mkdir(target, { recursive: true });
await call('Runtime.enable');
await evaluate('window.__verificationToasts=[];new MutationObserver(()=>{const text=document.getElementById("toast-root")?.textContent;if(text)window.__verificationToasts.push(text);}).observe(document.body,{childList:true,subtree:true})');
const checks = [], record = (name) => checks.push({ name, passed: true });
try {
  if (touchMode) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 3, mobile: true,
    });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await evaluate(`window.__touchEvidence=[];
      addEventListener('touchstart',event=>window.__touchEvidence.push({type:event.type,trusted:event.isTrusted}),true);
      addEventListener('pointerdown',event=>window.__touchEvidence.push({type:event.type,pointerType:event.pointerType,trusted:event.isTrusted}),true);`);
    await wait('!!document.querySelector(".welcome")');
    assert.equal(await evaluate('navigator.maxTouchPoints'), 5);
    await probeTouch('body');

    await touch('#sidebar-toggle');
    await wait('document.body.classList.contains("sidebar-open")');
    assert.equal(await evaluate('document.activeElement?.id'), 'sidebar-close');
    assert.equal(await evaluate('document.querySelector(".main-shell").inert'), true);
    await touch('a[data-nav="apps"]');
    await wait('!!document.querySelector(".collection") && !document.body.classList.contains("sidebar-open")');

    await touch('#sidebar-toggle');
    await touch('a[data-nav="home"]');
    await wait('!!document.querySelector(".welcome")');
    await touch('#files-button');
    await wait('document.getElementById("dialog").open && document.getElementById("dialog-title").textContent==="文件与修改范围"');
    const sheet = await evaluate('(()=>{const r=document.getElementById("dialog").getBoundingClientRect();return {width:r.width,height:r.height};})()');
    assert.deepEqual(sheet, { width: 390, height: 844 });
    await touch('#dialog .modal-head .icon-btn');
    await wait('!document.getElementById("dialog").open');

    await touch('#model-picker');
    await wait('!!document.getElementById("floating-popover")');
    await touch('#floating-popover button');
    await wait('!document.getElementById("floating-popover")');

    await touch('#sidebar-toggle');
    await touch('.history-item');
    await wait('!!document.querySelector(".task-actions")');
    await touch('.task-actions .btn');
    await wait('!document.getElementById("result-panel").hidden');
    await touch('[data-result-tab="证据"]');
    assert.equal(await evaluate('document.querySelector("[data-result-tab=\\"证据\\"]").getAttribute("aria-selected")'), 'true');
    await touch('#result-close');

    await touch('#sidebar-toggle');
    await touch('#settings-button');
    await wait('document.getElementById("dialog").open && document.getElementById("dialog-title").textContent==="设置"');
    await touch('[data-setting="规则"]');
    assert.equal(await evaluate('document.querySelector("[data-setting=\\"规则\\"]").getAttribute("aria-selected")'), 'true');
    await touch('#dialog .modal-head .icon-btn');
    assert.equal(await evaluate('document.getElementById("alert-root").children.length===0'), true);
    await touch('#sidebar-close');

    const evidence = await evaluate('window.__touchEvidence');
    assert.ok(evidence.filter((event) => event.type === 'touchstart' && event.trusted).length >= 12, JSON.stringify(evidence));
    assert.ok(evidence.some((event) => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted),
      JSON.stringify(evidence));
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    assert.deepEqual(errors, []);
    const image = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${target}/touch-mobile.png`, Buffer.from(image.data, 'base64'));
    await writeFile(`${target}/results.json`, JSON.stringify({
      status: 'passed',
      checks: ['trusted CDP touch events', 'drawer focus and inert isolation', 'mobile file sheet',
        'model popover', 'task result tabs', 'settings tabs', '390px containment'],
      touchEvents: evidence.length, trustedTouchStarts: evidence.filter((event) => event.type === 'touchstart' && event.trusted).length,
      pointerType: 'touch', exceptions: errors, devices: 'browser-touch-emulation', physicalTouchscreen: false,
    }, null, 2));
    console.log(JSON.stringify({ status: 'passed', touchEvents: evidence.length, artifacts: target }));
    ws.close();
    process.exit(0);
  }
  if (process.argv.includes('--debug')) {
    await wait('!!document.querySelector(".welcome")');
    const status = await evaluate('(async()=>{const api=await import("/api.js");return api.request("debug/status");})()');
    assert.equal(status.data.debugSession.state, 'serving');
    assert.equal(status.data.debugSession.target, null);
    assert.equal(status.data.debugSession.bridge.reason, 'KIT_TRANSPORT_NOT_IMPLEMENTED');
    const contract = await evaluate('(async()=>{const api=await import("/api.js");return api.request("debug/protocol");})()');
    assert.equal(contract.data.channels.length, 17);
    assert.equal(contract.data.mode, 'readonly');
    await click('#tools-button'); await fill('#tool-search', 'devtools.serve');
    await clickText('devtools serve · R0', 'document.getElementById("dialog")');
    await wait('document.getElementById("dialog-title").textContent==="在终端使用此入口"');
    assert.ok(await evaluate('document.getElementById("dialog").textContent.includes("ohmatecli devtools serve --help")'));
    assert.equal(await evaluate('!!document.getElementById("tool-input")'), false);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      const image = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${target}/debug-${width}.png`, Buffer.from(image.data, 'base64'));
    }
    assert.deepEqual(errors, []);
    await writeFile(`${target}/results.json`, JSON.stringify({ status: 'passed',
      checks: ['shared serving session', 'unpaired target and explicit missing Kit transport', '17-channel read-only contract',
        'compatibility alias requires terminal controls', '1440/390 containment'],
      exceptions: errors, actualKit: false, devices: 'not-operated', models: 'not-contacted' }, null, 2));
    console.log('Shared debug session, read-only contract and terminal-only alias verified in Chrome');
    ws.close(); process.exit(0);
  }
  if (process.argv.includes('--deps')) {
    await wait('!!document.querySelector(".welcome")');
    await click('#app-picker');
    await wait('document.getElementById("dialog").open');
    await evaluate('document.querySelector("#dialog button.choice").click()');
    await click('#tools-button'); await fill('#tool-search', 'deps.sbom');
    await clickText('deps sbom · R0', 'document.getElementById("dialog")');
    await fill('#tool-input', '{"standard":"spdx"}');
    await clickText('选择此本地任务', 'document.getElementById("dialog")');
    await click('#send-button');
    await wait('document.body.innerText.includes("工具执行成功")');
    await clickText('查看成果与依据');
    await wait('!document.getElementById("result-panel").hidden');
    const text = await evaluate('document.getElementById("result-body").innerText');
    assert.ok(text.includes('SPDX-2.3') && text.includes('browser-fixture') && text.includes('not-run'), text);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      const image = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${target}/deps-${width}.png`, Buffer.from(image.data, 'base64'));
    }
    assert.deepEqual(errors, []);
    await writeFile(`${target}/results.json`, JSON.stringify({ status: 'passed',
      checks: ['registered project selected', 'registry dependency tool selected', 'actual background SPDX task',
        'source-backed result with unrun checks', '1440/390 result containment'],
      exceptions: errors, devices: 'not-operated', paidModels: 'not-contacted' }, null, 2));
    console.log('Dependency tool, background SPDX receipt and responsive result verified in Chrome');
    ws.close(); process.exit(0);
  }
  if (process.argv.includes('--patch')) {
    const info = JSON.parse(await readFile(process.env.OHMATE_BROWSER_INFO, 'utf8'));
    const before = await readFile(join(info.root, 'README.md'), 'utf8'), after = '# Reviewed browser patch\n';
    const input = { changes: [{ path: 'README.md', oldHash: createHash('sha256').update(before).digest('hex'), text: after }] };
    await wait('!!document.querySelector(".welcome")');
    await click('#tools-button'); await fill('#tool-search', 'workspace.patch');
    await clickText('workspace patch · R2', 'document.getElementById("dialog")');
    await fill('#tool-input', JSON.stringify(input));
    await clickText('选择此本地任务', 'document.getElementById("dialog")'); await click('#send-button');
    await wait('document.body.innerText.includes("等待范围确认")');
    assert.ok(await evaluate('!!document.querySelector("[data-patch-path=\\"README.md\\"]")'), 'Patch plan must show a dedicated file diff before approval');
    const diff = await evaluate('document.querySelector(".patch-diff").textContent');
    assert.ok(diff.includes('-# Public verification fixture'));
    assert.ok(diff.includes('+# Reviewed browser patch'));
    assert.equal(await readFile(join(info.root, 'README.md'), 'utf8'), before);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      const image = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${target}/diff-${width}.png`, Buffer.from(image.data, 'base64'));
    }
    await clickText('确认此计划并执行');
    await wait('document.body.innerText.includes("工具执行成功")');
    assert.equal(await readFile(join(info.root, 'README.md'), 'utf8'), after);
    await click('#files-button'); await fill('#write-paths', 'new.ts');
    await clickText('保存选择', 'document.getElementById("dialog")');
    await wait('!document.getElementById("dialog").open');
    await clickText('上下文'); await wait('document.getElementById("dialog-title").textContent==="模型发送范围预览"');
    await evaluate('[...document.querySelectorAll("#dialog summary")].find(e=>e.textContent==="允许提出修改的路径与旧内容哈希").click()');
    assert.ok((await evaluate('document.getElementById("dialog").innerText')).includes('new.ts'));
    assert.deepEqual(errors, []);
    await writeFile(`${target}/results.json`, JSON.stringify({ status: 'passed', checks: [
      'file diff before approval', 'no pre-approval write', 'actual approved patch', '1440/390 containment', 'explicit write scope preview',
    ], exceptions: errors, devices: 'not-operated', paidModels: 'not-contacted' }, null, 2));
    console.log('Patch diff, approval, write scope and responsive browser checks passed');
    ws.close(); process.exit(0);
  }
  if (process.argv.includes('--home-reset')) {
    await evaluate('document.getElementById("prompt").value="Previous task";location.hash="library"');
    await wait('!!document.querySelector(".collection")');
    await evaluate('location.hash="home"');
    await wait('!!document.querySelector(".welcome")');
    assert.equal(await evaluate('document.getElementById("prompt").value'), '');
    console.log('New-task input reset passed');
    ws.close();
    process.exit(0);
  }
  await evaluate('location.hash="home"');
  await wait('!!document.querySelector(".welcome")');
  assert.equal(await evaluate('document.querySelectorAll("[data-nav]").length'), 3);
  assert.equal(await evaluate('document.querySelectorAll(".intent-btn").length'), 6);
  record('three navigation entries and six editable intents');
  await click('.intent-btn');
  assert.ok((await evaluate('document.getElementById("prompt").value')).includes('开发一个鸿蒙应用'));
  await click('#send-button');
  await wait('document.getElementById("dialog").open && document.getElementById("dialog-title").textContent==="模型连接"');
  assert.ok((await evaluate('document.body.innerText')).includes('无模型 · 本地工具'));
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait('!document.getElementById("dialog").open');
  record('no-model natural language does not send and modal Escape works');
  await clickText('检查本地环境');
  await wait('document.body.innerText.includes("工具执行成功")');
  await wait('document.getElementById("task-events")?.textContent.includes("process.closed")');
  await clickText('查看成果与依据');
  await wait('!document.getElementById("result-panel").hidden');
  assert.ok((await evaluate('document.getElementById("result-body").innerText')).includes('not-probed'));
  await click('#result-close');
  record('real background doctor, ordered events and source-backed receipt');
  await click('#tools-button');
  await fill('#tool-search', 'deveco.ui');
  await clickText('ui · R2', 'document.getElementById("dialog")');
  await clickText('选择此本地任务', 'document.getElementById("dialog")');
  await click('#send-button');
  await wait('document.body.innerText.includes("等待范围确认")');
  assert.ok((await evaluate('document.body.innerText')).includes('确认此计划并执行'));
  await clickText('停止任务');
  await wait('document.body.innerText.includes("已停止")');
  record('R2 plan displayed and cancelled without touching a device');
  await click('#app-picker');
  await wait('document.getElementById("dialog").open');
  await evaluate('document.querySelector("#dialog button.choice").click()');
  assert.equal(await evaluate('document.getElementById("app-picker").textContent'), 'webfixture');
  await click('#files-button');
  await fill('#context-files', 'README.md');
  await clickText('保存选择', 'document.getElementById("dialog")');
  await click('#context-button');
  await wait('document.getElementById("dialog-title").textContent==="模型发送范围预览"');
  assert.ok((await evaluate('document.getElementById("dialog").innerText')).includes('1 个文件'));
  await evaluate('document.getElementById("dialog").close()');
  record('registered application and bounded context file preview');
  await click('#models-button');
  await wait('document.getElementById("dialog-title").textContent==="模型连接"');
  await clickText('添加 API', 'document.getElementById("dialog")');
  for (const [name, value] of Object.entries({ id: 'browser-test', model: 'example-model', endpoint: 'https://example.invalid/v1', credentialEnv: 'OHMATE_BROWSER_EXAMPLE_KEY' })) {
    await fill(`#dialog #${name}`, value);
  }
  await clickText('保存配置', 'document.getElementById("dialog")');
  await wait('document.getElementById("dialog").innerText.includes("browser-test")');
  assert.equal(await evaluate('document.getElementById("dialog").querySelector("input[type=password]")'), null);
  record('BYOK metadata only; no browser password storage or remote request');
  await evaluate('document.getElementById("dialog").close()');
  await click('#settings-button');
  await clickText('长期记忆', 'document.getElementById("dialog")');
  await wait('!!document.getElementById("memory-text")');
  await fill('#memory-text', 'Browser acceptance fixture only.');
  await clickText('确认保存记忆', 'document.getElementById("dialog")');
  await wait('document.getElementById("dialog").innerText.includes("Browser acceptance fixture only.")');
  await evaluate('document.getElementById("dialog").close()');
  record('explicit local memory persisted through the shared tool');
  await evaluate('location.hash="apps"');
  await wait('!!document.querySelector(".collection") && document.body.innerText.includes("webfixture")');
  await evaluate('location.hash="library"');
  await wait('document.querySelectorAll(".artifact-row").length>=2');
  record('applications and reports contain real stored records');
  const sizes = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
    await evaluate('location.hash="home"');
    await wait('!!document.querySelector(".welcome")');
    await wait('document.getElementById("toast-root").children.length===0');
    const layout = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,prompt:document.getElementById("prompt").getBoundingClientRect().bottom,send:document.getElementById("send-button").getBoundingClientRect().bottom,height:innerHeight})');
    assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
    assert.ok(layout.send <= layout.height && layout.prompt <= layout.height, JSON.stringify(layout));
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${target}/home-${width}.png`, Buffer.from(screenshot.data, 'base64'));
    sizes.push(layout);
  }
  await click('#sidebar-toggle');
  assert.ok(await evaluate('document.body.classList.contains("sidebar-open")'));
  await click('a[data-nav="library"]');
  await wait('!document.body.classList.contains("sidebar-open")');
  record('1440/1024/390 containment and mobile navigation');
  assert.deepEqual(errors, []);
  await writeFile(`${target}/results.json`, JSON.stringify({ status: 'passed', checks, sizes, exceptions: errors,
    browser: 'test-owned Chrome 156; direct CDP fallback', devices: 'not-operated', paidModels: 'not-contacted' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: target, errors }));
} catch (error) {
  await writeFile(`${target}/failure.json`, JSON.stringify({
    message: error.message, page: await evaluate('document.body.innerText'), exceptions: errors,
    tasks: await evaluate('(async()=>{const api=await import("/api.js");return (await api.request("tasks")).data;})()'),
    dialog: await evaluate('({open:document.getElementById("dialog").open,title:document.getElementById("dialog-title")?.textContent,toasts:window.__verificationToasts})'),
  }, null, 2));
  throw error;
} finally { ws.close(); }
