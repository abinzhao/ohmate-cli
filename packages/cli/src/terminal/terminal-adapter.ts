/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createExecutionContext, createRuntime, type Receipt, type ExecutionContext, type OHMateRuntime } from '../runtime/index.js';
import { normalizeTerminalArguments, parseTerminalArguments, type TerminalArguments } from './arguments.js';
import { renderHelp, renderReceipt, resolveCommand } from './help.js';
import { nativeInput } from './native-input.js';
import { readInputFile } from './input-file.js';
import type { ReadStream, WriteStream } from 'node:tty';

export interface TerminalIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin?: ReadStream;
  output?: WriteStream;
}

function earlyError(message: string): Receipt {
  return {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0',
    command: 'arguments', status: 'error', locale: 'en-US',
    startedAt: new Date().toISOString(), durationMs: 0,
    project: { root: null, workspaceId: '' }, capabilities: {},
    data: { code: 'ARGUMENTS_INVALID', message }, warnings: [], artifacts: [],
    taskId: null, exitCode: 2, provenance: { adapter: 'terminal' },
  };
}

function writePairing(output: WriteStream, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => output.off('error', failed);
    const failed = () => { cleanup(); reject(new Error('PRIVATE_OUTPUT_FAILED')); };
    output.once('error', failed);
    try {
      output.write(`${text}\n`, (error) => {
        if (error) {
          // Writable emits its error after the callback; keep the listener through that emission.
          setImmediate(cleanup); reject(new Error('PRIVATE_OUTPUT_FAILED'));
        } else { cleanup(); resolve(); }
      });
    } catch { failed(); }
  });
}

function terminalHooks(id: string | undefined, runtime: OHMateRuntime, context: ExecutionContext, parsed: TerminalArguments, io: TerminalIO): void {
  if (id === 'agent.chat' && io.stdin?.isTTY && io.output) {
    context.console = async () => {
      const { openConsole } = await import('./console.js');
      return openConsole(runtime, context, io.stdin!, io.output!);
    };
  }
  if (id === 'debug.pair' && parsed.format === 'human' && !parsed.context.nonInteractive && io.stdin?.isTTY && io.output?.isTTY) {
    context.policy = { ...context.policy, nonInteractive: false };
    context.privatePairing = (text) => writePairing(io.output!, text);
  }
}

async function execute(parsed: TerminalArguments, io: TerminalIO): Promise<number> {
  normalizeTerminalArguments(parsed);
  const runtime = await createRuntime();
  if (!parsed.args.length && io.stdin?.isTTY && parsed.format === 'human') { parsed.args = ['agent', 'chat']; }
  const spec = parsed.args[0] === 'execute'
    ? runtime.registry.get(parsed.args[1]) : resolveCommand(runtime, parsed.args);
  if (!parsed.args.length || parsed.args.includes('--help') || parsed.args.at(-1) === 'help' || parsed.args.includes('-h')) {
    io.stdout(renderHelp(runtime, spec, parsed.args.filter((arg) => !['--help', '-h', 'help'].includes(arg))));
    return 0;
  }
  const controller = new AbortController(), force = new AbortController();
  const cancel = () => { if (controller.signal.aborted) { force.abort(); } else { controller.abort(); } };
  const consoleMode = spec?.id === 'agent.chat' && Boolean(io.stdin?.isTTY && io.output);
  if (!consoleMode) { process.on('SIGINT', cancel); }
  process.on('SIGTERM', cancel);
  process.on('SIGHUP', cancel);
  try {
    const protocol = spec?.protocol ?? false;
    const raw = parsed.raw && spec?.adapter === 'legacy-child';
    const context = await createExecutionContext({
      ...parsed.context, abortSignal: controller.signal,
      forceSignal: force.signal, protocolStdin: protocol,
      stdout: raw || protocol ? io.stdout : undefined, stderr: io.stderr,
    });
    terminalHooks(spec?.id, runtime, context, parsed, io);
    const remaining = parsed.args.slice(parsed.args[0] === 'execute' ? 2 : spec?.command.length ?? 1);
    if (parsed.inputFile !== undefined) { parsed.input = await readInputFile(parsed.inputFile, context.cwd, context.dataDir); }
    if (parsed.input !== undefined && remaining.length) { throw new Error('Use --input without command-specific arguments'); }
    if (parsed.context.projectRoot && spec?.options.some((option) => option.flags.includes('--project '))) {
      remaining.push('--project', parsed.context.projectRoot);
    }
    if (raw && spec?.options.some((option) => option.flags.includes('--format '))) {
      remaining.push('--format', parsed.format === 'json' ? 'json' : 'default');
    }
    const input = parsed.input ?? (spec?.adapter === 'legacy-child' ? { argv: remaining } : spec ? nativeInput(spec, remaining) : {});
    const receipt = await runtime.execute(spec?.id ?? parsed.args[0], input, context);
    outputReceipt(receipt, parsed, io, protocol, Boolean(raw));
    return receipt.exitCode;
  } finally {
    if (!consoleMode) { process.off('SIGINT', cancel); }
    process.off('SIGTERM', cancel);
    process.off('SIGHUP', cancel);
  }
}

function outputReceipt(receipt: Receipt, parsed: TerminalArguments, io: TerminalIO, protocol: boolean, raw: boolean): void {
  if (parsed.format === 'ndjson' && receipt.command === 'task.events' && receipt.exitCode === 0 && Array.isArray(receipt.data)) {
    for (const event of receipt.data) { io.stdout(`${JSON.stringify(event)}\n`); }
    return;
  }
  if ((!protocol && !raw) || (!protocol && receipt.exitCode === 5)) {
    io.stdout(parsed.format !== 'human' ? `${JSON.stringify(receipt)}\n` : renderReceipt(receipt));
  }
  if (protocol && receipt.exitCode !== 0) { io.stderr(renderReceipt(receipt)); }
}

export async function runTerminal(argv: string[], io: TerminalIO): Promise<number> {
  if (argv.length === 1 && ['-v', '-V', '--version'].includes(argv[0])) {
    io.stdout(`${process.env.npm_package_version ?? '0.1.0'}\n`);
    return 0;
  }
  try {
    return await execute(parseTerminalArguments(argv), io);
  } catch (error) {
    const receipt = earlyError(error instanceof Error ? error.message : String(error));
    io.stdout(argv.some((arg) => ['json', 'ndjson'].includes(arg)) ? `${JSON.stringify(receipt)}\n` : renderReceipt(receipt));
    return receipt.exitCode;
  }
}
