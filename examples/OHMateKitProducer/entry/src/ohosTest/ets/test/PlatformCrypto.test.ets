/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from '@ohos/hypium';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { PlatformCrypto } from '../../../main/ets/bridge/PlatformCrypto';
import { hex, unhex } from '../../../main/ets/bridge/Wire';

export default function platformCryptoTests(): void {
  describe('OHMatePlatformCrypto', () => {
    it('sha256_and_rfc4231_hmac', 0, () => {
      const crypto = new PlatformCrypto();
      expect(crypto.hash('abc')).assertEqual('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(crypto.proof(new Uint8Array(20).fill(0x0b), 'Hi There'))
        .assertEqual('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
      crypto.clear();
    });
    it('rfc5869_hkdf_sha256', 0, () => {
      const spec: cryptoFramework.HKDFSpec = {
        algName: 'HKDF', key: new Uint8Array(22).fill(0x0b),
        salt: unhex('000102030405060708090a0b0c'), info: unhex('f0f1f2f3f4f5f6f7f8f9'), keySize: 42
      };
      const key = cryptoFramework.createKdf('HKDF|SHA256').generateSecretSync(spec).data;
      try {
        expect(hex(key)).assertEqual('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
      } finally { key.fill(0); }
    });
    it('aes256_gcm_nist_zero_block_and_tamper', 0, () => {
      const key = cryptoFramework.createSymKeyGenerator('AES256').convertKeySync({ data: new Uint8Array(32) });
      try {
        const spec: cryptoFramework.GcmParamsSpec = {
          algName: 'GcmParamsSpec', iv: { data: new Uint8Array(12) },
          aad: { data: new Uint8Array() }, authTag: { data: new Uint8Array(16) }
        };
        const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
        cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, key, spec);
        const output = cipher.doFinalSync({ data: new Uint8Array(16) }).data;
        expect(hex(output)).assertEqual('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
        spec.authTag = { data: output.slice(16) };
        const decipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
        decipher.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, key, spec);
        expect(hex(decipher.doFinalSync({ data: output.slice(0, 16) }).data)).assertEqual('00000000000000000000000000000000');
        spec.authTag.data[0] ^= 1;
        let rejected = false;
        try {
          const tampered = cryptoFramework.createCipher('AES256|GCM|NoPadding');
          tampered.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, key, spec);
          tampered.doFinalSync({ data: output.slice(0, 16) });
        } catch { rejected = true; }
        expect(rejected).assertTrue();
      } finally { key.clearMem(); }
    });
    it('p256_spki_and_ecdh_direction_key_agreement', 0, () => {
      const left = new PlatformCrypto();
      const right = new PlatformCrypto();
      try {
        const leftPublic = left.ephemeral();
        const rightPublic = right.ephemeral();
        expect(hex(left.unbase64(leftPublic).slice(0, 27))).assertEqual('3059301306072a8648ce3d020106082a8648ce3d03010703420004');
        left.derive(rightPublic, 'a'.repeat(64));
        right.derive(leftPublic, 'a'.repeat(64));
        const input = left.encode('OHMate 设备');
        const aad = left.encode('test-only');
        const iv = new Uint8Array(12);
        // Each independent endpoint seals once with its kit-to-cli key.
        expect(hex(left.encrypt(input, iv, aad))).assertEqual(hex(right.encrypt(input, iv, aad)));
      } finally { left.clear(); right.clear(); }
    });
  });
}
