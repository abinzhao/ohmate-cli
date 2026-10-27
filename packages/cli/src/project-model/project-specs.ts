/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { basename } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { LocalState } from '../agent/local-state.js';
import { readMaterial } from '../agent/context-files.js';
import { serviceSpec } from '../agent/service-spec.js';
import { createExecutionContext } from '../runtime/context.js';
import { readProject } from './index.js';
import type { ExecutionContext, ToolSpec } from '../runtime/types.js';

const projectsSchema = z.array(z.strictObject({ root: z.string(), name: z.string(), workspaceId: z.string() }));
export async function registeredProjects(context: ExecutionContext) {
  return new LocalState(context.dataDir).read('projects', projectsSchema, []);
}
export function getProjectSpecs(): ToolSpec[] {
  return [
    serviceSpec('project.list', 'List explicitly registered local applications', z.strictObject({}),
      async (_, context) => ({ exitCode: 0, data: await registeredProjects(context) })),
    serviceSpec('project.register', 'Validate and register an explicitly selected application directory',
      z.strictObject({ path: z.string().min(1).max(1024) }), async (input, context) => {
        const scoped = await createExecutionContext({ cwd: context.cwd, projectRoot: (input as { path: string }).path });
        const project = await readProject(scoped.projectRoot!);
        let name = basename(project.root);
        try {
          const material = await readMaterial(project.root, 'AppScope/app.json5', 'file', context.dataDir);
          const app = z.object({ app: z.object({ bundleName: z.string().min(1) }) }).parse(JSON5.parse(material.text));
          name = app.app.bundleName.split('.').at(-1)!;
        } catch (error) { if (!project.modules.length) { throw error; } }
        const item = { root: scoped.projectRoot!, name,
          workspaceId: scoped.workspaceId };
        await new LocalState(context.dataDir).update('projects', projectsSchema, [], (items) =>
          [...items.filter((old) => old.root !== item.root), item]);
        return { exitCode: 0, data: item };
      }, [], [{ name: 'path', required: true, variadic: false }]),
  ];
}
