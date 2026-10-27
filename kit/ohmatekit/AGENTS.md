# OHMate Kit source package

- Single OHPM coordinate: `@ohmate/ohmatekit`, version `6.0.0`.
- HAR source entry: `Index.ets`; public Core: `src/main/ets/api/core.ets`.
- Stage HAR module `ohmatekit` uses official `harTasks`, target `default`,
  with phone/tablet/2in1 declarations. This is not an application root.
- The private consumer declares the module in its build profile. The root
  product remains a Node workspace; no application markers belong there.
- API/SDK values come from the consumer project. Current validation uses API26.
- Core dependencies are only `api`, `core` and `recorder`; no network, window,
  debug, providers, Test Bridge, CLI or Node runtime imports.
- `src/main/ets/providers/index.ets` is the static Debug/Test Provider entry.
  The official HAR keeps its domain declarations; additional root ETS entries
  are not shipped by this toolchain. ProviderRegistry
  takes an explicit application Profile and monotonic millisecond clock, never
  compiler or remote authentication. Registration is inert; capture is explicit,
  readonly and schema-projected. At most 32 lifetime IDs/exclusive Adapter owners
  and 256 reads including failures per ID; wait budgets are 100–3000 ms.
  Timeout/cancel retains pending native ownership. Unregister closes only after
  reads settle; failed/late cleanup retains the exact Adapter for explicit retry.
  Clock drift permanently closes capture grants. Status contains no raw fields,
  paths, errors or authenticated claims. Import creates no timer or I/O.
  `scripts/kit-provider-tests.mjs` executes these actual portable ETS contracts;
  injected Adapters do not establish device API or physical cleanup behavior.
- `src/main/ets/api/debug.ets` exports OHMateDebug, which owns an explicit
  OHMateCore plus the same readonly ProviderRegistry and application window
  Adapters. Construction/start never acquire a window or network. Release and
  invalid application Profiles reject Debug effects. Explicit attach/open/close/
  show/hide/detach are bounded to 100–3000 ms, 32 lifetime attachments and 256
  effect attempts per attachment. Each Adapter has exclusive lifetime ownership;
  a cleaned window ID may be explicitly reacquired by a fresh Adapter without
  resetting attachment quotas. Multiple windows require an explicit target.
  Cancelled operations retain native responsibility and detach only after they
  settle. Failed/timed-out cleanup is not repaired by late acceptance or queries;
  explicit retry remains available after dispose. Clock drift permanently closes
  UI grants. Window status is Adapter-reported/unverified, with unknown surface
  state after revocation. It does not certify paint or supply a platform surface.
  `scripts/kit-debug-tests.mjs` executes portable composition and private-file
  Core ZIP behavior.
- Public `src/main/ets/api/window.ets` exports HarmonyDebugWindowHost,
  DebugViewModel and FloatingRect. The host binds only the caller's exact
  UIContext window name/ID, never enumerates or creates system windows. Its
  stable size/avoid/lifecycle callbacks and exact ComponentContent objects retain
  cleanup ownership after partial registration, overlay, dialog or dispose failure.
  Late dialog completion cannot revive the revoked host; explicit detach retries
  retained responsibility. Current-window overlay and HDS/V2 panel are created
  only on show/open. The 48vp Symbol button separates drag/click at 8vp, snaps
  to edges and stores side/ratio in bounded per-window orientation/size buckets. At most 16
  explicit business rectangles plus system avoid areas participate; invalid or
  blocked geometry hides the button. Background never automatically restores it.
  Drag cancellation restores the original normalized position without committing.
  Its controlled Menu supports long-press, right-click and the menu key; actions
  are restricted to pause/resume, mark and hide with live visible/busy/geometry
  checks. Requested/late menus keep the original node until native disappearance;
  hidden, blocked or revoked hosts request close and explicit detach retries cleanup.
  updateConfiguration uses existing scoped ComponentContent nodes, never creates
  a new surface, and retains owners on failure.
  Runtime attachWindow(context, timeoutMs, positionKey) optionally uses a stable
  application-supplied ASCII logical key; absent keys remain memory-only, and
  duplicate active keys reject before effects. Raw names/IDs are not persisted.
  The one Runtime Preferences XML cache uses one fixed table, at most 32 logical
  keys, 27 buckets each and less than 64 KiB. Reads/writes share 256 lifetime
  attempts; each model has its own 256-attempt limit. No observer or data group
  is created. Missing SysCap or malformed tables are unavailable without replacing
  existing data. Cancel/resize/background/failed grants/release invalidate reads;
  only committed drags save. Failed put/flush preserves its proposed table and
  requires explicit retryPosition; failed/pending cache removal retains the exact
  owner until dispose retry. Older retries cannot acquire a new write after a
  background/foreground transition. XML results do not prove multiprocess safety
  or physical durability. scripts/kit-position-tests.mjs runs actual ETS owners
  with a private Preferences substitute; official builds check SDK compatibility.
  Chinese resource strings and system semantic colors are package resources.
  scripts/kit-window-host-tests.mjs uses private SDK/builders to check actual ETS
  ownership and geometry; paint, focus, themes, fonts, input and device UX remain
  unverified. The default Index/Core do not import this host or its UI resources.
  `api/runtime` supplies explicit context composition; CLI/standalone generation
  delegates it for explicit Debug/Test Profiles. These are application declarations,
  with actual debug Build Mode checked by the generated Hvigor guard.
