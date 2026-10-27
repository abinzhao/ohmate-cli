/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
document.getElementById('emit').addEventListener('click', () => {
  console.info('OHMate fixed local reference event');
  document.getElementById('result').textContent = '已产生一条固定示例事件';
});
console.info('OHMate fixed local reference loaded');

const resourceButton = document.getElementById('resource-probe');
const resourceResult = document.getElementById('resource-result');
let resourceRequest;
resourceButton.addEventListener('click', async () => {
  if (resourceRequest) return;
  const owner = new AbortController();
  resourceRequest = owner; resourceButton.disabled = true;
  resourceResult.textContent = '正在请求固定资源…';
  const timer = setTimeout(() => owner.abort(), 3000);
  try {
    const response = await fetch('/kit-readonly.css', {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: owner.signal,
    });
    const overridden = response.headers.has('X-OHMate-Resource');
    // The probe never applies stylesheet contents or retains response bytes.
    await response.body?.cancel();
    if (resourceRequest === owner) {
      resourceResult.textContent = overridden ?
        '本次请求收到覆盖响应。当前授权和命中数以应用为准。' : '本次请求收到原始资源响应。';
    }
  } catch {
    if (resourceRequest === owner) resourceResult.textContent = '资源请求未完成，可重试。';
  } finally {
    clearTimeout(timer);
    if (resourceRequest === owner) { resourceRequest = undefined; resourceButton.disabled = false; }
  }
});
window.addEventListener('pagehide', () => {
  resourceRequest?.abort(); resourceRequest = undefined;
  resourceButton.disabled = false;
  resourceResult.textContent = '资源请求已取消，可重新请求。';
});
