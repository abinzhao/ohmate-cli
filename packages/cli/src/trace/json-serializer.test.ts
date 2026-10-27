/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  NamingStrategies,
  JsonSerializer,
  serializeEvent,
} from './json-serializer.js';

describe('NamingStrategies', () => {
  it('snakeCase splits camelCase words', () => {
    expect(NamingStrategies.snakeCase('eventType')).toBe('event_type');
    expect(NamingStrategies.snakeCase('simple')).toBe('simple');
    expect(NamingStrategies.snakeCase('already_snake')).toBe('already_snake');
  });

  it('snakeCase separates acronym and digit boundaries', () => {
    expect(NamingStrategies.snakeCase('deviceID')).toBe('device_id');
    expect(NamingStrategies.snakeCase('parseXMLResponse')).toBe(
      'parse_xml_response'
    );
    expect(NamingStrategies.snakeCase('http2Status')).toBe('http2_status');
  });

  it('snakeCase lowercases everything', () => {
    expect(NamingStrategies.snakeCase('ALLCAPS')).toBe('allcaps');
  });

  it('identity and camelCase return the name unchanged', () => {
    expect(NamingStrategies.identity('eventType')).toBe('eventType');
    expect(NamingStrategies.camelCase('eventType')).toBe('eventType');
  });
});

describe('JsonSerializer', () => {
  it('serializes compact JSON by default', () => {
    const serializer = new JsonSerializer();
    expect(serializer.serialize({ a: 1 })).toBe('{"a":1}');
  });

  it('serializes pretty JSON when configured', () => {
    const serializer = new JsonSerializer({ pretty: true });
    expect(serializer.serialize({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('renames keys recursively with the naming strategy', () => {
    const serializer = new JsonSerializer({
      namingStrategy: NamingStrategies.snakeCase,
    });
    expect(
      serializer.serialize({
        eventType: 'cli',
        nested: { deviceType: 'phone', list: [{ osVersion: 'v6' }] },
      })
    ).toBe(
      '{"event_type":"cli","nested":{"device_type":"phone","list":[{"os_version":"v6"}]}}'
    );
  });

  it('prefers fieldNames overrides over the naming strategy', () => {
    const serializer = new JsonSerializer({
      namingStrategy: NamingStrategies.snakeCase,
      fieldNames: { eventType: 'type' },
    });
    expect(serializer.serialize({ eventType: 'cli', otherField: 1 })).toBe(
      '{"type":"cli","other_field":1}'
    );
  });

  it('keeps primitives, null and arrays as-is', () => {
    const serializer = new JsonSerializer();
    expect(serializer.serialize([1, 'a', null, true])).toBe(
      '[1,"a",null,true]'
    );
    expect(serializer.serialize(null)).toBe('null');
  });

  it('toObject returns the transformed value without stringifying', () => {
    const serializer = new JsonSerializer({
      namingStrategy: NamingStrategies.snakeCase,
    });
    expect(serializer.toObject({ eventType: 1 })).toEqual({ event_type: 1 });
  });
});

describe('serializeEvent', () => {
  it('uses snake_case as the wire format', () => {
    expect(serializeEvent({ eventType: 'x', commandName: 'run' })).toBe(
      '{"event_type":"x","command_name":"run"}'
    );
  });
});
