/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  API_COMPOUND_SUFFIXES,
  COMPOUND_FIRST_BLOCKLIST,
  COMPOUND_SECOND_BLOCKLIST,
  MANAGER_REFERENCE_MERGE_FIRST_WORDS,
} from './api-suffixes.js';

describe('API_COMPOUND_SUFFIXES', () => {
  it.each(['picker', 'dialog', 'sheet', 'panel', 'popup', 'menu', 'layout'])(
    'contains selector/structure suffix: %s',
    (suffix) => {
      expect(API_COMPOUND_SUFFIXES.has(suffix)).toBe(true);
    }
  );

  it.each(['manager', 'kit'])('contains kit/manager suffix: %s', (suffix) => {
    expect(API_COMPOUND_SUFFIXES.has(suffix)).toBe(true);
  });

  it('excludes generic tail words', () => {
    expect(API_COMPOUND_SUFFIXES.has('handler')).toBe(false);
    expect(API_COMPOUND_SUFFIXES.has('service')).toBe(false);
    expect(API_COMPOUND_SUFFIXES.has('extension')).toBe(false);
  });

  it('keeps every entry lowercase', () => {
    for (const suffix of API_COMPOUND_SUFFIXES) {
      expect(suffix).toBe(suffix.toLowerCase());
    }
  });
});

describe('MANAGER_REFERENCE_MERGE_FIRST_WORDS', () => {
  it.each(['wifi', 'wlan', 'notification', 'bluetooth', 'location'])(
    'contains manager merge first word: %s',
    (word) => {
      expect(MANAGER_REFERENCE_MERGE_FIRST_WORDS.has(word)).toBe(true);
    }
  );

  it('stays narrow for non-manager domains', () => {
    expect(MANAGER_REFERENCE_MERGE_FIRST_WORDS.has('camera')).toBe(false);
    expect(MANAGER_REFERENCE_MERGE_FIRST_WORDS.has('xyz')).toBe(false);
  });

  it('keeps every entry lowercase', () => {
    for (const word of MANAGER_REFERENCE_MERGE_FIRST_WORDS) {
      expect(word).toBe(word.toLowerCase());
    }
  });
});

describe('COMPOUND_FIRST_BLOCKLIST', () => {
  it.each(['a', 'an', 'how', 'the', 'use', 'what', 'when', 'with'])(
    'blocks common English/meta first word: %s',
    (word) => {
      expect(COMPOUND_FIRST_BLOCKLIST.has(word)).toBe(true);
    }
  );

  it('blocks generic leading nouns', () => {
    expect(COMPOUND_FIRST_BLOCKLIST.has('data')).toBe(true);
    expect(COMPOUND_FIRST_BLOCKLIST.has('file')).toBe(true);
    expect(COMPOUND_FIRST_BLOCKLIST.has('model')).toBe(true);
  });

  it('does not block real API first words', () => {
    expect(COMPOUND_FIRST_BLOCKLIST.has('camera')).toBe(false);
    expect(COMPOUND_FIRST_BLOCKLIST.has('wifi')).toBe(false);
  });

  it('keeps every entry lowercase', () => {
    for (const word of COMPOUND_FIRST_BLOCKLIST) {
      expect(word).toBe(word.toLowerCase());
    }
  });
});

describe('COMPOUND_SECOND_BLOCKLIST', () => {
  it.each(['ability', 'extension', 'service', 'callback', 'button', 'list'])(
    'blocks misleading second word: %s',
    (word) => {
      expect(COMPOUND_SECOND_BLOCKLIST.has(word)).toBe(true);
    }
  );

  it('does not block legitimate compound suffixes', () => {
    expect(COMPOUND_SECOND_BLOCKLIST.has('picker')).toBe(false);
    expect(COMPOUND_SECOND_BLOCKLIST.has('manager')).toBe(false);
  });

  it('keeps every entry lowercase', () => {
    for (const word of COMPOUND_SECOND_BLOCKLIST) {
      expect(word).toBe(word.toLowerCase());
    }
  });
});
