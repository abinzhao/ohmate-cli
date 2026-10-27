---
name: deveco-check-changes
description: Use before committing, pushing, or reporting validation results in deveco-cli to select checks for source, scripts, and built artifacts from the actual diff and identify coverage gaps.
---

# Checking DevEco CLI Changes

Use this skill to select the smallest credible set of checks for the actual change. The root AGENTS.md owns standing repository rules. Do not repeat passing checks merely because a commit or push follows, or use a full suite to avoid identifying what the diff affects.

## Establish the baseline

1. Confirm the repository root, current branch, worktree state, and user request. Record the actual comparison base and target commit.
2. Read [package.json](../../../package.json), the lint and Vitest configurations, and any affected check configuration. `npm run typecheck` checks CLI, docs-engine and docs-index-builder through their own tsconfigs; docs-zh and cli-wrapper have JavaScript entries. Determine which files these checks actually cover, and route each change by that coverage rather than by path. Update this skill when check entry points change.
3. Read the complete diff and enough surrounding context to assess affected source, tests, scripts, built artifacts, configuration, documentation, and untracked files. Recheck the diff after an amend, rebase, or baseline change.

## Select relevant evidence

Route each change by the coverage established in the baseline; a single change can require evidence from several rows.

| Change                                                                                                                 | Required evidence                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript implementation or types                                                                                     | Run every automated check that covers the changed files: `npm run typecheck`, `npm run lint` when the lint configuration includes them, and `npm test -- <relevant-test-paths>` when relevant tests exist.                                                              |
| TypeScript code outside automated coverage, or changes to CLI registration, output, entry points, or shipped resources | Run `npm run build`, then exercise the affected behavior through the real user entry points of the built artifacts. A successful build alone does not prove the user entry point works. Record any missing automated coverage as a validation gap. |
| Check scripts or test discovery config                                                                                 | Run the changed check and relevant tests. Every new rejection rule needs an invalid input that makes the check fail.                                                                                                                               |
| AGENTS.md or development skills                                                                                        | Run `git diff --check` and manually verify metadata and local references.                                                                                                                                                                          |
| CI, dependencies, or package scripts                                                                                   | Run `npm run lint`, `npm test`, or `npm run build` according to the affected scope. Verify whether the repository CI runs the affected entry point and how failures propagate.                                                                     |

Prose-only changes usually need only `git diff --check` and manual verification of metadata and local references. For a local behavior change, run the smallest test set that covers it. Packaging, types, source behavior, real toolchains, and mocked tests provide different evidence; fake hdc, hvigor, or ohpm tests do not establish compatibility with real Studio installations, CLT, or devices.

- Plugin code: run `npm run test:plugin` (TypeScript checks + Vitest) and `npm run build:plugin` (build + directory and ZIP validation). Use `npm run check:plugin` only to validate existing artifacts independently. Installer or release changes also require `npm run smoke:plugin`.

When the test discovery config changes, use a temporary failing case to prove that the runner executes it and reports failure, then remove the case. Regression tests should observe external results; a function call or success message alone does not establish the affected behavior.

## Handle failures and pushes

If a relevant check fails, stop and fix it or state the blocker. Timeouts, skipped checks, and unrun checks are not passes. For environment-specific failures, record the command, test, platform difference, and completed evidence that does not depend on that platform. Do not silently bypass required checks.

Before committing, run only the selected relevant checks and inspect whether hooks changed files. Pushing or rewriting history requires user authorization. Before a rewrite, record the observed remote branch commit and use lease protection; after pushing, compare the remote ref with local HEAD. Report only commands actually run and their results. Local passes do not establish that GitCode pipelines or branch protection have been verified.
