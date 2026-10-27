---
name: ohmate
description: Use ohmatecli for local HarmonyOS diagnosis, project inspection, persistent tasks and bundled DevEco commands. Consult the installed registry for actual capabilities, arguments, risks and schemas.
---

# OHMate CLI

Use the installed `ohmatecli` entry. In this source workspace, run
`node packages/cli-wrapper/cli.js` after `npm run build`.

The maintained user guide is `docs/usage.md`. `docs/commands.md` and
`docs/command-catalog.json` are generated from the built Runtime by
`npm run catalog`; `npm run check:catalog` detects drift. Registration alone is
not execution or platform acceptance evidence; verify target capability and
platform prerequisites from command help and actual receipts.

## Inspect before execution

```bash
ohmatecli doctor --format json
ohmatecli capabilities --format json
ohmatecli project inspect --project /absolute/project --format json
ohmatecli <command> --help
```

The registry is the source of executable capability contracts. Future commands in
the design document are not installed capabilities until registered.

## Command contracts

Bundled upstream command groups remain available:
`build`, `run`, `device`, `emulator`, `auth`, `skills`, `log`, `create`,
`init`, `serve`, `docs`, `ui`, `check`, `signature`, `verify`, `update`.
Arguments are enumerated in `capabilities` and the command's own help.

```bash
ohmatecli build --project /absolute/project --format json
ohmatecli ui layout --device <serial> --format json
ohmatecli execute deveco.ui.layout --input '{"argv":["--device","<serial>"]}' --format json
ohmatecli serve mcp
ohmatecli serve lsp --arkts --project-path /absolute/project
```

- `--project` selects the canonical working project; no global `chdir`.
- `--format json` returns one receipt; progress uses stderr.
- `--raw` forwards original tool output; protocol servers preserve their stream.
- `--lang zh-CN|en-US` selects locale.
- `--input-file <path>` reads the complete tool input from an explicitly chosen
  public JSON file (up to 1 MiB). It is mutually exclusive with `--input` and
  command-specific arguments; individual tools can have lower input limits.
  Secret material, linked files and private product state are refused.
- `--non-interactive` returns an approval plan immediately when needed.
- R2/R3 requests return 5 with exact input, project, risk and `planId`.
  Present that plan to the user. When explicitly authorized, repeat the same
  request with `--approve-plan <planId>`. Do not approve a changed target.
- Plans bind workspace contents, schema, input, target and product version;
  they expire after ten minutes and are consumed before one execution.
- `--force`, `-f` and `--uninstall` elevate operations to R3.
- SIGINT cancels and waits for subprocess cleanup. Cancellation is not rollback.
- A second SIGINT requests force cleanup while keeping the implementation alive
  long enough to persist its result.
- Never pass credentials through `--api-key`, persist them in tool input, or
  invent official docs, device observations or successful tool results.

`doctor` is read-only and requires no login, model, device or network lookup.
It reports missing optional components as warnings. Official docs archives are
not present in this snapshot; report that limitation if a docs command fails.
Upstream automatic updates, telemetry scheduling and global Skill migration
are disabled. Product-controlled updates are not yet implemented.

Exit codes: 0 passed, 1 findings, 2 arguments/project error, 3 degraded,
4 input validation failure, 5 blocked, 6 tool failure, 130 cancelled.
Use `OHMATE_DATA_DIR` for a private data root.

## Persistent tasks without Web or a model

```bash
ohmatecli task submit capabilities --wait --format json
ohmatecli task submit doctor --format json
ohmatecli task submit build.run --payload '{}' --project /absolute/project
ohmatecli task list --format json
ohmatecli task show <id> --format json
ohmatecli task events <id> --after 0 --format ndjson
ohmatecli task approve <id> <planId> --wait --format json
ohmatecli task cancel <id> --format json
ohmatecli task cancel <id> --force --format json
ohmatecli task resume <id> --wait --format json
```

Without `--wait`, a detached worker owns execution. Task records and ordered
events remain in the private data root after clients exit. `task show` returns
query success; inspect `data.state` and `data.receipt.exitCode` for task success.
`--payload` contains the submitted tool input; `--input` contains the complete
current command input. Do not mix `--input` with command-specific arguments.
Recursive task controls and protocol tools are refused by the task runner.
`agent.run` is the dedicated submit-capable Agent entry; model tools cannot
invoke task approval, submission, model configuration or protocol services.

Workspace writes are exclusive. Native device tools use an explicit target;
legacy device tools currently share a conservative fleet lock. Recovery verifies
recorded process identity before retrying an interrupted read. Do not replay
interrupted writes or treat cancellation as rollback. A worker crash can leave
a live file lock for up to fifteen seconds; report `RESOURCE_BUSY` and retry
recovery after it expires.

Approval fingerprints exclude credentials, dependency/build/artifact directories
and product data. Fingerprinting is bounded to 10000 entries, 8 MiB per file,
64 MiB in total; exceeding it blocks planning. Report this boundary instead of
claiming full coverage.

## Reviewed project creation and configuration

```bash
ohmatecli create --app-name DemoApp --api-level 22 --device-types phone tablet --format json
ohmatecli execute deveco.create --input '{"appName":"DemoApp","apiLevel":"22"}' --format json
ohmatecli config inspect --path AppScope/app.json5 --project /absolute/project --format json
ohmatecli config validate --path AppScope/app.json5 --project /absolute/project --format json
ohmatecli config edit --input-file ./config-request.json --project /absolute/project --format json
```

- `deveco.create` is now a native service backed by the bundled DevEco template
  generator. Structured input uses named fields, rather than `argv`.
- Creation previews actual template files in private product storage and binds
  generated hashes, target identity and observed SDK API to the R2 plan.
  The target must be absent or empty, below project/cwd, with existing real
  parents. Refuse incompatible API mappings and non-ASCII project names.
  A default API requires observed SDK metadata; explicit input is separately identified.
- The result contains generated AGENTS, project/doctor checks and a hashed
  manifest. Build/test/device are not run. Report fallback icons when present;
  do not present them as production artwork. External directory races require
  an isolated workspace for stronger exclusion.
- Configuration edit input is
  `{"path":"AppScope/app.json5","edits":[{"field":["app","versionCode"],"value":2}]}`.
  `operation` defaults to `replace` for existing leaf fields. Explicit `add`
  creates a missing object field or inserts before an original array index
  (the original length appends); `remove` deletes a field without a `value`.
  Parents must exist; all edits refer to the reviewed snapshot. Strings select
  keys and numbers select array indices. Unrelated comments, formatting and
  UTF-8 BOM are preserved. Adding/removing a container reviews that entire value.
- Refuse duplicate decoded keys, missing/overlapping fields, container replacement,
  linked files and secret configuration. Review field/file Diff before approval.
  Restore with the shared workspace recovery journal; never force over later edits.
- Config validation currently covers JSON5 syntax, top-level object shape and
  lossless edit support. `officialValidation:not-run` is not SDK semantic proof.
- Optional module `faultLog` entries additionally check declared API21/Stage,
  distinct valid extension names, non-exported source entries and a bounded
  local dependency closure with restricted SDK module/member checks.
  Definite errors exit 1; unknown dependencies or unverified host/system/build
  integration exit 3 with `valid:null`. No extension is explicit `not-configured`.
  Static success cannot certify host pre-registration or delayed system launch.
  The independent reference `examples/OHMateKitProducer/entry/src/main/ets/faultlogextension/`
  has inert `faultLogHost.configure(debug)` and explicit app-consented `confirm(true)`.
  Host normal A and empty B have different names; Extension reuses B.
  Detach/disconnect clear memory but preserve persisted filters; only explicit
  revoke deletes owned watchers, retaining failed cleanup. The nine-second
  uptime budget and 32 event-name summaries never read fault params or files.
  The reference page has no consent control and never opts in automatically.
  Device API/SysCap, thirty-minute delay, restart and ten-second exit are unverified.
- The independent reference `dfx/LeakWatcherHost.ets` requires explicit exclusive
  main-VM host integration and separate `review(mode)`, `confirm(revision, allowRawFiles)`,
  `start(revision)`. API26/Phone/debug/SysCap gate actual dispatch; objects stay on
  their original host thread with a fixed label. Manual check keeps only empty/
  nonempty return state, not raw object lists or a leak conclusion. CustomComponent
  monitoring uses an explicit 90-second interval and maxStoredHeapDumps 1; it
  requires raw-file consent and reports only bounded callback array shape.
  Review expires in thirty seconds; each run lasts at most ten minutes. Per host,
  cap reviews at 256, object attempts at 32 and checks at 3 including failures.
  Stop does not reset quotas or certify raw-file deletion. Failed disable retains
  ownership for explicit retry; wrong-thread cleanup cannot disable another VM.
  Clock invalidation is permanent. Ability exits stop monitoring; startup only
  configures, no Want/Bridge/Agent/ZIP opt-in. Phone detection, GC overhead,
  platform-file cleanup, UI confirmation and Release elimination remain unverified.
- The independent reference `dfx/RawHeapHost.ets` defaults closed and must run in
  an application-owned exclusive non-main Worker with explicit `RawHeapFiles`.
  Separate configure/review('process')/confirm/collect require raw-file consent
  and a Developer-options acknowledgment; neither queries nor enables that setting.
  API26/Phone/debug/SysCap gates the three-argument
  `dumpJsRawHeapData(false, false, true)` whole-process request. Two-argument
  capture addresses the calling VM only. Do not proxy it as main-VM capture.
  Do not request GC, change trimming or clear snapshot caches implicitly.
  Per Worker VM, cap reviews at 256 and acquisition attempts at one, including
  failures. The exclusive host declaration cannot discover other VM collectors.
  Prepare the exact file owner's partial/unreported-output responsibility before
  native dispatch. Adopt at most sixteen paths/16384 characters, never expose
  paths or raw bytes in status, frames, journals, receipts or ZIPs. Paths do not
  authenticate ownership. SDK output placement is not caller-selectable; the
  reference supplies no generic sandbox reader, deletion or enumeration.
  The explicit host processes locally with bounds and cleans immediately.
  Review and waiting each expire in thirty seconds; waiting includes cleanup.
  Cancellation/timeout/clock/source changes end waiting without preemption or
  releasing pending ownership. Late results go to the original cleanup owner only.
  Failed cleanup retries only through explicit retryCleanup with a bounded wait.
  Wrong-thread cleanup retains responsibility. Report literal host cleanup true
  only as host-reported-clean, never physical erasure or cache release.
  No startup Worker, page consent, default file host, Core/Bridge/Agent/export
  integration. Module debug sourceOption.workers explicitly compiles this source;
  release has no such declaration. Compilation does not start a Worker or prove
  Release artifact elimination. Native execution, VM coverage, Developer options, file handling,
  performance and Release elimination remain unverified.
