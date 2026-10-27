@echo off
rem Copyright (c) 2026 Huawei Device Co., Ltd.
rem SPDX-License-Identifier: MIT
rem deveco-cli-plugin-entry
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  >&2 echo Node.js 22 or later is required. Install Node.js and retry.
  exit /b 1
)
node.exe "%~dp0..\runtime\main.mjs" run %*
exit /b %ERRORLEVEL%
