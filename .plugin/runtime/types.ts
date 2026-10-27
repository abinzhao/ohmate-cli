/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { SpawnOptions } from 'node:child_process';

/** runtime.json — the plugin's bundled runtime metadata. */
export interface RuntimeMetadata {
  packageName: string;
  packageVersion: string;
  nodeMajorMinimum: number;
  installRoot: string;
  hostBinDirs: string[];
}

/** A command to invoke, e.g. npm's JavaScript entry. */
export interface CommandInvocation {
  command: string;
  args: string[];
}

/** A directly spawnable CLI command with its resolved entry file. */
export interface RuntimeCommand extends CommandInvocation {
  entry: string;
}

/** inspectExecutable's result: this plugin's own launcher or a spawnable CLI. */
export type ExecutableLookup =
  | (RuntimeCommand & { wrapper?: undefined })
  | { wrapper: true };

/** A discovered CLI before its owning package version is known. */
export interface SourcedCommand extends RuntimeCommand {
  source: string;
}

/** A CLI candidate with a resolved (possibly null) version. */
export interface RuntimeEntry extends SourcedCommand {
  version: string | null;
}

export interface SkippedRuntime {
  source: string;
  entry: string;
  version: string | null;
}

export interface ResolvedRuntime extends RuntimeEntry {
  skipped: SkippedRuntime[];
}

export interface RuntimeProcessOptions extends SpawnOptions {
  capture?: boolean;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RuntimeRunner = (
  command: string,
  args: string[],
  options?: RuntimeProcessOptions
) => Promise<ProcessResult>;

/** Injected install dependencies; tests substitute fakes. */
export interface InstallDependencies {
  npmInvocation?: () => Promise<CommandInvocation>;
  runProcess?: RuntimeRunner;
}