- Declared module `obfuscation-rules.txt` and `consumer-rules.txt` use the same
  commands. Rule edit input is
  `{"path":"entry/obfuscation-rules.txt","edits":[{"operation":"add","option":"-keep-property-name","values":["jsonField"]}]}`.
  `add/remove` accepts the three name lists (global/property/file) and supported
  switches in the command Schema. Switches take no `values`. Exact names are
  inserted/removed while other tokens and comments stay unchanged.
- Consumer rules allow only global/property name lists; an existing unsafe
  switch can be removed to repair them. Unknown directives return exit 3 with
  `valid:null` and block editing. Orphan values, empty lists, unsupported filename
  paths, missing names, repeated edits and parameter injection are rejected.
  Parsing is bounded to 10000 tokens. Rule checks use an explicit supported
  subset: Release/API prerequisites and effective dependency-rule merging still
  require official validation; `effectiveMerge:not-run` cannot certify Release.

## Read-only dependencies and SBOM

`project inspect --project /absolute/project --format json` discovers evidenced
ArkTS, Cloud, Native or Mixed facets. ArkTS uses declared module paths, source
and SDK/Hvigor configuration. Cloud accepts `function-config.json` with an explicit
`file.method` handler (at most 64 characters), an optional functionType of 0/1,
and one nonempty same-directory `.ts/.js` entry. It also supports a package manifest
declaring `@hw-agconnect/cloud-server` and an existing `main` source. Exports and
runtime behavior remain unverified; cloud account configuration is not read. Native
requires literal CMake declarations and referenced source or an explicit
`IMPORTED_LOCATION` library. Unknown facets return 2; identified facets with
incomplete inputs return 3. Unsupported or ambiguous Cloud entries, conditional/dynamic CMake,
Cloud execution and ABI remain unverified. Inspection never grants strict
ArkTS build/config validation.

```bash
ohmatecli deps analyze --project /absolute/project --format json
ohmatecli deps why --name @example/library --project /absolute/project --format json
ohmatecli deps audit --project /absolute/project --format json
ohmatecli deps sbom --standard cyclonedx --project /absolute/project --format json
ohmatecli deps sbom --standard spdx --project /absolute/project --format json
```

- These tools share Runtime, Web and Agent semantics. No installation, registry
  requests, toolchain, model or device is required.
- OHPM uses the observed v3 specifier/package map. A root lock is shared only
  when it explicitly enables unified locking; otherwise module locks apply.
  npm supports v2/v3 package locators, workspace links and nested versions.
  A nested manifest absent from the ancestor lock is not a locked workspace.
- Preserve the locked version and report manifest drift separately. Missing
  locks, unknown formats, duplicate keys and unavailable evidence are incomplete.
  Do not infer a version when multiple locked candidates lack a mapping.
  Local modules/workspaces retain `declaredVersion` and `versionSource`; changed
  source metadata does not overwrite the locked version. Conflicting locks degrade.
- Literal imports and CMake targets/links are lightweight evidence. CMake
  variables/includes/configure-time discovery need official configuration.
  Dynamic/resource/build usage has not been excluded: unused is not evaluated.
- Referenced GNU/BSD regular archives retain ordered member byte ranges, raw
  SHA-256 and ELF declarations. Limits are 256 members, a 64 KiB GNU name table
  and 256 bytes per declared name. Symbol/name tables retain ranges and hashes
  only; their references are not validated. Duplicate names retain separate
  ranges without invented member dependencies or link-selection claims.
  Thin external members are not read. Malformed, unsupported, nonrelocatable
  or unknown-machine members and exceeded limits remain incomplete.
  Both SBOM formats retain this metadata; the library checksum hashes the whole
  archive. Member declarations never authenticate artifact ownership or ABI compatibility.
- Online vulnerabilities, actual LICENSE validation and Native ABI checks are
  not run. Metadata does not prove those checks passed.
- `data.document` contains CycloneDX 1.6 or SPDX 2.3; `data.relationships`
  retains the cross-ecosystem edges and their input evidence.
- Analysis ignores installed dependencies, build artifacts, hidden directories
  and product state. Limits: 10000 directory entries, 2000 files, 8 MiB per file,
  32 MiB raw bytes total. Unsafe, private, sensitive, linked and oversized inputs
  produce explicit gaps; never read credentials to complete the inventory.
- Exit 3 means incomplete evidence; 1 means known findings; 0 means no finding
  within the supported evidence scope. None proves Release purity.

## Offline heap snapshot subset

```bash
ohmatecli analyze jsleak --snapshots /absolute/before.heapsnapshot --format json
ohmatecli analyze jsleak --snapshots /absolute/before.heapsnapshot /absolute/after.heapsnapshot --format json
```

- Explicit read-only inputs; no device, toolchain, model or converter invocation.
  Only the seven-field V8 JSON layout tested with private Node 22 snapshots is
  supported. Unknown layouts/versions, malformed counts/types/indices, invalid
  UTF-8, secret-named/linked files and exceeded limits return 4 without a partial report.
- Limits per snapshot: 32 MiB, 250000 nodes, 1000000 edges, 250000 strings,
  16 MiB string bytes and 50000 groups. At most two snapshots/64 MiB total;
  the private JSON report is bounded to 64 MiB.
- Retain raw input SHA-256, declared strong reachability, type/name-hash
  aggregates with counts and self bytes, and one shortest strong path per
  group representative. Paths keep at most 16 nodes with explicit truncation.
  Exclude weak and shortcut edges; never copy heap strings or edge names.
- Above 1 MiB, the receipt projects numeric summaries/group counts and a
  hashed report reference with `groupsLocation:report-artifact`. The file keeps
  every group and delta; the task receipt does not silently truncate a ranking.
- Two inputs compare aggregate counts/self bytes in the explicit input order,
  retaining positive, negative and zero deltas. Local object IDs do not establish
  cross-snapshot identity. Capture time, device/build and actual Ark capture
  remain unverified. Retained size is not computed; leaks are not established.
  Rawheap conversion, Native association and other snapshot sections remain
  unavailable/unexamined. Results always return incomplete/exit 3.
  Registration never certifies all formats or the nine-analyzer M4 contract.

## Offline GC summary subset

```bash
ohmatecli analyze gc --log /absolute/capture.log --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`; no device or producer execution.
  Support only the ArkCompiler `[gc]` summary shape declared by OpenHarmony
  5.0.3 sources and its documented example, without authenticating runtime version.
  Preserve exact GC type, local/shared heap, printed before/after used/committed
  MiB, total GC duration, separate concurrent mark duration and known reason.
  SharedGC leaves absent concurrent duration null; rounded values are not exact bytes.
- Bind raw file SHA-256 and each event's raw line offset/length/hash. Reject
  unknown summary/type/reason, invalid or underflowing numbers, inconsistent fields,
  truncated summary, BOM, invalid UTF-8, secret names, links or exceeded limits;
  return 4 with no partial analysis artifact.
- Limits: 16 MiB input, 100000 lines/16 KiB each, 10000 events and 16 MiB report.
  Above 1 MiB, receipts retain numeric summaries and a hash reference with
  `eventsLocation:report-artifact`; the file retains every event and duplicate.
- Raw log text and arbitrary prefixes/details are not copied. Other lines are
  counted but not associated with events. File order does not establish capture
  time, process/thread/VM identity or allocation/frequency trends.
  Allocation threshold/failure reasons give only single-feature candidates.
  OOM, leaks and root cause are not established; verbose association, frequency,
  allocation rate, runtime version and device/build remain unverified.
  Results stay incomplete/exit 3; documented examples are not live device captures.

## Offline FD snapshot and allocation subset

```bash
ohmatecli analyze fdleak --log /absolute/capture.log --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`. Support the Huawei Reliability
  Technology Lab FDLeak Skill 1.4 specification's stock count, FD/directory Top
  10 and FdTrack allocation stacks. Missing stock count, malformed integers or
  frames, duplicate fields/top names, inconsistent counts, empty declared Top/
  stack sections, UTF-8/BOM, secret names, links and excess budgets return 4
  without a partial report. RESOURCE_OVERLIMIT event JSON is outside this subset.
- Preserve raw input/field/line byte ranges and SHA-256; hash process, time,
  path and module names. Keep raw offsets and original frame order, with
  right-to-left call direction. Ten-minute allocation counts include subsequently
  closed descriptors and are separate from stock. Same PID is only a declared
  match. Whole-system detail sections are presence-only and unassociated.
- Limits: 16 MiB input/report, 100000 lines/16 KiB each, 10 entries per Top,
  10000 stacks/32 frames each and 1024-byte names. Reports over 1 MiB retain all
  stacks in the private artifact; receipts use `stacksLocation:report-artifact`.
- Candidates are single-feature only. Runtime format version, actual producer/
  capture, symbols, detail association, leak/root cause and device/build identity
  remain unverified. Results stay incomplete/exit 3; documented Skill examples
  and synthetic budget fixtures are not device evidence.

## Offline JS Crash primary JS stack subset

```bash
ohmatecli analyze jscrash --log /absolute/capture.log --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`. Require a known `Reason` or
  `Error name`, a single-line `Error message` and primary JS `Stacktrace` frames.
  Both declared error types must agree. Missing/unknown types, multiline messages
  or source excerpts, Native primary stacks, truncated/malformed frames, duplicate/
  concatenated logs, mixed/noncontiguous frame indices, invalid integers, BOM,
  invalid UTF-8, secret names, links and excess budgets return 4 without a report.