- Public `src/main/ets/api/runtime.ets` exports OHMateRuntime for Debug/Test
  application context integration. The default OHMateKit and Runtime reuse the
  same internal ContextCoreOwner and sandbox recorder; no second file owner is
  created. Schema registration closes at first start. Invalid options/context
  and conflicting context/options/Profile do not acquire resources; rejected
  context/options starts do not reserve Profiles. Release/unknown Profiles reject.
  Import/start never query windows. Explicit attach creates the current-window
  floating entry and binds only its live model's Core controls, problem creation,
  panel and hide actions. Multiwindow controls require a target. Native hidden
  synchronizes DebugWindows visibility and cancels pending UI waits; background
  cleanup waits for the exact native effect and cannot auto-restore a panel.
  Destroy unbinds actions before cleanup; only successful original host cleanup
  releases the old UIContext. Failed cleanup remains explicitly retryable after
  disposal. Runtime disposes Debug/Test then the shared Core/file owner.
  Explicit window-ID updateConfiguration shares the same 256-effect budget and
  native owner. Reentrant controls return busy and detach waits for notification
  return; unsupported Adapters do not acquire another effect.
  ProblemPanelModel adds counts/triage, file/field names and separate export/delete
  confirmations inside the existing HDS panel. Thirty-second grants bind the
  selected problem, window and final Core ZIP hash; every native effect rechecks
  Core approval. No raw values, paths, logs or attachments are displayed.
  Cancellation/background/close/configuration failure/destroy/dispose revoke
  saves without releasing pending Picker/file responsibility. Failed cleanup
  blocks original context/slot/key release; retryArchiveSaveCleanup(windowId)
  only closes that exact retained owner, including after disposal.
  Uncertain deletion retains quota and its target for separate confirmation/retry.
  User-saved or partial files are never removed by cancellation/problem deletion.
  Old captured window callbacks cannot operate a fresh same-ID attachment.
  test:kit:problem-panel executes actual ETS/Core ZIPs with private files;
  Runtime SDK substitutes do not establish Picker, UI or physical durability.
  `scripts/kit-context-runtime-tests.mjs` checks these actual portable ETS with
  private file and SDK hosts, including the complete default Core closure.
  Profile/build and READY/ASSERT remain application/Adapter reported,
  unverified-build/manual-only; compiler binding, paint and platform
  effects remain unverified.
- `src/main/ets/api/test.ets` exports OHMateTestBridge and readonly
  TestObservationAdapter. Only the explicit Test Profile may register an Adapter;
  READY/ASSERT are local observations, not Test HAP transport or actions.
  At most 32 unique test.assert.* references, one Adapter and 256 total reads
  including failures use the same ProviderRegistry. Missing Adapters are
  unavailable; results contain boolean summaries and remain manual-only,
  automation unavailable and build/capture unverified. Timeout/dispose retains
  exact native responsibility and cleanup only retries explicitly. No network,
  Core initialization, replay execution or surface acquisition is implied.
  `scripts/kit-testbridge-tests.mjs` executes these portable observation contracts.
