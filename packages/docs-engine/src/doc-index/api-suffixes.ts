/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Second-word whitelist for split-phrase API queries (e.g. "camera picker").
 *
 * Inclusion criteria (user + developer intent):
 * - The suffix is a recurring tail in HarmonyOS @ohos module / API names (see docs1/docs/API参考).
 * - Users often type "noun + suffix" in docs/FAQ to find a specific API (Camera Picker, Date Picker, …).
 * - The suffix is NOT a generic English/CS word (handler, service, config, context, buffer, …).
 *
 * Excluded on purpose:
 * - extension (file extension), model/type/name/data/info/event/code/state, service/client/handler/helper, …
 * - ability (search EntryAbility as one token; "stage model" must not compound)
 */

/** Second word of a two-token English query may compound only if listed here (lowercase). */
export const API_COMPOUND_SUFFIXES = new Set([
  // Selectors — cameraPicker, @ohos.file.picker, DatePicker, DocumentViewPicker, avCastPicker
  'picker',
  // Overlays — AlertDialog, ActionSheet, bindSheet, …
  'dialog',
  'sheet',
  'panel',
  'popup',
  'menu',
  // ArkUI structure / motion — Navigation, GestureRecognizer, PageTransition, …
  'layout',
  'view',
  'gesture',
  'animation',
  'transition',
  'recognizer',
  // @ohos.*Manager modules users describe as "wifi manager", "notification manager", …
  'manager',
  // Kit-oriented queries — "camera kit", "location kit" (maps to *Kit docs / symbols)
  'kit',
]);

/**
 * First word of "noun manager" / *Manager that may use API-reference-first merge (option C).
 * Keep narrow; extend after observing search quality.
 */
export const MANAGER_REFERENCE_MERGE_FIRST_WORDS = new Set([
  'wifi',
  'wlan',
  'notification',
  'bluetooth',
  'location',
  'sensor',
  'power',
  'battery',
  'account',
  'pasteboard',
  'calendar',
  'telephony',
  'contact',
]);

/**
 * First word must not compound (common English or meta terms).
 * Prevents "stage model", "use picker", "how to camera", etc.
 */
export const COMPOUND_FIRST_BLOCKLIST = new Set([
  'a',
  'an',
  'and',
  'api',
  'app',
  'application',
  'arkts',
  'arkui',
  'for',
  'get',
  'harmonyos',
  'how',
  'in',
  'oh',
  'ohos',
  'on',
  'or',
  'set',
  'the',
  'to',
  'use',
  'using',
  'what',
  'when',
  'where',
  'which',
  'with',
  'without',
  // Generic nouns that precede real APIs but should not auto-merge
  'data',
  'file',
  'main',
  'model',
  'name',
  'network',
  'stage',
  'system',
  'type',
  'user',
]);

/**
 * Second words that are API tails in other contexts but misleading as split compounds.
 */
export const COMPOUND_SECOND_BLOCKLIST = new Set([
  'ability',
  'extension',
  'module',
  'service',
  'context',
  'options',
  'config',
  'info',
  'event',
  'code',
  'state',
  'type',
  'data',
  'request',
  'response',
  'client',
  'server',
  'handler',
  'helper',
  'utils',
  'factory',
  'builder',
  'listener',
  'callback',
  'observer',
  'provider',
  'consumer',
  'delegate',
  'adapter',
  'driver',
  'buffer',
  'stream',
  'channel',
  'session',
  'task',
  'worker',
  'controller',
  'component',
  'container',
  'attribute',
  'descriptor',
  'modifier',
  'validator',
  'parser',
  'formatter',
  'encoder',
  'decoder',
  'filter',
  'converter',
  'generator',
  'iterator',
  'dispatcher',
  'resolver',
  'scanner',
  'tracker',
  'monitor',
  'scheduler',
  'renderer',
  'loader',
  'subscriber',
  'proxy',
  'button',
  'surface',
  'stack',
  'heap',
  'map',
  'set',
  'array',
  'list',
]);