- Limits: 16 MiB input, 100000 lines/16 KiB each, 256 primary frames, 1024-byte
  function/location names, 4096-byte fields and 1 MiB report. Keep all primary
  frames and duplicate locations in file order. Bind raw file/field/line ranges
  and SHA-256; field values are line-trimmed, and raw line hashes remain exact.
  Message/function/location/metadata values are hash/byte-count only. Preserve
  raw line/column declarations and path or four-part module/dependency/version/
  path forms, without reading source. Missing metadata remains explicit.
- HybridStack, SubmitterStacktrace, AsyncStack, ModuleImportStack and HiLog are
  presence-only with source-line evidence; their contents are not parsed, copied
  or attributed. Native Stacktrace and source excerpts are outside this subset.
- Official `Fingerprint` denotes fault clustering, never buildId or SourceMap
  identity. Raw coordinates, debug-shaped frames and reported mapping markers
  do not prove symbolication. Numeric error codes are not Kit-mapped; SourceMap,
  runtime, ownership/root cause, snapshot association and device/build remain
  unverified. Single-feature candidates retain multiple boundary hypotheses.
  Results stay incomplete/exit 3. Specification examples and budget fixtures
  are not capture evidence; older public samples without a type declaration
  are refused rather than classified from arbitrary error-message keywords.

## Offline Native Crash fault-thread subset

```bash
ohmatecli analyze cppcrash --log /absolute/capture.log --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`. Require `Reason:Signal:`, a known
  crash signal/code, `Fault thread info`, a declared thread and contiguous
  `#NN pc` Native frames. Unsupported signals/codes, missing sections/threads/frames,
  primary JS frames, GWP-ASan, truncation, duplicates/concatenated events,
  malformed numbers/addresses/frame suffixes, multiline Fatal messages, BOM,
  invalid UTF-8, secret names, links and excess budgets return 4 without a report.
  Legacy bare signal reasons and missing fault-thread envelopes are refused.
  The official `UNKNOWN` code remains an uninterpreted declaration.
- Keep raw file/field/section/thread/frame byte ranges and SHA-256. Hash
  location/function/thread/Fatal/metadata values; preserve raw pc, address,
  BuildID and signed function-offset strings without Number precision loss.
  The official emitter can print relative or absolute pc; this is not verified
  relative-offset evidence. Functions/BuildIDs remain declarations, not matching
  symbols or artifact identity. `[Unknown]` remains unknown.
- Registers, SubmitterStacktrace, Other thread info, Memory near registers,
  FaultStack, Maps, OpenFiles and HiLog are presence-only; do not analyze,
  associate or copy their content. Limits: 16 MiB input, 100000 lines/16 KiB each,
  256 frames, 1024-byte names, 4096-byte fields, 64-byte BuildID and 1 MiB report.
- Fingerprint denotes fault clustering. Printed NULL/stack-overflow heuristics
  are hash-only and cannot establish root cause. Signal/path evidence gives
  multiple boundary hypotheses only. Symbols/compressed DWARF, registers,
  detectors, BuildID association, ownership/root cause, runtime/capture and
  device/build remain unverified. Results stay incomplete/exit 3. Public format
  examples and repeated-frame budget fixtures are not device capture evidence.

## Offline AppFreeze event and thread-stack subset

```bash
ohmatecli analyze freeze --log /absolute/capture.log --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`. Require known Reason, star-separated
  event parts, start time, EVENTNAME, TIMESTAMP, PID, UID, MSG and contiguous
  thread frames. Support THREAD_BLOCK_6S, APP_INPUT_BLOCK and the historical
  BUSSINESS_THREAD_BLOCK_6S / BUSINESS_THREAD_BLOCK_6S spellings.
  Main-thread logs support one 3s/6s part or 3s then 6s/input timeout.
  Business events support one part and use only its declared TID; missing TID
  or target stack remains unknown rather than falling back to the PID.
- Main TID/PID contradictions, conflicting process declarations, unknown/legacy
  event formats, missing required fields, malformed/duplicate/truncated stacks,
  unsafe numbers, BOM/invalid UTF-8, secret names, links and excess budgets
  return 4 without a partial report. Old UI_BLOCK_6S logs remain unsupported.
- Retain original file/field/section/thread/frame byte ranges and SHA-256.
  Hash names, messages, times, functions and paths. Preserve mixed Native/JS
  frame order, raw pc/BuildID/signed offsets and declared JS coordinates.
  Thread state remains a hashed declaration, not scheduling evidence.
  Queues, Binder, CPU, memory, thermal, FFRT, embedded sampling/submitter stacks
  and HiLog are presence-only. Never attribute peer or sampled frames to the
  event thread. Do not discover attachment, project or symbol files implicitly.
- Limits: 16 MiB input, 100000 lines/16 KiB each, two event parts,
  64 threads/128 section markers per part, 256 frames per thread/512 total,
  1024-byte names, 4096-byte fields, 64-byte BuildIDs and 1 MiB report.
  A known resource NOTE gives only a candidate. One or two identical stacks,
  state and Fingerprint cannot establish a unique cause. System assessment,
  sample/symbol association, blocked/busy state, responsibility, runtime/capture
  and device/build remain unverified. Results are incomplete/exit 3;
  persisted tasks retain failed/degraded state.

## Offline API error-code and SDK declaration subset

```bash
ohmatecli analyze api --log /absolute/capture.log --format json
ohmatecli analyze api --log /absolute/capture.log --sdk-module @ohos.multimedia.media --format json
```

- Read one explicit public UTF-8 `.log`/`.txt`. Admit only E/F HiLog envelopes
  with `MM-DD HH:mm:ss.SSS PID TID E|F Cxxxxx/tag: message` and one positive
  integer `error code:`, `code:` or `code=` field. Ordinary numbers, HTTP status
  and lower-level lines count as context. Do not infer APIs from tags, domains
  or code prefixes. Ambiguous/malformed fields, invalid envelopes/time, mixed
  faultlogs, truncation, invalid UTF-8/BOM, secret names, links and excess budgets
  return 4 without a partial report.
- Retain raw file/event byte ranges and SHA-256, numeric code/PID/TID and domain
  declarations. Time/tag/message are hash-only. Context is line-count-only.
- Optional `--sdk-module` selects an exact @ohos declaration through ToolProvider.
  Require SDK/ETS API, platform and package versions to agree, then hash both
  metadata files and raw declaration bytes. Matching BusinessError JSDoc lines
  retain ranges/hashes and fixed categories, with unknown descriptions unclassified.
  Module-level declarations do not bind a callable or authenticate the failing
  device SDK/runtime. Missing codes stay unknown; unavailable/conflicting/bounded
  SDK input returns 4 without a fallback. Without the option no SDK lookup runs.
- Limits: 16 MiB input, 100000 lines/16 KiB each, 1024 events/1024-byte tags,
  4 MiB declaration, 16 KiB per metadata file, 512 matches and 1 MiB report.
  No automatic device, project, attachment, source or knowledge lookup.
  Error codes give multiple boundary hypotheses only. API/state association,
  root cause, responsibility, runtime/capture/device/build remain unverified.
  Results remain incomplete/exit 3; persisted tasks retain failed/degraded state.

## Offline Native memory sample and smaps subset

```bash
ohmatecli analyze nativeleak --sample /absolute/sample.txt --format json
ohmatecli analyze nativeleak --sample /absolute/sample.txt --smaps /absolute/smaps.txt --format json
```

- Read explicit public UTF-8 `.log`/`.txt` inputs. The OpenHarmony 5.0.3 sample
  subset requires pid/processName/threshold/actualRss/TopPssMemory and the
  `time(s) PssMemory(KB) realtime` table. That producer appends both RSS and
  PSS+SwapPss to one vector and trims history without per-row metric labels.
  Keep all rows as unidentified mixed metrics; never assign RSS/PSS by position.
  Require at least three rows and nondecreasing declared monotonic seconds;
  same-second rows are permitted. Start/end/peak/delta/percent/direction describe
  the mixed series, not pure PSS growth. Percentage is unknown for a zero start;
  do not infer rates or linear growth.
- Optional smaps accepts only the matching hidumper two-line header, ten numeric
  columns, names and Summary table. Keep row PSS and SwapPss separate. The
  Summary Pss already includes SwapPss; validate all sums without adding it again.
  Use the smaps total as its share denominator, never a sample value. No process,
  time, address or build association is established between inputs.
- Keep raw file/field/row ranges and hashes, declared numeric values and exact-tag
  classification candidates. Names and realtime remain hash-only; other names
  stay unclassified. Reject unknown/malformed/duplicate/truncated layouts, missing
  required fields/summary, unsafe integers/overflow, reversed time, invalid UTF-8/
  BOM, links, secret paths and exceeded limits with exit 4 and no partial report.
- Limits: 16 MiB per input/32 MiB total, 100000 lines/16 KiB each, 1024 sample
  rows and 1024 smaps rows, 1024-byte names and 1 MiB report. No directory or
  filename-based companion discovery, pickle input or collection scripts.
  DMA/GPU are not captured. htrace/NMD/native hook, allocation lifetime, symbols,
  cross-input association and root cause remain unverified. Memory growth alone
  does not establish a leak. Results remain incomplete/exit 3; persisted tasks
  retain failed/degraded state and responsibility remains undetermined.

## Offline UI events and automatic log triage

```bash
ohmatecli analyze ui --log /absolute/events.txt --format json
ohmatecli analyze auto --log /absolute/events.txt --format json
```

- UI accepts only the OpenHarmony 5.0.3 Ace window focus/unfocus/foreground/
  background/destroy notifications and currentId/trackedId/reason/instanceId.
  Release and ui_content_impl.cpp debug prefixes are supported; source coordinates
  are declarations, names/time are hashes. Use the six producer reasons:
  scope/active/default/singleton/foreground/undefined. The documented example
  spelling scoped is unsupported because the emitter prints scope.
