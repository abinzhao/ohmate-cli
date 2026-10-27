/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreEvent, CoreProblem, CoreSegment } from '../api/CoreTypes';
import { coreIdentifier, SchemaRegistry } from './SchemaRegistry';
import { eventValid, exactKeys, lossValid } from '../recorder/SegmentRecovery';
export function problemValid(problem: CoreProblem, schemas: SchemaRegistry): boolean {
  if (!exactKeys(problem, ['schemaVersion', 'profile', 'problemId', 'sessionId', 'buildId',
    'buildVerification', 'replay', 'events', 'attachments', 'loss', 'triage']) ||
    problem.schemaVersion !== '1.0' || problem.profile !== 'ohmate-core-summary' ||
    !coreIdentifier(problem.problemId) || !coreIdentifier(problem.sessionId) ||
    typeof problem.buildId !== 'string' || problem.buildId.length > 128 ||
    !new RegExp('^[A-Za-z0-9_.@-]*$').test(problem.buildId) ||
    problem.buildVerification !== 'unverified-build' || problem.replay !== 'manual-only' ||
    !Array.isArray(problem.events) || problem.events.length > 1024 ||
    !Array.isArray(problem.attachments) || problem.attachments.length !== 0 || !lossValid(problem.loss) ||
    !exactKeys(problem.triage, ['confidence', 'fault', 'source', 'missing']) ||
    problem.triage.source !== 'application-reported' ||
    JSON.stringify(problem.triage.missing) !== JSON.stringify(['system-first-scene', 'authenticated-build', 'symbols'])) {
    return false;
  }
  const segment: CoreSegment = { schemaVersion: '1.0', sessionId: problem.sessionId, buildId: problem.buildId,
    buildVerification: 'unverified-build', firstSequence: 0, lastSequence: 0, events: problem.events, loss: problem.loss };
  let previous: CoreEvent | undefined = undefined;
  for (const event of problem.events) {
    if (!eventValid(event, segment, schemas) || (previous !== undefined &&
      (event.sequence <= previous.sequence || event.clock.clockId !== previous.clock.clockId ||
        event.clock.bootId !== previous.clock.bootId || event.clock.monotonicNs < previous.clock.monotonicNs))) {
      return false;
    }
    previous = event;
  }
  const fault: CoreEvent | undefined = problem.events.find((event: CoreEvent): boolean =>
    event.source === 'application' && event.priority === 'critical');
  return fault === undefined ?
    problem.triage.fault === 'unknown' && problem.triage.confidence === 'insufficient-evidence' :
    problem.triage.fault === fault.name && problem.triage.confidence === 'single-reported-clue';
}
