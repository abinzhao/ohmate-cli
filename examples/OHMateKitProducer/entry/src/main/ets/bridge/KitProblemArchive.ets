/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { canonical, CryptoPort, requireWire, keysOf } from './Wire';
import { KitMemoryFile } from './KitMemorySample';
import { KitUiFile, UI_SOURCE_API } from './KitUiSample';
import { KitNetworkFile } from './KitNetworkSample';
import { WebExportSelection, checkWebExport } from './KitWebExport';
import { KIT_EXPORT_SCHEMAS, KIT_READONLY_EXPORT_SCHEMAS, KIT_DOMAIN_NAMES, KIT_MEMORY_PATH, KIT_UI_PATH,
  KIT_NETWORK_PATH, KIT_DFX_PATH, KIT_WEB_STORAGE_PATH, CHANNEL_CONTRACTS } from './GeneratedContract';

interface ArchiveTextFile { path: string; text: string; }
interface ArchiveEntry { path: string; bytes: Uint8Array; }
export const KIT_EXPORT_MAX_BYTES: number = 1024 * 1024;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(files: ArchiveEntry[], port: CryptoPort): Uint8Array {
  // This bounded exporter emits only generated schemas and one fixed summary path.
  const names = files.map((file: ArchiveEntry): Uint8Array => port.encode(file.path));
  let size = 22;
  for (let index = 0; index < files.length; index++) { size += 76 + names[index].length * 2 + files[index].bytes.length; }
  requireWire(size <= KIT_EXPORT_MAX_BYTES, 'EXPORT_SIZE_LIMIT');
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const offsets: number[] = [];
  const checksums: number[] = [];
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const name = names[index];
    const checksum = crc32(file.bytes);
    offsets.push(offset); checksums.push(checksum);
    view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); view.setUint16(offset + 12, 33, true);
    view.setUint32(offset + 14, checksum, true);
    view.setUint32(offset + 18, file.bytes.length, true); view.setUint32(offset + 22, file.bytes.length, true);
    view.setUint16(offset + 26, name.length, true);
    bytes.set(name, offset + 30); bytes.set(file.bytes, offset + 30 + name.length);
    offset += 30 + name.length + file.bytes.length;
  }
  const directory = offset;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const name = names[index];
    view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 14, 33, true); view.setUint32(offset + 16, checksums[index], true);
    view.setUint32(offset + 20, file.bytes.length, true); view.setUint32(offset + 24, file.bytes.length, true);
    view.setUint16(offset + 28, name.length, true); view.setUint32(offset + 42, offsets[index], true);
    bytes.set(name, offset + 46); offset += 46 + name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true); view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - directory, true); view.setUint32(offset + 16, directory, true);
  return bytes;
}
function summaryRecord(value: Object): Record<string, Object> {
  return keysOf(value, ['project', 'buildId', 'device', 'process', 'sessionId', 'protocolVersion',
    'channelVersion', 'messageId', 'sessionEpoch', 'sequence', 'channel', 'type', 'capability', 'clockId',
    'bootId', 'wallTimeUtc', 'monotonicNs', 'offsetUncertaintyMs', 'payload', 'redaction']);
}
function checkMemory(file: KitMemoryFile): Record<string, Object>[] {
  requireWire(file.path === KIT_MEMORY_PATH && file.records.length > 0 && file.records.length <= 2 &&
    file.status === 'summary-only' && file.sampled && file.source.kind === 'platform-api' &&
    file.source.provenance === 'peer-reported' && Number.isSafeInteger(file.dropped) && file.dropped >= 0,
    'EXPORT_SAMPLE_INVALID');
  const records: Record<string, Object>[] = [];
  const metrics: string[] = [];
  let previous = 0;
  for (const value of file.records) {
    const record = summaryRecord(value);
    const payload = keysOf(record['payload'], ['metric', 'value']);
    const redaction = keysOf(record['redaction'], ['policyId', 'fieldsRemoved']);
    const metric = payload['metric'] as string;
    requireWire((metric === 'pssBytes' || metric === 'cpuPercent') && !metrics.includes(metric) &&
      typeof payload['value'] === 'number' && Number.isFinite(payload['value']) && (payload['value'] as number) >= 0 &&
      (metric === 'cpuPercent' || Number.isSafeInteger(payload['value'])) &&
      record['channel'] === 'hidebug' && record['capability'] === 'hidebug.read' && record['type'] === 'event' &&
      redaction['policyId'] === 'metrics-only-v1' && redaction['fieldsRemoved'] === 0 &&
      Number.isSafeInteger(record['sequence']) && (record['sequence'] as number) > previous, 'EXPORT_SAMPLE_INVALID');
    if (records.length > 0) {
      for (const key of ['project', 'buildId', 'device', 'process', 'sessionId', 'sessionEpoch', 'protocolVersion']) {
        requireWire(record[key] === records[0][key], 'EXPORT_SAMPLE_INVALID');
      }
    }
    previous = record['sequence'] as number;
    metrics.push(metric); records.push(record);
  }
  const combined = metrics.length === 2;
  requireWire(file.source.id === (combined ? 'process-pss-and-cpu' :
    metrics[0] === 'pssBytes' ? 'process-pss' : 'process-cpu') &&
    file.source.api === (combined ? 'hidebug.getPss.getCpuUsage' :
      metrics[0] === 'pssBytes' ? 'hidebug.getPss' : 'hidebug.getCpuUsage') && file.dropped < previous, 'EXPORT_SAMPLE_INVALID');
  return records;
}
function checkDfx(file: KitMemoryFile, sample: Record<string, Object>): Record<string, Object> {
  requireWire(file.path === KIT_DFX_PATH && file.records.length === 1 && file.source.id === 'system-event-names' &&
    file.source.kind === 'platform-api' && file.source.api === 'hiAppEvent.addWatcher.onReceive' &&
    file.source.provenance === 'peer-reported' && file.status === 'summary-only' && file.sampled &&
    Number.isSafeInteger(file.dropped) && file.dropped >= 0, 'EXPORT_SAMPLE_INVALID');
  const record = summaryRecord(file.records[0]);
  for (const key of ['project', 'buildId', 'device', 'process', 'sessionId', 'sessionEpoch', 'protocolVersion']) {
    requireWire(record[key] === sample[key], 'EXPORT_SAMPLE_INVALID');
  }
  const payload = keysOf(record['payload'], ['eventName', 'summary']);
  const redaction = keysOf(record['redaction'], ['policyId', 'fieldsRemoved']);
  requireWire(record['channel'] === 'hiappevent' && record['capability'] === 'hiappevent.read' &&
    record['type'] === 'event' && Number.isSafeInteger(record['sequence']) && (record['sequence'] as number) > 0 &&
    (payload['eventName'] === 'APP_CRASH' || payload['eventName'] === 'APP_FREEZE') &&
    payload['summary'] === 'observed-callback;fault-time-unverified;[MEMORY_ONLY]' &&
    redaction['policyId'] === 'dfx-event-name-only-v1' && redaction['fieldsRemoved'] === 0, 'EXPORT_SAMPLE_INVALID');
  return record;
}
export function makeMemoryProblem(file: KitMemoryFile, port: CryptoPort, ui: KitUiFile | undefined = undefined,
  network: KitNetworkFile | undefined = undefined, web: WebExportSelection | undefined = undefined,
  dfx: KitMemoryFile | undefined = undefined): Uint8Array {
  let memoryRecords: Record<string, Object>[];
  let dfxRecord: Record<string, Object> | undefined = undefined;
  try {
    memoryRecords = checkMemory(file);
    if (dfx !== undefined) { dfxRecord = checkDfx(dfx, memoryRecords[memoryRecords.length - 1]); }
  } catch { throw new Error('EXPORT_SAMPLE_INVALID'); }
  const sample = memoryRecords[memoryRecords.length - 1];
  const identity: Record<string, Object> = {
    'project': sample['project'], 'buildId': sample['buildId'], 'device': sample['device'],
    'process': sample['process'], 'sessionId': sample['sessionId']
  };
  const offers = JSON.parse(CHANNEL_CONTRACTS) as Record<string, Object>[];
  const coverage = offers.map((offer: Record<string, Object>): Record<string, Object> => {
    return { 'channel': offer['channel'], 'count': 0, 'status': 'not-captured' };
  });
  const webFiles = web !== undefined ? checkWebExport(web, sample) : [];
  const readonly = ui !== undefined || network !== undefined || webFiles.length > 0 ||
    dfx !== undefined || file.source.api !== 'hidebug.getPss';
  const source: Record<string, Object> = { 'kind': readonly ? 'app-readonly-summary' : 'app-memory-summary' };
  const sessionRedaction: Record<string, Object> = {
    'policyId': 'offline-summary-v1', 'fieldsRemoved': 0, 'memoryOnlyText': 'excluded', 'attachments': 'none'
  };
  const session: Record<string, Object> = {
    'schemaVersion': '1.4', 'identity': identity, 'source': source,
    'buildVerification': 'unverified', 'deviceProvenance': 'peer-asserted', 'authentication': 'not-restored',
    'clockCalibration': 'not-verified', 'through': 0, 'coverage': coverage,
    'redaction': sessionRedaction
  };
  const descriptor: Record<string, Object> = {
    'path': KIT_MEMORY_PATH, 'domain': 'memory', 'source': file.source, 'status': 'summary-only',
    'count': memoryRecords.length, 'dropped': file.dropped, 'sampled': true, 'representation': 'domain-summary'
  };
  const descriptors: Record<string, Object>[] = [descriptor];
  if (dfx !== undefined) {
    const dfxDescriptor: Record<string, Object> = {
      'path': KIT_DFX_PATH, 'domain': 'dfx', 'source': dfx.source, 'status': 'summary-only',
      'count': 1, 'dropped': dfx.dropped, 'sampled': true, 'representation': 'domain-summary'
    };
    descriptors.push(dfxDescriptor);
  }
  if (ui !== undefined) {
    requireWire(ui.path === KIT_UI_PATH && ui.source.id === 'arkui-tree' && ui.source.kind === 'platform-api' &&
      (ui.source.api === UI_SOURCE_API || ui.source.api === 'UIContext.getFrameNodeById') &&
      ui.source.provenance === 'peer-reported' &&
      ui.status === 'captured' && ui.sampled && Number.isSafeInteger(ui.dropped) && ui.dropped >= 0 &&
      ui.records.length > 0 && ui.records.length <= 256, 'EXPORT_SAMPLE_INVALID');
    for (const record of ui.records) {
      const structural = keysOf(record, ['clock', 'payload']);
      keysOf(structural['clock'], ['clockId', 'bootId', 'wallTimeUtc', 'monotonicNs', 'offsetUncertaintyMs']);
      const geometry = ui.source.api === UI_SOURCE_API;
      const payload = keysOf(structural['payload'], geometry ?
        ['windowId', 'nodeId', 'parentId', 'role', 'childCount', 'bounds', 'visible'] :
        ['windowId', 'nodeId', 'parentId', 'role', 'childCount']);
      if (geometry) {
        const bounds = keysOf(payload['bounds'], ['x', 'y', 'width', 'height', 'unit', 'origin']);
        requireWire(bounds['unit'] === 'vp' && bounds['origin'] === 'window' &&
          typeof payload['visible'] === 'boolean', 'EXPORT_SAMPLE_INVALID');
        for (const key of ['x', 'y', 'width', 'height']) {
          requireWire(typeof bounds[key] === 'number' && Number.isFinite(bounds[key]) &&
            ((key === 'x' || key === 'y') || (bounds[key] as number) >= 0), 'EXPORT_SAMPLE_INVALID');
        }
      }
    }
    const uiDescriptor: Record<string, Object> = {
      'path': ui.path, 'domain': 'ui', 'source': ui.source, 'status': ui.status,
      'count': ui.records.length, 'dropped': ui.dropped, 'sampled': true, 'representation': 'structural-metadata'
    };
    descriptors.push(uiDescriptor);
  }
  if (network !== undefined) {
    requireWire(network.path === KIT_NETWORK_PATH && network.source.id === 'registered-http' &&
      network.source.kind === 'registered-adapter' && network.source.api === 'HttpRequest.request' &&
      network.source.provenance === 'peer-reported' && network.status === 'summary-only' && network.sampled &&
      Number.isSafeInteger(network.dropped) && network.dropped >= 0 && network.records.length === 1, 'EXPORT_SAMPLE_INVALID');
    const record = keysOf(network.records[0], Object.keys(sample));
    for (const key of Object.keys(identity)) {
      requireWire(record[key] === identity[key], 'EXPORT_SAMPLE_INVALID');
    }
    requireWire(record['channel'] === 'app.network' && record['capability'] === 'app.network.read' &&
      record['sessionEpoch'] === sample['sessionEpoch'], 'EXPORT_SAMPLE_INVALID');
    const networkPayload = record['payload'] as Record<string, Object>;
    keysOf(networkPayload, networkPayload['status'] === undefined ?
      ['requestId', 'method', 'durationMs'] : ['requestId', 'method', 'durationMs', 'status']);
    const networkRedaction = keysOf(record['redaction'], ['policyId', 'fieldsRemoved']);
    requireWire(networkRedaction['policyId'] === 'network-metadata-only-v1' && networkRedaction['fieldsRemoved'] === 0,
      'EXPORT_SAMPLE_INVALID');
    const networkDescriptor: Record<string, Object> = {
      'path': network.path, 'domain': 'network-summary', 'source': network.source, 'status': network.status,
      'count': 1, 'dropped': network.dropped, 'sampled': true, 'representation': 'domain-summary'
    };
    descriptors.push(networkDescriptor);
  }
  const networkRecords: Record<string, Object>[] = network === undefined ? [] : network.records.slice();
  for (const webFile of webFiles) {
    if (webFile.path === KIT_NETWORK_PATH) {
      networkRecords.push(webFile.records[0]);
      const existing = descriptors.find((entry: Record<string, Object>) => entry['domain'] === 'network-summary');
      if (existing !== undefined) {
        existing['count'] = networkRecords.length;
        existing['dropped'] = (existing['dropped'] as number) + webFile.dropped;
        const combinedSource: Record<string, Object> = {
          'id': 'registered-http-and-web', 'kind': 'registered-adapter',
          'api': 'HttpRequest.request.Web.onPageBegin.onPageEnd', 'provenance': 'peer-reported'
        };
        existing['source'] = combinedSource;
        continue;
      }
    }
    const webDescriptor: Record<string, Object> = {
      'path': webFile.path, 'domain': webFile.path === KIT_NETWORK_PATH ? 'network-summary' :
        webFile.path === KIT_WEB_STORAGE_PATH ? 'arkweb' : webFile.path.endsWith('.jsonl') ? 'web-console' : 'web-dom',
      'source': webFile.source, 'status': webFile.status, 'count': webFile.records.length,
      'dropped': webFile.dropped, 'sampled': true,
      'representation': webFile.path.endsWith('.jsonl') ? 'domain-summary' : 'structural-metadata'
    };
    descriptors.push(webDescriptor);
  }
  const domains = (JSON.parse(KIT_DOMAIN_NAMES) as string[]).map((domain: string): Record<string, Object> => {
    const selected = descriptors.find((entry: Record<string, Object>) => entry['domain'] === domain);
    return { 'domain': domain, 'count': selected !== undefined ? selected['count'] : 0,
      'status': selected !== undefined ? selected['status'] : 'not-captured',
      'reason': selected !== undefined ? 'provided' : 'not-captured' };
  });
  const profile: Record<string, Object> = {
    'profile': 'kit-readonly-v1', 'identity': identity, 'provenance': 'peer-reported',
    'privacy': 'memory-only-text-excluded', 'attachmentPolicy': 'none', 'files': descriptors, 'domains': domains
  };
  const files: ArchiveTextFile[] = [
    { path: 'session.json', text: canonical(session) }, { path: 'events.jsonl', text: '' }
  ];
  const schemas = JSON.parse(readonly ? KIT_READONLY_EXPORT_SCHEMAS : KIT_EXPORT_SCHEMAS) as Record<string, Object>;
  for (const name of Object.keys(schemas)) { files.push({ path: name, text: canonical(schemas[name]) }); }
  const sampleText = memoryRecords.map((record: Record<string, Object>): string => canonical(record) + '\n').join('');
  files.push({ path: KIT_MEMORY_PATH, text: sampleText }, { path: 'profile.json', text: canonical(profile) });
  if (dfxRecord !== undefined) { files.push({ path: KIT_DFX_PATH, text: canonical(dfxRecord) + '\n' }); }
  if (ui !== undefined) { files.push({ path: ui.path, text: canonical(ui.records) }); }
  if (networkRecords.length > 0) {
    files.push({ path: KIT_NETWORK_PATH, text: networkRecords.map((record: Record<string, Object>): string => canonical(record) + '\n').join('') });
  }
  for (const webFile of webFiles) {
    if (webFile.path !== KIT_NETWORK_PATH) {
      files.push({ path: webFile.path, text: webFile.path.endsWith('.jsonl') ?
        canonical(webFile.records[0]) + '\n' : canonical(webFile.records) });
    }
  }
  const entries = files.map((entry: ArchiveTextFile): ArchiveEntry => {
    return { path: entry.path, bytes: port.encode(entry.text) };
  });
  const manifestFiles = files.map((entry: ArchiveTextFile, index: number): Record<string, Object> => {
    return { 'path': entry.path, 'type': entry.path.startsWith('schemas/') ? 'json-schema' :
      entry.path.endsWith('.jsonl') ? 'jsonl' : 'json', 'size': entries[index].bytes.length,
      'sha256': port.hash(entry.text), 'sensitivity': entry.path.startsWith('schemas/') ? 'public-schema' : 'redacted-summary',
      'compression': 'store' };
  });
  const manifest: Record<string, Object> = {
    'format': 'ohmate-problem', 'schemaVersion': '1.4',
    'problemId': 'problem-' + port.hash(sampleText + (ui === undefined ? '' : canonical(ui.records)) +
      (network === undefined ? '' : canonical(network.records)) + (webFiles.length === 0 ? '' : canonical(webFiles)) +
      (dfxRecord === undefined ? '' : canonical(dfxRecord))).slice(0, 32),
    'sessionId': identity['sessionId'], 'content': 'kit-readonly', 'integrity': 'sha256-not-signature', 'files': manifestFiles
  };
  const manifestEntry: ArchiveEntry = { path: 'manifest.json', bytes: port.encode(canonical(manifest)) };
  entries.unshift(manifestEntry);
  return storedZip(entries, port);
}
