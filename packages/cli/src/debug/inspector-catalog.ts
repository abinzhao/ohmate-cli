/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ChannelSchema, PayloadSchemas, type Channel } from '../debug-protocol/domain-schemas.js';

function sdk(module: string, symbols: string[]) {
  return { kind: 'sdk-declaration', module, symbols, captureVerification: 'unverified' };
}
const web = sdk('@ohos.web.webview', ['WebviewController.executeAIPageCommand', 'WebviewController.setWebDebuggingAccess']);
const watcher = sdk('@ohos.hiviewdfx.hiAppEvent', ['addWatcher']);
const references: Record<Channel, object> = {
  session: { kind: 'protocol', name: 'session' },
  health: { kind: 'protocol', name: 'health' },
  'arkweb.dom': web, 'arkweb.network': web, 'arkweb.storage': web, 'arkweb.console': web,
  'app.network': sdk('@ohos.net.http', ['HttpRequest.request']),
  ui: sdk('@ohos.arkui.UIContext', ['UIContext.getUIInspector']),
  hilog: sdk('@ohos.hilog', ['info']),
  hiappevent: watcher,
  hitrace: sdk('@ohos.hiTraceChain', ['begin']),
  hichecker: sdk('@ohos.hichecker', ['addRule']),
  hidebug: sdk('@ohos.hidebug', ['getCpuUsage', 'getPss', 'getNativeHeapSize']),
  faultlog: watcher,
  jsleak: { kind: 'official-tool', name: 'DevEco Studio Profiler', captureVerification: 'unverified' },
  instrumentation: sdk('@ohos.util', ['Aspect']),
  problems: { kind: 'protocol', name: 'problems' },
};
const networkMissing = ['host', 'path', 'type', 'headers', 'body', 'timing', 'mock', 'trace'];
const missing: Record<Channel, string[]> = {
  session: ['actions'], health: ['diagnosticDetails'],
  'arkweb.dom': ['nodes', 'attributes', 'frames', 'sourceLocation'],
  'arkweb.network': networkMissing,
  'arkweb.storage': ['entries', 'values', 'indexedDB', 'cacheStorage'],
  'arkweb.console': ['pageText', 'stack', 'execution'],
  'app.network': networkMissing,
  ui: ['nodes', 'geometry', 'visibility', 'screenshot', 'sourceLocation', 'stateDependencies'],
  hilog: ['rawLog', 'stack'], hiappevent: ['eventParameters', 'startupStages'],
  hitrace: ['traceFile', 'spanTree', 'crossClockOrdering'],
  hichecker: ['stack', 'ruleDetails'],
  hidebug: ['samplingRate', 'cpuProfile', 'heapSnapshot', 'gc', 'frames'],
  faultlog: ['rawFaultlog', 'stack', 'symbols'],
  jsleak: ['heapSnapshot', 'retainingPaths', 'nativeStack'],
  instrumentation: ['eventParameters', 'sourceLocation'],
  problems: ['rootCause', 'sourceLocation'],
};
const titles: Record<Channel, string> = {
  session: '会话', health: '采集健康', 'arkweb.dom': 'ArkWeb DOM', 'arkweb.network': 'ArkWeb 网络',
  'arkweb.storage': 'ArkWeb 存储', 'arkweb.console': 'ArkWeb Console', 'app.network': '应用网络',
  ui: 'ArkUI', hilog: 'HiLog', hiappevent: 'HiAppEvent', hitrace: 'HiTrace',
  hichecker: 'HiChecker', hidebug: 'CPU / 内存', faultlog: 'FaultLog', jsleak: 'JS 内存线索',
  instrumentation: '埋点', problems: '问题摘要',
};

export function inspectorDescription(channel: Channel) {
  const schema = z.toJSONSchema(PayloadSchemas[channel]);
  return { channel, title: titles[channel], coverageLevel: 'summary-only',
    content: ['ui', 'arkweb.dom', 'arkweb.storage', 'arkweb.console'].includes(channel) ? 'memory-only' : 'redacted-summary',
    supportedFields: Object.keys(schema.properties ?? {}), unavailableFields: [...missing[channel]],
    reference: structuredClone(references[channel]), referenceRole: 'reference-only',
    fullInspection: 'not-captured',
    officialTool: channel.startsWith('arkweb.') ? 'ArkWeb DevTools' : channel === 'ui' ? 'DevEco UI Inspector' :
      ['hidebug', 'hitrace', 'jsleak'].includes(channel) ? 'DevEco Studio Profiler' : null };
}

export function inspectorCatalog() {
  return { schemaVersion: '1.0', mode: 'readonly', inspectors: ChannelSchema.options.map(inspectorDescription) };
}
