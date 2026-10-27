/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export { loginService, LoginService } from './login/login-service.js';
export { tokenStorage, TokenStorage, isDevecoCodeAuth } from './utils/token-storage.js';
export { DefinedError } from './utils/errors.js';
export { teamListAdapter, TeamListAdapter, getTeamList } from './team/team-service.js';
export type { Team, TeamListResult, UserInfo, LoginConfig } from './types/auth-types.js';
