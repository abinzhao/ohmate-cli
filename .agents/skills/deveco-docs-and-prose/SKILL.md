---
name: deveco-docs-and-prose
description: Use when writing or reviewing deveco-cli documentation, comments, or diagnostics to align prose and command guides with current behavior and remove repetition and process narration.
---

# Writing DevEco CLI Documentation and Prose

Use this skill to verify prose accuracy, contract coverage, and where explanations belong. Check facts against current code, help output, and operations actually run, then use [deveco-check-changes](../deveco-check-changes/SKILL.md) to select validation. The root AGENTS.md owns development rules; the product [SKILL.md](../../../SKILL.md) and [README.md](../../../README.md) own usage guidance.

## Establish scope and preserve facts

Identify the task scope and affected entry points first. Treat generated catalogs, indexes, snapshots, and fixtures as derivatives: edit the owning source before regenerating them through the repository workflow. Documentation steps must not depend on nonexistent scripts or another local repository.

Before editing, identify every proposition in the passage. Preserve the actor, action, conditions, timing, modality such as must/may/never, exceptions, ownership, side effects, failure modes, and consequences. Remove repetition, adjectives, and process narration; shorten only when every fact remains clear. Each fact should have one owner, with necessary local contracts linking back to the source document where appropriate.

## Maintain contracts where they belong

- **Command guides:** when commands or arguments change, update both the product SKILL and README. Verify command names, defaults, mutual exclusions, failure conditions, file and device side effects, and platform capabilities. Distinguish Studio, CLT, and individual components.
- **JSDoc and internal comments:** public JSDoc documents caller-visible return distinctions, exceptions, mutations, ownership, timing, cancellation, and persistence. Module and internal comments explain responsibilities, races, resource ownership, security boundaries, and compatibility promises that code cannot express.
- **Test comments:** explain only non-obvious fixtures, platform accommodations, real entry paths, or reasons for indirect observations. Delete line-by-line restatements, test walkthroughs, review dialogue, temporary proposal numbers, and process history such as "later changed to."
- **READMEs and diagnostics:** READMEs describe configuration, semantics, failures, limitations, extension points, and real verification methods. Diagnostics identify the failing subject, violated rule, and correction. Visible CLI and MCP output is behavior; check stable fields, protocol frames, and error wording against the real entry points.

## Edit and validate

For each proposition identified before editing, decide whether to keep, add, trim, or restructure it; when the evidence needed to verify it is insufficient, defer the decision and record the validation gap. Do not set a shortening goal and manufacture edits to meet it. Verify command names, relative Markdown links, and agreement between code and documentation, then run `git diff --check`. Prose cleanup does not itself authorize product behavior changes.
