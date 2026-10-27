/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { CryptoPort, hex, unhex, requireWire } from './Wire';

// API26 SDK cryptoFramework: ECC256/SPKI, ECDH, HKDF|SHA256,
// AES256|GCM|NoPadding. GCM doFinalSync appends the 16-byte tag.
export class PlatformCrypto implements CryptoPort {
  private privateKey: cryptoFramework.PriKey | undefined = undefined;
  private sendKey: cryptoFramework.SymKey | undefined = undefined;
  private receiveKey: cryptoFramework.SymKey | undefined = undefined;

  encode(text: string): Uint8Array { return new util.TextEncoder().encodeInto(text); }
  decode(bytes: Uint8Array): string {
    return new util.TextDecoder('utf-8', { fatal: true }).decodeToString(bytes);
  }
  base64(bytes: Uint8Array): string { return new util.Base64Helper().encodeToStringSync(bytes); }
  unbase64(text: string): Uint8Array { return new util.Base64Helper().decodeSync(text); }
  random(size: number): Uint8Array { return cryptoFramework.createRandom().generateRandomSync(size).data; }
  hash(text: string): string {
    const digest = cryptoFramework.createMd('SHA256');
    digest.updateSync({ data: this.encode(text) });
    return hex(digest.digestSync().data);
  }
  proof(code: Uint8Array, text: string): string {
    const key = cryptoFramework.createSymKeyGenerator('HMAC').convertKeySync({ data: code });
    try {
      const mac = cryptoFramework.createMac('SHA256');
      mac.initSync(key);
      mac.updateSync({ data: this.encode(text) });
      return hex(mac.doFinalSync().data);
    } finally { key.clearMem(); }
  }
  ephemeral(): string {
    this.clear();
    const pair = cryptoFramework.createAsyKeyGenerator('ECC256').generateKeyPairSync();
    this.privateKey = pair.priKey;
    return this.base64(pair.pubKey.getEncoded().data);
  }
  derive(remote: string, transcript: string): void {
    const privateKey = this.privateKey;
    if (privateKey === undefined) { throw new Error('INVALID_STATE'); }
    let material = new Uint8Array();
    try {
      const peer = cryptoFramework.createAsyKeyGenerator('ECC256').convertKeySync({ data: this.unbase64(remote) }, null);
      material = cryptoFramework.createKeyAgreement('ECC256').generateSecretSync(privateKey, peer.pubKey).data;
      requireWire(material.length === 32, 'PAIRING_INVALID');
      this.sendKey = this.directionKey(material, transcript, 'kit-to-cli');
      this.receiveKey = this.directionKey(material, transcript, 'cli-to-kit');
    } catch {
      this.clear();
      throw new Error('PAIRING_INVALID');
    } finally {
      material.fill(0);
      this.privateKey?.clearMem();
      this.privateKey = undefined;
    }
  }
  private directionKey(material: Uint8Array, transcript: string, direction: string): cryptoFramework.SymKey {
    const spec: cryptoFramework.HKDFSpec = {
      algName: 'HKDF', key: material, salt: unhex(transcript),
      info: this.encode('ohmate/debug/1/' + direction), keySize: 32
    };
    const bytes = cryptoFramework.createKdf('HKDF|SHA256').generateSecretSync(spec).data;
    try { return cryptoFramework.createSymKeyGenerator('AES256').convertKeySync({ data: bytes }); }
    finally { bytes.fill(0); }
  }
  encrypt(bytes: Uint8Array, iv: Uint8Array, aad: Uint8Array): Uint8Array {
    const key = this.sendKey;
    if (key === undefined) { throw new Error('INVALID_STATE'); }
    const spec: cryptoFramework.GcmParamsSpec = {
      algName: 'GcmParamsSpec', iv: { data: iv }, aad: { data: aad }, authTag: { data: new Uint8Array(16) }
    };
    const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
    cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, key, spec);
    return cipher.doFinalSync({ data: bytes }).data;
  }
  decrypt(bytes: Uint8Array, tag: Uint8Array, iv: Uint8Array, aad: Uint8Array): Uint8Array {
    const key = this.receiveKey;
    if (key === undefined) { throw new Error('INVALID_STATE'); }
    const spec: cryptoFramework.GcmParamsSpec = {
      algName: 'GcmParamsSpec', iv: { data: iv }, aad: { data: aad }, authTag: { data: tag }
    };
    const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
    cipher.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, key, spec);
    return cipher.doFinalSync({ data: bytes }).data;
  }
  clear(): void {
    this.privateKey?.clearMem();
    this.sendKey?.clearMem();
    this.receiveKey?.clearMem();
    this.privateKey = undefined;
    this.sendKey = undefined;
    this.receiveKey = undefined;
  }
}
