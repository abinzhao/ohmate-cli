/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
const vscode = require('vscode');
let bridge, starting;
async function start() {
  if (!vscode.workspace.isTrusted) { throw new Error('请先在可信工作空间启动模型桥。'); }
  if (bridge) { return bridge; }
  if (starting) { return starting; }
  starting = (async () => {
    const { startBridge } = await import('./bridge.mjs');
    const { createVSCodeHost } = await import('./vscode-host.mjs');
    const host = createVSCodeHost(vscode), models = await host.list();
    if (!models.length) {
      throw new Error('TRAE 当前没有向公开 Language Model API 开放模型。请核对宿主版本与模型授权；插件无法使用未开放的模型。');
    }
    bridge = await startBridge(host);
    await vscode.window.showInformationMessage(`OHMate 模型桥已启动：${bridge.endpoint}。当前公开模型 ${models.length} 个。请运行“复制模型桥连接设置”连接 CLI。`);
    return bridge;
  })();
  try { return await starting; } finally { starting = undefined; }
}
async function stop() {
  if (starting) { await starting.catch(() => {}); }
  const owned = bridge; bridge = undefined;
  await owned?.close();
}
exports.activate = (context) => {
  const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { await action(); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  command('ohmate.traeBridge.start', start);
  command('ohmate.traeBridge.copy', async () => {
    const value = await start();
    const choice = await vscode.window.showWarningMessage(
      '连接设置包含临时密钥。只粘贴到你的私有终端，不发送给助手或他人。停止模型桥后密钥失效。',
      { modal: true }, '复制到剪贴板');
    if (choice !== '复制到剪贴板') { return; }
    const terminal = await vscode.window.showQuickPick(['POSIX shell', 'PowerShell'], { title: '选择终端类型' });
    if (!terminal) { return; }
    const assignment = terminal === 'PowerShell' ? `$env:OHMATE_TRAE_BRIDGE_KEY='${value.key}'` : `export OHMATE_TRAE_BRIDGE_KEY='${value.key}'`;
    await vscode.env.clipboard.writeText(`${assignment}\nohmatecli model trae --endpoint ${value.endpoint}\nohmatecli model list\n`);
    await vscode.window.showInformationMessage('已复制。粘贴到私有终端执行，再选择模型；Web 工作台须从继承该变量的终端启动。');
  });
  command('ohmate.traeBridge.stop', async () => { await stop(); await vscode.window.showInformationMessage('OHMate 模型桥已停止。'); });
};
exports.deactivate = stop;
