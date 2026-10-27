/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Emulator row from `emulator -list -details` (JSON or text). */
export interface EmulatorInfo {
  name: string;
  isRunning?: boolean;
  /** Quick Boot enabled at creation (`isHotBoot` from `-list -details`). */
  hotBoot?: boolean;
  instancePath?: string;
  path?: string;
  imageRoot?: string;
  /** From `-list -details` when present; CLI target for some images */
  uuid?: string;
  deviceType?: string;
  osVersion?: string;
}

/** Boot mode for `Emulator -bootMode`. */
export type EmulatorBootMode = 'coldboot' | 'snapshot' | 'reset';

/** Optional passthrough args for `Emulator -start …`. */
export interface EmulatorStartOptions {
  /** hdc port, 10000-16555 (`-hdcport`). */
  hdcPort?: number;
  /** Boot mode (`-bootMode`); overrides the instance's default boot mode. */
  bootMode?: EmulatorBootMode;
  /** Headless start without a window (`-noWindow`). */
  noWindow?: boolean;
}

export interface EmulatorCreateOptions {
  name: string;
  deviceType: string;
  osVersion: string;
  instancePath?: string;
  imageRoot?: string;
  screenProfile?: string;
  screen?: string[];
  storage?: number;
  memory?: number;
  hotBoot?: boolean;
  force?: boolean;
}

/** Match CLI input to `-list` names (unicode / repeated spaces). */
export function normalizeListNameKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Enable hot boot for API 26 and later images. */
export function supportsHotBoot(osVersion: string): boolean {
  const apiLevel = osVersion
    .normalize('NFKC')
    .match(/\((\d+)(?:\.\d+)*\)/)?.[1];
  return apiLevel !== undefined && Number(apiLevel) >= 26;
}
