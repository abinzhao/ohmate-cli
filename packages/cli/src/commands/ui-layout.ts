/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError, Option } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { ArkUiDumpAdapter, ArkUiFindAdapter, findNodesInTree, flushWarnings } from '../ui/index.js';
import ora from 'ora';
import type { ArkUiNode, FindMatch } from '../ui/index.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

const SELECTOR_DSL_HELP = [
  'Selector DSL (common cases):',
  '  key=value              exact          text=Login',
  '  key*=value             contains       text*=Log',
  '  key^=value             prefix         text^=Log',
  '  key$=value             suffix         text$=in',
  '  key/=regex[/flags]     regex search   text/=^Login$  text/=login/i',
  '  a,b                    AND            text=Login,type=Button',
  '  [n]                    nth match (at end)  text=Login[0]  [last]/[-1]',
  '  keys: text key desc id type enabled focused checked selected visible clickable scrollable',
  '  value with , [ ] or quotes -> quote it: text="a,b"  text="a[b]"',
  '  regex backslashes must be doubled',
  '  xpath= prefix -> use xpath expression: xpath=//Button[@id="login"]',
  '  base64= prefix -> base64-encoded selector for shell-safe special chars',
  '  shell special chars -> wrap whole selector in quotes, or use base64= prefix',
].join('\n');

interface LayoutOptions {
  device?: string;
  id?: string;
  depth: number;
  window?: string;
  allWindows?: boolean;
  format: 'default' | 'json';
  mode: 'full' | 'simplified';
}

interface LayoutTraceEvent extends CommandExecuted {
  mode: LayoutOptions['mode'];
  outputSize: number;
}

function parseNonNegativeInt(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
    throw new InvalidArgumentError('depth must be a non-negative integer');
  }
  return n;
}

export function parsePositiveNum(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('timeout must be a positive number');
  }
  if (n > 360000) {
    throw new InvalidArgumentError('timeout must not exceed 360000ms');
  }
  return n;
}

function renderNodeLine(node: ArkUiNode): string {
  const parts: string[] = [];
  if (node.type || node.id) {
    parts.push(
      node.type
        ? node.id
          ? `${node.type}#${node.id}`
          : node.type
        : `#${node.id}`
    );
  }
  parts.push(node.bounds ? `[${node.bounds.join(',')}]` : '[]');
  if (node.text) {
    parts.push(`"${JSON.stringify(node.text).slice(1, -1)}"`);
  }
  const flags: string[] = [];
  if (node.clickable) {
    flags.push('clickable');
  }
  if (node.longClickable) {
    flags.push('longClickable');
  }
  if (node.scrollable) {
    flags.push('scrollable');
  }
  if (node.checkable) {
    flags.push('checkable');
  }
  if (flags.length > 0) {
    parts.push(...flags);
  }
  return parts.join(' ');
}

function renderTree(nodes: ArkUiNode[], indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);
  for (const node of nodes) {
    lines.push(`${prefix}${renderNodeLine(node)}`);
    if (node.children.length > 0) {
      lines.push(...renderTree(node.children, indent + 1).split('\n'));
    }
  }
  return lines.join('\n');
}

function validateOptions(options: LayoutOptions) {
  if (options.allWindows && options.window) {
    throw new Error('--all-windows and --window are mutually exclusive.');
  }
}

function renderNodesById(tree: ArkUiNode[], id: string): string {
  const nodes = findNodesInTree(tree, id);
  if (nodes.length === 0) {
    throw new Error(`Node '${id}' not found.`);
  }
  const stripped = nodes.map((node) => ({ ...node, children: [] }));
  return JSON.stringify(stripped, null, 2);
}

function renderLayoutOutput(tree: ArkUiNode[], options: LayoutOptions): string {
  if (options.id) {
    return renderNodesById(tree, options.id);
  }
  const format = options.format;
  if (format === 'json') {
    return JSON.stringify(tree, null, 2);
  }
  return renderTree(tree);
}

