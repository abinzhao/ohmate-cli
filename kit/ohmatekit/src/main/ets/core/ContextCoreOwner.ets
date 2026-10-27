/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { CoreHealth, CoreOptions, CoreResult, CoreSchema } from '../api/CoreTypes';
import { copyOptions, OHMateCore, optionsValid } from './OHMateCore';
import { HarmonySandboxHost } from './HarmonySandboxHost';
import { SchemaRegistry } from './SchemaRegistry';

// The default API and explicit Debug/Test context entry share this sole owner.
// It never imports a UI, Provider or Test implementation.
export class ContextCoreOwner {
  private static core: OHMateCore | undefined = undefined;
  private static host: HarmonySandboxHost | undefined = undefined;
  private static contextKey: string = '';
  private static optionKey: string = '';
  private static disposed: boolean = false;
  private static schemas: CoreSchema[] = [];
  private static registry: SchemaRegistry = new SchemaRegistry();
  static getCore(): OHMateCore | undefined { return ContextCoreOwner.core; }
  static ownsContext(key: string): boolean { return ContextCoreOwner.contextKey !== '' && ContextCoreOwner.contextKey === key; }
  static ownsOptions(options: CoreOptions): boolean {
    return ContextCoreOwner.optionKey === JSON.stringify(copyOptions(options));
  }
  static registerSchema(schema: CoreSchema): CoreResult {
    if (ContextCoreOwner.core !== undefined || ContextCoreOwner.disposed) {
      return new CoreResult('SCHEMA_REGISTRATION_CLOSED');
    }
    const result: CoreResult = ContextCoreOwner.registry.register(schema);
    if (result.code === 'REGISTERED') {
      ContextCoreOwner.schemas.push(JSON.parse(JSON.stringify(schema)) as CoreSchema);
    }
    return result;
  }
  static start(context: common.Context, options: CoreOptions): Promise<CoreResult> {
    if (ContextCoreOwner.disposed) { return Promise.resolve<CoreResult>(new CoreResult('DISPOSED')); }
    try {
      if (!optionsValid(options)) { return Promise.resolve<CoreResult>(new CoreResult('OPTIONS_INVALID')); }
      const key: string = context.filesDir;
      if (typeof key !== 'string' || key === '') {
        return Promise.resolve<CoreResult>(new CoreResult('START_CONTEXT_INVALID'));
      }
      if (ContextCoreOwner.contextKey !== '' && ContextCoreOwner.contextKey !== key) {
        return Promise.resolve<CoreResult>(new CoreResult('START_CONTEXT_CONFLICT'));
      }
      if (ContextCoreOwner.core === undefined) {
        const host = new HarmonySandboxHost(key, options);
        const core = new OHMateCore(host);
        for (const schema of ContextCoreOwner.schemas) { core.registerSchema(schema); }
        ContextCoreOwner.host = host; ContextCoreOwner.core = core; ContextCoreOwner.contextKey = key;
        ContextCoreOwner.optionKey = JSON.stringify(copyOptions(options));
      }
      return ContextCoreOwner.core.start(options);
    } catch (_) { return Promise.resolve<CoreResult>(new CoreResult('START_DEGRADED')); }
  }
  static getHealth(): CoreHealth {
    const health: CoreHealth = ContextCoreOwner.core?.getHealth() ?? new CoreHealth();
    health.clockEvidence = 'system-startup-ms-session-scope'; return health;
  }
  static async dispose(): Promise<CoreResult> {
    ContextCoreOwner.disposed = true;
    const result: CoreResult = await (ContextCoreOwner.core?.dispose() ??
      Promise.resolve<CoreResult>(new CoreResult('DISPOSED')));
    await ContextCoreOwner.host?.dispose();
    return ContextCoreOwner.host !== undefined && !ContextCoreOwner.host.resourcesReleased() ?
      new CoreResult('CLOSE_UNCERTAIN') : result;
  }
}
