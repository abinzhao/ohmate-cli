/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command, InvalidArgumentError } from 'commander';
import { red, dim } from 'colorette';
import { telemetry, EventType, type DocOperation } from '../trace/index.js';
import { loadDocsEngineModule } from '../docs-loader.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import docsUpdateCommand from './docs-update.js';

interface SearchResult {
  title: string;
  documentId: string;
  snippet: string;
  sectionTitle?: string;
}

interface CatalogNode {
  nodeId: string;
  nodeName: string;
  catalogIndex: number;
}

interface SearchOptions {
  catalog?: string;
  format?: 'json' | 'default';
  limit: number;
}

interface CatalogOptions {
  format?: 'json' | 'default';
}

async function trackDocOperation<T>(
  event: DocOperation,
  operation: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await operation();
    await recordDocOperation(event, Date.now() - start, true, null);
    return result;
  } catch (error) {
    const code =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.name)
        : 'UnknownError';
    await recordDocOperation(event, Date.now() - start, false, code);
    throw error;
  }
}

async function recordDocOperation(
  event: DocOperation,
  durationMs: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  await telemetry
    .track(event, {
      duration_ms: durationMs,
      success,
      error_code: errorCode,
    })
    .catch(() => {});
}

function isDocStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CacheDirError' ||
      error.name === 'DocPathSafetyError')
  );
}

function handleDocCommandError(error: unknown): void {
  console.error(red(formatDocCommandError(error)));
  process.exitCode = 1;
}

function formatDocCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isDocStorageError(error)) {
    return message;
  }
  if (/\b(EACCES|EPERM|ENOSPC|ENOTDIR|ELOOP)\b/.test(message)) {
    return 'Documentation data directory is unavailable. Check DEVECO_CLI_DATA_DIR and retry.';
  }
  return message;
}

function validateOneOf<T extends string>(
  ...allowed: T[]
): (value: string) => T {
  return (value: string) => {
    if (!allowed.includes(value as T)) {
      throw new InvalidArgumentError(`Allowed values: ${allowed.join(', ')}`);
    }
    return value as T;
  };
}

function validatePositiveInt(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new InvalidArgumentError('Must be a positive integer.');
  }
  return num;
}

const validateSearchFormat = validateOneOf<'json' | 'default'>(
  'json',
  'default'
);
const validateCatalogFormat = validateOneOf<'json' | 'default'>(
  'json',
  'default'
);

function resolveSearchInput(keywords: string[]): string[] {
  const normalizedKeywords = keywords
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  if (normalizedKeywords.length === 0) {
    throw new Error('Keywords cannot be empty.');
  }
  return normalizedKeywords;
}

function outputSearchResults(results: SearchResult[]): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(r.documentId);
    console.log(`  Title: ${r.title}`);
    if (r.snippet) {
      console.log(`  Content: ${r.snippet}`);
    }
    if (i < results.length - 1) {
      console.log();
    }
  }
}

const docCommand = new Command('docs').description(
  'HarmonyOS documentation commands (search, read, catalog, update)'
);

docCommand
  .command('search <keywords...>')
  .description('Search documentation by keywords')
  .option('--catalog <name>', 'Catalog name (all for all catalogs)', 'all')
  .option(
    '--format <fmt>',
    'Output format (default, json)',
    validateSearchFormat,
    'default'
  )
  .option('--limit <n>', 'Max number of results', validatePositiveInt, 10)
  .action(async (keywords: string[], opts: SearchOptions) => {
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'search',
      keywords,
      queryLen: keywords.join(' ').length,
      catalog: opts.catalog ?? 'all',
    };
    try {
      await trackDocOperation(event, async () => {
        const searchInput = resolveSearchInput(keywords);
        const catalog =
          opts.catalog && opts.catalog !== 'all' ? opts.catalog : undefined;
        const engineModule = await loadDocsEngineModule();
        const names = engineModule.CATALOG_NAMES;
        if (catalog && names && !names.includes(catalog)) {
          throw new Error(`Invalid catalog "${opts.catalog}". Allowed: all, ${names.join(', ')}`);
        }
        const engine = (await engineModule.createDocsEngine({
          cacheDir: getCliDataDir(),
        })) as {
          search(r: {
            keywords: string[];
            catalog?: string;
            limit?: number;
          }): Promise<SearchResult[]>;
          close(): Promise<void>;
        };
        try {
          const results = await engine.search({
            keywords: searchInput,
            catalog,
            limit: opts.limit,
          });
          if (opts.format === 'json') {
            console.log(JSON.stringify(results, null, 2));
          } else {
            outputSearchResults(results);
          }
        } finally {
          await engine.close();
        }
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

docCommand
  .command('read <documentId>')
  .description('Read full content of a document by document ID')
  .action(async (documentId: string) => {
    const normalizedId = documentId.trim();
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'read',
      documentId: normalizedId,
    };
    try {
      await trackDocOperation(event, async () => {
        if (!normalizedId) {
          throw new Error('Document ID cannot be empty.');
        }
        const engineModule = await loadDocsEngineModule();
        const engine = (await engineModule.createDocsEngine({
          cacheDir: getCliDataDir(),
        })) as {
          read(r: { relativePath: string }): Promise<string>;
          close(): Promise<void>;
        };
        try {
          const content = await engine.read({ relativePath: normalizedId });
          console.log(content);
        } finally {
          await engine.close();
        }
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

docCommand
  .command('catalog')
  .description('List all available catalogs')
  .option(
    '--format <fmt>',
    'Output format (default, json)',
    validateCatalogFormat,
    'default'
  )
  .action(async (opts: CatalogOptions) => {
    const event: DocOperation = {
      event: EventType.DocOperation,
      subAction: 'catalog',
      fmt: opts.format ?? 'default',
    };
    try {
      await trackDocOperation(event, async () => {
        const engineModule = await loadDocsEngineModule();
        const engine = (await engineModule.createDocsEngine({
          cacheDir: getCliDataDir(),
        })) as {
          catalog(): Promise<CatalogNode[]>;
          close(): Promise<void>;
        };
        try {
          const nodes = await engine.catalog();
          if (opts.format === 'json') {
            console.log(
              JSON.stringify(
                nodes.map((n) => ({ name: n.nodeId, title: n.nodeName })),
                null,
                2
              )
            );
          } else {
            for (const node of nodes) {
              console.log(`  ${node.nodeId.padEnd(20)} ${dim(node.nodeName)}`);
            }
          }
        } finally {
          await engine.close();
        }
      });
    } catch (error) {
      handleDocCommandError(error);
    }
  });

docCommand.addCommand(docsUpdateCommand);

export default docCommand;
