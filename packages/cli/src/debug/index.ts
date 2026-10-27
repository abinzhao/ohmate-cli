/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { idArgument, serviceSpec, valueOption } from '../agent/service-spec.js';
import { openWorkbench, stopWorkbench, workbenchStatus } from '../web/web-lifecycle.js';
import { listDebugSessions, readDebugSession } from './debug-state.js';
import { describeReadonlyProtocol, describeWriteProtocol } from '../debug-protocol/index.js';
import type { ToolSpec } from '../runtime/types.js';
import { PairingInvitationSchema, PairingRequestSchema, PairingReplySchema, SealedFrameSchema, SECURITY_SUITE } from '../debug-protocol/security.js';
import { PairTargetSchema, pairWorkbench } from './private-pairing.js';
import { DebugEventsQuerySchema, readDebugEvents, DebugStreamsQuerySchema, readDebugStreams } from './event-query.js';
import { InspectorQuerySchema, readInspector } from './inspector.js';
import { inspectorCatalog } from './inspector-catalog.js';
import { getMockSpecs } from './mock-specs.js';

export { createDebugSession, readDebugSession, listDebugSessions, stopDebugSession } from './debug-state.js';
export type { DebugSession } from './debug-state.js';
export { isInspectorTool } from './inspector.js';

export function getDebugSpecs(): ToolSpec[] {
  const start = serviceSpec('debug.start', 'Start the shared local workbench without opening a browser or probing devices',
    z.strictObject({ port: z.coerce.number().int().min(0).max(65535).default(0),
      devAutoPair: z.boolean().default(false) }),
    (input, context) => openWorkbench(context, { port: (input as { port: number }).port,
      devAutoPair: (input as { devAutoPair: boolean }).devAutoPair, open: false }),
    [valueOption('port', 'Bind an explicit loopback port (default: random)'),
      { flags: '--dev-auto-pair', description: 'Development only: serve one-time invitations to a loopback peer without a TTY', required: false, optional: false, mandatory: false }]);
  return [
    ...getMockSpecs(),
    { ...start, timeoutMs: 30_000 },
    { ...start, id: 'devtools.serve', command: ['devtools', 'serve'],
      description: 'Compatibility alias of debug start; uses the same owned service', timeoutMs: 30_000 },
    serviceSpec('debug.status', 'Read shared workbench and debug session status', z.strictObject({}),
      (_, context) => workbenchStatus(context)),
    serviceSpec('debug.stop', 'Stop the shared workbench and retain debug records', z.strictObject({}),
      (_, context) => stopWorkbench(context)),
    serviceSpec('debug.pair', 'Issue a short-lived invitation only to a private interactive terminal',
      PairTargetSchema, (input, context) => pairWorkbench(context, PairTargetSchema.parse(input)),
      [valueOption('buildId', 'Peer build identifier (unverified)'), valueOption('device', 'Peer device identifier (unverified)'),
        valueOption('process', 'Peer process identifier'), valueOption('sessionId', 'Peer recorder session identifier'),
        valueOption('hdc-device', 'Exact connected HDC serial for an owned reverse mapping')]),
    serviceSpec('debug.list', 'List saved debug sessions, including stopped and disconnected services', z.strictObject({}),
      async (_, context) => ({ exitCode: 0, data: await listDebugSessions(context.dataDir) })),
    serviceSpec('debug.protocol', 'Describe supported read-only protocol schemas without claiming device capture', z.strictObject({}),
      async () => ({ exitCode: 0, data: debugContract() })),
    serviceSpec('debug.show', 'Read a saved debug session without probing devices', z.strictObject({ id: z.string().uuid() }),
      async (input, context) => ({ exitCode: 0, data: await readDebugSession(context.dataDir, (input as { id: string }).id) }), [], idArgument),
    serviceSpec('debug.streams', 'List all saved event streams with committed integrity and no authentication recovery',
      DebugStreamsQuerySchema, async (input, context) => ({
        exitCode: 0, data: await readDebugStreams(context.dataDir, DebugStreamsQuerySchema.parse(input)),
      }), [valueOption('after', 'Exclusive stream UUID cursor'), valueOption('limit', 'Maximum streams returned (1–64)')], idArgument),
    serviceSpec('debug.events', 'Read verified, redacted durable events without resuming a device connection',
      DebugEventsQuerySchema, async (input, context) => ({
        exitCode: 0, data: await readDebugEvents(context.dataDir, DebugEventsQuerySchema.parse(input)),
      }), [valueOption('stream', 'Saved event stream identifier'), valueOption('after', 'Exclusive persisted event cursor'),
        valueOption('limit', 'Maximum records returned (1–256)')], idArgument),
    { ...serviceSpec('debug.inspectors', 'Describe read-only channel views, missing fields and official API references',
      z.strictObject({}), async () => ({ exitCode: 0, data: inspectorCatalog() })), idempotency: 'read' },
    { ...serviceSpec('debug.inspect', 'Inspect a verified channel summary at a fixed committed cut without probing devices',
      InspectorQuerySchema, async (input, context) => ({
        exitCode: 0, data: await readInspector(InspectorQuerySchema.parse(input), context),
      }), [valueOption('stream', 'Saved event stream UUID'), valueOption('channel', 'Read-only protocol channel'),
        valueOption('after', 'Exclusive committed event cursor'), valueOption('limit', 'Maximum matching records (1–256)'),
        valueOption('through', 'Fixed inclusive committed cut (defaults to the current tail)')], idArgument), idempotency: 'read' },
  ];
}

function debugContract() {
  return { ...describeReadonlyProtocol(), writes: describeWriteProtocol(), transport: 'websocket-loopback', target: null,
    security: { suite: SECURITY_SUITE, lan: 'disabled', pairingCodeBits: 256, pairingTtlMs: 120000, sessionTtlMs: 600000,
      maxFramesPerKey: 65536, keyRotation: 'fresh-pairing-required', buildVerification: 'unverified',
      deviceProvenance: 'peer-asserted', kitProducer: 'not-verified', persistedResume: 'fresh-pairing-same-identity',
      maxEpochsPerStream: 24, authenticationRecovery: 'disabled' },
    securitySchemas: { invitation: z.toJSONSchema(PairingInvitationSchema), request: z.toJSONSchema(PairingRequestSchema),
      reply: z.toJSONSchema(PairingReplySchema), frame: z.toJSONSchema(SealedFrameSchema) } };
}