- currentId in [100000,1000000) gives one-feature candidates with alternatives.
  Never infer disposal, lifecycle state, causal association, layout or rendering
  from a notice, matching ID or file order. Limits: 16 MiB input, 100000 lines/
  16 KiB each, 1024 events, 1024-byte names and 1 MiB report. Reject unknown,
  malformed, truncated, unsafe numeric, invalid UTF-8/BOM, linked, secret-named or
  excessive input with exit 4 and no partial publication.
- auto classifies one explicit public UTF-8 .log/.txt by raw markers for UI, GC,
  API, JS/Cpp Crash, Freeze, FD and Native sample. A sole candidate runs its
  existing parser; rejection returns 4 without fallback. Multiple candidates
  keep selection=null and require explicit manual domain selection. Markers
  are not format validation, capture authentication or cross-domain evidence.
- Bind classification and selected report to the same raw hash. Derived files
  remain in an owned private temporary directory and are cleaned before the
  one final auto report is published. Bound input to 16 MiB/100000 lines/16 KiB
  each, references to 32 per family while preserving marker totals, the selected
  report to 16 MiB and final report to 17 MiB. Above 768 KiB return a summary and
  artifact hash reference; preserve full analysis only in the final report.
- No snapshot, SDK, attachment, device or project discovery or capture execution.
  Both entries remain incomplete/exit 3 with failed/degraded persisted tasks.
  Runtime/capture/device/build, root cause and responsibility remain unverified.
  An ambiguous list is triage, not a joint fault diagnosis.

## Reviewed build and test orchestration

```bash
ohmatecli build plan --modules entry@default --project /absolute/project --format json
ohmatecli build --modules entry@default --project /absolute/project --format json
ohmatecli build run --modules entry@default --project /absolute/project --format json
ohmatecli test plan --kind local --files entry/src/test/Acceptance.test.ets --project /absolute/project --format json
ohmatecli test local --files entry/src/test/Acceptance.test.ets --no-coverage --project /absolute/project --format json
ohmatecli test local --modules entry --build-only --no-coverage --project /absolute/project --format json
ohmatecli test instrument --modules entry --project /absolute/project --format json
```

- Plans are read-only. Unsigned builds require exact R2 approval. Plain `build`
  and `build run` use the same native Runtime, tasks and artifact provenance.
  Plain `build` retains upstream flags and `{argv:[...]}` inputs, installs OHPM
  dependencies when sync is required, and forwards explicit assemble overrides
  to the official tool with a compatibility warning.
- Explicit `--signing-config` (including `--signing-config=value`) and an implicit
  product reference resolving to a declared config require R3. Undeclared template
  references are marked unresolved. Temporary changes only replace the
  product's config reference. Review and recovery records contain names, offsets
  and hashes, never signing material. Restore original bytes after success,
  failure or cancellation; preserve subsequent edits and unsafe paths.
- Reviewed quickfix compiler-cache removal includes its exact Diff and hashes.
  Immutable original bytes and a scoped journal support explicit restoration.
  Interrupted cleanup retains recovery evidence.
- File transactions displace and hash-check current bytes, then publish without
  overwriting concurrently created files. Keep both current and held originals
  on conflict; remove held files only after verified restoration. Held paths and
  permissions are recovery metadata, and cache permissions are restored explicitly.
- Validate product/module/target/buildMode before invoking the bundled Hvigor
  adapters. HAP, HAR and HSP task scopes are separate. `--install` explicitly
  requests OHPM installation for `build run`. Hvigor bootstrap and project scripts may download;
  a private HOME does not establish an offline build.
- Record the actual official task list and hashed installed lazy task declarations,
  tools, argv/cwd, raw output, exit status, input and output hashes. Do not call
  Commander actions from a service. Execution uses a private tool HOME and the
  observed no-daemon option; cancellation awaits child termination.
- Provenance is incomplete until compiler closure, ArkGuard/Native versions and
  cache validity are established. `buildId:null` prohibits claiming a complete
  symbolization or replay identity. Output UTF-8 hashes preserve captured text.
  Blocking/truncated output, explicit warnings and notes are P0/P1/P2. Lock/input
  evidence is refreshed after installation/sync. Unchanged outputs remain
  reused-unverified until cache identity can be proved; unrelated module outputs
  cannot satisfy the requested build.
- Infer literal suites/methods in selected files or modules. Local layouts include
  `test/` and the installed producer's `src/test/`. Dynamic names, duplicate suite
  identities, missing methods/modules and unknown scopes are refused. Each module
  receives its own scope and must report every selected method.
- Distinguish `executed`, `build-only`, `not-run`, `failed`, `cancelled`. Require
  fresh recognized results, matching cases, unchanged source and consistent totals.
  The verified DevEco 26 format is `class/test/result` with summary counts; explicit
  `[pass] Suite#method` and `[fail] Suite#method` are also accepted. Preserve raw
  reports as immutable evidence. Local `--build-only` uses `UnitTestBuild`, never
  an ohosTest target, and returns 3 rather than asserting a test pass.
- Without a verified official device selector, Instrument Test remains not-run.
  Do not choose a connected device automatically. Coverage/ASan collection, cloud
  tests and Native ABI validation are incomplete.

```bash
ohmatecli build signing inspect --journal-id <id> --project /absolute/project --format json
ohmatecli build signing restore --journal-id <id> --project /absolute/project --format json
ohmatecli build cache inspect --journal-id <id> --project /absolute/project --format json
ohmatecli build cache restore --journal-id <id> --project /absolute/project --format json
```

Restoration requires a separate approval: R3 for signing references, R2 for cache
files. Reject changed profiles, recreated conflicting caches and altered backups.
Cache bytes and permissions are staged before exclusive publication. Interrupted
permissions or retained originals can be reviewed again; every displaced path
stays journaled until verification and cleanup succeed.

Build provenance hashes the installed SDK frontend, ArkGuard package, loader
bridge scripts and default es2abc candidate. Its release version remains unknown;
the candidate is not proof of actual execution. Byte drift invalidates approval;
added/changed components during a build appear in `compilerDrift`. Observed loaders
in the default layout retain hashes, freshness and explicit worker/bytecode
HAR/SourceMap input identities. These are post-build declarations, not a verified
final configuration or transitive read closure. Unreadable/sensitive inputs degrade
the result while retaining official invocations. Keep `completeness: incomplete`
and `buildId: null`; do not use this provenance for automatic replay/symbolication.
Declaration counts and bytes accumulate across all loaders in one collection
(4096/64 MiB). File type and remaining bytes are checked before reading;
nonblocking open prevents a swapped FIFO from stalling collection.
Root and declared module `oh_modules` stores have a separate precompile inventory,
including hidden stores and in-scope OHPM alias target hashes. Approval binds this
inventory; additions, removals and changes during compilation appear in
`installedInputDrift`. Unreadable, sensitive, out-of-scope links and over-budget
inputs degrade the result while preserving official exits and artifacts.
The inventory has 10000-entry, 8 MiB/file and 64 MiB total limits. Its
`binding:inventory-only` is not an actual compiler read closure, final config or
cache certification.
Private Hvigor build processes and workers also retain `compilerObservation`:
allowlisted actual `job.run` configuration fields, SDK Host calls, module
resolutions and synchronous/asynchronous read hashes. The observed loader path covers custom
directories with `binding:observed-partial`; full configuration remains missing.
`configurationStages` keeps merged SDK input, SDK output, actual Rollup input and
Ark-derived returns separate; `configurationIndex` binds each to its job configuration.
Only allowlisted scalar data properties are retained; getters and nested objects
are not evaluated. Original failures do not create output stages. Each invocation
allows at most 64 stages/256 KiB within the shared budget. These stages do not
certify complete configuration, Watch, cache reuse or the product `buildId`.
`textReads` separately records UTF-8 hashes of returned Host text and
ScriptSnapshots, preserving raw file hashes across BOM decoding and preprocessing.
Watch Hosts are wrapped again before use to observe SDK method replacements.
Cached returns and decoded filesystem text without observed raw bytes remain
coverage gaps; no replacement file read is used to manufacture actual inputs.
`fs.readFile` and `fs.promises.readFile` retain the initiating build invocation.
Hash returned Buffers before passing them to callers; `readMethods` names the
observed filesystem entry. Encoded returns remain decoded text. Resolve relative
paths and file URLs at initiation. Pending reads at close are coverage gaps;
late results never become inputs of the next invocation.
Observed `fs.promises.open` handles support `FileHandle.readFile` and
`fs.promises.readFile(handle)`. Resolve the path at open initiation and compare
descriptor/path device, inode, size, mtime and ctime before and after reading.
Only complete Buffer returns qualify as whole-file hashes; partial returns,
encoded text, replaced paths, unknown Promise handle origins and original failures
retain their separate evidence or gaps. Do not perform substitute reads.
Direct methods on handles created before observation, unwrappable methods and
other descriptor operations remain uncovered. Close never restores late attribution.
`fs.createReadStream` and observed `FileHandle.createReadStream` can retain complete
raw byte hashes. Observe the existing queue and dispatch without attaching a
data/readable consumer; hash chunks before decoding or caller mutation, then admit
only a completed read/end with matching descriptor/path identity and whole-file size.
Reject pre-read injected EOF/chunks, partial ranges/current-position returns,
cancelled, oversized, replaced or changed inputs. An observed FileHandle fd binds
its open origin, ignoring the supplied path. Numeric fd, custom/accessor I/O,
unwrappable streams and late consumption remain gaps. Preserve original backpressure,
errors, autoClose and emitClose; this does not certify the full filesystem closure.
`nativeCalls` observes only the SDK ModuleMode es2abc shell-call boundary:
allowlisted pre-dispatch configuration, command hash/byte/count metadata,
declared file/cache/context/output paths, and matching exec return/PID/close.
Limit each invocation to 64 calls/256 KiB, with 256 arguments/64 KiB per command,
within the shared quota. Do not retain command text, arbitrary argv or native output.
Preserve SDK/ChildProcess returns, errors and event dispatch. Command mismatch,
multiple dispatch, accessors, unsafe paths, unwrappable hooks and pending calls
remain gaps. Close seals records; late events cannot repair or reattribute them.
`sdk-call-reference-only` does not attest the shell executable, native input bytes,
cache origins, final configuration or buildId. Post-build descriptor hashes only
describe post-build bytes.
`nativeDescriptions` observes synchronous writes inside four SDK generation methods:
pre-write UTF-8/Buffer size/hash, write/method outcomes, owner identity and order.
`nativeCalls.descriptionSequences` links only the latest single successful generation
for the same job, receiver and declared path. Duplicate writes, failures, unknown
encodings, accessors, locked hooks and cross-job receivers remain gaps; close cuts off
late generation. Per job, allow 64 records/256 KiB metadata and 8 MiB per input/
16 MiB total fingerprint bytes within the shared quota. Do not copy bodies or read
files to substitute evidence. `sdk-write-call-only` does not attest durable writes,
dispatch-time disk bytes or actual native reads.
`nativeInputWrites` observes the two SDK source generation exports: permitted source
argument (or own AST fileName), destination, pre-write UTF-8/Buffer hash/size,
generation identity, outcomes and shared observation/settlement order. Preserve
original Promise identity, returns and errors. Allow 512 attempts/writes and
512 KiB metadata per job, 8 MiB per input/16 MiB total within the shared quota.
Description `inputReferences` retains module/bytecode/cache-pair path declarations
and hashes other fields; allow 512 rows per description/256 KiB total metadata.
Link only the latest single successful same-job destination write completed before
the description. Duplicate/failed/no-write retries, old Promise settlement,
unsafe paths and unknown representations cannot revive earlier bindings; close
seals pending generation. Bytecode rows and cache outputs remain declarations.
`sdk-source-write-call-only` does not attest durable disk bytes, subsequent contents,
cache reads/writes or actual native reads. No bodies or substitute filesystem reads.
Cache-pair `sourceDescriptionSequence` links only the latest completed single
successful npm-entries description for the same job, receiver and input path;
it is mutually exclusive with `sourceWriteSequence`. Duplicate, failed, no-write
retries, nested late completion and later destination replacement cannot restore
old origins. Unknown encodings and over-budget writes invalidate the destination
too; unobservable source arguments or destination properties revoke prior
description destination bindings. The origin remains `sdk-write-call-only`; proto outputs are declarations,
without cache-hit or native-read certification.
SDK Watch setup and each Rollup-lite Task `run`/`hotCompile`/`close` have separate
observations. `watchRounds` binds session/round and the original configuration index,
retaining actual events, changed paths and `rollup-reported` reuse lists. Close cuts
off pending round reads immediately. Reject duplicate/missing rounds, rounds after
close and sensitive paths; journal creation stops at 64 files. Preserve original
Promises, returns, errors and event dispatch; unwrappable exports retain execution
and a coverage gap. Task.close return and outer process closure are separate evidence.
Reported reuse remains `watch-cache-reuse-unverified`; it does not certify complete
ArkTS Watch or the memory/filesystem cache closure.
Absent Host probes are rechecked for additions. Changed/unreadable inputs or an
unclosed observation degrade the result. Generated cache/output reads remain
separate; `.tsbuildinfo` and `.tsbuildinfo.linter` retain read/after hashes as
`cache-unverified`, without source-drift or cache-certification claims.
All observations share 10000 entries, 64 MiB input and 16 MiB record budgets,
with at most 64 files. Other FileHandle/stream reads, native resolution, internal closure calls and
unobserved Hosts remain outside this partial evidence.