async function handleLayoutCommand(options: LayoutOptions): Promise<number> {
  validateOptions(options);
  const spinner = ora({ text: 'Dumping layout…', color: 'cyan' }).start();
  let tree: ArkUiNode[];
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveDeviceSerial(toolProvider, options.device);
    const dumpAdapter = new ArkUiDumpAdapter(toolProvider.hdcPath);
    tree =
      options.mode === 'full'
        ? await dumpAdapter.dumpFullTree(
            serial,
            options.depth,
            options.window,
            options.allWindows
          )
        : await dumpAdapter.dumpCollapsedTree(
            serial,
            options.depth,
            options.window,
            options.allWindows
          );
  } catch (error) {
    spinner.stop();
    throw new Error(`Failed to dump layout: ${(error as Error).message}`, {
      cause: error,
    });
  }
  spinner.stop();

  const output = renderLayoutOutput(tree, options);
  console.log(output);
  return Buffer.byteLength(output, 'utf8');
}

function buildLayoutEvent(options: LayoutOptions): LayoutTraceEvent {
  return {
    event: EventType.CommandExecuted,
    args: ['ui', 'layout', ...(options.device ? ['--device'] : [])],
    mode: options.mode,
    outputSize: 0,
  };
}

async function trackLayoutCommand(options: LayoutOptions): Promise<void> {
  const event = buildLayoutEvent(options);
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    event.outputSize = await handleLayoutCommand(options);
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    throw error;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

export const layoutCommand = new Command('layout')
  .description('Inspect on-screen node(s) for UI testing')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Layout node id')
  .option('--window <windowId>', 'Target window id')
  .option(
    '--all-windows',
    'Include all windows (mutually exclusive with --window)'
  )
  .addOption(
    new Option(
      '--depth <n>',
      'Tree depth limit (0=unlimited, 1=root only, 2=root+children)'
    )
      .argParser(parseNonNegativeInt)
      .default(0)
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .addOption(
    new Option('--mode <mode>', 'Output mode: full | simplified')
      .choices(['full', 'simplified'])
      .default('simplified')
  )
  .action(async (options: LayoutOptions) => {
    await trackLayoutCommand(options);
  });

interface FindCommandOptions {
  device?: string;
  selector?: string;
  window?: string;
  all?: boolean;
  timeout: number;
  format: 'default' | 'json';
}

function renderFindMatch(m: FindMatch): string {
  const node: ArkUiNode = {
    id: m.id,
    type: m.type,
    text: m.text,
    bounds: m.bounds,
    clickable: m.clickable === 'true' || undefined,
    longClickable: m.longClickable === 'true' || undefined,
    scrollable: m.scrollable === 'true' || undefined,
    checkable: m.checkable === 'true' || undefined,
    children: [],
  };
  return renderNodeLine(node);
}

function findMatchToJson(m: FindMatch): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (m.id !== undefined) {
    o.id = m.id;
  }
  if (m.type !== undefined) {
    o.type = m.type;
  }
  if (m.text !== undefined) {
    o.text = m.text;
  }
  if (m.bounds !== undefined) {
    o.bounds = m.bounds;
  }
  if (m.clickable !== undefined) {
    o.clickable = m.clickable === 'true';
  }
  if (m.longClickable !== undefined) {
    o.longClickable = m.longClickable === 'true';
  }
  if (m.scrollable !== undefined) {
    o.scrollable = m.scrollable === 'true';
  }
  if (m.checkable !== undefined) {
    o.checkable = m.checkable === 'true';
  }
  if (m.checked !== undefined) {
    o.checked = m.checked === 'true';
  }
  return o;
}

function printPendingWarnings(): void {
  for (const w of flushWarnings()) {
    console.warn(w);
  }
}

async function handleFindCommand(options: FindCommandOptions) {
  if (!options.selector) {
    throw new Error('Provide a selector expression.');
  }
  const spinner = ora({ text: 'Finding element…', color: 'cyan' }).start();
  let matches: FindMatch[];
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveDeviceSerial(toolProvider, options.device);
    const findAdapter = new ArkUiFindAdapter(toolProvider.hdcPath);
    matches = await findAdapter.find(serial, options.selector, {
      window: options.window,
      all: options.all,
      timeoutMs: options.timeout,
    });
  } catch (error) {
    spinner.stop();
    printPendingWarnings();
    throw new Error(`Failed to find element: ${(error as Error).message}`, {
      cause: error,
    });
  }
  spinner.stop();
  printPendingWarnings();
  if (options.format === 'json') {
    const data = options.all
      ? matches.map((m) => findMatchToJson(m))
      : findMatchToJson(matches[0]);
    console.log(JSON.stringify(data, null, 2));
  } else {
    const withIndex = options.all === true;
    for (const m of matches) {
      const line = renderFindMatch(m);
      console.log(withIndex ? `#${m.index} ${line}` : line);
    }
  }
}

