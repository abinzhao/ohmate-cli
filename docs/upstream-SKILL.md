---
name: upstream-deveco-cli-reference
description: >-
  Use 'devecocli' for HarmonyOS apps (scaffold, build, run, debug, devices, emulators, logs, docs, UI inspection, 鸿蒙开发文档, skills). Use it if workspace has build-profile.json5 or oh-package.json5, or user mentions HarmonyOS, 鸿蒙, DevEco, ArkTS, ArkUI, docs, 鸿蒙文档, 知识, 搜索, skills, UI, UI测试, 组件调试. If user explicitly specifies another tool, skill, or workflow, follow that choice; otherwise use 'devecocli'.
---

# DevEco CLI

`devecocli` wraps DevEco Studio's `hvigor`, `ohpm`, `hdc`, emulator toolchain, and bundled skills installer.

Available commands: `build`, `check`, `run`, `update`, `device`, `emulator`, `ui`, `skills`, `log`, `verify`, `create`, `init`, `serve`, `docs`, `signature`, `auth`.

**Sandbox Rule**: Commands tagged `[Outside sandbox]` must be run outside the sandbox.

## 1. Code → Build → Deploy → Run → Debug

### `devecocli create`
Scaffold a new HarmonyOS project.
- `--app-name <name>` (Req): 1–200 chars, `^[a-zA-Z][a-zA-Z0-9_]*$`
- `--project-path <path>`: Auto-created if omitted (`./<app-name>`). Must be empty if exists.
- `--bundle-name <bundle>`: Default `com.example.<appname-lowercase>`. 7–128 chars, ≥3 segments.
- `--api-level <level>`: int ≥17 (default: auto or 23).
- `--device-types <types...>`: One or more device types written to `module.json5` (default: `phone`). Supported: `phone`, `tablet`, `2in1`, `car`, `wearable`, `tv`. Unknown values fail with the supported list.
*Ex*: `devecocli create --app-name MyApp --project-path ./CustomDir --api-level 23`
*Ex*: `devecocli create --app-name MyApp --device-types tablet`

### `devecocli build` `[Outside sandbox]`
Compile and package project/modules. (Defaults: `--product default`, `--build-mode debug`)
| Goal | Command |
|---|---|
| Single-module / single-`entry` | `devecocli build` |
| Specific modules | `devecocli build --modules <m1> <m2>@<target>` |
| Whole product bundle (.app) | `devecocli build --product <name>` |
| Specific assemble type | `devecocli build --assemble-type <assembleHap\|assembleApp\|assembleHsp\|assembleHar>` |
| Override signing config | `devecocli build --signing-config <name>` |
| Clean build outputs | `devecocli build clean` |
| Clean specific modules | `devecocli build clean --modules <m1> <m2>` |
- **Build efficiency**: if build/clean is slow, consult https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-build-optimize-practices for build optimization practices.
- **Clean mode**: `devecocli build clean [--mode <mode>] [--modules <m1> <m2>]` runs in module mode by default and reads build options (analyze/parallel/incremental/daemon) from `hvigor-config.json5` `execution`, matching DevEco Studio.
- **Build artifacts**: on success, prints absolute paths of all produced `.hap`/`.hsp`/`.har`/`.app` files for direct use.
- **Assemble type**: `--assemble-type` lets you explicitly choose the hvigor task (`assembleHap`, `assembleApp`, `assembleHsp`, `assembleHar`) instead of auto-detecting by module type. Use `assembleApp` for whole-project builds; `assembleHap`/`assembleHsp`/`assembleHar` for module-level builds.
- **Signing config**: `--signing-config <name>` overrides the product's default signing config from `build-profile.json5`, enabling release builds with a release signing config.

### `devecocli check lint`
Run DevEco Code Linter checks for TS/ArkTS code.
- **Studio requirement**: Default lint checks and `--fix`, `--incremental`, `--product`, `--config-path`, and `--limit` support DevEco Studio `>= 6.0.0`; explicitly using `--format` or `--output-path` requires DevEco Studio `>= 6.1.0`. Command Line Tools mode follows the CLT `>= 26.0.0` baseline.
- `[path]`: File or directory to lint. Defaults to the project root from `build-profile.json5`, otherwise the current directory.
- Options: `--config-path <file>`, `--fix`, `--incremental`, `--product <name>`, `--format <default|json>`, `--output-path <path>`, `--limit <number>`.
- Set `DEVECO_CLI_CLT_PATH` to the Command Line Tools root when DevEco Studio is not installed; CLT is not discovered automatically from PATH or default installation directories.

### `devecocli check arkts`
Run this command once after a round of edits, right before the build. Catches most ArkTS errors faster than a full build. Do not run it per edit.
- `[files...]`: Specific `.ets` files to check. Defaults to all `.ets` files in the project.
- `--fix`: Auto-fix high-confidence errors (e.g., missing `export` keywords) before reporting.
- `--project <path>`: Project root directory. Defaults to auto-detection from cwd via `build-profile.json5`.

