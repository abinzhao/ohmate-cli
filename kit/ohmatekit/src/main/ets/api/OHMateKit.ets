/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { common } from '@kit.AbilityKit';
import { CoreArchiveResult, CoreFault, CoreHealth, CoreOptions, CoreProblem, CoreResult, CoreSchema } from './CoreTypes';
import { ContextCoreOwner } from '../core/ContextCoreOwner';

export class OHMateKit {
  static registerSchema(schema: CoreSchema): CoreResult {
    return ContextCoreOwner.registerSchema(schema);
  }
  static start(context: common.Context, options: CoreOptions = new CoreOptions()): Promise<CoreResult> {
    return ContextCoreOwner.start(context, options);
  }
  static mark(name: string, fields: Record<string, Object>): CoreResult {
    return ContextCoreOwner.getCore()?.mark(name, fields) ?? new CoreResult('NOT_ACTIVE');
  }
  static recordFault(fault: CoreFault): CoreResult {
    return ContextCoreOwner.getCore()?.recordFault(fault) ?? new CoreResult('NOT_ACTIVE');
  }
  static pause(): CoreResult { return ContextCoreOwner.getCore()?.pause() ?? new CoreResult('NOT_ACTIVE'); }
  static resume(): CoreResult { return ContextCoreOwner.getCore()?.resume() ?? new CoreResult('NOT_ACTIVE'); }
  static flush(): Promise<CoreResult> {
    return ContextCoreOwner.getCore()?.flush() ?? Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
  }
  static stopNormally(): Promise<CoreResult> {
    return ContextCoreOwner.getCore()?.stopNormally() ?? Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
  }
  static getHealth(): CoreHealth { return ContextCoreOwner.getHealth(); }
  static createProblem(): Promise<CoreResult> {
    return ContextCoreOwner.getCore()?.createProblem() ?? Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
  }
  static listProblems(): CoreProblem[] { return ContextCoreOwner.getCore()?.listProblems() ?? []; }
  static getProblem(id: string): CoreProblem | undefined { return ContextCoreOwner.getCore()?.getProblem(id); }
  static reviewExport(id: string): CoreResult {
    return ContextCoreOwner.getCore()?.reviewExport(id) ?? new CoreResult('NOT_ACTIVE');
  }
  static exportProblem(id: string, reviewHash: string = ''): CoreResult {
    return ContextCoreOwner.getCore()?.exportProblem(id, reviewHash) ?? new CoreResult('NOT_ACTIVE');
  }
  static reviewArchive(id: string): CoreResult {
    return ContextCoreOwner.getCore()?.reviewArchive(id) ?? new CoreResult('NOT_ACTIVE');
  }
  static exportArchive(id: string, reviewHash: string = ''): CoreArchiveResult {
    return ContextCoreOwner.getCore()?.exportArchive(id, reviewHash) ?? new CoreArchiveResult('NOT_ACTIVE');
  }
  static deleteProblem(id: string): Promise<CoreResult> {
    return ContextCoreOwner.getCore()?.deleteProblem(id) ?? Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
  }
  static prune(): Promise<CoreResult> {
    return ContextCoreOwner.getCore()?.prune() ?? Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
  }
  static dispose(): Promise<CoreResult> { return ContextCoreOwner.dispose(); }
}