`outputLayout` retains module-target and product output directories actually
returned by Hvigor. Snapshot their artifacts after task discovery and before
compilation, then recheck hashes after execution. Persist each synchronous method
return immediately; no worker exit callback is required, and method completion
does not prove process exit. Collect direct artifacts in custom output
directories; do not traverse product symbol subtrees or attribute a child
directory APP to its parent output root. Artifact/output-path links and
hardlinked artifact files remain rejected;
an output without a directory baseline is `baseline-unavailable`, and unchanged
files stay `reused-unverified`. Other targets, ambiguous directories, escaped or
sensitive paths, symlinks and unclosed observations cannot satisfy the selected
facet. Bound observation to 64 files, 128 paths and 4 MiB, and directory scanning
to 10000 entries. `observed-partial` records paths only; full output layout,
cache identity and product buildId remain unverified.

Normal `run` queries official `tasks` in a private home with no daemon before
installation, including with `--skip-build`; this query loads project build
scripts but does not assemble packages. Match independently observed HAP/HSP
metadata files and output directories by module, target and product. Missing,
ambiguous or unsafe paths block installation without falling back to stale
default output. The existing `run` approval applies. Preserve original tool
exits, observed paths and artifact hashes in private `run-artifact-paths`
evidence; build identity stays unverified.

## Release evidence gates and manual delivery

```bash
ohmatecli build run --build-mode release --project /absolute/project --format json
ohmatecli release verify --manifest /private/evidence/build-provenance.json --project /absolute/project --format json
ohmatecli release guide --manifest /private/evidence/build-provenance.json --project /absolute/project --lang zh-CN --format json
ohmatecli release artifacts --manifest /private/evidence/build-provenance.json \
  --symbols build/sourceMaps.map build/nameCache.json build/libexample.so --project /absolute/project --format json
```

- Use the actual build receipt's manifest path. Product, modules and mode are
  bound to that manifest. Artifact hashes must match; source drift is a finding.
  Explicit `--artifacts` without a manifest supports package inspection only.
- Build receipts include a CycloneDX 1.6 SBOM bound by path and raw SHA-256.
  Release verification checks its bounded public JSON and current dependency
  inventory; changed bytes, unavailable files or mismatched inventories fail
  the build-identity gate. A legacy manifest without SBOM remains incomplete.
  Verified inventory does not prove the production/compiler closure, licenses
  or vulnerabilities; `production-sbom-closure` remains missing.
- Fourteen gates report scope, hashes, findings and missing producer evidence.
  Source debug/log matches are candidates, not compiler reachability proof.
  Check the actual DevEco package fields `app.debug` and `app.buildMode`.
- Inspect ZIP entries without extraction and bounded ELF sections for ABI,
  GNU BuildID, debug/static symbols. Retain dynamic symbols. Certificate entries
  are identified by filename without decoding the payload. Invalid, private,
  linked, out-of-scope or contradictory inputs return 4.
- A finding returns 1; absent producer evidence returns 3. Permission use,
  compiled purity, effective ArkGuard merges, cloud/production-SBOM identity and complete
  symbol association remain incomplete. Do not claim release readiness.
- Guidance is manual only: no login, signing, upload or store submission.
  Archiving preserves original bytes, uses exclusive destination files and
  records original-to-archive mappings. Only explicitly selected SourceMap,
  nameCache and Native symbols are copied. Source inputs remain hash references;
  the archive does not yet provide a complete standalone build closure.

## Official scanning and project API documentation

```bash
ohmatecli scan --files entry/src/main/ets/Api.ts --domains official --config codelinter.json5 --project . --format json
ohmatecli docs generate --modules entry --project . --format json
ohmatecli docs check --modules entry --baseline /private/evidence/docs-ai-json-UUID.json --project . --format json
```

- Scan calls the installed ToolProvider Code Linter once per selected source
  file in declared modules. It uses a private HOME and never invokes `--fix`.
  Reports retain raw JSON, original exit/output hashes and input fingerprints;
  normalized findings are also exported as SARIF and escaped static HTML.
- Default scan requests all domains. Missing domains remain not-run and return
  3. Explicit `--domains official` returns 0 without diagnostics or 1 with
  diagnostics. An empty report does not certify complete ArkTS/compiler/Compat
  coverage. `--fix` and `--apply` are not registered yet and are refused.
- Project docs call Studio ArkTSDoc and parse its embedded model as JSON without
  executing scripts. The SDK compiler Program/TypeChecker resolves public
  exports, relative re-exports, defaults and callable overloads before associating
  declaration documentation. HTML, index and AI JSON share one stable API model.
  Compiler metadata, file hashes, reads and module resolutions are retained;
  unresolved exports or input/compiler drift prevent certification. This Program
  does not establish a real build input closure. SDK/OHPM module configuration,
  namespaces and cross-file declaration merges still require implementation.
  Official random IDs/time do not form API identity. Existing official docs
  search/read/catalog remain intact.
- `docs check` reports missing descriptions without a baseline, or additions,
  removals and signature/description changes against a model of the same
  modules. Module scope permits source files to be added/removed; explicit
  `--files` requires identical file scope. Native, Cloud and complex re-export
  producers are incomplete.
- Missing/invalid/out-of-scope reports and unexpected producer exits fail with
  original invocation evidence. Project files added, removed or changed during
  execution invalidate certification. Output evidence uses exclusive files.

## Thin Hvigor tasks and portable Skill

```bash
ohmatecli integrate runtime --module entry --profile release-none --project . --format json
ohmatecli integrate runtime --module entry --profile release-none --write --project . --format json
ohmatecli config validate --path runtime-profile.json5 --project . --format json
```

- Runtime integration previews by default. Explicit `--write` binds approval to
  configuration and file hashes and uses the shared Patch journal. Refuse existing
  targets, undeclared/non-Entry modules and absent real parent directories.
  Generate only the root Profile, module Hvigor adapter, module Profile manifest
  and `src/main/ets/OHMateRuntimeEntry.ets`; the host imports the entry manually.
- Profile fields are `schemaVersion:"1.0"`, `release:"none"|"core"`,
  `debug:"debug"`, `test:"test"` and `probes:[]`. Probe declarations require
  unique id, runtime-aspect/aspect-plugin/abckitts kind, declared module,
  ruleHash and literal runtimeGate:true. Never include method arguments/results.
  Valid declarations remain `valid:null/exit 3`; they prove no compiled probes.
