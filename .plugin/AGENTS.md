# Plugin Development Guide

## Code Structure

The plugin gives Agents a Skill and commands to find, install and run DevEco CLI. The CLI handles HarmonyOS tasks. Install the CLI, Studio and SDK separately. Plugin setup does not register MCP. Node.js >=22 is required; CLI installation also needs npm and access to its registry.

| File | Purpose |
| --- | --- |
| `platforms.json` | Agent host settings: names, manifests, CLI search and install paths |
| `README.md` | Plugin marketplace page template: features, usage and settings |
| `runtime-skill-supplement.md` | Plugin guidance added to the main SKILL.md |
| `bin/*` | Start Node and pass the `run/check/install` mode and command arguments |
| `runtime/main.ts` | Check Node, handle each mode, print check results and apply private CLI rules |
| `runtime/resolve.ts` | Find CLI entry files, read package versions and select the CLI |
| `runtime/install.ts` | Find npm, lock the install folder, verify the new CLI and make it current |
| `runtime/process.ts`, `runtime/types.ts` | Run and clean up child processes; define types for Runtime, processes and install dependencies |
| `scripts/platforms.mjs` | Check host settings, build output paths and replace template variables |
| `scripts/build.mjs` | Generate the Skill, bundle Runtime and create plugin folders, ZIP files and checksums |
| `scripts/validate.mjs` | Check folder and ZIP contents, metadata, templates and launchers |
| `scripts/smoke.mjs` | Install a real CLI from npm and check version and help output |
| `tests/plugin.test.ts` | Test host settings, build output, CLI selection, installation and processes |

## Shared Design

- Agent hosts share the same source files. Add each host as an entry in `platforms.json` and keep its settings there.
- Read the CLI package name, minimum version and default install version from `packages/cli/package.json`. Read the plugin version from the host manifest. After a plugin update, the next check uses the new requirements; installed CLIs stay unchanged.
- Keep shared command guidance in the root `SKILL.md`. The build preserves its metadata header, replaces variables in `runtime-skill-supplement.md` and inserts that text before the main body.
- `runtime.json` records the CLI package, minimum Node version and host Runtime settings. `provenance.json` records the source commit, working tree state, platform, versions and root Skill hash.
- Select the CLI in this order: `DEVECO_PLUGIN_RUNTIME_EXECUTABLE`, each `hostBinDirs` folder, PATH, then the private install. The explicit path must be absolute and valid. It skips the minimum version check; an invalid path causes an error.
- Search `runtime.hostBinDirs` in order, relative to the user's home folder. Skip missing entries, old versions and unknown versions, then continue to the next folder. The installer leaves these folders unchanged.
- Search absolute PATH folders in order and ignore the plugin's own launchers. Check the first CLI found; if its version fails, try the private install. All entries except the explicit path must meet the minimum version. Record old or unknown versions in `skipped`.
- Read versions from the npm package that owns each CLI entry. Runtime checks do not execute the CLI, install software or scan separate Skills. Checks and normal calls report an install hint when no suitable CLI exists.
- Before the first CLI task in a session, run `devecocli-runtime-check`. Use its absolute `launcher` path for later calls and the user's project folder as cwd for application commands.
- Install the private CLI under `runtime.installRoot`, relative to the user's home folder. `DEVECO_PLUGIN_INSTALL_ROOT` can set another absolute path. The install folder must be outside the plugin and current project. Keep the global npm prefix and PATH unchanged.
- Hold `install.lock` during installation and write to `installs/<UUID>/`. Check package identity, entry and minimum version, then run `--version`. After all checks pass, rename the new state file to `current.json`. On failure, remove the new install and keep the current one. Keep old install folders after success.
- Use the user's npm registry, proxy and script permission settings. Stop with an error if another install holds the lock. Remove a lock left by an interrupted install only after confirming that the recorded process has stopped.
- Private CLIs reject `init` (including `--mcp`), `skills add/remove` and `update` without a subcommand. Help requests, `skills list/find` and `update docs` are allowed. Update private installs through `devecocli-install`. Apply these rules even when the private entry was selected explicitly.
- After an approved global CLI upgrade, verify the global entry and use it to run `init --skill --agent <agentName> --force`. This refreshes the global Skill and keeps project Skills unchanged. Private setup leaves all Skills and Agent settings unchanged.
- Use existing approval for installation, login or agreement acceptance; ask only when approval for that action is missing. Use `auth login --no-prompt` for login. Display emulator agreements with `emulator license view`, then run `emulator license accept` after approval.
- Pass the caller's cwd, environment and stdio to the child, and return its exit code. Call `debugLog` before starting each external command. On the first interrupt, wait for the child to clean up; on the second, stop it immediately. Remove listeners when the process ends.

## Platform Details

### Agent Host: Qoder

- `platform` and `agentName`: `qoder`. Manifest: `.qoder-plugin/plugin.json`.
- CLI search order: `DEVECO_PLUGIN_RUNTIME_EXECUTABLE` → `~/.qoder/bin` → `~/.qoder-cn/bin` → `PATH` → `~/.local/share/qoder/deveco-cli`.
- Default install folder: `~/.local/share/qoder/deveco-cli`.

### Operating Systems

- Windows: search `devecocli.cmd`, then `devecocli.exe`. Read the JavaScript entry from standard npm `.cmd` files and run it with Node using an argument array. Custom batch files are unsupported. Console Ctrl+C reaches the child directly.
- Unix: search `devecocli`; accept executable files and Node scripts.

## Development and Checks

- Implement CLI features in `packages/cli/`. Keep plugin launchers, Runtime and extra Skill guidance in `.plugin/`. Edit source files and rebuild after template or host setting changes.
- Update plugin `README.md` and `runtime-skill-supplement.md` when commands, arguments or CLI selection rules change. For shared CLI command or argument changes, also update the root `SKILL.md` and `README.md`.
- Define template variables in `scripts/platforms.mjs` and reject unknown names. Keep LF line endings in `bin/*` and Unix execute permissions in ZIP entries.
- Give each test its own folder and set cwd and environment. Restore environment changes and wait for children to exit before deleting folders. Assert the selected CLI, `skipped`, arguments, exit codes and file state. Confirm that regression tests fail with the original bug.
- Plugin tests use their own `vitest.config.ts`; root `npm test` does not include them. Choose checks based on the changes, following [deveco-check-changes](../.agents/skills/deveco-check-changes/SKILL.md).

| Command | When to use |
| --- | --- |
| `npm run lint` | After plugin TypeScript / MJS changes |
| `npm run test:plugin` | Run plugin type checks and Vitest tests |
| `npm run build:plugin` | Build and check folders and ZIP files for all configured hosts |
| `npm run check:plugin` | Check existing build output |
| `npm run smoke:plugin` | After installer or release changes; test a real npm install with network access |
| `git diff --check` | Check whitespace; check document links separately |

## Release Files

Write build output to `dist/plugin/<platform>/`: the `deveco-cli/` folder, a ZIP named with the plugin version and its SHA-256 file. Bundle Runtime as `runtime/main.mjs` and write the manifest at `manifestPath`. Put plugin files directly at the ZIP root.

Build only the files listed in `scripts/validate.mjs`: the manifest, three pairs of `bin/*` launchers, Runtime, Skill, README, LICENSE, PRIVACY and two metadata files. Validation rejects extra files. Keep development docs, source and tests out of the release package.

The GitCode daily workflow runs plugin tests and builds before publishing the CLI, then checks a real install and uploads ZIP files. Verify client loading, real project tasks and marketplace publishing separately.
