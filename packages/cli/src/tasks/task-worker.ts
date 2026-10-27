/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { isMainModule } from '../runtime/entry-detection.js';
import { TaskManager } from './task-manager.js';
import { controlReceipt, finishTask } from './task-execution.js';
import { redactTaskValue } from './task-redaction.js';
import { ResourceBusyError } from '../runtime/execution-lock.js';

export async function runTaskWorker(argv: string[]): Promise<void> {
  if (argv.length !== 4 || argv[0] !== '--id' || argv[2] !== '--data-dir') { throw new Error('Invalid worker arguments'); }
  const cancel = new AbortController(), force = new AbortController();
  const interrupt = () => { if (cancel.signal.aborted) { force.abort(); } else { cancel.abort(); } };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const context = await createExecutionContext({ dataDir: argv[3], abortSignal: cancel.signal, forceSignal: force.signal });
  const manager = new TaskManager(await createRuntime(), context);
  try { await manager.run(argv[1]); }
  catch (error) {
    if (error instanceof ResourceBusyError) { return; }
    const task = await manager.store.show(argv[1]);
    await manager.store.append(task.id, 'task.worker-error', redactTaskValue({ message: error instanceof Error ? error.message : String(error) }));
    await finishTask(manager.store, task.id, controlReceipt(task, context, 'WORKER_EXECUTION_BLOCKED', 5));
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

if (isMainModule(import.meta.url)) { await runTaskWorker(process.argv.slice(2)); }