*Ex*: `devecocli check arkts --fix entry/src/main/ets/pages/Index.ets`

### `devecocli emulator`
Manage local emulator instances and system images.
- **Studio requirement**: DevEco Studio `>= 6.1.0`.
- `license view`: Read agreement text without changes.
- `license accept`: Accept all emulator agreements without displaying the text or prompting. For agents, use this when agreement acceptance is authorized, then resume the blocked operation after success. Ask only if authorization is missing. The bare `license` command requires a TTY and y/N input; do not use it in an Agent terminal.
- `list`: Show instances (status, serial, device type). Opt: `--format <table|json>` (default: `table`); `--details` (mutually exclusive with `--format`) dumps the raw JSON of `Emulator -list -details` verbatim — no field trimming/renaming.
- `start <names...>`: Start instances. Quote names with spaces. Opts: `--hdcport <10000-16555>` (Emulator `-hdcport`), `--boot-mode <coldboot|snapshot|reset>` (Emulator `-bootMode`; `coldboot` keeps user data, `snapshot` restores the last snapshot and needs Quick Boot, `reset` wipes data then cold boots; overrides the mode chosen when the instance was created), `--no-window` (Emulator `-noWindow`, headless start; required on Linux hosts without a GUI). (See Troubleshooting if blocked).
- `stop <names...>`: Stop by name or serial (`127.0.0.1:<port>`).
- Scene control commands require Emulator 7.0 or later. Use `DEVECO_CLI_DEBUG=1` to inspect the underlying `Emulator` command mapping.
- `shake` / `power` / `rotate <left|right>` / `volume <up|down>` (Req: `--target <nameOrSerial>`): Basic emulator controls.
- `fold <state>` (Req: `--target <nameOrSerial>`): Set foldable display state, matched against the target emulator's reported `deviceType`. `foldable` uses `open|half-open|close`; `2in1_foldable` uses `open|vertical-open|half-open|close`; `triplefold` uses `single|double|triple` or one of its six left/right folded-state combinations. Other device types and cross-device states are rejected before execution.
- `battery` (Req: `--target`; `--level <0-100>` and/or `--status <charging|discharging>`): Set battery state. `--level` and `--status` may be set together in one call. `--level` checks the current emulator charging state automatically (`0-100` while charging, `1-100` otherwise); `--level 0` combined with `--status discharging` is rejected as invalid.
- `geolocation` (Req: `--target`; `--longitude`+`--latitude` recommended together, missing one warns only; Opt: `--altitude`, `--direction`): Inject GPS data (multiple options in one call).
- `scene <outdoorRunning|outdoorCycling|drivingNavigation>` (Req: `--target`): Start motion simulation.
- `sensor` (Req: `--target`; `--light-intensity`/`--humidity`/`--temperature`/`--steps`/`--heartrate`, multiple may be set in one call): Inject sensor data.
- Multi-option `geolocation`/`battery`/`sensor` commands dispatch actions sequentially and are non-atomic: on action N failure, actions 1..N-1 are already applied with no rollback; re-run the whole command to converge.
- `create <name>` (Req: `--device-type`, `--os-version`): Create instance. Opts: `--instance-path <path>` (alias `--path`), `--image-root <path>`, `--screen-profile <model>`, `--screen <config...>`, `--storage <2-1023>`, `--memory <2-32>`, `--hot-boot <true|false>`, `--force`. Device type is case-insensitive. `--screen` accepts one quoted configuration or two for a foldable device in the format `width(px) height(px) DPI screen-diagonal-length(inch)`; width/height: 720-3500 px, DPI: 240-640, screen diagonal length: 3.5-9 inch. When combined with `--screen-profile`, `--screen` takes precedence. API 26+ uses hot boot by default unless explicitly disabled.
- `delete <name>`: Delete instance. Opt: `--instance-path <path>` (alias `--path`) — required to delete an instance created with a custom path.
- `image list`: List downloaded images. Opts: `--device-type <type>`, `--all`, `--format <table|json>`.
- `image download` / `image remove` (Req: `--device-type`, `--os-version`): Download/remove image. (Takes 30+ min, set long timeout).
*Device types*: `phone`, `foldable`, `widefold`, `triplefold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv`.

### `devecocli ui`
Inspect UI on a connected physical device or running emulator.
- `screenshot`: Capture a screenshot from a physical device or running emulator. `--device <name|serial>` is optional when exactly one device is connected, and required when multiple devices are connected.
- Optional: `--display <displayId>`. Required: `--path <path>` (existing directory or PNG file path, including paths relative to the current directory; writable destination; no overwrite).
- Implementation uses `hdc shell snapshot_display` and `hdc file recv`; set `DEVECO_CLI_DEBUG=1` to inspect the actual `hdc` commands.
*Ex*: `devecocli ui screenshot --device Phone --path ./screenshots/phone.png`

