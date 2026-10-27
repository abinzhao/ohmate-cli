---
name: deveco-find-simplifications
description: Use when refactoring or auditing deveco-cli for simplifications to find duplicated business rules, abstractions without production consumers, and unnecessary defensive logic, and assess the maintenance and compatibility effects of removal.
---

# Finding DevEco CLI Simplifications

Use evidence to turn apparent complexity into reviewable simplification candidates. Prioritize real duplication, dead code, speculative interfaces, and hand-rolled infrastructure. Do not target a line count or a number of file splits. Start with the [domain module rules](../../../AGENTS.md#domain-module-rules), the [gradual migration policy](../../../AGENTS.md#how-to-migrate-existing-code-to-this-shape-gradual), and the affected modules' production entry points.

## Identify strong candidates

A strong candidate meets at least one of these conditions: a symbol, parameter, configuration option, event, cache, or test artifact has no production consumer; two implementations maintain the same business fact; an abstraction serves only tests or examples; an interface anticipates future generality without a product owner; or a maintained npm package or Node builtin can replace a hand-rolled implementation and its dedicated tests. Typos, isolated small cleanups, and claims that "the code is complex" are insufficient grounds for a proposal.

Use `rg` to search exact symbols, command names, configuration keys, method names, wire strings, and dynamic loading entry points. Read callers, public interfaces, tests, READMEs, scripts, and configuration. Classify consumers as production code, tests/documentation, or examples and scripts whose role is uncertain. External scripts may rely on CLI arguments, output, and file formats; zero references in this repository alone do not justify removal.

## Check ownership and boundaries

- Identify the rule's owner first. Prefer ToolProvider, Project parsers, and existing domain adapters. Do not force together flows that look similar but differ in semantics, failure behavior, or ownership.
- New options, Managers, caches, state booleans, or forwarding layers must have current production callers and reduce branches, rule owners, or test maintenance. Do not retain interfaces or empty files for imagined future extensions.
- Distinguish same-process values already guaranteed by TypeScript from JSON5, CLI, device output, file, network, and protocol inputs. Confirm real entry points and compatibility behavior before removing duplicate validation or fallbacks.
- For defensive copies, validation, callback capture, sentinels, and lifecycle state, identify the data source, next owner, and distinct protection each mechanism provides. When several mechanisms maintain the same fact, assess whether one lifecycle controller can own it.
- For dependency replacements, check maintenance status, engine compatibility, distribution size, semantics still left to implement, and net deletion. A wrapper that merely moves complexity does not count as a simplification.

## Prove, reject, and record candidates

For each candidate, state its location, real callers, duplicated rules it would remove, behavior retained or dropped, compatibility impact, and validation plan. Default to rejecting removal when production callers or documented defensive patterns exist, unless new evidence overturns the original rationale. Do not disguise a feature behavior change as cleanup.

Long-term proposals should state the problem, approach, tradeoffs, acceptance criteria, and risks. Use TODO/FIXME/XXX comments with stable tags for small local cleanups.

Validation should cover affected behavior, built entry points, test discovery config, and documentation links, while recording environmental gaps that still need verification. Put pure refactors in dedicated commits. For candidates outside the current task, report findings or record proposals without implementing them automatically.
