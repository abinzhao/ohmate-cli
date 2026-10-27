/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { getCliDataDir } from '../../../utils/cli-data-dir.js';
import type { Config } from '../common/config.js';
import type { Logger } from '../common/logger.js';

export interface FastModeStoreOptions {
  config?: Config;
  dir?: string;
  logger?: Logger | null;
}

export interface FastModeEndpointEntry {
  hostPort: number;
  deviceEndpoint: string;
  style: 'unix' | 'tcp';
  agentVersion: string | null;
  uitestVersion: string | null;
  savedAt: string;
}

export interface FastModeDoc {
  serial: string;
  createdAt: string;
  updatedAt: string;
  hdcServer?: string;
  endpoints: Record<string, FastModeEndpointEntry>;
}

export interface FastModeSaveRecord {
  endpoint: string;
  hostPort: number;
  deviceEndpoint: string;
  style: 'unix' | 'tcp';
  agentVersion?: string | null;
  uitestVersion?: string | null;
  hdcServer?: string;
}

/** Unsafe filesystem characters in SN are uniformly replaced with _ */
export function sanitizeSerial(serial: string): string {
  return String(serial || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

export const DEFAULT_STATE_DIR = join(getCliDataDir(), 'fast-mode');

export class FastModeStore {
  config: Config | undefined;
  logger: Logger | null;
  _explicitDir: string | undefined;

  constructor({ config, dir, logger }: FastModeStoreOptions = {}) {
    this.config = config;
    this.logger = logger ? logger.child('FastModeStore') : null;
    this._explicitDir = dir;
  }

  get dir(): string {
    if (this._explicitDir) {
      return this._explicitDir;
    }
    if (this.config) {
      const configured = this.config.get('device.fastModeDir');
      if (configured !== undefined && typeof configured !== 'string') {
        throw new TypeError('device.fastModeDir must be a string');
      }
      if (configured) {
        return configured;
      }
    }
    return DEFAULT_STATE_DIR;
  }

  pathFor(serial: string): string {
    return join(this.dir, `${sanitizeSerial(serial)}.json`);
  }

  async _ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async save(serial: string, record: FastModeSaveRecord): Promise<FastModeDoc> {
    await this._ensureDir();
    const doc: FastModeDoc = (await this.read(serial)) || {
      serial,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      endpoints: {},
    };
    doc.serial = serial;
    doc.updatedAt = new Date().toISOString();
    if (!doc.createdAt || doc.createdAt === new Date(0).toISOString()) {
      doc.createdAt = doc.updatedAt;
    }
    doc.hdcServer = record.hdcServer || doc.hdcServer || '';
    doc.endpoints[record.endpoint] = {
      hostPort: record.hostPort,
      deviceEndpoint: record.deviceEndpoint,
      style: record.style,
      agentVersion: record.agentVersion || null,
      uitestVersion: record.uitestVersion || null,
      savedAt: doc.updatedAt,
    };
    const file = this.pathFor(serial);
    await writeFile(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
    if (this.logger) {
      this.logger.debug(`saved fast-mode state for ${serial}: ${record.endpoint} -> tcp:${record.hostPort}`);
    }
    return doc;
  }

  async read(serial: string): Promise<FastModeDoc | null> {
    try {
      const raw = await readFile(this.pathFor(serial), 'utf8');
      const doc = JSON.parse(raw) as FastModeDoc;
      if (!doc || typeof doc !== 'object' || !doc.endpoints) {
        return null;
      }
      return doc;
    } catch {
      return null;
    }
  }

  async get(serial: string, endpoint: string): Promise<FastModeEndpointEntry | null> {
    const doc = await this.read(serial);
    return doc && doc.endpoints ? doc.endpoints[endpoint] || null : null;
  }

  async forget(serial: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(serial));
      if (this.logger) {
        this.logger.debug(`removed fast-mode state for ${serial}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async forgetEndpoint(serial: string, endpoint: string): Promise<boolean> {
    const doc = await this.read(serial);
    if (!doc || !doc.endpoints[endpoint]) {
      return false;
    }
    doc.endpoints = Object.fromEntries(
      Object.entries(doc.endpoints).filter(([k]) => k !== endpoint)
    );
    if (!Object.keys(doc.endpoints).length) {
      return this.forget(serial);
    }
    await this._ensureDir();
    await writeFile(this.pathFor(serial), JSON.stringify(doc, null, 2), { mode: 0o600 });
    return true;
  }

  async list(): Promise<FastModeDoc[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const docs: FastModeDoc[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) {
        continue;
      }
      try {
        docs.push(JSON.parse(await readFile(join(this.dir, f), 'utf8')) as FastModeDoc);
      } catch {
        /* Skip corrupted files */
      }
    }
    return docs;
  }
}