- Release-none has no Runtime imports or effects; Debug API methods return
  CAPABILITY_NOT_AVAILABLE. Debug/Test entries delegate actual api/runtime and
  require the Entry's @ohmate/ohmatekit dependency declaration, bound to R2 writes.
  Both require actual debug Build Mode. Bounded hashes bind current Profile,
  entry, manifest and dependency bytes; drift blocks compilation. Release-core
  remains RUNTIME_ENTRY_UNAVAILABLE/exit 3. Configured probes reject without a
  compiler producer and are never silently omitted.
  The generated guard refuses mode mismatch and every unverified Release;
  there is no bypass flag. Keep buildId:null/incomplete and compiler/final
  purity requirements even for empty manifests. Selected Debug/Test manifests
  and probe claims are Release findings, not inferred compiler certification.
- Standalone build-only tools/{doctor,generate-integration,verify-release}.mjs
  share CLI source and need Node 22 plus builtins. Pass --project, --data-dir
  and --input JSON. Generator input matches CLI but write is forbidden; doctor
  checks consumer SDK/API, module dependency, Profile, entry/manifest and
  generated guard bytes. Test manifests require debug Build Mode; declaration
  errors exit 1 and missing actual Hvigor/compiler/artifact evidence exits 3.
  Never infer API26 as the minimum supported API.
  verify-release shares all fourteen gates. Its input accepts format
  json/sarif/html: JSON facts are receipt data; other formats are data.content
  with data.reportHash binding the same JSON facts. Helpers create no report
  files by default. CLI release verify/guide saves JSON, SARIF and escaped HTML
  in its private evidence store, including final-package hashes, manifest-declared
  toolchain version and unverified Core-only baseline.
  They never apply patches or run producers. tools/** is packed in HAR outside
  resources; compiler/buildId/final Release remain unverified.

```bash
ohmatecli integrate hvigor --project . --format json
ohmatecli integrate hvigor --project . --approve-plan PLAN_ID --format json
ohmatecli skill export --format json
ohmatecli skill verify --path EXPORT_DIRECTORY/ohmate-cli --format json
```

- Review the actual root `hvigorfile.ts` and new `ohmate-hvigor.ts` Diff.
  Applying and restoring use the shared Patch journal. Existing plugin entries,
  comments, BOM and line endings are preserved. Unsupported dynamic exports,
  nonliteral plugin arrays and existing generated-file names are refused.
- Install `@ohmate/ohmatecli` in the application before running Hvigor tasks.
  The generated plugin resolves the installed CLI, takes the official
  `NormalizedFile.getPath()` value and uses executable plus argv with no shell.
  It contains no workstation paths, credentials or approved-plan values.
- `ohmatecliScan` delegates to native scan and `ohmatecliDocs` to docs check.
  `ohmatecliVerifyRelease` delegates to the current Release gates.
  All nonzero receipts cause a failing Hvigor task.
- Set per-task input in the root plugin invocation, for example
  `ohmatePlugin({ ohmatecliScan: { modules: ['entry'], domains: ['official'] }, ohmatecliDocs: { modules: ['entry'] } })`.
  Each input is validated by its fixed target ToolSpec; it cannot replace the
  tool ID, choose an arbitrary executable or grant approval.
- `ohmatecliTest` creates a persistent Local Test task requiring approval.
  Inspect the original receipt and execute its `task approve` command after
  Hvigor exits. This avoids nested Hvigor execution and does not claim tests
  passed merely because a plan was created. The internal dispatcher accepts
  only these four task names; it is not a general process tool.
- Exports are immutable private artifact directories containing `SKILL.md`,
  `commands.json` and a file-hash manifest. Copy the reported `ohmate-cli`
  directory manually; no global installation or publication is performed.
  The live public registry covers native and bundled DevEco commands.
- Verification reads only those bounded regular files and checks metadata,
  hashes, duplicate IDs, dispatch entry, versions and exact command/schema
  drift. It refuses links, additional executable files, machine paths,
  credential data and unrestricted process instructions. The Runtime remains
  authoritative for argument restrictions and execution permissions.

## BYOK Agent and conversation context

TRAE CLI: run `ohmatecli model trae-cli` (optionally
`--executable /absolute/path/to/trae-cli`), then explicitly select a configuration
with `model select <id>` and check it with `model check <id>`. The CLI manages its
own login; never read or copy its authentication files. Discovery runs only
`models --json`. Requests use ephemeral `app-server --stdio` sessions in owned
temporary directories with host tools, MCP, environments and Skills disabled.
Pass only the approved OHMate transcript. Dynamic tool proposals return to the
Pi loop for Runtime validation and human write approval; never execute them in
the TRAE host. Cancellation terminates the owned process tree, escalates after
one second if stdio remains open, and waits for closure before cleanup.
POSIX cleanup also terminates owned process-group descendants that outlive the
stdio parent, without falling back to that exited parent's PID.
Explicit absolute `.js`, `.mjs` and `.cjs` launchers run through the current Node
without a shell or POSIX shebang requirement. The terminal
provides `/trae [absolute executable path]` and `/models`; Web exposes the same
discovery and check flow. Seed-2.1-Turbo text/tool/continuation is locally verified
with CLI 0.211.1; other models, versions and platforms remain unverified.

TRAE bridge: explicitly install/start `extensions/trae-model-bridge` in the editor,
copy connection settings into the user's private terminal, then run
`ohmatecli model trae --endpoint http://127.0.0.1:<port>/v1`.
The command discovers only models exposed by public `vscode.lm`, saves the
`OHMATE_TRAE_BRIDGE_KEY` environment-variable reference, and never selects or
calls a model automatically. Do not ask the user to send the bridge key to an
Agent. Select a discovered configuration explicitly; every model request
requires confirmation in the editor. Restart the Web service after changing
the environment. Actual editor/model availability remains unverified.

```bash
ohc                                      # interactive terminal; same implementation as ohmatecli
ohc --web                                # local Web workbench; alias of `ui`
ohc --web --no-open --project /absolute/project
ohmatecli agent chat
ohmatecli model list --format json
ohmatecli model add example --api openai-completions --model <model-id> \
  --endpoint https://provider.example/v1 --credential-env OHMATE_MODEL_KEY
ohmatecli model select example
ohmatecli model check example --format json
ohmatecli context preview --prompt "Inspect code" --files src/main.ts \
  --allowed-tools workspace.read --project /absolute/project --format json
ohmatecli agent run "Inspect code" --files src/main.ts --allowed-tools workspace.read \
  --preview-hash <reviewed-hash> --project /absolute/project --format json
ohmatecli session list --format json
ohmatecli session show <id> --format json
ohmatecli session resume <id> --format json
ohmatecli session export <id> --format json
ohmatecli rules check --files src/main.ts --project /absolute/project --format json
ohmatecli memory list --project /absolute/project --format json
ohmatecli extensions list --format json
```

- Requires Node >=22.19.0. Model configuration stores environment-variable
  names only. Do not read existing credentials, pass keys through arguments,
  or silently select a paid endpoint.
- `model.check` explicitly sends a small connectivity probe. Unverified tools,
  reasoning and multimodal features remain marked unverified.
- Review the full context preview before sending. Hashes bind files, applicable
  AGENTS/rules, approved memories, model, session history and linked evidence.
  Changing any of those requires a fresh preview.
- The model cannot expand file access beyond preview-selected paths, change
  project scope, grant itself approval or call administrative commands.
  High-risk proposals create independent awaiting-approval tasks.
- `session resume` returns history and the explicit Agent resume command.
  New Agent requests use `--session-id`; interrupted model calls are not
  automatically replayed. Approved tool receipts are included in the next
  sending preview.
- Sessions and ordered task events remain local. Generated text and tool
  results are untrusted facts, never authorization or executable shell text.
- Turn count, tool calls, per-response output, input and timeout are bounded.
  UTF-8 bytes provide a conservative input-token bound without a tokenizer.
  Unknown model cost is null, never zero-cost proof.
- The real pi SDK is pinned at `@earendil-works/*@1.4.0`. Local
  OpenAI-compatible SSE, tool loops and cancellation have been verified.
  Anthropic/Gemini cloud certification and executable extension adapters
  remain incomplete; extension enablement is blocked.
- In a TTY, no arguments open the same console as `agent chat`. `/execute`
  accepts a ToolSpec ID and JSON; `/files`, `/tools`, `/model`, `/session`
  select context. `/approve <taskId> [planId]` approves and executes a pending
  plan, then a new message continues that session. Tab completes console
  commands and execute tool IDs; Up/Down recalls in-process history. The first
  idle Ctrl+C prints a hint, the second exits with 130. Non-TTY/no-argument use
  prints help.

## Reviewed workspace patches

```bash
ohmatecli context preview --prompt "Propose a change" --files src/main.ts \
  --write-paths src/main.ts src/new.ts --allowed-tools workspace.read workspace.patch \
  --project /absolute/project --format json
ohmatecli workspace patch --input '<changes-json>' --project /absolute/project --format json
ohmatecli task submit workspace.patch --payload '<changes-json>' --wait --project /absolute/project
ohmatecli task approve <taskId> <planId> --wait
ohmatecli workspace recovery inspect --journal-id <journalId> --project /absolute/project
ohmatecli workspace recovery restore --journal-id <journalId> --project /absolute/project
```

- `changes-json` is `{"changes":[{"path":"src/main.ts","oldHash":"<sha256>","text":"<new text>"}]}`.
  Use `oldHash:null` for a new file and `text:null` for deletion. Paths are exact
  project-relative paths with existing parent directories; no glob expansion.
- Read the file Diff and old/new hashes before approving a patch or restore.
  Up to 20 files, 128 KiB per file, 256 KiB total input; secrets, binary,
  linked files, private product state and paths outside scope are refused.
- Agent `--write-paths` binds permitted paths and old hashes to the sending
  preview. Reading a file does not authorize writing it. `/write` selects these
  paths in the console. The Agent cannot call recovery or approval tools.
- Each write is atomic for one file. Failed or cooperatively cancelled batches
  roll back their completed writes when hashes still match. Inspect
  `PATCH_RECOVERY_REQUIRED` and its journal instead of forcing a restore.
- Journal state can evolve, while receipt evidence snapshots retain their
  original bytes and hashes. Hard-interrupted writes are not automatically replayed.
- OHMate locks coordinate its own writers. External edits between the final
  hash check and filesystem operation require an isolated checkout for stronger
  exclusion; do not claim multi-file transaction guarantees.

## Same-runtime Web workbench

```bash
ohc --web
ohc --web --no-open --format json
ohmatecli ui
ohmatecli ui --no-open --format json
ohmatecli ui status --format json
ohmatecli ui stop --format json
ohmatecli debug start --format json
ohmatecli debug status --format json
ohmatecli debug list --format json
ohmatecli debug protocol --format json
ohmatecli debug pair --buildId peer-build --device peer-device --process peer-process --sessionId peer-session
ohmatecli debug pair --buildId peer-build --device peer-device --process peer-process --sessionId peer-session --hdc-device <connected-serial>
ohmatecli debug show <session-id> --format json
ohmatecli debug streams <session-id> --limit 20 --format json
ohmatecli debug events <session-id> --stream <stream-id> --after 0 --limit 100 --format json
ohmatecli debug inspectors --format json
ohmatecli debug inspect <session-id> --stream <stream-id> --channel hidebug --limit 100 --format json
ohmatecli debug stop --format json
ohmatecli project register /absolute/app --format json
ohmatecli project list --format json
```

- Bare `ui` opens Web; `ui layout/find/wait` and other device leaves retain
  their original semantics. `execute deveco.ui` retains the upstream parent.
- The private detached service uses loopback and a random port. The browser
  fragment is a single-use capability valid for 60 seconds; do not persist or
  share it. Exchange clears it and uses an HttpOnly/SameSite cookie.
- CLI and Web share the registry, approval bindings, task events and receipts.
  Closing the browser does not cancel tasks. Stopping the service closes HTTP
  and SSE connections; records remain available to the terminal.
- Register only explicitly selected real application directories. Web task
  input cannot override its selected project through a legacy `--project`.
- Web lifecycle and stdio protocol tools require their own terminal entries;
  they are not Agent tools or general background tasks.
- `debug start` and compatibility alias `devtools serve` start the same service
  without opening a browser. `ui` reuses its process and persistent DebugSession.
  `debug status/list/show` and authenticated `GET /api/v1/debug/status` and
  `GET /api/v1/debug/sessions` read the same records. Stop preserves records;
  restart creates a new session. Initial bridge state is `waiting-pairing` with
  null target. Loopback WebSocket is available; actual Kit/HDC and build identity
  have not been verified.
- `debug protocol` and authenticated `GET /api/v1/debug/protocol` expose the
  shared 1.1/1.0 read-only structural schemas and channel hashes. Runtime exports
  pure handshake/receiver APIs with continuous ack, deduplication/conflicts,
  retained-window resume/gap and clock segments. Short-lived 256-bit invitations,
  mutual challenges and P-256/HKDF-SHA256/AES-GCM protect the loopback frames.
  Only durably written redacted events are acknowledged. `debug events` reads
  validated evidence; it never restores authentication or automatically replays.
  Device identity is peer-asserted, build verification remains unverified, LAN
  is disabled and actual Kit transport resumption remains unverified.
- The same descriptor's `writes` lists seven scopes, command/receipt schemas and
  risks. Every remote scope remains `available:false / DEVICE_BUILD_UNVERIFIED`.
  Runtime `WriteSession` manages only application-local, per-command confirmation,
  idempotent receipts, TTL and revocation. Temporary operations register rollback
  before execution; failed cleanup retains its owner for explicit retry. Pending
  native work is not reported as applied. Status/receipts, review/confirm, apply
  (including duplicates) and completion observe the clock. Backward or
  non-safe-integer readings permanently revoke this session without replacing its
  last valid time; invalid construction starts revoked. Queries inspect command
  and ten-minute session deadlines before timer delivery. Duplicate receipts remain,
  and polling never retries failed cleanup. This API cannot authenticate a peer or
  guarantee preemption of Console scripts.
- The example's Console and response-body owners cancel current consent on
  backward or non-safe-integer clocks without replacing the last valid reading.
  Valid-clock recovery requires a fresh review and independent confirmation;
  it cannot revive old plans or in-flight tickets. Body re-confirmation does not
  renew TTL or reset quotas. Console duplicates do not dispatch another native
  call, and cancellation retains its native lock until settlement.
- `mock validate --input-file request.json` accepts `{rules}`; `mock plan` accepts
  `{rules,samples}` through the same input-file option. These are offline checks,
  not observed device traffic or remote approval. Exact target/origin/method/path/
  allowlisted header/resourceType matching uses descending priority and stable input
  order. Limits: 32 rules, 256 KiB total, 64 KiB per fixed body and 3-second delay.
  Fixed response, deterministic text template, delay, timeout and network-error
  are supported rule descriptions; file, chunk and stream remain unsupported.
  Template responses use `{kind:"template",status,headers,template,variables,delayMs}`.
  Only `{{test.name}}` expands from explicit string variables, once without code
  execution, request context, environment or file reads. Limits: 16 KiB template,
  16 variables/2 KiB each, 64 references, 64 KiB rendered body and 256 KiB whole
  rendered table. Reject missing/unused variables, malformed syntax and invalid
  UTF-8; HEAD must render empty. Dry-run binds response and rendered-body hashes.
  Sensitive paths
  and authentication/payment/upload/delete/unknown requests are refused. Only
  GET/HEAD/OPTIONS, fetch/xhr and explicit non-sensitive headers are permitted.
  Receipts contain hashes/counts/match identifiers, never raw response bodies.
  Runtime `NetworkMockTable` owns memory rules, validates payload/plan hashes and
  the prior table version, and restores original state without reviving aborted or
  expired owners. It does not perform HTTP; the example ArkTS Adapter has local
  confirmation and a fixed template probe, while platform/Phone behavior remains unverified.
  NetworkMock and WebResourceOverride permanently invalidate their current owner
  after backward or non-safe-integer clocks. Cancel, clock recovery and fresh
  review cannot revive it; normal valid-clock cancel/expiry permits fresh review
  with independent confirmation.
  `mock apply/revoke` return `DEVICE_BUILD_UNVERIFIED`; `mock status` keeps active/
  hits null. All five Mock tools stay outside Agent and persistent background tasks.
  Desktop approvals never substitute for application consent or authentication.
- The example's separate Web resource owner supports host-declared packaged
  ohmate-resources/ css/txt files, 64 KiB each/256 KiB total, only after exact
  byte-count/hash verification and descriptor close. Its dedicated Web instance
  explicitly grants scheme ownership for bounded WebSchemeHandler chunks.
  Application review/confirmation stays separate; cancellation stops later chunks.
  Retain buffers until exact request-stop and native call return; failed close
  keeps responsibility and retries only on explicit stop. No bodies in events/ZIPs.
  This does not add file/stream formats to mock or enable remote writes.
  Actual ArkWeb request identity/lifecycle and device/build remain unverified.
- The Web debug list combines updates per browser animation frame and displays
  at most the latest 100 records. Pause, fault and end display accepted records;
  refresh and selection cancel old rendering. This does not prove actual Kit
  capture or the ten-minute performance target.
- Encrypted ready may negotiate `eventBatch:"events-v1"` with a matching reply.
  A batch frame holds 1–64 events within the existing maxFrame budget. Manifest
  1.3 stores immutable segments; its synced checkpoint precedes cumulative ack.
  Legacy clients and archives remain compatible and reject whole batches at quota.
  Explicit `retention:"rolling-v1"` together with events-v1 selects manifest 1.4
  for a new stream. It retires oldest segments within 4096 events/5 MiB, reports
  gaps and preserves absolute cursors and retained counts in CLI/SSE/offline pages.
  Resume requires the same opt-in; old archives are never converted. Prefix
  eviction invalidates export approval. Ten-minute load and real Kit remain
  unverified. See `docs/debug-event-batches.md` and `docs/debug-retention.md`.
- Persisted resumption requires fresh private pairing and application confirmation.
  The encrypted ready includes `resume: {streamId, previousEpoch, resumeFrom}`.
  Only the same DebugSession, full identity and negotiation may append to a saved
  stream. Manifest 1.2 binds both handshakes; checkpoint 1.1 persists at most 24
  epochs. Recovery validates committed event digests and clock segments, rejects
  stale writers and reports unavailable sequences as gaps. Older manifest 1.1
  archives remain readable but are not upgraded or guessed. Keys are never saved;
  service restart or revocation changes the fingerprint and prevents old-stream
  append. Historical reads remain available.
- `debug pair` requires human format and both input/output TTYs; pipes, JSON,
  non-interactive use, Agent tools and tasks cannot receive invitations.
  Only the private terminal sink receives the short-lived invitation; ordinary
  receipts expose public metadata. Output failure attempts explicit revocation.
  Pairing checks the startup scope and current workbench fingerprint.
- Optional `--hdc-device` requires an exact connected serial. The worker creates
  and verifies a device-to-host `rport` using the workbench port on both ends.
  It refuses pre-existing rules and removes only the observed selected reverse
  rule on expiry, disconnect, revoke or stop. Failed cleanup remains visible and
  blocks new pairing until explicit cleanup succeeds; an incomplete acquisition
  retains its owner for revocation after the device returns. Target hashes prove
  no device/build identity. HDC has no ownership token; external replacement
  races, crash leftovers and the real device path remain unverified.
- The Web debug page reads the same verified event pages (`nextCursor`,
  `through`, `hasMore`) and subscribes to a distinct read-only SSE endpoint.
  It shows unverified identity, gaps, stopped sessions and integrity failures.
  Live view retains at most 100 events; reconnecting never restores device keys.
- `debug streams <session-id>` and authenticated
  `GET /api/v1/debug/sessions/<id>/streams` enumerate historical streams.
  Use `--after <stream-uuid>` for exclusive pagination; default limit is 20,
  maximum 64. More than 1000 stream directories is an explicit error.
  Corrupt archives are marked individually without exposing unverified contents.
  Web offers stream selection and additional stream pages; only the active
  connected stream can follow new events. It locates a preferred stream beyond
  the initial index page, preserves selection during index reads and discards
  stale event pages after a stream switch.
- `debug inspectors` describes all 17 read-only channel summary views and API
  references. `debug inspect <session-id> --stream <stream-id> --channel <channel>`
  filters the verified journal, default limit 100, maximum 256. Use the returned
  `nextCursor` as `--after` and `through` as `--through` for a fixed cut; the last
  cursor may advance over other channels to the cut. `snapshotHash` binds its
  committed tail. CLI, HTTP and Agent enforce the same cwd/project scope.
  Only `debug.inspect` and `debug.inspectors` join the Agent/task allowlist;
  pairing and lifecycle entries remain denied. Web offers channel selection,
  fixed-cut pages, refresh and explicit not-captured/not-negotiated states.
  Network records remain summary-only; an API reference never proves its use
  or intercepted coverage. Sampling rate remains unknown. An opt-in encrypted
  four-timestamp exchange records per-event offsets, uncertainty and drift
  assumptions; expired, changed or over-budget clocks stay segmented.
  Legacy mergeable flags do not prove calibration. Journal recovery and problem
  import recompute evidence; a new epoch requires new measurements.
  See `docs/debug-clock.md`.
  Full UI Inspector, ArkWeb DevTools and Profiler endpoints are not associated.
  See `docs/debug-inspector.md`.
- Export standalone `.ohmate-problem.zip` files from a fixed committed cut:
  `debug problem plan <session-id> --stream <stream-id> --through <safe-integer>`
  previews fields, files, bytes, hashes, redaction, coverage and retained risks.
  `debug problem export` with the same arguments requires a one-use R2 plan
  via `--approve-plan <plan-id>`. Later events do not enlarge the cut.
  Export writes a new private immutable artifact; it does not overwrite files.
  `replay import --path <file>` validates and opens a read-only reference:
  `path` is absolute, `importStatus:opened`, `access:read-only`. It does not copy,
  extract or register the package persistently. Use that path with `replay show`;
  every later read revalidates the original file. Import returns metadata without
  whole event or clock arrays; other majors return `importStatus:manifest-only`
  and exit 3. Task, HTTP and Agent execution use the same R0 read service.
  `replay verify --path <file>` validates the archive without extraction.
  `replay show --path <file> --after 0 --limit 100` pages validated summaries
  (maximum page size 256). `--domain <Kit-domain>` selects a Kit record page;
  optional `--file <listed-path>` selects a file in that domain. Kit cursors are
  exclusive record ordinals in profile file order, restarting at 0 on selection
  changes. Record JSON is bounded to 48 KiB per page after whole-package
  validation; attachments expose metadata only. Optional `--build-id <expected-id>` is an exact
  assertion, not build authentication. No replay actions are performed.
  `replay plan --path <zip> [--steps <file.ohmate-replay.json>]` validates the
  archive again and binds raw ZIP/script hashes into a deterministic offline
  plan. The script uses version `1.0`, exact `buildId` and 1–64 ordered steps
  within 64 KiB UTF-8. Ordinary kinds `action/input/route/wait/assert` require
  `test.` actionId/assertionId, a `test:` dataRef (or empty string), `test:`
  expected reference and 1–3000 ms waitMs. Manual steps contain only kind
  `manual` and reason `system-interaction/adapter-required`. Raw input, extra
  fields, sensitive actions and mismatched builds are refused. Without a script, return
  an empty manual plan; events never imply business actions. All current plans
  remain `manual-only/not-performed`; local Adapter and compiled artifact binding
  are required separately, and no peer identity admits a remote write.
  Web uses the same task approval and offline viewer. Agent may call the six
  problem tools and the two read-only Inspector tools; export pauses for human approval.
  Same-major additive fields are omitted and counted, with known constraints
  and domain alternatives pinned. Other majors expose only a safe manifest
  with exit 3 and unchecked payload integrity. Authentication is never restored.
  Default desktop exports remain summaries without attachments or network bodies.
  Kit minor 1.4 validates 18 provided domains, source/role/count/coverage assertions
  and explicitly reviewed inert attachments. Provenance remains peer-reported;
  SDK catalogs are not captured data. Web offers the same domain/file selection.
  The Kit example inspects at most 256 expanded nodes in its registered page
  subtree without text or input values, sends a node-count summary, and exports
  the frozen PSS plus current structural file only after explicit review.
  Structure may include window-relative vp geometry and native visibility
  attributes, without occlusion or physical-paint claims. The exact legacy
  pre-geometry UI schema remains readable; other constraints stay pinned.
  A separate thirty-second screenshot review permits only the fixed public
  description subtree. Capture is bounded to 512 pixels per side, 1 MiB pixels,
  256 KiB PNG and a three-second wait. Pending native work and failed releases
  retain ownership until settlement or explicit revoke cleanup. The preview
  remains memory-only for thirty seconds and is excluded from frames and ZIPs;
  this example does not provide protected screenshot storage.
  Its registered `HttpRequest.request` wrapper observes method/status/duration
  without reading URL, headers or bodies. It queues at most 32 completions,
  alternates with PSS using one pending ACK and synchronously rejects expired
  reads. Other instances, streaming requests and third-party clients are outside
  coverage. Explicit export may also freeze the latest sent request summary.
  A registered API26 Web instance loads only the confirmed workbench reference
  page. `getFullDom` projects at most 256 nodes/32 levels/65536 returned characters;
  native default title/text/attributes are discarded in temporary memory.
  Cookie reads retain only URL-related incognito nonpartitioned counts in app
  memory for thirty seconds. Explicit app publishing makes that metadata
  readable through `debug inspect <id> --stream <stream> --channel arkweb.storage`.
  No names, values, attributes, other origins or quota are captured.
  Only a successfully sent, still-current summary may enter `arkweb.jsonl`
  through app export review; read it with `replay show --path <zip> --domain arkweb`.
  Cancellation, source drift and expiry invalidate unsaved exports. Clearing
  the app snapshot cannot retract desktop history or a user-owned saved file.
  Local/session storage defaults closed. The example may explicitly permit two
  ordinary ohmate-test- keys before pairing and show only their presence counts
  through a fixed page Adapter. Raw values stay in private memory until the
  original thirty-second deadline, never in UI state, frames or exports. Permission
  can be closed any time and resets on stop; no enumeration, seeds or raw unlock.
  Separate application-local R3 controls review, confirm and execute one test key
  using a fixed marker, empty string or removal. Cancel attempts conditional
  restoration without overwriting concurrent values; failed cleanup retries only
  explicitly. Timeout keeps native ownership; late restoration cannot certify
  success. Originals expire at the original thirty-second deadline. Observed
  source drift permanently revokes recovery; unresolved responsibility blocks new
  pairing. Stop clears the grant and originals before asynchronous close; retained
  recovery keeps cleanup-failed/STORAGE_RESTORE_REQUIRED after transport closure.
  Repeated stop or late native settlement cannot certify recovery or dispatch
  into the destroyed source. No remote write admission, capture attestation or verified Phone UX.
  The application-local R2 highlight defaults closed without a registered host.
  Independent review/confirm/execute/cancel/retry targets only the current window's
  fixed description subtree. Thirty-second review and three-second outline limits
  bind source ancestry, identity/epoch/generation and earliest deadline. Cleanup
  precedes new UI capture, and effects clear old UI/screenshot/unsaved exports.
  Source or clock drift permanently revokes a grant. Failed exact-command cleanup
  retains responsibility across stop and blocks new pairing until explicit retry.
  Constant-width border state acceptance does not attest native rendering or paint.
  Console reads only level with a fixed summary; main-page callback duration has
  no HTTP status or full-request claim. A three-second wait timeout retains the
  native owner until settlement; rebuild, expiry and source drift invalidate
  snapshots. Explicit export may include DOM, latest Console and navigation;
  HTTP and navigation share one file with an explicitly combined adapter source.
  Optional HiAppEvent collection requires a separate start action and negotiated
  SysCap. Only OS crash/freeze event names are projected; params, stacks and
  log paths are never read. The 32-record queue rotates with Web/HTTP, alternating
  with PSS at a combined automatic 1 Hz and one ACK. Callback time is observation,
  not authenticated fault time; registration is not capture. Failed removal
  retains its owner and blocks pairing until explicit retry.
  CPU is an explicit TaskPool process-percentage read without interval/thread
  claims or automatic polling. Unsettled metrics retain ownership across revoke.
  Explicit export combines latest CPU/PSS in one memory file and adds only
  actually observed DFX names in its unique event file; PSS-only stays compatible.
  Missing domains have no placeholder files. Platform collection/save execution and device/build authentication
  remain unverified. Archive limits are 2 GiB/1 GiB per file/10000 files/ratio 100.
  Positional file reads avoid whole-archive allocation; summary decode limits
  are 4 MiB for manifest/each schema, 1 MiB for session and 32 MiB for events.
  Kit JSONL construction/import share 32 MiB per file, JSON/profile 4 MiB;
  structural/summary content totals at most 64 MiB.
  Retained packages use minor 1.2, or 1.3 when clocks must be stored alongside
  events to keep the session budget. Pages return only page clocks with their
  absolute `clockEvidenceFrom`; verification retains complete clock evidence.
  See `docs/problem-package.md` for the full supported-profile boundaries.
- Events and the atomic checkpoint must both be synced before acknowledgement.
  Missing tails, absent checkpoints, uncommitted files and old 1.0 journals are
  rejected rather than repaired. Idle key expiry releases the connection.
  Status write failures do not prevent listener cleanup. A changed code, assets,
  protocol or Node fingerprint returns `WORKBENCH_CODE_CHANGED`; explicitly stop
  and restart the owned workbench before generating a new pairing.
  Per-stream cross-process locks coordinate reads with checkpoint commits.
- Models only store environment-variable references. The webpage cannot
  configure a plaintext key. New host variables require a service restart.
- This workbench implements task orchestration, previews and real records.
  Patch Diff and explicit write paths share terminal semantics.
  Full engineering generation/verification, Kit debugging and performance capture
  are subsequent capabilities, not implied by the six intent buttons.