export const findCommand = new Command('find')
  .description('Find on-screen element(s) by a selector (e.g. "text=Login,type=Button")')
  .argument('[selector]', 'Selector DSL, xpath=, or base64= expression')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--window <windowId>', 'Target window id')
  .option('--all', 'Print all matches instead of the first/indexed one')
  .addOption(
    new Option('--timeout <ms>', 'Max wait time in milliseconds for the element to appear')
      .argParser(parsePositiveNum)
      .default(3000)
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .action(async (selector: string | undefined, options: FindCommandOptions) => {
    await handleFindCommand({ ...options, selector });
  })
  .addHelpText('after', SELECTOR_DSL_HELP);

interface WaitCommandOptions {
  device?: string;
  window?: string;
  disappear?: boolean;
}

function renderWaitInfo(m: FindMatch): string {
  return renderFindMatch(m);
}

async function handleWaitPureSleep(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  console.log(`Waited ${timeoutMs}ms`);
}

async function handleWaitDisappear(
  adapter: ArkUiFindAdapter,
  serial: string,
  selector: string,
  timeoutMs: number,
  window: string | undefined
): Promise<void> {
  await adapter.waitForDisappear(serial, selector, timeoutMs, window);
  console.log(`Element disappeared: ${selector}`);
}

async function handleWaitAppear(
  adapter: ArkUiFindAdapter,
  serial: string,
  selector: string,
  timeoutMs: number,
  window: string | undefined
): Promise<void> {
  const match = await adapter.waitForAppearance(serial, selector, timeoutMs, window);
  console.log(renderWaitInfo(match));
}

async function handleWaitCommand(
  args: string[],
  options: WaitCommandOptions
): Promise<void> {
  if (args.length === 0) {
    throw new Error('Usage: ui wait [timeoutMs] | ui wait <selector> [timeoutMs]');
  }
  const first = args[0];
  const isPureNumber = /^\d+$/.test(first);

  if (isPureNumber) {
    // Pure sleep mode: ui wait [timeoutMs]
    if (options.disappear) {
      throw new Error('--disappear requires a selector.');
    }
    const timeoutMs = parsePositiveNum(first);
    printPendingWarnings();
    await handleWaitPureSleep(timeoutMs);
    return;
  }

  // Element wait mode: ui wait <selector> [timeoutMs]
  const selector = first;
  const timeoutMs = args[1] ? parsePositiveNum(args[1]) : 3000;

  const spinner = ora({ text: 'Waiting…', color: 'cyan' }).start();
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveDeviceSerial(toolProvider, options.device);
    const findAdapter = new ArkUiFindAdapter(toolProvider.hdcPath);
    if (options.disappear) {
      await handleWaitDisappear(
        findAdapter, serial, selector,
        timeoutMs, options.window
      );
    } else {
      await handleWaitAppear(
        findAdapter, serial, selector,
        timeoutMs, options.window
      );
    }
    spinner.stop();
    printPendingWarnings();
  } catch (error) {
    spinner.stop();
    printPendingWarnings();
    throw new Error(`Failed to wait: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export const waitCommand = new Command('wait')
  .description('Wait: sleep [timeoutMs], or wait for element <selector> [timeoutMs] [--disappear]')
  .argument('[args...]', 'Args: [timeoutMs] for sleep, or <selector> [timeoutMs] for element wait')
  .option('--disappear', 'Wait for element to disappear (requires selector)')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--window <windowId>', 'Target window id')
  .action(async (args: string[], options: WaitCommandOptions) => {
    await handleWaitCommand(args, options);
  })
  .addHelpText('after', SELECTOR_DSL_HELP);
