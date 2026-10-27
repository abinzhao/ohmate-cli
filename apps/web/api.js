/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
let csrf;
export async function request(path, input) {
  const response = await fetch(`/api/v1/${path}`, {
    method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-ohmate-csrf': csrf } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = response.status === 401 ? '连接已过期，请在终端重新运行 ohmatecli ui。' : data.data?.message ?? data.code ?? '请求未完成，请重试。';
    throw new Error(message);
  }
  return data;
}
export async function initialize() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('access');
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    await request('connect', { ticket });
  }
  const bootstrap = await request('bootstrap');
  csrf = bootstrap.csrf;
  return bootstrap;
}
export async function execute(toolId, input = {}, projectRoot = null) {
  const receipt = await request('execute', { toolId, input, projectRoot });
  if (receipt.exitCode !== 0) { throw new Error(receipt.data?.message ?? receipt.data?.code ?? '操作未完成。'); }
  return receipt;
}
export function download(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