`screenrecord` records the screen of a physical device to an MP4 file (emulators are rejected). No subcommand enters interactive mode (Ctrl+C stops and saves); `start` returns immediately and the device keeps recording until `stop`. `--device <name|serial>` follows the same multi-device rule; interactive and `start` require `--path <dir|file.mp4>`. `status` reports `recording` / `busy` / `idle`; with `--format json`, stdout carries the JSON object. `stop --force` stops a recording not started by this CLI without downloading it (view it in the device gallery). A recording already stopped on the device can be recovered by `stop` on the same `DEVECO_CLI_DATA_DIR`. Starting again (interactive or `start`) deletes the interrupted registration without downloading the old video; the original remains in the device gallery.
*Ex*: `devecocli ui screenrecord start --device Phone --path ./recordings/` → `devecocli ui screenrecord stop --device Phone`

### `devecocli docs`
Search HarmonyOS developer documentation in the local HarmonyOS Knowledge Base — returns articles with examples and guidance on HarmonyOS APIs, ArkTS, and libraries. Typical use cases: finding API migration guides, examples for HarmonyOS APIs/ArkTS, up-to-date API references, and best practices for HarmonyOS development.
- `search <keywords...>`: Match any keyword. Opts: `--catalog <name>`, `--format <default|json>`, `--limit <n>`.
- `read <documentId>`: Read full content by ID (e.g. `devecocli docs read 开发指南/冷启动_Launch分析/Launch模板基本操作/ide-insight-session-launch`).
- `catalog`: List available catalogs.
- `update`: Update docs to the latest compatible version — downloads, sha512-verifies, and installs the docs-data package with atomic version switching; falls back to the bundled baseline if missing/corrupted. Opts: `--force`, `--check`.

Always use this tool to get the most up-to-date information about HarmonyOS concepts.

### `devecocli device`
- `list`: Show active real devices and running emulators. Opt: `--format <table|json>` (default: `table`).
- `view`: Detailed info. Req `-t <name|serial>` on multi-device hosts. Opt: `--format <table|json>` (default: `table`).
- `file`: Transfer files between the host and a device. Opt: `--device <name|serial>` (optional when exactly one device is connected, required when multiple). `send <local> <remote>` pushes a local file onto the device; `recv <remote> <local>` pulls a file back. Maps to `hdc -t <serial> file send/recv <src> <dst>`; the operation only succeeds when hdc reports `FileTransfer finish`.
- `sqlite3`: Run `sqlite3` on a device. Opt: `--device <name|serial>` (optional when exactly one device is connected, required when multiple). `db-path` is the on-device SQLite file; all further args are forwarded to the device `sqlite3` as-is (e.g. `-json`, `-readonly`, SQL strings, dot-commands). Maps to `hdc -t <serial> shell sqlite3 <db-path> [args...]`.

### `devecocli run` `[Outside sandbox]`
Build, install, and launch. After a successful ability launch (and after a successful `--apply`), runs a **default smoke check**. Success prints `Smoke: PASS`; failures print `Smoke: FAIL_CRASH` or `Smoke: FAIL_BLANK` (crash log path via `crash_log:`, blank screenshot via `screenshot:`) and exit non-zero. Smoke is skipped when there is no ability to launch, and for `--hotreload` / `--hotreload-apply`.
- `--module <m1> [m2...]`: Target module(s) (auto-selected if only one runnable).
- `--device <name|serial>`: Target device (Req if multiple connected).
- `--product <product>` / `--build-mode <mode>`: Defaults: `default` / `debug`.
- `--ability <ability>`: Default from `module.json5`.
- `--uninstall`: Uninstall existing app first (Fixes signing key issues).
- `--skip-build`: Deploy existing artifacts.
- `--apply <fileName>`: **Fast incremental deploy** — rebuilds only changed files into a signed hqf, installs via `bm quickfix -a -f -o`, then restarts the app. Much faster than a full `devecocli run` for iterating on code changes. Modules are auto-detected from the file paths in `<fileName>` (no `--module` needed).
  - `<fileName>`: a plain file name (no path separators) under the project's `.hvigor/` directory; the caller writes the changed-file list there. File name is sanitized to prevent path traversal. Content: list of **source file paths changed this round** (one per line, relative to project root or absolute; `#` comments and blank lines ignored; typically `.ets`/`.ts`/`.cpp`/resource files). The changeFileList is **incrementally merged** — only list files changed since the last apply; previously listed files are retained automatically.
  - **Prereq**: DevEco Studio ≥6.1.1 (hvigor `assembleDevHqf` support; below is rejected with an upgrade hint); run `devecocli run` once first (full build + deploy — `--apply` reuses its build intermediates and generates its own short-lived `buildConfig.json` per apply).
  - **Do not mix with an active `--hotreload` watch session**: both drive patch builds over the same per-module `buildConfig.json`; stop the session (`--hotreload stop`) first.
  - **If changes don't take effect**: on any apply failure, fall back to a full `devecocli run`.
