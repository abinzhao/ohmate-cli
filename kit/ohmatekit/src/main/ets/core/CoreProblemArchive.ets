/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreHost, CoreProblem, CoreSchema } from '../api/CoreTypes';
import { problemValid } from './ProblemRecovery';
import { SchemaRegistry } from './SchemaRegistry';
import { CORE_PROBLEM_SCHEMAS } from './GeneratedCoreContract';
import { CoreZipEntry, coreStoredZip, coreUtf8 } from './StoredZip';

interface ArchiveDocument {
  profile: string;
  provenance: string;
  privacy: string;
  schemas: CoreSchema[];
  summary: CoreProblem;
}
interface ArchiveFile {
  path: string;
  type: string;
  size: number;
  sha256: string;
  sensitivity: string;
  compression: string;
}
interface ArchiveManifest {
  format: string;
  schemaVersion: string;
  problemId: string;
  sessionId: string;
  content: string;
  integrity: string;
  files: ArchiveFile[];
}
interface ArchiveReview {
  archiveBytes: number;
  files: ArchiveFile[];
  fields: CoreSchema[];
  attachments: string;
  retainedRisks: string[];
  replay: string;
}
export class CoreArchiveBuild {
  bytes: Uint8Array = new Uint8Array(0);
  review: string = '';
}
export function coreByteHash(host: CoreHost, bytes: Uint8Array): string {
  if (host.hashBytes === undefined) { throw new Error('ARCHIVE_HASH_UNAVAILABLE'); }
  const hash: string = host.hashBytes(bytes.slice());
  if (!new RegExp('^[a-f0-9]{64}$').test(hash)) { throw new Error('ARCHIVE_HASH_UNAVAILABLE'); }
  return hash;
}
function describe(entry: CoreZipEntry, host: CoreHost): ArchiveFile {
  const schema: boolean = entry.path.startsWith('schemas/');
  return { path: entry.path, type: schema ? 'json-schema' : 'json',
    size: entry.bytes.length, sha256: coreByteHash(host, entry.bytes),
    sensitivity: schema ? 'public-schema' : 'redacted-summary', compression: 'store' };
}
export function makeCoreArchive(text: string, registry: SchemaRegistry, host: CoreHost): CoreArchiveBuild {
  const problem: CoreProblem = JSON.parse(text) as CoreProblem;
  // Revalidate the saved evidence, including registered fields, order, loss and triage.
  if (!problemValid(problem, registry)) { throw new Error('ARCHIVE_EVIDENCE_INVALID'); }
  const schemas: CoreSchema[] = registry.snapshot();
  const checked = new SchemaRegistry();
  if (schemas.some((schema: CoreSchema): boolean => checked.register(schema).code !== 'REGISTERED')) {
    throw new Error('ARCHIVE_EVIDENCE_INVALID');
  }
  const document: ArchiveDocument = { profile: 'core-readonly-v1', provenance: 'application-reported',
    privacy: 'registered-fields-only', schemas, summary: problem };
  const embedded: Record<string, Object> = JSON.parse(CORE_PROBLEM_SCHEMAS) as Record<string, Object>;
  const entries: CoreZipEntry[] = [{ path: 'core-summary.json', bytes: coreUtf8(JSON.stringify(document)) }];
  for (const path of ['schemas/manifest.schema.json', 'schemas/core-summary.schema.json']) {
    entries.push({ path, bytes: coreUtf8(JSON.stringify(embedded[path])) });
  }
  const files: ArchiveFile[] = entries.map((entry: CoreZipEntry): ArchiveFile => describe(entry, host));
  const manifest: ArchiveManifest = { format: 'ohmate-problem', schemaVersion: '1.5', problemId: problem.problemId,
    sessionId: problem.sessionId, content: 'core-readonly', integrity: 'sha256-not-signature', files };
  const manifestEntry: CoreZipEntry = { path: 'manifest.json', bytes: coreUtf8(JSON.stringify(manifest)) };
  entries.unshift(manifestEntry);
  const output = new CoreArchiveBuild(); output.bytes = coreStoredZip(entries);
  const review: ArchiveReview = { archiveBytes: output.bytes.length, files: [describe(manifestEntry, host)].concat(files),
    fields: schemas, attachments: 'none', replay: 'manual-only',
    retainedRisks: ['unverified-build', 'application-reported', 'host-asserted-clock', 'host-reported-durability'] };
  output.review = JSON.stringify(review); return output;
}
