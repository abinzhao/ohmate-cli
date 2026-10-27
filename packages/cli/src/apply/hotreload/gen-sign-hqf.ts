/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import json5 from 'json5';
import { execa } from 'execa';
import { ToolProvider } from '../../toolchain';
import { debugLog } from '../../utils/logger.js';
import { resolveModuleSrcPath } from '../module-path.js';

export interface GenSignHqfResult {
  success?: boolean;
  signedHqfPaths: string[];
  unsignedHqfPath?: string;
  message: string;
}

interface SigningConfig {
  storeFile?: string;
  storePassword?: string;
  keyAlias?: string;
  keyPassword?: string;
  profile?: string;
  certpath?: string;
  signAlg?: string;
}

class DecipherUtil {
  private static COMPONENT = new Int8Array([
    49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119,
  ]);
  private static DIRS = ['fd', 'ac', 'ce'];

  static decryptPwd(materialDir: string, encrypted: string, label: string): string {
    if (encrypted.length < 32 || encrypted.length % 2 !== 0) {
      throw new Error(`Invalid encrypted password for ${label}`);
    }
    debugLog(`[DecipherUtil] Decrypting ${label}, encrypted length: ${encrypted.length}`);
    const actualDir = path.resolve(materialDir, 'material');
    const key = DecipherUtil.getKey(actualDir, label);
    const data = new Int8Array(Buffer.from(encrypted, 'hex'));
    debugLog(`[DecipherUtil] Data length: ${data.length}, key length: ${key.length}`);
    const result = DecipherUtil.decrypt(key, data);
    return result.toString('utf-8');
  }

  private static getKey(materialDir: string, label: string): Int8Array {
    const fdPath = path.resolve(materialDir, DecipherUtil.DIRS[0]);
    const components = DecipherUtil.readFd(fdPath, label);
    const salt = DecipherUtil.readDirBytes(
      path.resolve(materialDir, DecipherUtil.DIRS[1]),
      label
    );
    const rootKey = DecipherUtil.getRootKey(components, salt, label);
    const workMaterial = DecipherUtil.readDirBytes(
      path.resolve(materialDir, DecipherUtil.DIRS[2]),
      label
    );
    return new Int8Array(DecipherUtil.decrypt(rootKey, workMaterial));
  }

  private static getRootKey(
    components: Int8Array[],
    salt: Int8Array,
    label: string
  ): Int8Array {
    if (!components.every((c) => c.length === 16)) {
      throw new Error(`Signing material data error for ${label}`);
    }
    const merged = [...components, DecipherUtil.COMPONENT];
    let result = DecipherUtil.xor(merged[0], merged[1], label);
    for (let i = 2; i < merged.length; i++) {
      result = DecipherUtil.xor(result, merged[i], label);
    }
    const derived = crypto.pbkdf2Sync(
      Buffer.from(result).toString(),
      Buffer.from(salt),
      10000,
      16,
      'sha256'
    );
    return new Int8Array(derived);
  }

  private static xor(a: Int8Array, b: Int8Array, label: string): Int8Array {
    if (a.byteLength !== b.byteLength) {
      throw new Error(`Signing material data error for ${label}`);
    }
    const result = new Int8Array(a.byteLength);
    for (let i = 0; i < a.byteLength; i++) {
      result[i] = a[i] ^ b[i];
    }
    return result;
  }

  private static decrypt(key: Int8Array, data: Int8Array): Buffer {
    const headerVal =
      ((255 & data[0]) << 24) |
      ((255 & data[1]) << 16) |
      ((255 & data[2]) << 8) |
      (255 & data[3]);
    const ivLen = data.length - 4 - headerVal;
    const iv = data.slice(4, 4 + ivLen);
    const authTag = data.slice(data.length - 16);
    const cipher = crypto.createDecipheriv(
      'aes-128-gcm',
      Buffer.from(key),
      Buffer.from(iv)
    );
    cipher.setAuthTag(Buffer.from(authTag));
    const updated = cipher.update(
      Buffer.from(data.subarray(4 + ivLen, data.length - 16))
    );
    const finalized = cipher.final();
    return Buffer.concat([updated, finalized]);
  }