- `OHMateCore` requires an explicit `CoreHost`. `OHMateKit.start(context)` uses
  `HarmonySandboxHost`; this singleton never acquires a window or network listener.
  Sandbox I/O is async, ordered and file-lock owned. Disposal bounds waiting while
  retaining ownership until pending writes/reads settle.
- Core fields accept registered bounded enums, numbers and booleans. Unknown,
  sensitive and free-text fields never enter the recorder.
- Default bounds: 512 records, 256 KiB pending plus ring event bytes, 32 reserved
  Critical records/32 KiB, 5 MiB stored bytes, 20 problems, seven-day policy,
  one-second flush and 100 ms normal-close wait. Explicit seven-day prune updates
  disk and Core accounting even after partial unlink/fsync/index failure. Idle
  heartbeat cleanup runs at most once per idle minute, outside fault paths.
  Root lock/index, bounded session manifests and staging consume quota.
  Session manifests are rebuildable segment inventories, not system exit proof.
  Derived format 1.1 groups root-index files by directory and stores only local
  segment names in session manifests. Valid 1.0 metadata rebuilds from unchanged
  checksummed segments; index/manifest contents never choose recovery paths.
  Publications preflight 256 global segments, configured problem count, 64
  sessions, 63 pending directories and 32 KiB derived metadata. Metadata can
  exhaust capacity before the count limit. Pending entries participate in
  restart-index budgets; explicit retries retain original staging ownership.
  Core may extend its newest segment only through the optional
  `CoreHost.extendSegment`, which requires an exact stored event prefix of the
  same session and atomically replaces that one file within 1024 events/512 KiB;
  plain append never rewrites a segment and no committed event is removed.
  Only a missing owned staging file/directory can be reconciled without removal.
  Missing FileIO/Time/CryptoFramework SysCaps reject sandbox initialization.
  API26 devices expose the umbrella CryptoFramework capability while the Md
  sub-capability may report false, so only the SDK-declared umbrella is gated.
- Segment checksums and host-reported fsync are evidence of host results only.
  Build identity, system capture, crash callbacks and physical durability remain
  unverified. Problem summaries use manual replay only. reviewArchive/exportArchive
  produce a registered-fields-only store ZIP with embedded canonical schemas.
  Approval binds final bytes via hashBytes; export repeats schema projection and
  returns independent bytes. Deletion, uncertain results, prune, invalid clocks
  and disposal revoke approval; uncertain deletion keeps quota until explicit retry.
- Problem records recover with schema/field/triage checks and a fresh export
  review. Uncertain saves retain their byte/count reservation and cannot export.
- Clock ordering uses system STARTUP milliseconds relative to this session,
  avoiding unsafe nanosecond integers. Session UUID is not a system boot identity.
  Invalid startup values and session deltas outside safe nanosecond precision reject.
- Run actual portable ETS behavior tests with
  `node scripts/kit-public-core-tests.mjs` from the product root. They use private
  temporary files and track timer cleanup; they do not execute device APIs.
- `node scripts/kit-platform-host-tests.mjs` executes actual ETS with private
  Node files and SDK shims, covering locks, partial writes, cancellation, recovery
  and retention. It does not certify HarmonyOS physical storage behavior.
- Official validation uses private consumer projects and SDK copies. Do not
  publish, touch existing devices, read credentials or alter the installed SDK.
- Build-only tools/doctor.mjs, generate-integration.mjs and verify-release.mjs
  are generated from CLI source by scripts/generate-kit-tools.mjs. The standalone
  bundle needs only Node 22 and builtins; build-profile packs tools/** in the HAR,
  outside resource directories. Helpers do not apply patches or execute producers.
  Doctor checks consumer SDK/API, dependencies and Profile/entry/manifest/guard
  declarations without inferring the minimum API or actual Hvigor Build Mode.
  Test manifests require debug mode. verify-release input selects JSON/SARIF/HTML;
  rendered formats bind the same JSON facts and preserve final-package hashes,
  manifest-declared toolchain version and unverified Core-only baseline. Helpers
  have no default report writes; CLI stores formats in its private evidence store.
  Debug/Test previews require the Entry's @ohmate/ohmatekit dependency declaration;
  CLI writes require R2 approval. Configured probes reject without a compiler
  producer, release-core is unavailable and every generated Release build remains
  blocked without final purity evidence. Lexical coverage gaps remain incomplete
  while explicit package-byte checks continue. Hash/mode checks are not buildId authentication.
