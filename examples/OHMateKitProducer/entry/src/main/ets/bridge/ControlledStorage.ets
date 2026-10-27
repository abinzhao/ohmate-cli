/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, requireWire, match } from './Wire';

export interface ControlledStorageKey { area: string; key: string; sensitivity: string; }
export interface ControlledStorageAccess { enabled: () => boolean; entries: ControlledStorageKey[]; }
export interface ControlledStorageValue { area: string; key: string; value: string | null; }
interface ControlledStorageResult { url: string; entries: ControlledStorageValue[]; }

export function storageKeys(access: ControlledStorageAccess | undefined): ControlledStorageKey[] {
  if (access === undefined) { return []; }
  requireWire(typeof access.enabled === 'function' && Array.isArray(access.entries) &&
    access.entries.length > 0 && access.entries.length <= 16, 'STORAGE_ACCESS_INVALID');
  const result: ControlledStorageKey[] = [];
  for (const item of access.entries) {
    requireWire(item !== null && typeof item === 'object' && !Array.isArray(item) &&
      Object.keys(item).every((key: string) => ['area', 'key', 'sensitivity'].includes(key)) &&
      ['local', 'session'].includes(item.area) && item.sensitivity === 'ordinary' &&
      typeof item.key === 'string' && match(item.key, '^ohmate-test-[a-z0-9-]{1,64}$') &&
      !result.some((entry: ControlledStorageKey): boolean => entry.area === item.area && entry.key === item.key),
    'STORAGE_ACCESS_INVALID');
    result.push({ area: item.area, key: item.key, sensitivity: 'ordinary' });
  }
  return result;
}
export function storageScript(url: string, keys: ControlledStorageKey[]): string {
  // JSON literals and a fixed getItem-only body: no enumeration, caller code or writes.
  return '(()=>{const expected=' + JSON.stringify(url) + ';const keys=' + JSON.stringify(keys) +
    ';if(location.href!==expected)throw Error("STORAGE_SOURCE_CHANGED");' +
    'const entries=keys.map(k=>{const value=(k.area==="local"?window.localStorage:window.sessionStorage).getItem(k.key);' +
    'if(value!==null&&(typeof value!=="string"||value.length>1024))throw Error("STORAGE_LIMIT");' +
    'return {area:k.area,key:k.key,value};});if(location.href!==expected)throw Error("STORAGE_SOURCE_CHANGED");' +
    'const text=JSON.stringify({url:location.href,entries});if(text.length>4096)throw Error("STORAGE_LIMIT");return text;})()';
}
export function projectStorage(crypto: CryptoPort, text: string, url: string,
  keys: ControlledStorageKey[]): ControlledStorageValue[] {
  requireWire(typeof text === 'string' && text.length <= 4096, 'STORAGE_RESULT_INVALID');
  const bytes = crypto.encode(text);
  try { requireWire(bytes.length <= 4096 && crypto.decode(bytes) === text, 'STORAGE_RESULT_INVALID'); }
  finally { bytes.fill(0); }
  const root = JSON.parse(text) as ControlledStorageResult;
  requireWire(root !== null && typeof root === 'object' && !Array.isArray(root) &&
    Object.keys(root).length === 2 && Object.keys(root).every((key: string) => ['url', 'entries'].includes(key)) &&
    root.url === url && Array.isArray(root.entries) && root.entries.length === keys.length, 'STORAGE_RESULT_INVALID');
  const result: ControlledStorageValue[] = [];
  for (let index = 0; index < keys.length; index++) {
    const item = root.entries[index];
    requireWire(item !== null && typeof item === 'object' && !Array.isArray(item) &&
      Object.keys(item).length === 3 && Object.keys(item).every((key: string) => ['area', 'key', 'value'].includes(key)) &&
      item.area === keys[index].area && item.key === keys[index].key &&
      (item.value === null || (typeof item.value === 'string' && item.value.length <= 1024)),
    'STORAGE_RESULT_INVALID');
    if (item.value !== null) {
      const valueBytes = crypto.encode(item.value);
      try { requireWire(crypto.decode(valueBytes) === item.value, 'STORAGE_RESULT_INVALID'); }
      finally { valueBytes.fill(0); }
    }
    result.push({ area: item.area, key: item.key, value: item.value });
  }
  return result;
}

export interface StorageMutation {
  url: string; area: string; key: string; commandId: string; mode: string;
  expected: string | null; replacement: string | null; original: string | null; deadline: number;
}
interface StorageMutationResult {
  url: string; area: string; key: string; commandId: string; mode: string; outcome: string;
}
export function storageMutationScript(input: StorageMutation): string {
  // One synchronous compare and mutation, then verification. Restore must never
  // overwrite a value different from both our replacement and the original.
  return '(()=>{const c=' + JSON.stringify(input) + ';' +
    'const valid=()=>location.href===c.url&&Number.isSafeInteger(Date.now())&&Date.now()<c.deadline;' +
    'if(!valid())throw Error("STORAGE_SOURCE_CHANGED");' +
    'const s=c.area==="local"?window.localStorage:window.sessionStorage;' +
    'const result=outcome=>JSON.stringify({url:c.url,area:c.area,key:c.key,commandId:c.commandId,mode:c.mode,outcome});' +
    'const current=s.getItem(c.key);if(!valid())throw Error("STORAGE_SOURCE_CHANGED");' +
    'if(c.mode==="restore"&&current===c.original)return result("restored");' +
    'if(current!==c.expected)return result("conflict");' +
    'if(c.replacement===null)s.removeItem(c.key);else s.setItem(c.key,c.replacement);' +
    'if(!valid())throw Error("STORAGE_SOURCE_CHANGED");' +
    'return result(s.getItem(c.key)===c.replacement?(c.mode==="restore"?"restored":"applied"):"unknown");})()';
}
export function projectStorageMutation(crypto: CryptoPort, text: string, input: StorageMutation): string {
  requireWire(typeof text === 'string' && text.length <= 512, 'STORAGE_MUTATION_INVALID');
  const bytes = crypto.encode(text);
  try { requireWire(bytes.length <= 512 && crypto.decode(bytes) === text, 'STORAGE_MUTATION_INVALID'); }
  finally { bytes.fill(0); }
  const result = JSON.parse(text) as StorageMutationResult;
  requireWire(result !== null && typeof result === 'object' && !Array.isArray(result) &&
    Object.keys(result).length === 6 && Object.keys(result).every((key: string): boolean =>
      ['url', 'area', 'key', 'commandId', 'mode', 'outcome'].includes(key)) &&
    result.url === input.url && result.area === input.area && result.key === input.key &&
    result.commandId === input.commandId && result.mode === input.mode &&
    ['conflict', 'unknown', input.mode === 'restore' ? 'restored' : 'applied'].includes(result.outcome),
  'STORAGE_MUTATION_INVALID');
  return result.outcome;
}
