/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import {
  ChannelSchema,
  HashSchema,
  IdentitySchema,
  PayloadSchemas,
} from './domain-schemas.js';
import type { Channel, Identity } from './domain-schemas.js';
import { hashContract } from './canonical-hash.js';
import { parseProtocol, ProtocolError } from './protocol-error.js';

export const CURRENT_PROTOCOL_VERSION = '1.1';
export const PREVIOUS_PROTOCOL_VERSION = '1.0';
export const ProtocolVersionSchema = z.enum(['1.1', '1.0']);
const version = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/);
export const ProtocolVersionRangeSchema = z
  .strictObject({ min: version, max: version })
  .refine((range) => versionNumber(range.min) <= versionNumber(range.max));
export const BudgetSchema = z.strictObject({
  maxFrame: z.number().int().min(1024).max(1048576),
  resumeWindow: z.number().int().min(1).max(4096),
});

export function capabilitySchema(channel: Channel) {
  return z
    .strictObject({
      capability: z.literal(`${channel}.read`),
      available: z.boolean(),
      read: z.boolean(),
      write: z.literal(false),
      highRisk: z.literal(false),
      reason: z.string().max(256),
    })
    .refine((grant) => grant.available === grant.read);
}

const channelOffers = ChannelSchema.options.map((channel) =>
  z
    .strictObject({
      channel: z.literal(channel),
      channelVersion: version,
      schemaHash: HashSchema,
      capabilityHash: HashSchema,
      ...capabilitySchema(channel).shape,
    })
    .refine((grant) => grant.available === grant.read)
);
export const ChannelOfferSchema = z.union(channelOffers);
export const HandshakeSchema = z
  .strictObject({
    type: z.literal('handshake'),
    mode: z.literal('readonly'),
    protocolVersionRange: ProtocolVersionRangeSchema,
    identity: IdentitySchema,
    channels: z
      .array(ChannelOfferSchema)
      .min(1)
      .max(ChannelSchema.options.length),
    ...BudgetSchema.shape,
    compression: z.tuple([z.literal('none')]),
  })
  .refine(
    (hello) =>
      new Set(hello.channels.map((item) => item.channel)).size ===
      hello.channels.length
  );

export type Handshake = z.infer<typeof HandshakeSchema>;
export type ChannelOffer = z.infer<typeof ChannelOfferSchema>;
export interface HandshakeOptions {
  protocolVersionRange?: { min: string; max: string };
  maxFrame?: number;
  resumeWindow?: number;
  channels?: Channel[];
}
export interface NegotiatedReadonly {
  mode: 'readonly';
  protocolVersion: z.infer<typeof ProtocolVersionSchema>;
  identity: Identity;
  channels: ChannelOffer[];
  maxFrame: number;
  resumeWindow: number;
  compression: 'none';
}

function versionNumber(value: string): number {
  const [major, minor] = value.split('.').map(Number);
  return major * 10000 + minor;
}

function channelContract(channel: Channel): ChannelOffer {
  return {
    channel,
    channelVersion: '1.0',
    schemaHash: hashContract(z.toJSONSchema(PayloadSchemas[channel])),
    capabilityHash: hashContract(z.toJSONSchema(capabilitySchema(channel))),
    capability: `${channel}.read`,
    available: true,
    read: true,
    write: false,
    highRisk: false,
    reason: '',
  };
}

export function createHandshake(
  identity: unknown,
  options: HandshakeOptions = {}
): Handshake {
  return parseProtocol(HandshakeSchema, {
    type: 'handshake',
    mode: 'readonly',
    identity,
    protocolVersionRange: options.protocolVersionRange ?? {
      min: '1.0',
      max: '1.1',
    },
    channels: (options.channels ?? ChannelSchema.options).map(channelContract),
    maxFrame: options.maxFrame ?? 65536,
    resumeWindow: options.resumeWindow ?? 256,
    compression: ['none'],
  });
}

export function assertIdentity(expected: Identity, actual: Identity): void {
  if (
    Object.keys(IdentitySchema.shape).some(
      (key) => expected[key as keyof Identity] !== actual[key as keyof Identity]
    )
  ) {
    throw new ProtocolError('IDENTITY_MISMATCH');
  }
}

function selectVersion(
  local: Handshake,
  peer: Handshake
): NegotiatedReadonly['protocolVersion'] {
  for (const candidate of ProtocolVersionSchema.options) {
    const match = [local, peer].every(
      ({ protocolVersionRange: range }) =>
        range.min.startsWith('1.') &&
        range.max.startsWith('1.') &&
        versionNumber(range.min) <= versionNumber(candidate) &&
        versionNumber(candidate) <= versionNumber(range.max)
    );
    if (match) {
      return candidate;
    }
  }
  throw new ProtocolError('VERSION_MISMATCH');
}

function validateChannels(hello: Handshake): void {
  for (const offer of hello.channels) {
    const expected = channelContract(offer.channel);
    if (
      offer.channelVersion !== expected.channelVersion ||
      offer.schemaHash !== expected.schemaHash ||
      offer.capabilityHash !== expected.capabilityHash
    ) {
      throw new ProtocolError('CHANNEL_MISMATCH');
    }
  }
}

export function negotiateReadonly(
  localInput: unknown,
  peerInput: unknown
): NegotiatedReadonly {
  const local = parseProtocol(HandshakeSchema, localInput);
  const peer = parseProtocol(HandshakeSchema, peerInput);
  assertIdentity(local.identity, peer.identity);
  const protocolVersion = selectVersion(local, peer);
  validateChannels(local);
  validateChannels(peer);
  const channels = local.channels.filter(
    (offer) =>
      offer.available &&
      offer.read &&
      peer.channels.some(
        (remote) =>
          remote.channel === offer.channel && remote.available && remote.read
      )
  );
  if (!channels.length) {
    throw new ProtocolError('NO_READ_CAPABILITY');
  }
  return {
    mode: 'readonly',
    protocolVersion,
    identity: local.identity,
    channels,
    maxFrame: Math.min(local.maxFrame, peer.maxFrame),
    resumeWindow: Math.min(local.resumeWindow, peer.resumeWindow),
    compression: 'none',
  };
}