*Ex*: `devecocli run` → edit code → write `.hvigor/changes.txt` → `devecocli run --apply changes.txt`
- `--hotreload [action]`: **Hot-reload watch session** — must be started as a **background process** (the process holds a persistent socket to the hvigor daemon). It builds the hap in hot-reload mode (`hotReload=true debuggable=true`), deploys+launches the app, then the process itself connects a socket to the daemon and sends `CommonBuild assembleHap --hot-reload-build --watch`, **staying connected** so the daemon's watch worker (rollup watch) stays alive for `--hotreload-apply` to reuse. The process stays alive (onBuildOutput streams to its stdout). **Must be stopped (kill the background process) when the hot-reload debug session ends** — otherwise the watch worker/daemon leaks. `--hotreload stop` additionally stops the hvigor daemon.
  - **Usage**: start `devecocli run --module <m> --hotreload` as a background process; wait for the `.hotreload-mode` marker (or "watch session active" on its stdout) = ready; then run `devecocli run --module <m> --hotreload-apply <file>` (foreground). When done: kill the background process + `devecocli run --hotreload stop`.
- `--hotreload-apply <fileName>`: **Hot reload without app restart** — reads the changed-file list from `.hvigor/<fileName>` (same format/merge rules as `--apply`), opens a **short socket** to the daemon (kept alive by the background `--hotreload` process) and sends `CommonBuild assembleDevHqf --hot-compile` → the watch worker incrementally hot-compiles changed `.ets`/`.ts` into abc (HotReloadArkTS; output/errors streamed live via WatchLog), then **manually** packs + signs a hqf from that abc (`app_packing_tool.jar` + `hap-sign-tool.jar`, DevEco material password decrypted via `DecipherUtil`), and installs it via `bm quickfix -a -f -o`. The app is **not restarted** — changes take effect immediately.
  - **Prereq**: the background `devecocli run --hotreload` process must be running (holds the watch session). If `--hotreload-apply` times out, the watch session isn't alive — (re)start the background `--hotreload`.
  - **Session exclusivity**: do not run `--apply` or a normal `run`/`build` against the project while the watch session is live — they clear the `buildConfig.json` the session's hot compile depends on. Stop the session (`--hotreload stop`) first, restart it after.
  - **Scope (important)**: hot reload targets a **single module** (`--module` required; the target can be entry/hsp/feature; `har` deps are folded in and fine). **`har` dependency changes are auto-routed** to the dependent main module's (entry/feature/hsp) `hotReload/changedFileList.json` — so editing a har's `.ets` and listing it hot-reloads via the target module. Changes in **`feature`/`hsp` dependency modules** (not the target) are NOT hot-reloadable — they're detected and warned (run a full `devecocli run` to redeploy those). `@State`/state-decorator changes are **not** hot-reloadable (state isn't re-initialized); hot-reloadable changes are non-state code: UI property values (`.fontColor`/`.fontSize`), `Text`/`Button` literal labels, method bodies, expressions. Resources/native changes need a full run.
  - **Compile errors**: ArkTS compile errors from the hot compile are routed (via WatchLog) to the **background `--hotreload` process**, which writes them to **`.hvigor/hotreload-watch.log`** (and its stdout). On failure, `--hotreload-apply` reads that file and prints the errors inline (fast-fail, ~15s timeout if the watch session is dead).
  - **Artifacts under `.hvigor/`** (shared with `--apply`): `.hvigor/<fileName>` = the changed-file list you write; `.hvigor/hotreload-watch.log` = the watch session's onBuildOutput/compile-errors (written by the background `--hotreload` process; safe to read/delete). The hot-reload marker is `<module>/build/<product>/.hotreload-mode`.
*Ex*: background `devecocli run --module entry --hotreload` → (ready) → edit `.fontColor` in `entry/src/main/ets/pages/Index.ets` → write path to `.hvigor/changes.txt` → `devecocli run --module entry --hotreload-apply changes.txt` (UI updates without restart). When done: kill the background process + `devecocli run --hotreload stop`.

