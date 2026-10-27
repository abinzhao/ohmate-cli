---
name: deveco-test-reliability
description: Use when writing or diagnosing deveco-cli tests involving subprocesses, locks, cancellation, MCP initialization, timing, or shared state to make concurrent execution and cleanup reliable.
---

# Writing Reliable DevEco CLI Tests

Use this skill for test isolation, synchronization, and cleanup decisions. Select commands through [deveco-check-changes](../deveco-check-changes/SKILL.md). Tests must remain repeatable under the actual runner, subprocess, and platform topology; passing alone on a quiet workstation is insufficient.

## Read the rules and model execution

Read the current Vitest configuration, relevant npm scripts, and CI workflows to determine whether test files, workers, independent check processes, and separate jobs can overlap. Process isolation does not isolate ports, fixed paths, shared databases, sockets, external services, or leftover child processes. For every resource, identify its owner, allocation mechanism, readiness signal, cleanup action, and signal that all test-owned processes and asynchronous tasks have stopped.

## Isolate resources

- Give each test a private temporary directory. Set subprocess cwd and required environment explicitly to avoid reading the user's real projects, credentials, or default data directory.
- Use `listen(0)` and read the system-assigned address. Give files, databases, sockets, and output paths unique names or use exclusive creation; never scan for availability and claim a resource later.
- Fake hdc, hvigor, ohpm, or MCP services should record argv, cwd, and environment, and provide ready/ack signals or controlled blocking. Wait for observable state before triggering cancellation, a restart, or a second request.
- Treat `process.env`, cwd, timers, locale, global mocks, registries, and fetch interception as shared mutable resources. Restore the original absent or present state, and use `try/finally` for cleanup around the smallest mutation scope.

## Synchronize, cancel, and clean up

- Use timeouts to bound failure waits, not to prove synchronization. Respect the owning test lane's timeout budget; the outer wait must exceed the timeout under test.
- Distinguish cancellation before startup, cancellation during execution, and normal nonzero exit. Lock tests should observe a later task actually acquiring the lock. When descendant processes are involved, verify that the process doing the work stops.
- After a timeout or failure, terminate test-owned processes and wait for processes, listeners, and asynchronous tasks to stop before deleting temporary directories. Calls to `kill()` or `release()` alone do not prove cleanup is complete.
- Control when initialization completes in MCP restart tests. Cover allowed and denied restarts and the arrival of stale asynchronous results. Check protocol output with real inputs and responses; ordinary logs must not mix with stdio protocol frames.

## Verify platforms and regressions

Windows and POSIX differ in environment-variable case sensitivity, file-handle release, signals, and permissions. Prefer observations that hold across platforms. When that is impossible, skip explicitly by platform and record the reason. For tests requiring Studio, CLT, or devices, list prerequisites and platforms separately; a pass on one machine does not establish cross-platform coverage.

Use the old faulty implementation or a targeted negative control to prove that the test catches the regression. Do not hide shared-resource conflicts by serializing everything, adding retries, or lengthening sleeps. Report the failing test, resource, synchronization point, platform, timeout, and cleanup outcome.
