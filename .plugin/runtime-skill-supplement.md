## {{hostName}} Plugin Runtime

Before the first CLI operation in a session, run `devecocli-runtime-check`. It reads package versions without executing or installing the CLI. An explicit `DEVECO_PLUGIN_RUNTIME_EXECUTABLE` takes priority and is used without a minimum-version check. Otherwise it checks {{hostBinDirs}} in order, then the global CLI on PATH, then a private Runtime in {{installRoot}}. Each must meet `minimumVersion`; missing host entries are skipped, and entries with old or unidentifiable versions appear in `skipped`. Host directories are lookup-only: do not install or upgrade a CLI there. Private installation and updates use {{installRoot}}, or the configured `DEVECO_PLUGIN_INSTALL_ROOT`. For all plugin tasks, use the returned absolute `launcher` path in place of `devecocli`, regardless of PATH order.

- If the global CLI is old or unidentifiable, first offer to upgrade it and refresh its global skill together. When the user agrees to a global CLI upgrade, verify the upgraded global entry meets the minimum, then use that global entry (not the plugin launcher) to run `init --skill --agent {{agentName}} --force`. Never copy the plugin skill over it. Recheck afterward and start a new host session to reload the skill. Project skills are not part of this update.
- If the user declines, preserve the global CLI and all skills. Use a suitable existing private Runtime, or inspect `devecocli-install --help` and install only the private CLI within the user's authorization. Use this installation path also when no CLI exists. Recheck and verify with the returned launcher and `--version`. Never run initialization, install/remove skills or delete skill files during private setup.

Installation requires Node.js >=22, npm and access to the npm registry. Report installation errors without repeatedly retrying or switching registries.

Run application commands from the user's HarmonyOS project directory. The plugin already provides this skill and does not scan standalone copies. The private Runtime rejects `init` (including `--mcp`) and `skills add/remove` for every skill and scope, even when its entry is explicitly selected. Standalone help forms and read-only skill commands remain available. Private setup must never modify skills or agent configuration.

For the plugin-managed Runtime, `devecocli update` is rejected; use `devecocli-install`, or `devecocli-install --version <version-or-tag>` for an explicitly requested version at or above the minimum. `update docs` and `update --help` remain available. Updating the plugin does not update an existing CLI; the next check selects again against the new minimum.

Use the non-interactive commands below when the task requires login or emulator agreement acceptance. Installation, login, and accepting agreements require the user's authorization for the corresponding action. If already authorized in the conversation, proceed without asking again; otherwise ask for the missing authorization.

- Login: run `devecocli auth login --no-prompt`. This skips the terminal Enter confirmation; the user still completes authentication in the browser. Non-TTY stdin also skips the Enter confirmation automatically.
- Emulator agreements: `devecocli emulator license view` displays the text without changes. Once agreement acceptance is authorized, run `devecocli emulator license accept` to accept all emulator agreements without terminal prompts, then resume the blocked operation after success. Do not use the interactive `devecocli emulator license` form in an Agent terminal or send an already-authorized CLI step back to the user.

Keep all Studio/CLT, device, authorization, and agreement checks enforced by DevEco CLI. This plugin does not register an MCP server.