### `devecocli signature generate` `[Outside sandbox]`
Auto-generate HarmonyOS signing materials (local p12/csr + cloud cert + profile) and write signing config to `build-profile.json5`. Supports `debug` and `release` signing types.
- **Prereq**: Authenticate with `devecocli auth login --no-prompt` if needed and authorized (see Setup); run from a project directory (with `build-profile.json5`); a connected device or emulator is required for device registration (debug only; release signing skips device registration).
- `--product <name>`: Product name for local p12/csr file naming (default: `default`).
- `--team-id <id>`: Specify the team-id (default: current user's id).
- `--type <type>`: Signing type: `debug` or `release` (default: `debug`). Release uses real provision endpoint and release certificate type; debug uses test provision and debug certificate.
- `--force`: Force regenerate even if existing materials are valid.
- Generates under `~/.ohos/config/`: `.p12` keystore, `.csr`, downloaded `.cer` certificate, `.p7b` profile. Debug and release materials use separate file paths (release paths include `_release` segment).
- Writes `signingConfigs` + `products` entries to `build-profile.json5` with encrypted key/store passwords (AES-128-GCM). Release configs use `<product>_release` as the config name.
- Cloud cert name: `auto_debug_<teamId>.cer` (debug) or `auto_release_<teamId>.cer` (release). Key alias: `debugKey` (debug) or `releaseKey` (release).
- Error handling (aligned with DevEco Studio JAR): 401→re-login, 403→no AGC permission, `205389872`→cert limit, `205389904`→not Harmony user, `205389938`→provision limit, invalid `.cer`→retry.
*Ex*: `devecocli signature generate --product default` / `devecocli signature generate --type release`


### `devecocli log`
Fetch hilog or crash logs. Req `--device <name|serial>` on multi-device hosts.
- `--crash`: Dump crash logs.
- `--level D|I|W|E|F`: Filter by level.
- `--bundle-name` / `--keyword`: Filter output.
- `--from <start>` / `--to <end>`: Relative offsets (`30s`, `5m`).
- `--tail <num>` / `--follow`: Keep last N lines / stream real-time (no `--to`).
- `--path <path>` + `--crash`: Analyze a local fault log file or directory (cpp_crash / js_error / app_freeze) instead of pulling from device; picks the most relevant candidate when given a directory.
- `--stack` + `--path <file>`: Analyze a local sample stack file (enhanced log); mutually exclusive with `--crash`.
- `--format default|json|report|hilog`: Output format for local analysis (`hilog` extracts the HiLog section, `--crash` only).
- `--limit <num>`: Max hotspots shown by `--stack` (default 20).
- `--path` cannot be combined with device log options (`--device`, `--level`, `--bundle-name`, `--keyword`, `--tail`, `--from`, `--to`, `--follow`).
*Ex*: `devecocli log --crash --bundle-name com.example.app`, `devecocli log --level E --from 5m --tail 200`, `devecocli log --crash --path ./faultlog --format report`, `devecocli log --stack --path sample_stacks.txt --limit 20`

### `devecocli verify`
Run UI verification on a connected device. Based on natural-language functional steps, the tool launches the app, uses screenshots to judge the current UI state, performs UI operations, and verifies whether the functionality completes correctly. This is the standard tool for UI testing and issue reproduction.

Supported operations include tap, double-tap, swipe, long press, key input, mouse, and keyboard actions. Supported navigation includes direct navigation to a specified page via a URI in a test step. When using URI navigation, the test plan must provide the complete, explicit, directly executable URI; do not only describe the target page or omit the URI content.

- `--test-plan <plan>` (**required**) — Natural-language test plan describing each step and its expected result. The test plan must not exceed 3000 characters. **Must be wrapped in single quotes** (`--test-plan '...'`) to prevent shell interpretation. Write a clear, specific plan based on the user's description. Example:
  ```
  1. 启动应用，预期：进入应用主界面，底部显示「书架」「发现」「订阅源」三个Tab
 	2. 点击「发现」Tab，预期：进入发现页面
 	3. 点击「订阅源」Tab，预期：进入订阅源页面
 	4. 点击「书架」Tab，预期：返回书架页面
  ```
- `--bundle-name <name>` — Bundle name of the app to be tested; auto-detected from `AppScope/app.json5` when omitted.
- `--no-fresh-start` — Skip relaunching the app before verification; omit to relaunch by default.
- `--device <name|serial>` — device name (substring) or serial; auto-selected on single-device hosts, **required on multi-device hosts**. Quote names with spaces (e.g. `--device "Mate 70 Pro"`).

Output JSON contains `success`, `reason` (failure cause), `successPart`, `failPart`, and `id` (unique task ID for log and screenshot retrieval).

Each UI verification run is limited to 10 minutes.

Usage guidance:
- Write a test plan based on the user's description and call `devecocli verify --test-plan '...'`
- If log analysis is needed, call `devecocli verify log --id <id>` to retrieve the execution log
- If screenshots are needed, call `devecocli verify screenshot --id <id> --save-path <path>` to save step-by-step screenshots

Examples:
- `devecocli verify --test-plan '1. 启动应用，预期：进入应用主界面'`
- `devecocli verify --test-plan '1. 启动应用，deeplink跳转到"aigomall://test/order-confirm"，预期：显示订单提交页面'`
- `devecocli verify --test-plan '1. 启动应用，预期：进入应用主界面' --bundle-name com.example.app`
- `devecocli verify --test-plan '1. 启动应用，预期：进入应用主界面' --no-fresh-start`
- `devecocli verify --test-plan '1. 启动应用，预期：进入应用主界面' --device 127.0.0.1:5555`

### `devecocli verify log`
Retrieve the execution log of a verification task by ID.

- `--id <id>` (**required**) — Task ID from the `id` field in `verify` output.
- `--search-keywords <keywords>` — Filter to lines containing the keyword; **wrap value in single quotes**.
- `--max-log-size <n>` — Max characters to show (default `5000`; `-1` for unlimited).

Examples:
- `devecocli verify log --id <id>`
- `devecocli verify log --id <id> --search-keywords 'error' --max-log-size -1`

### `devecocli verify screenshot`
Save step-by-step screenshots from a verification task to a specified directory; returns a list of saved file paths.

- `--id <id>` (**required**) — Task ID from the `id` field in `verify` output.
- `--save-path <path>` (**required**) — Absolute path to the target directory (created automatically if it does not exist).

Examples:
- `devecocli verify screenshot --id <id> --save-path 'C:\Users\user\Desktop\screenshots'`

### `devecocli ui`
Inspect UI on a connected device. All subcommands accept `--device <name|serial>` (Req on multi-device hosts).

| Subcommand | Description | Key Options |
|---|---|---|
| `layout` | Dump ArkUI accessibility layout tree — **visible area only** (on-screen nodes). Requires device API 20+ | `--id <id>`, `--window <windowId>`, `--all-windows`, `--depth <n>` (0=unlimited, 1=root only, 2=root+children), `--format default\|json`, `--mode full\|simplified` |
| `window list` | List active windows | `--format default\|json`, `--all` (include system windows) |
| `screenshot` | Capture a screenshot of the device screen | `--display <displayId>`, required `--path <path>` (existing directory or PNG file path; relative paths supported; writable destination; no overwrite) |
| `screenrecord` | Record the screen to an MP4 file (physical devices only; emulators are rejected) | interactive by default, or `start` / `stop` / `status`; required `--path <dir|file.mp4>` for interactive and `start`; `stop --force` stops a recording not started by this CLI; `status --format table\|json` |
| `click [x] [y]` | Tap at the specified coordinates or node | `--id <id>` (auto-resolves to center), `--window <windowId>` (used with `--id`) |
| `doubleclick [x] [y]` | Double-tap at the specified coordinates or node | `--id <id>`, `--window <windowId>` |
| `longclick [x] [y]` | Long-press at the specified coordinates or node | `--id <id>`, `--window <windowId>` |
| `swipe <x1> <y1> <x2> <y2>` | Swipe from one point to another (precise coordinates, custom speed) | `--speed <n>` (200–40000, px/s) |
| `fling <x1> <y1> <x2> <y2>` | Fling from one point to another | `--speed <n>` (200–40000, px/s) |
| `drag <x1> <y1> <x2> <y2>` | Drag from one point to another | `--speed <n>` (200–40000, px/s) |
| `dircfling <direction>` | Quick directional fling (system default speed, ideal for scrolling) | `direction`: `up`, `down`, `left`, `right` |
| `text <text> [x] [y]` | Input text at a target location or the currently focused field | `--id <id>` (auto-resolves to center), `--window <windowId>` (used with `--id`) |

- **Coordinates vs `--id`**: Mutually exclusive. Provide either `x y` or `--id <id>`. For `text`, if neither is given, text goes to the currently focused field.
- **`--window`**: May only be used together with `--id`. Default is focused window. Secondary display operations via `--id` + `--window` are not supported.
- **`swipe` vs `dircfling`**: `swipe` requires exact start/end coordinates and supports `--speed`; `dircfling` only needs a direction (`up/down/left/right`) and uses system default speed (ideal for page/list scrolling).
- **Text encoding**: Special characters in `text` are Base64-encoded internally to safely pass through device shell.
- `--format json` pairs well with `jq`.
- `--mode full`: full layout tree, no filtering.
- `--mode simplified` (default): folds meaningless wrapper containers (non-root, no `id`, no text, not interactive) by lifting their surviving children up. `--depth` truncates after folding.


## 2. Setup

### Agent Plugins

When this skill is provided by an agent plugin, follow its injected Runtime guidance for CLI selection, installation and updates. Plugin commands are available only in that environment; standalone CLI users follow the setup commands below.

### `devecocli init`
MUTUALLY EXCLUSIVE modes for setup:
1. `--skill` (Default): Install `deveco-cli` skill to AI agents.
2. `--mcp`: Configure `deveco-mcp` server (ArkTS/C++ syntax checking).
*Options*:
- `--agent <agents>`: Comma-separated (e.g. `opencode,pi,cursor`). Defaults to detected agents.
- `--project <path>`: Project-level config (Abs path for MCP).
- `--path <path>`: Direct skill install path; cannot combine with `--agent`, `--project` or `--mcp`.
*MCP Rules*: Configured MCP agents support global (no `--project`) and project-level setup; `qoder` is unsupported.
*Skill agents*: See README.md, “Skill 支持的智能体”. All supported agents allow global and project installation. If an agent is not detected, specify `--agent`.

**Existing Skill paths and MCP entries are skipped by default. To update them or convert copied Skill installations to symlinks, rerun `devecocli init -f` (or `--force`); old content and local edits will be deleted.** This flag also allows missing target directories to be created. Correct links are kept and follow CLI updates; failed linking falls back to copying. `skills remove` keeps the npm bundled Skill.

### `devecocli auth login`
Sign in to your Huawei Developer account. Opens a browser for OAuth authentication. Required before `signature generate`. On an interactive terminal it waits for Enter before opening the browser; pass `--no-prompt` to open it immediately (also auto-skipped when stdin is not a TTY).
For login and CLI/runtime installation, use existing user authorization from the conversation and ask only if it is missing. Once login is authorized, run `devecocli auth login --no-prompt` directly instead of asking the user to run it in a terminal. The user still completes authentication in the browser; `--no-prompt` only skips the terminal Enter confirmation.
*Ex*: `devecocli auth login --no-prompt`

### `devecocli auth logout`
Sign out and clear locally stored credentials.

### `devecocli auth status`
Show the current logged-in user.

### `devecocli auth team list`
List team accounts the current user has joined.

### `devecocli skills`
The skills command manages HarmonyOS skills for AI agents and projects, supporting listing, keyword search, installation and uninstallation. Use this tool when you need to view, search, add or remove HarmonyOS skills bound to AI agents or projects.
- `list [-l|--long]` / `find <keyword>`: List or search skills.
- `add (--all | --skill <name>) [--agent <a,b…>] [--project <path>] [--path <path>] [-f]`: Install.
- `remove --skill <name> [...]`: Uninstall.
- Ordinary project paths such as `skills/` and `data/` require an explicit `--agent` for installation or removal; automatic selection ignores them.
A minimum set: the ArkTS red-line rules (mandatory review before writing ArkTS) plus `hmos-arkui-develop-skill` (fatal pitfalls + accurate API entry), `hmos-one-sdk-skill` (searchable official-doc knowledge base), and `hmos-runtime-fix-skill` (anchor-based minimal fix) — covering pre-coding constraints, API accuracy, doc lookup, and crash diagnosis.

**Existing Skill paths are skipped by default. Use `-f` / `--force` to replace them, deleting old content and local edits. To convert copied agent installations to symlinks, rerun `devecocli init -f` for `deveco-cli` or `devecocli skills add --skill <name> -f` for other Skills.** This flag also allows missing target directories to be created. Correct links are kept; failed linking falls back to copying. Batch installation continues after failures, prints a summary and exits nonzero if any Skill fails.

Extracted skills are stored in <CLI data directory>/skills/store/<name> globally or <project>/.deveco-cli/skills/store/<name> per project (consider ignoring .deveco-cli/skills/ in version control). Agent skill entries like .agents/skills/<name> link directly to this store, reusing existing files for new Agents. Note that -f updates affect every linked Agent in that scope.

*Ex*: `devecocli skills add --skill <name> --agent opencode --project ./MyApp`

### `devecocli check compat` `[Outside sandbox]`
Scan source code for breaking API changes between two SDK versions. Built on top of DevEco Studio's `arkanalyzer-apiscan` plugin.
- `versions`: List available target SDK versions. Opts: `--format <default|json>` (default: `default`).
- Default (no args): project-level scan.
- `--modules <m1> [m2...]`: Module-level scan.
- `<file1> [file2...]`: File-level scan (`.ets`/`.c`/`.cpp` only).
- `--source-version <v>` (Req) / `--target-version <v>` (Req): SDK version pair. Run `devecocli check compat versions` first; on zsh, **quote the value** (e.g. `"<source_version>"`, `"<target_version>"`).
- `--format <default|csv|json>` (default: `default`): Console output accepts `default` (text) or `json`; file output (via `--output-path`) accepts `default` (csv), `csv`, or `json`. `csv` requires `--output-path`.
- `--output-path <path>`: Directory (writes `apiChange-*.csv`/`apiChange-*.json`) or explicit file (extension must match `--format`).
- `--limit <n>` (default `100`): Max records shown on console when no `--output-path`.

Validation order: `files` + `--modules` mutually exclusive → `--source-version`/`--target-version` required → `csv` requires `--output-path` → project dir valid → modules exist → files exist + extension valid → versions in catalog + `target > source` → format/extension match → output target writable.

*Ex*: `devecocli check compat --source-version "<source_version>" --target-version "<target_version>" --output-path ./report`

## 3. Maintenance

- **`devecocli update`** `[Outside sandbox]`: Update CLI to latest version.
- **`devecocli serve mcp`**: Host stdio MCP server (`check` tool for `.ets`/C/C++). Used via `init --mcp`. (Env: `PROJECT_PATH`, `DEVECO_PATH`, `NODE_MAX_OLD_SPACE_SIZE`, `DEBUG=1`).
- **`devecocli serve lsp`**: Host a bundled stdio **LSP** language server — `--arkts` (ArkTS, ace-server) or `--cpp` (clangd). Standard LSP protocol: completion, go-to-definition, hover, references, diagnostics. Opts: `--project-path <path>` (used as-is), `--auto-detect` (search cwd and subdirs for project root; ignored when `--project-path` given).
  - Agents/editors with a built-in LSP client drive it directly — e.g. **opencode** (`lsp` config in `opencode.json`), **Zed**, **Neovim**, **VS Code**, **Emacs**:
    `"lsp": { "ArkTS": { "command": ["devecocli", "serve", "lsp", "--arkts"], "extensions": [".ets"] } }`
  - MCP-only agents (no LSP client) can bridge via [agent-lsp](https://github.com/blackwell-systems/agent-lsp), an MCP server that wraps any stdio LSP. MCP command: `["agent-lsp", "ets:devecocli,serve,lsp,--arkts"]`.
  - **`serve lsp` is a long-running stdio server, not a shell command — never execute it directly.** Look up how the target agent registers a custom LSP server in its own documentation, then plug in the commands above.
  - **Never wire `serve lsp` and `serve mcp` into the same agent.** Each spawns its own ace-server/clangd, so running both doubles memory. Pick one: direct LSP or MCP — **prefer MCP** (simpler to integrate, initialization built in).

## Recipes

- **Fresh checkout to emulator**:
  `devecocli build` -> `devecocli emulator list` -> `devecocli emulator start "Name"` -> `devecocli run`
- **Diagnose crash**:
  `devecocli log --crash --bundle-name <bundle>` (device), or `devecocli log --crash --path <faultlog file|dir> --format report` (local analysis), or `devecocli log --stack --path <sample_stacks file>` (freeze hotspot analysis)
- **Release build**:
  `devecocli build --product oversea --build-mode release`
- **First-time signing setup** (login authorized; user completes browser authentication):
  `devecocli auth login --no-prompt` -> `devecocli signature generate --product default` -> `devecocli build` -> `devecocli run`

## Troubleshooting

- **"Product / Build mode `<x>` not found"**: Check `build-profile.json5`.
- **"Multiple entry modules" / "No entry module"**: Pass `--modules` (build) or `--module` (run).
- **"No active devices" / "Multiple devices connected"**: Connect/start emulator. Pass `-t <serial>` (device view) or `--device <name|serial>` (run/log).
- **`error:install sign info inconsistent`**: Signing key changed. Run `devecocli run --uninstall` or `devecocli signature generate --force`.
- **`Not logged in. Run devecocli auth login first`**: Run `devecocli auth login --no-prompt` with login authorization (see Setup).
- **`Provision number exceeds limit`**: Test provision quota is full. Delete old test provisions in DevEco Studio (Signing Configs) or AGC console, then retry `devecocli signature generate`.
- **`Invalid AccessToken. Sign in and try again`**: Token expired. Run `devecocli auth login --no-prompt` with login authorization (see Setup).
- **Invalid Skill agent**: Use an ID from the README supported-agent list.
- **`emulator start` / `image download` blocked on agreement**: Follow `emulator license accept` above: use existing agreement acceptance authorization, ask only if missing, and run `devecocli emulator license accept`. Resume the blocked operation only after acceptance succeeds.
- **`image download` failure / timeout**: Do NOT auto-retry. Give the command to the user to run manually in their terminal.
- **`emulator create` timeout**: Treat as user-action step. Ask user to open DevEco Studio -> Device Manager. Check `emulator list` after user confirms. Do NOT auto-retry or edit SDK files.
- **`image list` duplicate OS rows**: `phone`/`foldable`/`widefold`/`triplefold` share the same image. Download/remove ONCE per OS version.
- **`ui layout` missing expected node**: `layout` only returns on-screen nodes. Use `devecocli ui dircfling <direction>` or `devecocli ui swipe <x1> <y1> <x2> <y2>` to scroll the target into view, then retry `ui layout`. Specify `--device <name|serial>` when multiple devices are connected.
