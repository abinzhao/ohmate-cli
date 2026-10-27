---
name: deveco-code-review
description: Use when reviewing code changes or merge requests in deveco-cli to check CLI and MCP consumers, shared parsing, external process lifecycles, and regression evidence.
---

# Reviewing DevEco CLI Changes

Use this skill for the review workflow; the root AGENTS.md owns standing repository rules. Base findings on current code, tests, and commands actually run. An author's or agent's account is not evidence.

## Before reviewing

1. Confirm the base, target commit, and worktree state. Read the complete diff and enough surrounding context; recheck after a baseline change or retarget.
2. Read [deveco-check-changes](../deveco-check-changes/SKILL.md) and [deveco-find-simplifications](../deveco-find-simplifications/SKILL.md); apply the simplification audit to changed code and directly affected production callers, and report candidates outside the review scope separately. For asynchronous resources, also read [deveco-test-reliability](../deveco-test-reliability/SKILL.md); for documentation or visible text, read [deveco-docs-and-prose](../deveco-docs-and-prose/SKILL.md).
3. Identify concrete inputs, expected results, failure behavior, change scope, and real entry points. Record potential issues outside the scope separately rather than including them in the current fix.

## Required checks

- **Interfaces and behavior:** trace both sides of every changed interface and all production callers. Verify arguments, return values, defaults, errors, exit codes, stdout/stderr, and compatibility behavior.
- **Responsibilities and duplication:** check that each shared rule has one owner. ToolProvider owns toolchain paths; existing parsers own project JSON5. Keep commands focused on orchestration and rendering without duplicating installation layouts, configuration precedence, or business rules.
- **Lifecycle and concurrency:** for locks, cancellation, timeouts, watch, restarts, or subprocesses, trace signals through to the final process. Verify exit, lock release, listener removal, state after an old task completes, and independent error reporting.
- **Boundaries and security:** inspect parsing, paths, cwd, environment variables, argv, timeouts, and failure propagation at file, JSON5, network, external-command, and MCP protocol boundaries. Verify that neither a denial path nor an alternate caller can bypass the constraint.
- **Real entry points:** validate user-visible CLI changes through the built `dist/cli.js`. For MCP changes, exercise the real `serve mcp` entry point or an equivalent packaged protocol path. Handler unit tests alone do not prove that the shipped entry point works.
- **Regression evidence:** tests should observe external behavior such as package names, tool argv, file results, state transitions, or protocol responses, and fail for the original defect. Confirm that the current configuration discovers the tests. Use [deveco-check-changes](../deveco-check-changes/SKILL.md) to select the smallest relevant set of commands.
- **Test reliability:** for tests that own resources, run asynchronously, depend on platform behavior, or may run concurrently, check private temporary directories, real synchronization points, timeout budgets, global-state restoration, and cleanup that waits for all test-owned processes and asynchronous tasks to stop. Do not hide races with fixed sleeps.
- **Documentation:** changes to commands, flags, errors, shipped resources, or public behavior update `README.md`, `SKILL.md`, and any required JSDoc in the same diff.
- **Design quality:** new abstractions must have current production callers and reduce the rules that need to be kept in sync. Check for hardcoded mutable configuration, defaults without evidence, duplicated defensive logic, and extensions unrelated to the task.

## Report findings

State each defect's location, trigger, impact, and evidence. Prioritize incorrect behavior, data corruption, resource leaks, compatibility regressions, and ineffective quality checks. Separate suggestions from blockers. Mark unrun paths as validation gaps, and omit findings already covered by passing automated checks. A review task alone does not authorize code edits, publishing review comments, or merging requests.
