/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalState } from './local-state.js';
import { redactTaskValue } from '../tasks/task-redaction.js';

const entrySchema = z.strictObject({ sequence: z.number().int().positive(), time: z.iso.datetime(), type: z.string(), value: z.unknown() });
const sessionSchema = z.strictObject({
  id: z.string().uuid(), projectRoot: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  entries: z.array(entrySchema),
});
export type Session = z.infer<typeof sessionSchema>;

export class SessionStore {
  private readonly state: LocalState;
  constructor(dataDir: string) { this.state = new LocalState(dataDir); }
  private name(id: string): string { return `session-${z.string().uuid().parse(id)}`; }
  async create(projectRoot: string | null): Promise<Session> {
    const now = new Date().toISOString();
    const session = { id: randomUUID(), projectRoot, createdAt: now, updatedAt: now, entries: [] };
    return this.state.update(this.name(session.id), sessionSchema, session, () => session);
  }
  async show(id: string): Promise<Session> { return this.state.read(this.name(id), sessionSchema); }
  async list(): Promise<Session[]> {
    return Promise.all((await this.state.names('session-')).map((name) => this.show(name.slice(8))));
  }
  async append(id: string, type: string, value: unknown): Promise<Session> {
    return this.state.update(this.name(id), sessionSchema, undefined, (session) => {
      const time = new Date().toISOString();
      return { ...session, updatedAt: time, entries: [...session.entries,
        { sequence: session.entries.length + 1, type, time, value: redactTaskValue(value) }] };
    });
  }
  async export(id: string): Promise<{ name: string; session: Session }> {
    const session = await this.show(id), name = `export-${id}`;
    await this.state.update(name, sessionSchema, session, () => session);
    return { name: `${name}.json`, session };
  }
}
