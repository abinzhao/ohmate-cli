/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { LocalCrypto } from '../utils/local-crypto.js';
import { AppConfig } from '../auth-config';
import { debugLog } from '../../utils/logger';
import { getCliDataDir } from '../../utils/cli-data-dir.js';

export function isDevecoCodeAuth(): boolean {
  return process.env.DEVECO_CLI_AUTH_SOURCE === AppConfig.AUTH_SOURCE_DEVECO_CODE;
}

export class TokenStorage {
  private getLocalTokenFilePath(): string {
    const configPath =
      process.env.DEVECO_CLI_DATA_DIR
        ? getCliDataDir()
        : path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
    return path.join(configPath, AppConfig.TOKEN_FILE_NAME);
  }

  /**
   * 确保配置目录存在
   */
  private ensureConfigDir(): void {
    const dir = path.dirname(this.getLocalTokenFilePath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * 保存 JWT Token 到磁盘
   * 使用 LocalCrypto 加密后存储
   */
  public async saveJwtToken(token: string): Promise<void> {
    if (!token) {
      throw new Error('Token is empty');
    }

    const tokenData = LocalCrypto.encryptForLocalStorage(token);
    this.ensureConfigDir();
    const tokenFilePath = this.getLocalTokenFilePath();
    fs.writeFileSync(tokenFilePath, JSON.stringify(tokenData, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * 从磁盘加载 JWT Token
   * 如果设置了 DEVECO_CLI_AUTH_SOURCE=deveco-code，从DEVECO_CODE_AUTH_DIR读取
   * 否则读取 CLI 本地存储的 token。
   */
  public async loadJwtToken(): Promise<string | null> {
    if (isDevecoCodeAuth()) {
      return this.loadDevecoCodeToken();
    }
    return this.loadLocalJwtToken();
  }

  private loadDevecoCodeToken(): string | null {
    if (!isDevecoCodeAuth()) {
      return null;
    }
    const configDir = process.env.DEVECO_CODE_AUTH_DIR?.trim();
    if (!configDir) {
      return null;
    }

    const resolvedDir = path.resolve(configDir);

    try {
      const tokenFilePath = path.join(resolvedDir, AppConfig.TOKEN_FILE_NAME);
      if (!fs.existsSync(tokenFilePath)) {
        return null;
      }
      const tokenData: unknown = JSON.parse(
        fs.readFileSync(tokenFilePath, 'utf8')
      );
      if (!LocalCrypto.isEncryptedBlob(tokenData)) {
        return null;
      }
      return LocalCrypto.decryptForLocalStorageFromDirectory(
        tokenData,
        configDir
      );
    } catch {
      return null;
    }
  }

  private async loadLocalJwtToken(): Promise<string | null> {
    const tokenFilePath = this.getLocalTokenFilePath();
    try {
      if (!fs.existsSync(tokenFilePath)) {
        return null;
      }

      const tokenData = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
      if (!LocalCrypto.isEncryptedBlob(tokenData)) {
        return null;
      }
      return LocalCrypto.decryptForLocalStorage(tokenData);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
        return null;
      }
      await this.clearToken();
      return null;
    }
  }

  /**
   * 清除存储的 Token
   */
  public async clearToken(): Promise<void> {
    if (isDevecoCodeAuth()) {
      debugLog('clearToken: skipped, session managed by DevEco Code');
      return;
    }
    const tokenFilePath = this.getLocalTokenFilePath();
    try {
      if (fs.existsSync(tokenFilePath)) {
        fs.unlinkSync(tokenFilePath);
      }
    } catch (err) {
      throw new Error('Failed to clear token', { cause: err });
    }
  }
}

/** Token 存储单例实例 */
export const tokenStorage = new TokenStorage();
