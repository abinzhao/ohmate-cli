/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export type ConfigOverrides = Record<string, unknown>;

/** @internal Built-in default config (frozen, read-only, modify via clone) */
export const DEFAULT_CONFIG: Readonly<ConfigOverrides> = Object.freeze({
  /** L1 hdc command execution */
  hdc: {
    bin: 'hdc',
    host: '127.0.0.1',
    port: 8710,
    execTimeoutMs: 10000,
    maxOutputBytes: 4 * 1024 * 1024,
  },

  /** L2 Device */
  device: {
    autoSelectFirst: true,
    queryVersion: true,
    newUiTestMinVersion: '6.0.2.2',
    autoPushResources: true,
    resourcesDir: '',
    fastModeDir: '',
  },

  /** L3 RPC */
  rpc: {
    mode: 'fast',
    framing: 'auto',
    connectTimeoutMs: 5000,
    requestTimeoutMs: 30000,
    socketIdleTimeoutMs: 30000,
    portRange: { start: 10000, end: 19999 },
    concurrency: 'auto',
    maxInFlight: 16,
    strictPairing: false,
    timeoutKillsConnection: false,
    recovery: {
      enabled: true,
      maxAttempts: 1,
      delayMs: 200,
    },
    fast: {
      connectTimeoutMs: 1500,
      probeOnReuse: true,
      keepOnRelease: true,
      forceRestartOnProbeFailure: true,
    },
    operate: {
      fastHostPort: 19801,
      startWaitMs: 500,
      processWaitTimeoutMs: 15000,
      processCheckIntervalMs: 200,
      checkListening: true,
      resources: [],
    },
  },

  /** L0 Logging */
  log: {
    level: 'info',
    timestamp: true,
    transports: ['console'],
    file: '',
  },

  /** L0 DFX */
  dfx: {
    enabled: true,
    sinks: ['memory'],
    slowThresholdMs: 1000,
  },
});

/** Environment variable mapping */
const ENV_MAP: Record<string, string> = {
  HM_HDC_BIN: 'hdc.bin',
  HM_HDC_HOST: 'hdc.host',
  HM_HDC_PORT: 'hdc.port',
  HM_LOG_LEVEL: 'log.level',
  HM_RPC_MODE: 'rpc.mode',
  HM_RPC_REQUEST_TIMEOUT: 'rpc.requestTimeoutMs',
};

function isPlainObject(v: unknown): v is ConfigOverrides {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base: Readonly<ConfigOverrides>, patch: Readonly<ConfigOverrides>): ConfigOverrides {
  const out = deepClone(base) as ConfigOverrides;
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = deepClone(value);
    }
  }
  return out;
}

function getByPath(obj: ConfigOverrides | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as ConfigOverrides)[key];
  }, obj);
}

function setByPath(obj: ConfigOverrides, path: string, value: unknown): ConfigOverrides {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let cursor: ConfigOverrides = obj;
  for (const key of keys) {
    if (!isPlainObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as ConfigOverrides;
  }
  cursor[last] = value;
  return obj;
}

export class Config {
  _data: ConfigOverrides;
  /** Runtime overrides */
  constructor(overrides: ConfigOverrides = {}) {
    this._data = deepMerge(DEFAULT_CONFIG, readEnvOverrides());
    if (overrides && Object.keys(overrides).length) {
      this._data = deepMerge(this._data, overrides);
    }
  }

  /** Create a sub-config view (sharing the same data, for per-module consumption) */
  slice(path: string): ConfigOverrides {
    const value = this.get(path);
    return isPlainObject(value) ? value : {};
  }

  /**
   * Dot-path read.
   *
   * Note: Config is a dot-path-based **dynamic** key-value store; the return type
   * cannot be statically inferred at compile time, so a generic `T` is used to let
   * the caller assert as needed (when a fallback is provided, it can be inferred from it).
   * This is one of the few "necessary dynamic escape hatches" in this codebase.
   */
  get<T = unknown>(path: string, fallback?: T): T {
    const value = getByPath(this._data, path);
    return (value === undefined ? fallback : value) as T;
  }

  set(path: string, value: unknown): this {
    setByPath(this._data, path, value);
    return this;
  }

  /** Merge a set of override values */
  merge(patch: ConfigOverrides): this {
    this._data = deepMerge(this._data, patch);
    return this;
  }

  /** Deep clone snapshot (for logging/DFX use, to avoid being affected by subsequent modifications) */
  snapshot(): ConfigOverrides {
    return deepClone(this._data);
  }

  toJSON(): ConfigOverrides {
    return this.snapshot();
  }
}

function readEnvOverrides(): ConfigOverrides {
  const out: ConfigOverrides = {};
  for (const [envKey, path] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined || raw === '') {
      continue;
    }
    let value: string | number = raw;
    if (path === 'hdc.port' || path === 'rpc.requestTimeoutMs') {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        continue;
      }
      value = n;
    }
    setByPath(out, path, value);
  }
  return out;
}

/** Create a config object */
export function createConfig(overrides?: ConfigOverrides): Config {
  return new Config(overrides);
}