  private static readFd(fdPath: string, label: string): Int8Array[] {
    const entries = fs.readdirSync(fdPath).filter((e) => e !== '.DS_Store');
    if (entries.length !== 3) {
      throw new Error(`fd directory must have 3 entries for ${label}`);
    }
    const result: Int8Array[] = [];
    for (const name of entries) {
      const subPath = path.join(fdPath, name);
      result.push(DecipherUtil.readDirBytes(subPath, label));
    }
    return result;
  }

  private static readDirBytes(dirPath: string, label: string): Int8Array {
    const stat = fs.statSync(dirPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(dirPath).filter((e) => e !== '.DS_Store');
      if (files.length !== 1) {
        throw new Error(`Expected exactly 1 file in ${dirPath} for ${label}`);
      }
      return new Int8Array(fs.readFileSync(path.join(dirPath, files[0])));
    }
    return new Int8Array(fs.readFileSync(dirPath));
  }
}

export class GenSignHqf {
  private toolProvider: ToolProvider;
  private readonly projectRoot: string;
  private env: Record<string, string>;

  constructor(toolProvider: ToolProvider, projectRoot: string) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;

    const javaBinDir = path.dirname(toolProvider.javaPath);
    const newPath = `${javaBinDir}${path.delimiter}${process.env.PATH || ''}`;
    this.env = {
      ...process.env,
      PATH: newPath,
      DEVECO_SDK_HOME: toolProvider.sdkPath,
    } as Record<string, string>;
  }

  public async generateAndSign(
    moduleName: string,
    abcOutputDir: string,
    patchJsonPath: string,
    productName: string,
    skipSign = false
  ): Promise<GenSignHqfResult> {
    const abcCheck = this.checkAbcExists(abcOutputDir);
    if (!abcCheck.exists) {
      return { signedHqfPaths: [], message: abcCheck.message };
    }

    const hqfPaths = this.resolveHqfPaths(moduleName, productName);
    const genResult = await this.generateHqf(
      patchJsonPath,
      abcCheck.abcPath,
      hqfPaths.unsignedHqfPath
    );
    if (!genResult) {
      return {
        signedHqfPaths: [],
        unsignedHqfPath: hqfPaths.unsignedHqfPath,
        message: 'Failed to generate unsigned hqf.',
      };
    }

    if (skipSign) {
      return {
        success: true,
        signedHqfPaths: [hqfPaths.unsignedHqfPath],
        unsignedHqfPath: hqfPaths.unsignedHqfPath,
        message: 'Unsigned hqf generated (signing skipped for emulator).',
      };
    }

    return this.signHqfDirect(hqfPaths.unsignedHqfPath, hqfPaths.signedHqfPath);
  }

  private checkAbcExists(
    abcOutputDir: string
  ): { exists: boolean; abcPath: string; message: string } {
    const abcPath = path.join(abcOutputDir, 'ets', 'modules.abc');
    if (fs.existsSync(abcPath)) {
      return { exists: true, abcPath, message: 'abc file exists.' };
    }

    const found = this.findFirstAbc(abcOutputDir);
    if (found) {
      return { exists: true, abcPath: found, message: 'abc file exists.' };
    }

    // Silent: resolveHqf tries multiple candidate dirs and only reports an
    // error if ALL fail. Logging here spams a scary "not found" for the first
    // candidate even when a later one succeeds.
    const msg = `abc file not found in ${abcOutputDir}.`;
    return { exists: false, abcPath: '', message: msg };
  }

  private findFirstAbc(dir: string): string | null {
    if (!fs.existsSync(dir)) {
      return null;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this.findFirstAbc(fullPath);
        if (found) {
          return found;
        }
      } else if (entry.isFile() && entry.name.endsWith('.abc')) {
        return fullPath;
      }
    }
    return null;
  }

  private resolveHqfPaths(moduleName: string, productName: string): {
    unsignedHqfPath: string;
    signedHqfPath: string;
  } {
    const srcPath = resolveModuleSrcPath(this.projectRoot, moduleName);
    const outputDir = path.join(
      this.projectRoot,
      srcPath,
      'build',
      productName,
      'outputs',
      'default'
    );

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return {
      unsignedHqfPath: path.join(
        outputDir,
        `${moduleName}-default-unsigned.hqf`
      ),
      signedHqfPath: path.join(outputDir, `${moduleName}-default-signed.hqf`),
    };
  }

  private async generateHqf(
    patchJsonPath: string,
    abcPath: string,
    outputHqfPath: string
  ): Promise<boolean> {
    const packingToolPath = this.resolvePackingTool();
    if (!packingToolPath) {
      console.error('[HotReload] app_packing_tool.jar not found in SDK.');
      return false;
    }

    const etsPath = path.dirname(abcPath);
    const javaPath = this.toolProvider.javaPath;
    const args = [
      '-jar', packingToolPath, '--mode', 'hqf',
      '--json-path', patchJsonPath, '--ets-path', etsPath,
      '--out-path', outputHqfPath, '--force', 'true',
    ];
    debugLog(`[GenSignHqf] Packing: ${javaPath} ${args.join(' ')}`);

    try {
      const tPack = Date.now();
      const result = await execa(javaPath, args, {
        cwd: this.projectRoot, stdout: 'pipe', stderr: 'pipe', reject: false,
      });
      console.log(`[Timing] pack (JVM#1): ${Date.now() - tPack}ms`);
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.error(result.stderr);
      }
      if (result.exitCode !== 0) {
        console.error(`[HotReload] app_packing_tool failed with exit code ${result.exitCode}`);
        return false;
      }
      if (!fs.existsSync(outputHqfPath)) {
        console.error(`[HotReload] hqf not generated at ${outputHqfPath}`);
        return false;
      }
      console.log(`[HotReload] Unsigned hqf generated: ${outputHqfPath}`);
      return true;
    } catch (error) {
      console.error(`[HotReload] Packing hqf failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async signHqfDirect(
    unsignedHqfPath: string,
    signedHqfPath: string
  ): Promise<GenSignHqfResult> {
    const signConfig = this.resolveSignConfig();
    if (!signConfig) {
      return this.signFailResult(unsignedHqfPath, 'Signing prerequisites not met.');
    }

    const signArgs = this.buildSignArgs(signConfig, unsignedHqfPath, signedHqfPath);
    const javaPath = this.toolProvider.javaPath;
    const logSafeArgs = signArgs.map((item, i) =>
      i > 0 && ['-keyPwd', '-keystorePwd'].includes(signArgs[i - 1]) ? '******' : item
    );
    debugLog(`[GenSignHqf] Signing: ${javaPath} ${logSafeArgs.join(' ')}`);

    try {
      const tSign = Date.now();
      const result = await execa(javaPath, signArgs, { cwd: this.projectRoot, stdout: 'pipe', stderr: 'pipe', reject: false });
      console.log(`[Timing] sign (JVM#2): ${Date.now() - tSign}ms`);
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.error(result.stderr);
      }
      if (result.exitCode !== 0) {
        return this.signFailResult(unsignedHqfPath, `hqf signing failed with exit code ${result.exitCode}`);
      }
      if (!fs.existsSync(signedHqfPath)) {
        return this.signFailResult(unsignedHqfPath, `Signed hqf not generated at ${signedHqfPath}`);
      }
      console.log(`[HotReload] Signed hqf generated: ${signedHqfPath}`);
      return { success: true, signedHqfPaths: [signedHqfPath], unsignedHqfPath, message: 'hqf generated and signed successfully.' };
    } catch (error) {
      return this.signFailResult(unsignedHqfPath, `hqf signing failed: ${(error as Error).message}`);
    }
  }

  private resolveSignConfig(): {
    signToolPath: string;
    storePwd: string;
    keyPwd: string;
    signingConfig: SigningConfig;
  } | null {
    const signToolPath = this.resolveSignTool();
    if (!signToolPath) {
      return null;
    }
    const signingConfig = this.readSigningConfig('default');
    if (!signingConfig?.storeFile || !signingConfig?.certpath || !signingConfig?.profile) {
      return null;
    }
    const materialDir = this.resolveMaterialDir();
    if (!materialDir) {
      return null;
    }
    try {
      const storePwd = DecipherUtil.decryptPwd(materialDir, signingConfig.storePassword!, 'storePassword');
      const keyPwd = DecipherUtil.decryptPwd(materialDir, signingConfig.keyPassword!, 'keyPassword');
      return { signToolPath, storePwd, keyPwd, signingConfig };
    } catch {
      return null;
    }
  }

  private buildSignArgs(
    cfg: { signToolPath: string; storePwd: string; keyPwd: string; signingConfig: SigningConfig },
    unsignedHqfPath: string,
    signedHqfPath: string
  ): string[] {
    return [
      '-jar', cfg.signToolPath, 'sign-app', '-mode', 'localSign',
      '-keyAlias', cfg.signingConfig.keyAlias || 'debugKey',
      '-keyPwd', cfg.keyPwd,
      '-keystoreFile', cfg.signingConfig.storeFile!,
      '-keystorePwd', cfg.storePwd,
      '-appCertFile', cfg.signingConfig.certpath!,
      '-profileFile', cfg.signingConfig.profile!,
      '-inFile', unsignedHqfPath,
      '-outFile', signedHqfPath,
      '-signAlg', cfg.signingConfig.signAlg || 'SHA256withECDSA',
    ];
  }

  private resolveMaterialDir(): string | null {
    const signingConfig = this.readSigningConfig('default');
    if (!signingConfig?.storeFile) {
      return null;
    }
    const materialDir = path.resolve(signingConfig.storeFile, '..');
    const matSubDir = path.join(materialDir, 'material');
    return fs.existsSync(matSubDir) ? materialDir : null;
  }

  private readSigningConfig(productName: string): SigningConfig | null {
    const profilePath = path.join(this.projectRoot, 'build-profile.json5');
    if (!fs.existsSync(profilePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const profile = json5.parse(content) as {
        app?: {
          signingConfigs?: Array<{ name: string; material: SigningConfig }>;
          products?: Array<{ name: string; signingConfig?: string }>;
        };
      };
      const product = profile.app?.products?.find((p) => p.name === productName);
      const configName = product?.signingConfig;
      if (!configName) {
        return null;
      }
      return (
        profile.app?.signingConfigs?.find((c) => c.name === configName)?.material ?? null
      );
    } catch {
      return null;
    }
  }

  private resolveSignTool(): string | null {
    const sdkPath = this.toolProvider.sdkPath;
    const candidates = [
      path.join(sdkPath, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar'),
      path.join(sdkPath, 'toolchains', 'lib', 'hap-sign-tool.jar'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  private signFailResult(
    unsignedHqfPath: string,
    message: string
  ): GenSignHqfResult {
    console.error(`[HotReload] ${message}`);
    return {
      success: false,
      signedHqfPaths: [],
      unsignedHqfPath,
      message,
    };
  }

  private resolvePackingTool(): string | null {
    const sdkPath = this.toolProvider.sdkPath;
    const candidates = [
      path.join(sdkPath, 'default', 'openharmony', 'toolchains', 'lib', 'app_packing_tool.jar'),
      path.join(sdkPath, 'toolchains', 'lib', 'app_packing_tool.jar'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }
}
