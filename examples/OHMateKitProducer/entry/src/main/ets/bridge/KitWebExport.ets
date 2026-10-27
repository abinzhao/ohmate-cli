/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { KitWebFile } from './KitWebSample';
import { requireWire, keysOf, match } from './Wire';
import { KIT_WEB_DOM_DIRECTORY, KIT_WEB_CONSOLE_PATH, KIT_NETWORK_PATH,
  KIT_WEB_STORAGE_PATH, KIT_STORAGE_SUMMARY } from './GeneratedContract';

export interface WebExportSelection {
  dom: KitWebFile | undefined;
  console: KitWebFile | undefined;
  navigation: KitWebFile | undefined;
  storage?: KitWebFile;
}
function isConsoleSourceSummary(value: Object): boolean {
  return typeof value === 'string' && !value.includes('\n') && match(value,
    '^source-(?:[0-9]|1[0-2]);(?:page|script);line-(?:[0-9]|[1-9][0-9]{1,5}|1000000);frame-column-unverified;\\[MEMORY_ONLY\\]$');
}
export function checkWebExport(selection: WebExportSelection, sample: Record<string, Object>): KitWebFile[] {
  try { return validateWebExport(selection, sample); }
  catch { throw new Error('EXPORT_SAMPLE_INVALID'); }
}
function validateWebExport(selection: WebExportSelection, sample: Record<string, Object>): KitWebFile[] {
  const result: KitWebFile[] = [];
  for (const file of [selection.dom, selection.console, selection.navigation, selection.storage]) {
    if (file === undefined) { continue; }
    const dom = file === selection.dom;
    const console = file === selection.console;
    const storage = file === selection.storage;
    requireWire(file.source.provenance === 'peer-reported' && file.sampled &&
      Number.isSafeInteger(file.dropped) && file.dropped >= 0 && file.records.length > 0 &&
      file.records.length <= (dom ? 256 : 1), 'EXPORT_SAMPLE_INVALID');
    requireWire(file.path === (dom ? KIT_WEB_DOM_DIRECTORY + '/web-main.json' : storage ? KIT_WEB_STORAGE_PATH :
      console ? KIT_WEB_CONSOLE_PATH : KIT_NETWORK_PATH) &&
      file.source.id === (dom ? 'registered-web-dom' : storage ? 'registered-web-cookie' :
        console ? 'registered-web-console' : 'registered-web-navigation') &&
      file.source.kind === (dom || storage ? 'platform-api' : 'registered-adapter') &&
      file.source.api === (dom ? 'WebviewController.executeAIPageCommand' : storage ? 'WebCookieManager.fetchCookie' :
        console ? 'Web.onConsole' : 'Web.onPageBegin.onPageEnd') &&
      file.status === (dom ? 'captured' : 'summary-only'), 'EXPORT_SAMPLE_INVALID');
    const nodeIds: string[] = [];
    for (const record of file.records) {
      if (dom) {
        const structural = keysOf(record, ['clock', 'payload']);
        keysOf(structural['clock'], ['clockId', 'bootId', 'wallTimeUtc', 'monotonicNs', 'offsetUncertaintyMs']);
        const payload = keysOf(structural['payload'], ['targetId', 'nodeId', 'parentId', 'role', 'childCount']);
        requireWire(payload['targetId'] === 'web-main' && typeof payload['nodeId'] === 'string' &&
          match(payload['nodeId'] as string, '^dom-[0-9]+-[0-9]+$') && typeof payload['role'] === 'string' &&
          match(payload['role'] as string, '^[A-Za-z][A-Za-z0-9]{0,127}$') &&
          Number.isSafeInteger(payload['childCount']) && (payload['childCount'] as number) >= 0 &&
          (payload['childCount'] as number) <= 256, 'EXPORT_SAMPLE_INVALID');
        const nodeId = payload['nodeId'] as string;
        requireWire(!nodeIds.includes(nodeId) && (payload['parentId'] === null ||
          (typeof payload['parentId'] === 'string' && nodeIds.includes(payload['parentId'] as string))),
          'EXPORT_SAMPLE_INVALID');
        nodeIds.push(nodeId);
      } else {
        keysOf(record, Object.keys(sample));
        for (const key of ['project', 'buildId', 'device', 'process', 'sessionId', 'sessionEpoch']) {
          requireWire(record[key] === sample[key], 'EXPORT_SAMPLE_INVALID');
        }
        const channel = storage ? 'arkweb.storage' : console ? 'arkweb.console' : 'arkweb.network';
        requireWire(record['channel'] === channel && record['capability'] === channel + '.read', 'EXPORT_SAMPLE_INVALID');
        const redaction = keysOf(record['redaction'], ['policyId', 'fieldsRemoved']);
        requireWire(redaction['policyId'] === 'web-structure-only-v1' && redaction['fieldsRemoved'] === 0, 'EXPORT_SAMPLE_INVALID');
        const payload = keysOf(record['payload'], storage ? ['targetId', 'entryCount', 'summary'] :
          console ? ['level', 'summary'] : ['requestId', 'method', 'durationMs']);
        if (storage) {
          requireWire(payload['targetId'] === 'web-main' && Number.isSafeInteger(payload['entryCount']) &&
            (payload['entryCount'] as number) >= 0 && (payload['entryCount'] as number) <= 64 &&
            payload['summary'] === KIT_STORAGE_SUMMARY && record['protocolVersion'] === sample['protocolVersion'] &&
            record['channelVersion'] === '1.0' && record['type'] === 'event' &&
            Number.isSafeInteger(record['sequence']) && (record['sequence'] as number) > file.dropped &&
            record['messageId'] === 'web-' + record['sequence'] &&
            record['clockId'] === sample['clockId'] && record['bootId'] === sample['bootId'] &&
            typeof record['monotonicNs'] === 'string' &&
            match(record['monotonicNs'] as string, '^(0|[1-9][0-9]{0,19})$') &&
            BigInt(record['monotonicNs'] as string) <= BigInt('18446744073709551615') &&
            typeof record['wallTimeUtc'] === 'string' &&
            new Date(record['wallTimeUtc'] as string).toISOString() === record['wallTimeUtc'] &&
            record['offsetUncertaintyMs'] === Number.MAX_SAFE_INTEGER, 'EXPORT_SAMPLE_INVALID');
        } else if (console) {
          requireWire(isConsoleSourceSummary(payload['summary']) &&
            ['debug', 'info', 'warn', 'error'].includes(payload['level'] as string), 'EXPORT_SAMPLE_INVALID');
        } else {
          requireWire(typeof payload['requestId'] === 'string' && match(payload['requestId'] as string, '^web-navigation-[0-9]+$') &&
            ['GET', 'HEAD'].includes(payload['method'] as string) && Number.isSafeInteger(payload['durationMs']) &&
            (payload['durationMs'] as number) >= 0, 'EXPORT_SAMPLE_INVALID');
        }
      }
    }
    if (dom) {
      for (const record of file.records) {
        const payload = record['payload'] as Record<string, Object>;
        const children = file.records.filter((child: Record<string, Object>): boolean => {
          return (child['payload'] as Record<string, Object>)['parentId'] === payload['nodeId'];
        });
        requireWire(children.length === payload['childCount'], 'EXPORT_SAMPLE_INVALID');
      }
    }
    result.push(file);
  }
  return result;
}
