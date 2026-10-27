/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { textContent } from './bridge.mjs';

function cancellable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('BRIDGE_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createVSCodeHost(vscode) {
  const list = async () => {
    if (typeof vscode.lm?.selectChatModels !== 'function') { throw new Error('BRIDGE_API_UNAVAILABLE'); }
    return vscode.lm.selectChatModels();
  };
  return { list, complete: async function* (body, signal) {
    signal.throwIfAborted();
    const model = (await cancellable(list(), signal)).find((item) => item.id === body.model);
    if (!model) { throw new Error('BRIDGE_MODEL_UNKNOWN'); }
    const choice = await cancellable(vscode.window.showInformationMessage(
      `OHMate 请求调用 ${model.name}。将发送 ${body.messages.length} 条上下文消息和 ${body.tools?.length ?? 0} 个工具合同。`,
      { modal: true, detail: '内容来自本机 CLI/Web 中确认的发送范围。模型请求可能联网并产生费用；工具仍由 OHMate 审批执行。' },
      '允许本次请求'), signal);
    signal.throwIfAborted();
    if (choice !== '允许本次请求') { throw new Error('BRIDGE_USER_DECLINED'); }
    const tokenSource = new vscode.CancellationTokenSource();
    const cancel = () => tokenSource.cancel(); signal.addEventListener('abort', cancel, { once: true });
    try {
      const messages = body.messages.map((message) => {
        const text = textContent(message.content);
        if (message.role === 'tool') {
          return vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelToolResultPart(message.tool_call_id, [new vscode.LanguageModelTextPart(text)]),
          ]);
        }
        if (message.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant([
            ...(text ? [new vscode.LanguageModelTextPart(text)] : []),
            ...(message.tool_calls ?? []).map((call) =>
              new vscode.LanguageModelToolCallPart(call.id, call.function.name, JSON.parse(call.function.arguments))),
          ]);
        }
        // The public API has no System role; preserve its source explicitly as a user message.
        return vscode.LanguageModelChatMessage.User(
          ['system', 'developer'].includes(message.role) ? `[OHMate ${message.role} context]\n${text}` : text);
      });
      let tokens = Math.ceil(JSON.stringify(body.tools ?? []).length / 3);
      for (const message of messages) { tokens += await cancellable(model.countTokens(message, tokenSource.token), signal); }
      if (tokens >= model.maxInputTokens) { throw new Error('BRIDGE_CONTEXT_LIMIT'); }
      const tools = body.tool_choice === 'none' ? [] : (body.tools ?? []).map((tool) => ({
        name: tool.function.name, description: tool.function.description ?? tool.function.name,
        inputSchema: tool.function.parameters,
      }));
      const response = await cancellable(model.sendRequest(messages, {
        justification: '用户确认的 OHMate 本机模型请求', tools,
        toolMode: body.tool_choice === 'required' ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
      }, tokenSource.token), signal);
      const iterator = response.stream[Symbol.asyncIterator]();
      while (true) {
        const next = await cancellable(iterator.next(), signal);
        if (next.done) { break; }
        const part = next.value;
        signal.throwIfAborted();
        if (part instanceof vscode.LanguageModelTextPart) { yield { text: part.value }; }
        else if (part instanceof vscode.LanguageModelToolCallPart) { yield { toolCall: { id: part.callId, name: part.name, input: part.input } }; }
        else { throw new Error('BRIDGE_RESPONSE_INVALID'); }
      }
    } finally { signal.removeEventListener('abort', cancel); tokenSource.cancel(); tokenSource.dispose(); }
  } };
}
