/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const source = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), 'utf8');

it('drives the mobile workbench through genuine CDP touch input', async () => {
  const [browser, launcher, manifest] = await Promise.all([
    source('scripts/verify-web-browser.mjs'),
    source('scripts/verify-patch-browser.mjs'),
    source('package.json'),
  ]);
  expect(browser).toContain("process.argv.includes('--touch')");
  expect(browser).toContain("call('Emulation.setTouchEmulationEnabled'");
  expect(browser).toContain("call('Input.dispatchTouchEvent', { type: 'touchStart'");
  expect(browser).toContain("call('Input.dispatchTouchEvent', { type: 'touchEnd'");
  expect(browser).toContain("call('Input.synthesizeTapGesture'");
  expect(browser).toContain('r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight');
  expect(browser).toContain('e.contains(document.elementFromPoint(x,y))');
  expect(browser).toContain("event.pointerType === 'touch'");
  expect(browser).toContain("addEventListener('touchstart'");
  expect(browser).toContain('document.getElementById("dialog-title")?.textContent');
  expect(browser).toContain('document.getElementById("alert-root").children.length===0');
  expect(launcher).toContain("process.argv.includes('--touch') ? '--touch'");
  expect(launcher).toContain('OHMATE_WEB_VALIDATION_OUTPUT');
  const scripts = JSON.parse(manifest).scripts;
  expect(scripts['pretest:web:touch']).toBe('npm run build -w packages/cli');
  expect(scripts['test:web:touch'])
    .toBe('node scripts/verify-patch-browser.mjs --touch');
});
