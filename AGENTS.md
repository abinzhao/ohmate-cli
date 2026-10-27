# Agents.md

## OHMate project contract

This directory is the OHMate CLI product workspace, created from the supplied
DevEco source snapshot. It is a Node.js tool, not a HarmonyOS application.
Do not add app markers to make it pass application preflight.

- Primary contract: `../鸿蒙智能开发质量工具最终设计方案/01-OHMate-CLI最终设计方案.md`.
- Optional FaultLog integration is independent of Core and bridge start.
  `config.validate` statically checks API21/Stage entries, non-exported sources,
  names and bounded local dependencies; absent is `not-configured`, definite
  errors exit 1 and unverified host/system/build evidence remains exit 3/valid:null.
  Reference host configure never registers; explicit application consent owns
  normal A and empty B, with Extension B using the same fixed name.
  Detach/disconnect invalidate memory while preserving persisted filters;
  only explicit revoke deletes owned watchers. Retain failed cleanup and reject
  synchronous acquisition revival. Extension has a terminal nine-second uptime
  budget and bounded event-name summaries, no params/files/transport/Core imports.
  Static/Node/compiled evidence does not verify actual delayed launch or Release.
- Preserve the five packages under `packages/`: cli, cli-wrapper, docs-zh,
  docs-engine, docs-index-builder. The upstream overview below is historical.
- TRAE CLI model requests use the `trae-cli` model schema and owned ephemeral
  stdio app-server sessions. Authentication stays inside the installed CLI.
  Never read/copy its credentials or let its host tools execute Agent proposals;
  declarations and results pass through the existing Pi/Runtime approval loop.
  Discovery is not model capability evidence. Preserve explicit context review,
  bounded RPC/response data, generic errors and awaited child cleanup.
- Context continuation may reference current material only when path, source,
  hash, byte count, redaction flag and text all match. Preserve changed/deselected
  historical text, tool results, raw saved sessions and the existing send budget.
- Runtime Profile declarations have one schema owner in integrate/runtime-profile.
  Valid configuration remains incomplete; probe ids are unique and module-bound,
  and runtimeGate is literal true. The integration command previews by default;
  only explicit writes use approval and the existing Patch journal, without
  creating missing parents or overwriting collisions. Release-none has no imports
  or Runtime effects. Debug/Test generation delegates the actual api/runtime
  entry and requires the Entry's single-coordinate dependency declaration.
  Writes bind that declaration to R2 review; source guards hash bounded current
  Profile/entry/manifest/dependency bytes and require actual debug Build Mode
  for both Debug and Test. Runtime Profiles remain application declarations.
  Configured probes reject without their compiler producer; release-core remains
  unavailable. The module Hvigor guard refuses wrong mode and unverified
  Release; no bypass switch exists. Empty manifests never certify compiler/final
  artifact purity. Generated standalone tools/doctor, generate-integration and
  verify-release share CLI source; the HAR explicitly packs tools/** outside
  application resources. Helpers never apply patches or invoke producers.
  Doctor reads bounded consumer SDK/API, dependency, Profile, manifest/entry and
  generated guard declarations; unknown minimum API and actual Hvigor execution
  remain gaps. Test manifests require debug Build Mode. Release facts produce
  hash-bound JSON/SARIF/escaped HTML, preserving package hashes, manifest-declared
  toolchain version and an unverified Core-only baseline. Helpers render selected
  formats without default report writes; CLI stores formats as private evidence.
  Generation stays preview-only; Release verification keeps fourteen evidence
  gates and does not establish final purity. Source lexical coverage failures
  keep each affected gate incomplete while explicit package-byte checks continue.
  No OHPM publication is implied.
- `kit/ohmatekit` is a separate single-coordinate OHPM source package, outside
  the five Node workspaces. Its portable `api/core` exports a bounded OHMateCore
  with an explicit CoreHost; it is not ProducerController or a desktop bridge.
  Registered enum/number/boolean fields only; Critical is never sampled.
  Pending native batches and ring records share the same limits. Close timeout
  retains pending ownership and remains uncertain after late settlement.
  Startup disposal rejects late effects and timer revival. Checksummed recovery
  validates structure, order and registered fields; unknown schemas reject data.
  Build declarations remain unverified, and problem summaries are manual-only.
  Context start and the sandbox host use async owned I/O, file locks, checksummed
  recovery and derived atomic indexes. Uncertain writes retain quota; disposal
  bounds waiting without releasing pending native ownership. Explicit seven-day
  pruning coordinates partial deletions with Core problem/review accounting.
  Uncertain deletion suspends export while retaining reservations for explicit
  retry. Root index, lock, session manifests and staging participate in storage
  accounting; session manifests are derived from segments, not exit evidence.
  Derived metadata 1.1 groups root-index files by directory and uses local names
  in session manifests. Valid legacy 1.0 metadata is rebuilt from the same
  checksummed segments; metadata contents never authorize recovery reads.
  New publications preflight the global segment/problem/session limits, reserve
  one recovery staging slot and bound derived metadata to 32 KiB. Pending records
  participate in restart-index budgets; metadata may exhaust capacity before
  record counts. Explicit retries reconcile only their original staging paths.
  Core extends its newest segment only through the optional
  `CoreHost.extendSegment`, which accepts an exact stored event prefix of the
  same session and atomically replaces that file within 1024 events/512 KiB;
  plain append never rewrites a segment and no committed event is removed.
  Idle heartbeat maintenance scans at most once per idle minute, outside fault
  paths. Missing FileIO/Time/CryptoFramework SysCaps reject sandbox initialization;
  API26 reports the CryptoFramework umbrella while Md may be false.
  Clock ordering uses a precise session delta, not an authenticated boot identity.
  Invalid startup clocks and unsafe nanosecond session deltas reject.
  Core ZIP review binds the final stored ZIP bytes through mandatory hashBytes;
  export revalidates registered fields and returns a defensive byte copy.
  Core readonly minor compatibility preserves canonical constraints and refuses
  private or authentication claims before omission. Debug api/debug composes
  this actual Core and readonly Providers with explicit application window
  Adapters; construction/start do not acquire windows. Window effects have
  exclusive native ownership, bounded waits and lifetime quotas. Cancellation
  waits for the original native operation before detach; failed/late cleanup
  only retries explicitly, including after disposal. Clock drift permanently
  closes UI grants. Host acceptance never proves actual paint or build identity.
  The explicit HarmonyDebugWindowHost binds only its caller's UIContext name/ID
  and creates current-window overlay/HDS V2 panel on demand. Stable native
  listeners, ComponentContent and dialogs retain cleanup responsibility after
  partial failure or late completion. Its bounded 48vp button geometry hides
  invalid/blocked positions and preserves only normalized per-host placement.
  Drag cancellation restores the original placement. A controlled standard Menu
  accepts long-press/right-click/menu-key requests and only pause/resume/mark/hide
  actions, rechecking visible/geometry/busy state. Requested or late menus retain
  their original floating node until native disappearance; callbacks never retry
  cleanup. Explicit per-window configuration updates use original scoped nodes,
  share the 256-effect budget, and retain native responsibility across reentrant
  cancellation. Neither configuration calls nor key dispatch prove device UX.
  Runtime optional stable positionKey selects a bounded Preferences XML table
  of normalized side/ratio by logical window, orientation and size bucket.
  Missing keys remain memory-only; conflicting keys reject before effects.
  One private cache holds at most 32 keys/27 buckets each and less than 64 KiB;
  its 256 lifetime attempts include failed reads/writes. Cancelled drags never
  save; resize/background/revocation discard late reads and older retry grants.
  Failed flush retains the original proposal for explicit retry; pending or failed
  cache removal retains ownership until dispose retry. No raw window identity,
  trajectory, configuration or user data is persisted. XML/shim acceptance is not
  device durability or multiprocess safety; test:kit:position runs the actual ETS.
  Private shim tests do not prove paint, input, focus, themes or device UX.
  Public api/runtime composes the existing default singleton through the sole
  internal ContextCoreOwner, preserving the Core dependency direction. Explicit
  Debug/Test Profiles never authenticate compiler/build identity; start does not
  find a window. Rejected context/options do not reserve Profiles; conflicts are
  inert, and late cancelled
  startup cannot create Debug owners. Current-window attach binds Core controls,
  problem creation and panel/floating actions to only the live model. Background
  synchronizes cached visibility, cancels pending UI waits and closes the original
  surfaces only after their effects settle. Destruction unbinds actions first;
  native cleanup completion releases the old UIContext, allowing a fresh same-ID
  owner within the original lifetime quota. Failed cleanup retries only explicitly.
  ProblemPanelModel displays only bounded counts/triage and file/field names.
  Export and deletion use separate current-window confirmations with a 30-second
  lifetime. Archive saves recheck the same Core ZIP hash before native effects;
  cancellation/background/close/configuration failure/disposal revoke the grant.
  Original pending Picker/file/deletion responsibility blocks window release;
  retryArchiveSaveCleanup requires an explicit retained window ID and only closes
  its original owner. Uncertain deletion preserves capacity and its retry target.
  Saved or partial user files are never deleted by cancellation or problem removal.
  Captured callbacks from released slots cannot act on a fresh same-ID owner.
  scripts/kit-context-runtime-tests.mjs checks real portable ETS with private
  file/SDK hosts; it does not establish paint or physical platform behavior.
  Generated integration and build helpers do not certify compiler-bound profiles,
  final Release artifacts or physical durability.
  Test api/test exposes local readonly READY/ASSERT observations through the
  same ProviderRegistry wait/ownership model. Only an explicit Test Profile and
  application Adapter with up to 32 test.assert.* identifiers may read; missing
  Adapters return unavailable. Results remain adapter-reported/unverified-build,
  manual-only with automation unavailable. No action, Test HAP transport,
  authenticated build or remote replay is inferred from an assertion.
  The separate providers/index.ets entry supplies readonly SummaryProvider
  contracts and a default-closed Release registry. Debug/Test is an explicit
  application declaration, not compiler/capture authentication. Registration
  never reads; capture projects registered fields, excludes raw status values
  and binds lifetime ownership to 32 IDs/unique Adapters and 256 reads per ID.
  Timeout/cancel retains native responsibility; failed or late cleanup retries
  only explicitly, including after disposal. Clock drift permanently revokes
  capture without resetting quotas. No Core import points back into Providers,
  and no remote write or automatic collector is enabled.
  Portable ETS tests run through scripts/kit-public-core-tests.mjs and must also
  prove all timer owners are disposed. scripts/kit-platform-host-tests.mjs uses
  private actual Node files with SDK shims; it is not device/performance evidence.
- The independent reference LeakWatcherHost stays on the original main VM;
  exclusive host configure is inert, then separate review/confirm/start gate
  API26/Phone/debug/SysCaps. Watch retains no object and uses a fixed label;
  check retains only empty/nonempty API status, never a diagnosis or raw list.
  Component monitoring is narrow CustomComponent with explicit 90-second
  interval and one platform dump; require separate raw-file consent.
  Callback observes only array shape, never paths. Thirty-second review,
  ten-minute run, lifetime 256 reviews/32 object attempts/3 checks; errors count.
  Stop cannot reset quotas or certify file removal. Failed or wrong-thread
  cleanup retains exact ownership for explicit retry. Invalid clock permanently
  closes grants. Ability startup configures only and exits stop; no Core/Bridge/
  Agent/frame/ZIP coupling. Real Phone, GC/file cleanup and Release unverified.
- Independent RawHeapHost is default closed and requires an application-owned
  exclusive non-main Worker and explicit RawHeapFiles, not a transient TaskPool.
  Configure/review('process')/confirm/collect are separate. Require raw-file and
  Developer-options acknowledgments; do not query or enable Developer options.
  API26/Phone/debug/SysCaps gate dumpJsRawHeapData(false,false,true); its process
  request never substitutes a worker-only two-argument dump for main-VM capture.
  Do not request GC, trimming changes or cache release. Each Worker VM owns at
  most one attempt and 256 reviews; errors count. This does not discover other
  VM collectors. prepare owns partial/unreported outputs before effects; adopt
  receives at most 16 paths/16384 characters without authenticating ownership.
  SDK cannot select an output directory; no general sandbox reader/remover exists.
  Explicit file host processes locally with bounds and cleans immediately.
  Thirty-second review/wait includes prepare/native/process/cleanup. Cancel,
  timeout or drift ends waiting while keeping pending owners; late outputs go
  only to original cleanup. Failed cleanup retries only explicitly with another
  bounded wait, never another capture. Wrong-thread cleanup retains responsibility.
  Host cleanup true is host-reported-clean, not physical erasure or cache release.
  No page/default Worker/default file host/Core/Bridge/Agent/frame/ZIP integration.
  entry buildOptionSet debug sourceOption.workers explicitly compiles RawHeapHost;
  this does not start a Worker and release has no such declaration.
  Native VM/file/developer/performance/Release behavior remains unverified.
- Public entry is `@ohmate/ohmatecli` / `ohmatecli`. Product packages use the
  `@ohmate` scope. Keep Huawei copyright and MIT attribution.
- Runtime services must be importable without parsing argv, changing cwd,
  exiting, starting timers, migrating Skills or querying update services.
  Startup must not load command-only libraries: the Windows registry client,
  archive readers, the socket transport and the stdio MCP server stay behind
  dynamic imports or a separate bundle entry. `runtime/startup-imports.test.ts`
  checks the source graph; the private bundle-attribution harness checks the
  built worker, because non-external dynamic imports can still be hoisted.
- CLI, Web and Agent use the same registry, context, task store and receipts.
  Unmigrated commands run in an isolated child with `shell: false`.
- `ui`, `debug start` and compatibility `devtools serve` share one owned
  workbench and persistent DebugSession. Lifecycle aliases stay out of Agent
  tools and background tasks. The public read-only protocol is separate from
  task SSE. Loopback pairing uses one-time invitations and Node crypto AEAD;
  acknowledge device events only after private, bounded, redacted persistence.
  DOM/Storage/Console/UI text remains memory-only by default. No LAN, plaintext
  payload fallback or automatically restored authentication. Peer-asserted device
  fields and unverified builds never prove actual Kit capture or authorize writes.
  Runtime WriteSession owns application-local consent only, not peer admission.
  Reviews bind one command, scope, target, payload/plan hashes, identity and epoch.
  Keep 256 command tombstones and a ten-minute maximum TTL; never evict a receipt
  to permit re-execution. Register rollback before temporary effects, invalidate
  before waiting for native completion, and retry failed cleanup only explicitly.
  Runtime WriteSession observes clocks on status, receipts, review, confirm,
  apply (including duplicates) and completion. Backward/non-safe-integer readings
  permanently revoke its consent without replacing the last valid time. Invalid
  construction starts revoked. Queries observe command/session deadlines before
  timer delivery; expired native work keeps its owner until settlement. Polling
  never retries failed cleanup, and duplicate commands retain their receipt.
  Console abort is cooperative and does not
  prove script preemption. Preserve only the exact bounded native Console
  category/page-or-script/line summary; URLs, text, frame claims and appended
  data remain memory-only. The application-local Console owner is default
  closed, individually reviewed/confirmed/executed and single use. It retains
  native ownership after timeout/cancel, limits code/results and review/rate
  budgets, clears old DOM/export snapshots before effects and never stores
  code/results/command receipts in frames or ZIPs. Console and NetworkBodyCapture
  reject backward or non-safe-integer clocks without replacing the last valid
  reading. They cancel current consent and pending tickets; valid-clock recovery
  permits only a fresh review and independent confirmation, never old-plan revival.
  Body re-confirmation cannot renew TTL or reset capture quotas; Console duplicate
  execution cannot dispatch another native call. The protocol descriptor leaves every remote write
  scope unavailable; local consent never upgrades device/build authentication.
  The registered incognito Web Storage read keeps only URL-related nonpartitioned
  Cookie counts and a fixed mask, without names, values or attributes. It checks
  source/debug/identity/revision, uses 4 KiB UTF-8/64 pairs, one read per second
  and 256 attempts including failures per owner. Thirty-second memory expiry
  starts at dispatch and cannot exceed the connection deadline. Clock rollback
  permanently invalidates the owner; native timeout/cancel retains the shared
  Web lock until settlement. Console effects clear earlier Storage metadata.
  Keep local/session storage default closed. A host-explicit ControlledStorageAccess
  may allow only at most 16 distinct ordinary ohmate-test- keys on the registered
  incognito page. The fixed getItem script uses runJavaScriptExt, checks the exact
  source and current host permission, and shares Cookie attempt/rate/expiry/native
  ownership. Bound the whole projection to 4 KiB UTF-8 and each value to 1024
  characters; absent and empty values remain distinct. Raw values live only in
  private capture memory for at most thirty seconds, with no public raw getter,
  state, frame, journal or ZIP. Revocation clears references, not proof of physical
  erasure. The page permission can be enabled before pairing, closed at any time
  and resets on stop; no automatic writes, seeds or re-enablement. Do not use
  global WebStorage enumeration, quota or deletion as evidence of instance-local storage.
  Reading alone keeps
  metadata in app memory. One explicit publish per current read sends only the
  count and exact fixed scope summary through the shared sequence/ACK owner.
  Its latest successfully sent record may enter arkweb.jsonl only after app
  export review; cancellation, replacement, expiry and source drift revoke
  unsaved exports, including pending Picker selection. Never renew the dispatch
  deadline on send or restore late send completions. Clearing app metadata does
  not retract desktop history or user-owned saved files. Report the API source
  as peer-reported only; no remote write admission or capture authentication.
  The application Storage R3 core reviews a single captured allowlisted key,
  binding original/payload hashes, source, identity/epoch, generation, capture
  and deadline. Fixed compare/mutate/verify scripts and conditional restoration
  follow the WriteSession contract; recovery is registered before native effects.
  Timeout/cancel retains native ownership and pending recovery. Failed recovery
  retries only explicitly; its private originals expire at the original capture
  deadline without clearing unresolved responsibility. In-flight application
  mutation fields clear too; native scripts and physical erasure remain unverified.
  Source drift permanently revokes recovery; returning bindings cannot revive it.
  Producer stop disposes the Storage grant before asynchronous close. Retained
  storage responsibility reports cleanup-failed/STORAGE_RESTORE_REQUIRED after
  transport closes; repeated stop and late native settlement cannot certify
  recovery or dispatch into a destroyed source.
  A timed-out restore cannot certify late effects and requires explicit retry.
  Separate V2 page controls review, confirm, execute, cancel and retry two ordinary
  test keys with fixed marker/empty/removal choices. Persistent recovery state
  survives disconnection; real Phone behavior and packaging evidence are recorded
  separately from substituted tests. The application-local UI highlight owner
  defaults closed without an explicit host. It binds the fixed current-window
  description subtree's unique-ID ancestry, identity/epoch/generation and deadline
  to one R2 command; geometry validates presence but does not authenticate paint.
  Independent review/confirm/execute/cancel/retry, 256 attempts and persistent
  tombstones, one execution per second, thirty-second review and three-second
  outline apply. Register cleanup before host effects, inspect source/expiry every
  250 ms and on status, and invalidate permanently on source or clock drift.
  Clear only the exact command; failed cleanup retains the host/responsibility
  across disconnection, blocks pairing and retries only explicitly. Effects revoke
  old UI/screenshot and unsaved export snapshots. The V2 page changes only a fixed
  two-vp outline's semantic color; it does not alter text, focus or touch handling.
  Host state acceptance, substituted tests and HAP compilation are separate from
  actual UI rendering. Semantic replay plans validate bounded offline scripts
  separately from the archive, bind their raw hashes and leave all steps manual
  without an application Adapter and local compiled build evidence. Never infer
  actions from event text. Ordinary action/data/assertion references use test
  namespaces; system steps are manual and sensitive operations are rejected.
  The local SemanticReplaySession binds one R3 step, source/build/identity/window,
  descriptor and payload hashes, a thirty-second review, one-Hz dispatch and
  256 persistent tombstones. Each action and assertion share a three-second
  maximum wait. Recovery is registered before preparation; cancellation/timeout
  stops waiting without releasing pending host ownership. Failed or uncertain
  recovery needs explicit retry, while observed source drift permanently forbids
  wrong-source restoration. Disposal retains the exact host until responsibility
  resolves. Effects revoke UI/DOM/Storage/screenshot and unsaved exports, and
  unresolved responsibility blocks capture, registration and pairing. The
  example build remains unverified and its fixed V2 marker Adapter is manual-only.
  Latest command/assertion/recovery metadata stays in memory; no raw input,
  host result, exception text, write frames or replay ZIPs. All remote write scopes stay
  unavailable. Cookie publication cannot relabel controlled-page counts as its
  fixed uncaptured-range metadata. Mock validation/planning are offline, exact-match and bounded; never include
  response bodies or headers in receipts. The local NetworkMockTable verifies
  raw payload/plan hashes and table revision, preserves rollback responsibility
  on owner conflicts and never revives aborted, expired or clock-invalidated
  owners. It does not perform HTTP. Remote apply/revoke remain blocked, and
  remote status keeps active/hits unknown. Keep every mock.* tool outside Agent
  and persisted tasks. Unavailable remote controls must not write approval plans
  containing their raw payloads. Deterministic templates expand only explicit
  test-namespaced string variables once; no request/environment/file lookup or
  evaluation. Reject malformed/missing/unused variables and invalid UTF-8.
  Bound templates to 16 KiB, 16 variables/2 KiB each, 64 references, rendered bodies
  to 64 KiB and the whole rendered table to 256 KiB. HEAD must render empty.
  Plans bind response and rendered-body hashes without copying text to receipts.
  The local ArkTS Adapter follows the same format and consent/cancellation bounds;
  its fixed page probe checks the exact output. NetworkMock and WebResourceOverride
  permanently close their current owner after observing backward or non-safe-integer
  clocks. Cancel, clock recovery and fresh review cannot reset this state; normal
  expiry/cancel still allow a new review while the clock remains valid.
  Network Mock file/chunk/stream
  remain absent. Web resource registration separately supports host-declared
  packaged ohmate-resources/ css/txt files, at most 32/64 KiB each/256 KiB total.
  Check raw descriptor offset/length before bounded reads, canonical UTF-8 and
  the explicit byte hash before registering memory text. Close via the exact
  ResourceManager name; failed close retains responsibility and blocks pairing,
  with retry only on explicit stop. No general filesystem or remote resource read.
  Scheme streaming requires the host's exclusive ownership of a dedicated Web
  instance because clearWebSchemeHandler clears all handlers on that instance.
  Only exact GET URL, current frame URL, no-referrer, STYLE_SHEET/XHR, no request
  body stream and allowlisted header names may dispatch. SDK redirect information
  is absent; keep redirect-unverified. Existing non-owned hosts keep one-shot
  response behavior. At most four buffered requests, 4 KiB chunks and the shared
  response quotas; overflow invalidates consent and fails the selected request.
  Native buffer references survive finish/abort/clear until exact request-stop
  and all reentrant native calls return. Cancel stops future chunks without
  certifying native completion. Failed abort/handler clear retains exact owners
  across background and blocks registration/pairing; retry only explicitly.
  Responses, file names and raw bodies stay out of state/frames/journals/ZIPs.
  SDK signatures and substituted tests do not authenticate ArkWeb behavior,
  native request object identity, physical buffer erasure or device/build.
  Event journals require a synced independent checkpoint before ack and reject
  missing tails or uncommitted records. Owned worker reuse requires the current
  code/assets/protocol/Node fingerprint; explicit stop remains available on drift.
  Workspace fingerprints read in groups of at most four, retain all sibling
  read/close owners on failure, and hash results in the original traversal order.
  Keep full byte revalidation, content limits and private-path exclusions;
  previous digests and file metadata never replace the current scan.
  Encrypted events-v1 opt-in supports at most 64 events within the negotiated
  frame budget. Manifest 1.3 segments preserve legacy reads, whole-batch quota
  preflight, synced checkpoints and cumulative ack. Explicit events-v1 +
  rolling-v1 selects manifest 1.4 for bounded suffix retention, original absolute
  positions, committed anchors and exact gaps. Resume requires the same opt-in;
  never convert old archives. Prefix eviction invalidates export approval.
  Rolling retention does not prove sustained throughput or real Kit capture.
  Journal query caches must reread and hash all file bytes and recheck the commit
  anchor before reusing validated prefixes; metadata alone never proves integrity.
  Safe file reads run in groups of at most four; simultaneous byte budgets must
  fit the remaining journal quota, shrinking the group when necessary. Await all
  sibling reads and closes before rejecting or releasing the stream lock.
  Bound decoded cached records/bytes/streams, discard failed partial validation,
  and return defensive copies. Cache eviction must not remove disk evidence.
  `debug pair` uses a private sink only in human mode with input/output TTYs;
  never pass invitations through receipts, tasks, Agent tools or argv. An
  explicit `debug start --dev-auto-pair` development switch serves the same
  short-lived one-time invitation over loopback (`/dev-invitation`) so a
  developer phone can fetch and auto-confirm it; the endpoint is default-off,
  loopback-only, never registered in production/Release guidance, and still
  requires the one-time proof and AEAD channel. In that mode only, a peer that
  appends its own Origin value may be accepted when the header list contains
  the exact workbench Origin. This is unauthenticated local admission, not
  device/build attestation, and must stay out of Agent tools and tasks. Coordinate
  journal reads with writes through the per-stream lock. Local contenders take
  FIFO turns before the cross-process disk lock; the five-second budget includes
  queue time, and failed or timed-out turns cannot bypass a still-held owner.
  Web event SSE is separate
  from task SSE and never restores device authentication.
  Owned bridge commits wake scoped SSE only after checkpoint and status persistence;
  subscribe before reading and retain one wake flag without event payload queues.
  Page writes preserve individual SSE IDs and wait for drain or cancellation.
  Keep the one-second external-write/integrity recheck and close subscriptions on
  initial-read failure, disconnect, cancellation, stream replacement and shutdown.
  The Web debug list validates each SSE cursor immediately and retains at most
  100 records with one pending animation frame. Track the last DOM-rendered
  sequence; flush accepted records before bounded eviction, retention or a gap
  removes unseen rows. Do not add another event buffer. Pause, fault and end flush accepted
  records before displaying terminal status; refresh, selection, paging and view
  closure cancel old frames. DOM timing or a next-frame callback does not prove
  physical display paint, sustained GA load or actual Kit capture.
  Opt-in clock probes use encrypted four-timestamp measurements with explicit
  quantization, drift assumptions, expiry and per-record evidence. Recompute
  mappings when reading journals or problem packages. Legacy mergeable flags
  do not prove calibration; never reuse alignment across connection epochs.
  Optional HDC forwarding requires an exact connected serial and a newly observed
  device-to-host reverse rule. The worker owns expiry/revoke/disconnect/stop
  cleanup and persists release status before ending the session. Retain incomplete
  acquisition owners and failed cleanup for explicit revocation; never claim
  existing or changed rules. HDC table matching is unverified transport evidence,
  not an ownership token or actual device/build authentication.
- Offline Kit readonly profile 1.4 validates only provided nonempty domain
  records; missing domains stay not-captured. Reuse realtime summary schemas
  and redaction, distinguish structural metadata from summaries and attachments.
  Source assertions remain peer-reported; platform-api declarations name the
  collecting API, and SDK/reference catalogs never count as captured evidence.
  Inert faultlog text and PNG/JPEG attachments require an explicit-export review
  declaration, which is not authenticated consent or automatic redaction proof.
  Stream all attachment bytes through CRC/length/hash verification without
  collecting their content. Retain the original ZIP quotas and reject executable,
  link, traversal and role-conflicting inputs. The default desktop summary export
  does not synthesize Kit files or include attachments.
  Kit JSONL construction/import share the 32 MiB budget. Domain/file pages
  follow profile file order with exclusive ordinals, returning at most 256
  records and 48 KiB of record JSON only after full-package validation.
  Attachments stay metadata-only; do not cache another complete Kit record set.
  The existing Kit contract generator embeds current public problem schemas
  and domain paths into the real example application. Never hand-edit generated
  ETS or rawfile resources. Its local latest-PSS file is memory-only, sampled,
  revocable and peer-reported; a platform API declaration or Node substitute
  does not authenticate capture, and a sent record does not prove a persisted ack.
- Native `scan` and `docs generate/check` resolve official producers through
  ToolProvider. Preserve raw reports, original exits and input hashes; missing
  coverage and source drift must prevent certification. Never evaluate the
  scripts embedded in official documentation output.
  Public export and callable identities use the discovered SDK compiler frontend.
  Preserve its package/script hashes, CompilerHost reads and module resolutions;
  an export Program is not evidence of the actual build input closure.
- Default `build` and `build run` share native execution. Keep upstream build
  flags and argv-shaped callers; only the default entry installs on required
  sync. Explicit and resolved implicit signing selections require R3. Temporary signing
  changes retain reference-only journals and exact-hash restoration; never store
  signing material. Quickfix-cache removal needs a reviewed Diff and recoverable
  original bytes. Publish without overwriting concurrent destinations and retain
  displaced originals until successful recovery. New or unreadable compiler
  inputs prevent certification.
  Installed compiler candidates and post-build loader declarations remain
  partial evidence. Preserve unknown es2abc version, unverified final configuration,
  input roles, source-map dependencies and unchanged-loader status explicitly.
  Root and declared module OHPM installed inventories bind approval and record
  precompile byte hashes, including safe aliases into hidden stores. Recheck
  additions, removals, drift and unavailable inputs after tools close. Keep
  inventory-only separate from actual compiler reads; its bounded snapshot
  does not certify final configuration, cache reuse or a complete buildId.
  Private official builds observe actual job.run configuration allowlist fields,
  SDK Hosts, module resolution and readFileSync/readFile/Promise reads. Retain observed custom
  loader paths, absent probes and changed/unreadable inputs. Generated cache
  reads and build-info transitions stay cache-unverified; internal/native and other stream
  reads and full configuration remain incomplete. Observed promises.open handles
  may bind complete readFile returns only through matching descriptor/path
  device, inode, size and timestamps before and after the read. Keep partial
  returns and encoded text separate; no substitute reads or inferred handle origin.
  A handle passed to promises.readFile without an observed open remains unbound.
  Preserve original failures and close-time attribution. Direct preexisting or
  unwrappable handle methods and other descriptor operations remain coverage gaps.
  Observe complete fs.createReadStream and observed FileHandle.createReadStream
  raw chunks through their existing queue and dispatch, without attaching
  data/readable consumers. Incremental hashes precede decoding/caller mutation;
  only original read/end, matching descriptor/path identity and whole-file size
  admit a file fingerprint. Keep partial ranges/current-position reads, pre-read
  injected chunks/EOF, cancellation, budget/type failures, replacement and
  mid-read writes unbound. An observed FileHandle fd uses its open origin and
  ignores the supplied path. Numeric fd, custom/accessor I/O and unwrappable
  streams remain gaps. Preserve original backpressure, errors, autoClose/emitClose
  and cutoff at invocation close; no chunk copies or substitute filesystem reads.
  Never equate official build
  invocation IDs or these partial observations with the product buildId.
  Native observations wrap the SDK ModuleMode es2abc shell-call boundary only.
  Bind allowlisted pre-dispatch configuration, bounded command hash/count,
  declared file/cache/context/output references and the matching exec return,
  PID and close event to the initiating job. Keep command text, arbitrary argv,
  native output and configuration bodies out of these records. At most 64 calls/
  256 KiB and 256 arguments/64 KiB command bytes share the observation quota.
  Preserve SDK and ChildProcess returns/errors/event dispatch; reject mismatches,
  duplicate dispatch, accessors, unsafe references and unavailable hooks.
  Job close seals pending native events; late close never repairs evidence or
  enters another invocation. This is sdk-call-reference-only, not proof of the
  shell's executable identity, native reads, final bytes, cache origins or buildId.
  Native description records observe only synchronous writes within four SDK
  generation methods. Hash UTF-8/Buffer inputs before writing, keep write/method
  outcomes and opaque owner/order, and link only the latest single successful
  same-job/same-receiver/same-path generation to nativeCalls. Reserve 64 records
  before nested calls complete, 256 KiB metadata, 8 MiB per input and 16 MiB
  cumulative fingerprint bytes within the shared quota. No bodies or substitute
  reads. Failed/duplicate writes, unknown encodings, accessors and locked hooks
  remain gaps. Close prevents late attribution; cross-job receiver reuse cannot
  revive old evidence. sdk-write-call-only does not certify persistence,
  dispatch-time bytes, actual native reads or cache origins.
  Generated input provenance wraps only SDK writeFileContentToTempDir and
  writeFileSyncByNode. Retain the permitted source argument (or own AST fileName),
  destination, pre-write UTF-8/Buffer hash/size, operation/generation identity,
  write/method outcome and shared observation/settlement order. Preserve original
  Promise identity, returns and errors. Reserve at most 512 attempts/writes,
  512 KiB metadata, 8 MiB per input and 16 MiB total within the shared quota.
  files-info/cache-info inputReferences hash non-path fields and retain permitted
  module/bytecode/cache-pair declarations; at most 512 rows per description and
  256 KiB total reference metadata. Only the latest single successful same-job
  destination write completed before the description may link a source sequence;
  old Promise settlement, duplicate/failed/no-write retries and unsafe/unobservable
  attempts cannot revive it. Bytecode rows and cache outputs remain declarations.
  No bodies or substitute reads; close seals pending generation. The binding
  sdk-source-write-call-only certifies neither disk durability nor native reads.
  Cache-pair sourceDescriptionSequence links only the latest completed single
  successful same-job/same-receiver/same-input npm-entries description and is
  mutually exclusive with sourceWriteSequence. Failed, duplicate, no-write,
  nested late completion or later destination replacement cannot revive the
  origin; unknown and over-budget writes invalidate it too. Unobservable source
  arguments or destination properties revoke prior description destination
  bindings. Keep the origin
  sdk-write-call-only and proto output declaration separate from cache hits,
  persistence or native reads.
  Record merged SDK input/output, actual Rollup input and Ark-derived returns as
  separate allowlisted scalar snapshots, bound to their job configuration.
  Do not evaluate getters or copy nested configuration. Preserve original returns
  and failures; absent or uninstrumentable stages cannot certify full configuration.
  Bound each job to 64 stages/256 KiB within the shared observation quota.
  Async reads belong to their initiating job.run context. Hash returned bytes
  before caller mutation, preserve callback arguments and original failures,
  and resolve relative paths/file URLs at initiation. Pending reads at close
  leave a coverage gap; closed contexts cannot contaminate later invocations.
  Watch setup and Rollup-lite Task rounds have independent contexts. Retain
  session/round, configuration index, actual events and reported changed/reused paths.
  Reject mixed PID/configuration identities within a Watch session.
  Close immediately ends active read attribution; reject lifecycle gaps and unsafe paths.
  Preserve original Promises, failures and event dispatch when observing rounds,
  including uninstrumentable exports and non-writable emitters. A thrown close
  remains a coverage gap even after the Task sets its closed flag. Bound journal creation to 64 files.
  Reported reuse remains unverified; Task.close return is separate from process exit
  and does not certify complete ArkTS Watch or memory/filesystem cache integrity.
  Cache observations keep per-invocation opaque object/module identities and raw
  read fingerprints separate from decoded text. Bind a file module only through
  the observed Unpackr return and its unchanged input Buffer; old reads do not
  establish a new store load. Keep original cache/Rollup returns, Promises and
  failures, bound events and module references to the shared quota, and cut off
  pending cache callbacks at close. Store set/persist returns are observed calls,
  not proof of acceptance or durable writes. Object identity and Rollup input/output
  do not certify complete cache origins, transformed bytes or buildId.
  SDK `.tsbuildinfo`, `.tsbuildinfo.linter`, `.ts_checker_cache` and
  `.ts_checker_cache_widget` qualify as compiler cache transitions only at the
  exact parent of the observed cachePath. Preserve read/after hashes and absent
  probes as cache-unverified; same-named files elsewhere still report source drift.
  Host text and ScriptSnapshot hashes stay separate from raw filesystem bytes;
  BOM decoding and preprocessing never replace source hashes. Rewrap Watch Hosts
  before actual use after SDK method replacement. Cached/decoded returns without
  observed raw bytes remain coverage gaps, with no substitute file reads.
  Output paths come from observed Hvigor module-target/product path methods.
  Collect only direct artifacts in each output directory; do not attribute
  child-directory APP files or traverse product symbol subtrees. Artifact and
  output-path symlinks and hardlinked artifact files remain rejected.
  Capture their artifact baseline after task discovery and before compilation;
  a newly observed directory without that baseline stays baseline-unavailable.
  Retain unchanged artifacts as reused-unverified and reject cross-target or
  ambiguous attribution, escaped/sensitive paths, symlinks and unclosed records.
  Bound output observation to 64 files, 128 paths and 4 MiB, and scans to 10000
  entries. Paths remain observed-partial, with full output layout unverified.
  Persist synchronous path returns before Hvigor can terminate its workers;
  method completion is separate from the executor's process-close evidence.
- Telemetry is off by default. Upstream auto-update, recalled-version gates
  and implicit global Skill migration are not product startup requirements.
- OHMate writes only requested project changes or its own data directory.
  Never read the user's credentials or operate existing devices in tests.
- Tests use private canonical temporary roots. On macOS run with
  `TMPDIR=/private/tmp`; `/var` versus `/private/var` breaks upstream
  path-sensitive fault injection. Do not weaken those assertions.
- Read-only project inspection and dependencies discover bounded ArkTS, Cloud
  and Native facets with raw input hashes. Cloud uses explicit function-config.json
  handler metadata plus one same-directory ts/js source, or declared server-SDK/main
  sources. Keep unsupported handler/type values, ambiguous entries and absent
  sources unresolved; do not read cloud account configuration or certify exports,
  compilation, runtime or deployment. Native declarations need referenced inputs.
  Conditional/dynamic CMake and missing evidence stay unverified. Keep facet
  completeness separate from dependency-inventory completeness. Neither grants
  strict ArkTS build/config/release preflight. Referenced local binary components
  retain raw hashes and bounded ELF metadata from the same safe read. ABI hints,
  GNU BuildID and stripped metadata never establish ABI compatibility, compiled
  artifact ownership or device/build authentication. Unresolved configuration,
  unavailable metadata and uninspected archive members remain explicit gaps;
  SBOM binary checksums must hash library bytes rather than CMake declarations.
  GNU/BSD ordinary archives keep ordered member byte ranges, raw hashes and
  ELF declarations with at most 256 members, a 64 KiB GNU name table and
  256-byte names. Names never authorize external reads. Thin, malformed,
  unsupported or nonrelocatable members and unknown machines stay incomplete.
  Symbol/name table ranges and hashes do not validate their internal references.
  Do not invent member dependency nodes, ABI compatibility or linker selection.
  Incoming why chains preserve recorded order and evidence. Limit total admitted
  states to 2000 including initial matches, results to 100 chains and depth to
  32 edges before allocation or insertion. Never treat unexplored parents as
  roots; truncated explanations remain separate from inventory completeness.
- Offline JS heap analysis admits only the validated seven-field V8 JSON layout
  subset. Bound two explicit snapshots to 32 MiB each/64 MiB total, 250000 nodes,
  1000000 edges, 250000 strings/16 MiB string bytes and 50000 groups per snapshot.
  Reject malformed/unknown layouts, indices, versions, secret-named files and
  links before publishing analysis. Keep raw input hashes, declared nonweak
  reachability and aggregate counts/self bytes; shortcut edges are excluded too.
  Group names are hashes, not raw strings. Each group representative keeps at
  most 16 path nodes with explicit truncation. Reports over 1 MiB retain all
  groups in the bounded 64 MiB artifact, while task receipts project numeric
  summaries and its hash. Input order and local IDs never authenticate capture
  time, cross-snapshot objects, device or build. Retained size/leak diagnosis,
  Ark capture, rawheap conversion, Native association and other snapshot sections
  remain unverified; exit 3 and registration do not certify the full M4 contract.
- Offline GC analysis reads one explicit public UTF-8 log/txt and supports only
  the OpenHarmony 5.0.3 ArkCompiler GC summary subset. Keep exact local/shared
  types, known reasons, printed used/committed MiB and separate total/concurrent
  duration fields. Reject unsupported/malformed summaries and numeric fields,
  underflow, invalid UTF-8/BOM, secret names, links and exceeded limits without
  partial reports. Bound input/report to 16 MiB, lines to 100000/16 KiB each and
  events to 10000. Preserve raw file/line hashes and byte ranges, not log text.
  Above 1 MiB keep full events in the artifact and only summaries/hash references
  in receipts. Never infer VM identity, frequency, allocation rate or verbose
  event association from file order. Allocation reasons give single-feature
  candidates only; OOM, leak, root cause, runtime/device/build and actual capture
  remain unverified. Official examples and synthetic budgets are separate evidence.
- Offline FD analysis reads one explicit public UTF-8 log/txt using the FDLeak
  Skill 1.4 documented subset. Require the stock count, bound Top lists to ten,
  stacks to 10000/32 frames each, names to 1024 bytes and input/report to 16 MiB,
  with 100000 lines/16 KiB each. Reject malformed, duplicate, inconsistent or
  truncated declared fields/sections and unsafe inputs before publication.
  Preserve raw file/field/line ranges and hashes; process/time/path/module names
  are hashes only. Ten-minute allocation counts include closed descriptors and
  never certify current leaks. Same declared PID is not capture authentication;
  right-to-left raw frame order is not symbol resolution. Whole-system detail
  sections are presence-only, without record attribution. Above 1 MiB keep all
  stacks in the artifact and only summaries/hash references in receipts.
  Format/runtime version, producer/capture, symbols, root cause and device/build
  remain unverified. Documented Skill examples and budget fixtures do not certify
  actual capture or the full M4 contract; results remain incomplete/exit 3.
- Offline JS Crash analysis requires an explicit public UTF-8 log/txt, known
  Reason/Error name, one-line message and primary JS Stacktrace. Reject unknown
  or conflicting types, source excerpts/multiline messages, Native primary stacks,
  malformed/truncated frames, duplicate/concatenated logs, inconsistent indices,
  unsafe inputs and exceeded budgets. Bound input to 16 MiB, 100000 lines/16 KiB
  each, 256 frames, names to 1024 bytes, fields to 4096 bytes and report to 1 MiB.
  Preserve raw input/field/line ranges and hashes, while message/function/path/
  metadata values remain hashes. Coordinates and frame order are declarations,
  not source or capture identity. Supplementary stacks/HiLog are presence-only.
  Official Fingerprint is a fault clustering hash, never a buildId or SourceMap
  identity. SourceMap, error-code meaning, root cause, ownership, snapshot linkage,
  runtime/device/build remain unverified; single-feature hypotheses and exit 3
  do not establish full M4. Public format examples do not certify capture.
- Offline Native Crash analysis requires one explicit public UTF-8 log/txt,
  a known Reason:Signal envelope, fault-thread section and declaration, and
  contiguous Native frames. Reject unknown signals/codes, mixed JS primary
  frames, GWP-ASan, malformed or duplicate fields/frames/sections, concatenation,
  truncation, multiline Fatal text, unsafe inputs and exceeded budgets.
  Bound input to 16 MiB, 100000 lines/16 KiB each, 256 frames, 1024-byte names,
  4096-byte fields, 64-byte BuildIDs and 1 MiB report. Preserve raw file/field/
  section/thread/frame ranges and hashes; names, paths, functions, Fatal and
  metadata values remain hashes. Raw address/pc/BuildID/signed-offset strings
  avoid Number precision loss; pc may be relative or absolute in the emitter.
  Functions/BuildIDs are declarations, not symbol or artifact authentication.
  Supplementary registers/stacks/maps/files/logs are presence-only. Fingerprint
  is a fault clustering hash. Signal, paths and printed heuristics never establish
  root cause or ownership; retain multiple hypotheses. Symbols/compressed DWARF,
  BuildID association, registers/detectors, runtime/capture/device/build remain
  unverified. Public examples, budgets and exit 3 do not establish full M4.
- Offline Freeze analysis requires an explicit public UTF-8 log/txt, known
  Reason, star-separated event parts, start time/EVENTNAME/TIMESTAMP/PID/UID/MSG
  and contiguous mixed Native/JS thread frames. Main events permit one 3s/6s
  part or 3s then 6s/input timeout. Business events use one part and only its
  declared TID; missing target evidence never falls back to the main PID.
  Reject unknown/legacy events, contradictory main TID or process declarations,
  missing required fields, malformed/duplicate/truncated stacks, unsafe inputs
  and exceeded budgets without a partial report. Keep raw file/field/section/
  thread/frame byte ranges and hashes, with names/messages/times/paths/functions
  hash-only. Preserve raw pc/BuildID/signed offsets and declared JS coordinates.
  Bound input to 16 MiB, 100000 lines/16 KiB each, two parts, 64 threads and
  128 section markers per part, 256 frames per thread/512 total, 1024-byte names,
  4096-byte fields, 64-byte BuildIDs and 1 MiB report. Queues, Binder, resources,
  FFRT, embedded sampling/submitter stacks and HiLog are presence-only.
  Never attribute peer/sampled frames to the target or discover attachments.
  A known resource NOTE is a candidate only. State, identical stacks and
  Fingerprint do not establish blocking, scheduling or cause. System assessment,
  sample/symbol association, responsibility, runtime/capture/device/build remain
  unverified; retain undetermined state and incomplete/exit 3.
- Offline API analysis reads one explicit public UTF-8 log/txt and only E/F
  HiLog lines with one explicit error code/code field. Keep raw file/event byte
  ranges and hashes, numeric PID/TID/code and declared domain; tag/time/message
  are hash-only and other lines count as context, not state or API association.
  Reject ambiguous/malformed codes, unsupported envelopes, mixed faultlogs,
  truncation, invalid UTF-8/BOM, unsafe inputs and exceeded budgets without
  partial publication. Bound input to 16 MiB, 100000 lines/16 KiB each,
  1024 events/1024-byte tags and report to 1 MiB. Optional sdk-module selects
  exactly one @ohos declaration through ToolProvider, with matching SDK/ETS
  package versions and raw hashes. Bound declarations to 4 MiB, metadata to
  16 KiB each and matching BusinessError JSDoc lines to 512. Categories remain
  declaration candidates, not callable binding; unknown messages remain
  unclassified and absent codes unknown. No knowledge-prefix, automatic SDK,
  project, device, attachment or source discovery. Root cause, API/state
  association, responsibility, runtime/capture/device/build remain unverified;
  declared SDK versions do not authenticate the failing runtime. Exit 3 and
  failed/degraded tasks do not establish the full M4 analysis contract.
- Offline Native memory analysis reads an explicit public UTF-8 log/txt sample
  and optional smaps table using the OpenHarmony 5.0.3 emitter subset. Require
  all sample identity/threshold fields and at least three rows. The producer
  appends RSS and PSS+SwapPss to one vector and trims history without per-row
  metric labels. Never assign individual RSS/PSS identities from position.
  Keep declared monotonic seconds separate from hash-only realtime, allow
  same-second rows and reject reversed time. Numeric deltas/direction describe
  only the mixed series, never pure PSS growth, rates or linear/leak
  classification. Smaps has the matching two-line header, ten
  numeric columns, names and Summary; its Summary Pss already includes SwapPss.
  Validate each sum without double counting and use its own total as denominator.
  Exact names give classification candidates only; other names stay unclassified.
  Bound each input to 16 MiB/32 MiB total, 100000 lines/16 KiB each, 1024 records
  per table, 1024-byte names and 1 MiB report. Reject unknown/malformed/duplicate/
  truncated layouts, missing fields/summary, unsafe integers/overflow, links,
  secret paths and invalid UTF-8/BOM without partial publication. Preserve raw
  file/field/row ranges and hashes; process names, map names and realtime are
  hash-only. No directory, companion pickle, device or attachment discovery.
  DMA/GPU remain not-captured; htrace/NMD/native hook, allocation lifetime,
  symbols and cross-input time/address/build association remain not-analyzed.
  Producer source/layout examples are not actual capture. Root cause, leak,
  responsibility and runtime/capture/device/build remain unverified; results
  stay incomplete/exit 3 and persisted tasks failed/degraded.
- Offline UI analysis accepts only the OpenHarmony 5.0.3 Ace window lifecycle
  notifications and six producer context reasons. Release and ui_content_impl.cpp
  debug prefixes retain raw line ranges/hashes; names/time stay hashes, numeric
  IDs and source coordinates are declarations. Reject scoped because the emitter
  prints scope. currentId in [100000,1000000) gives a single-feature candidate
  only; never infer disposal, lifecycle state, causality, layout or rendering.
  Bound input to 16 MiB/100000 lines/16 KiB each, 1024 events, 1024-byte names and
  1 MiB report; reject unknown/malformed/truncated layouts, unsafe numbers,
  invalid UTF-8/BOM, links, secret names and excessive input without partial reports.
- Offline auto triage reads one explicit public log/txt and uses raw markers for
  eight log domains. Validate a sole candidate through its existing parser;
  rejection has no fallback. Multiple candidates keep selection null and manual.
  Bind classification and selected report to the same input hash. Owned private
  temporary derived files must be cleaned before one final report is published.
  Bound input to 16 MiB/100000 lines/16 KiB each, marker references to 32 per
  domain with separate totals, selected report to 16 MiB and final report to
  17 MiB; above 768 KiB return only summary/hash references in receipts. No
  snapshot/SDK/attachment/device/project discovery. Markers, notifications and
  parser acceptance never establish capture, build or runtime authentication,
  cross-domain evidence, root cause or responsibility. Both commands stay
  incomplete/exit 3 and persisted tasks failed/degraded.
- No publishing, pushing, merging or deployment without explicit user approval.

Guidance for AI coding assistants working in this repo.

## What this repo is

OHMate is a five-package Node workspace: `cli` (`@ohmate/cli-common`),
`cli-wrapper` (`@ohmate/ohmatecli`, bin `ohmatecli`), `docs-engine`,
`docs-index-builder` and `docs-zh` (`@ohmate/knowledgebase`). The wrapper loads
the bundled Runtime; legacy commands run in an isolated bundled child.
DevEco Studio/CLT/SDK remain external toolchain requirements. Official knowledge
archives are not present in the supplied snapshot. Packages are local development
artifacts, not published or GA-certified.

The current public command surface is generated in `docs/commands.md`;
legacy commands and native Runtime services coexist. The upstream architecture
and operational notes below describe retained baseline domains; they do not
override the OHMate product contract or certify current publishing workflows.

User-facing invocation guide for AI agents lives in `SKILL.md` — update it whenever a command or flag changes.

Root `README.md`, `SKILL.md` and maintained user documents in `docs/` are source
copies. CLI `prebuild` and `prepack` synchronize them into the CLI package;
do not edit generated copies. `npm run catalog` generates `docs/commands.md`,
`docs/command-catalog.json` and `artifacts/contracts/command-catalog.json` from
the built Runtime; `npm run check:catalog` detects drift. Build after ToolSpec
changes, regenerate the catalog, then synchronize package documents.
Current status and archived implementation records are maintained outside this
public repository; capability and acceptance boundaries come from command help
and actual receipts.

Agent plugin sources live in `.plugin/` and are shared across hosts; per-host differences belong only in the `.plugin/platforms.json` array.

## Commands

```bash
npm run build          # Build all workspace packages (engine — docs-zh — cli)
npm run build:engine   # Build docs-engine + copy dist to docs-zh/dist/engine
npm run build:index    # Call docs-index-builder to generate index.zip
npm run build:docs-zh  # Build docs-zh (copy engine dist + write apiVersion)
npm run lint           # eslint packages/*/src/**/*.ts + .plugin TS/MJS
npm run typecheck      # CLI, docs-engine and docs-index-builder source checks
npm run test:web:touch # Build CLI and run test-owned Chrome CDP touch acceptance
npm run test:platform  # Build and run serial process/lock/Web lifecycle checks on the current OS
npm run lint:fix       # eslint --fix
npm run format         # prettier --write packages/*/src/**
npm run license         # regenerate THIRD-PARTY-LICENSES
npm run test           # vitest run
npm run test:plugin    # plugin TypeScript checks + Vitest suite
npm run build:plugin   # build and validate every platform in .plugin/platforms.json into dist/plugin/<platform>/
```

## Agent workflows

Root `SKILL.md` is the published product-use guide. Repository development workflows live under `.agents/skills/`.

| Task | Workflow |
|---|---|
| Review code changes or merge requests | [deveco-code-review](.agents/skills/deveco-code-review/SKILL.md) |
| Select checks before committing, pushing, or reporting validation results | [deveco-check-changes](.agents/skills/deveco-check-changes/SKILL.md) |
| Write or diagnose tests involving subprocesses, locks, cancellation, timing, or shared state | [deveco-test-reliability](.agents/skills/deveco-test-reliability/SKILL.md) |
| Refactor or audit for duplicated rules and simplification candidates | [deveco-find-simplifications](.agents/skills/deveco-find-simplifications/SKILL.md) |
| Write or review documentation, comments, or diagnostics | [deveco-docs-and-prose](.agents/skills/deveco-docs-and-prose/SKILL.md) |

## Conventions that bite

- **Modules**: ESM, `"type": "module"`. Internal imports **must** use `.js` even when the source is `.ts`.
- **Output bundle**: edits to `src/` are not visible until `npm run build` (or `npm run dev` / `npm start`).
- **Husky**: pre-commit runs `npm run lint`; `prepare-commit-msg` auto-appends `Signed-off-by:` (DCO).

## Env vars

- `DEVECO_CLI_DEBUG=1` — log raw `node` / `ohpm` / `hvigor` / `hdc` / `emulator` invocations via `utils/logger.ts → debugLog`. Also prints stack traces on error from `cli.ts`.
- `DEVECO_CLI_SKIP_VERSION_CHECK=1` — bypass the DevEco Studio 6.1.0+ version check on startup. (`update` is the only command exempt by default; see `TOOLCHAIN_FREE_COMMANDS` in `packages/cli/src/cli.ts`.)
- `DEVECO_CLI_SKIP_INSTALL_CHECK=1` — bypass the install-location consistency check that runs before `devecocli update` proceeds. Warns (non-blocking) when the running binary's install root differs from `npm root -g`'s output (typical of multi-nvm / multi-node setups where `devecocli update` would land in a different prefix than the binary in PATH); see `src/install-check/`.
- `DEVECO_CLI_DATA_DIR` — override user data root (default `~/.local/share/deveco-cli`). Derives `docs/.index/search.db`, `logs/doc-init.log`, `TraceLogData/upload-state.json`, etc.
- `DEVECO_CLI_CPP_ENABLED` — set to `false` or `0` to disable C++ LSP in the MCP server (skips `compileNative` + `clangd`; C++ tools return "disabled"). Default: enabled.
- `DEVECO_CLI_CPP_COMPILE_COMMANDS` — path to a user-provided `compile_commands.json` (honoured by `serve mcp` and `serve lsp --cpp`). Supports an absolute path, a `{workspace}` placeholder template (replaced with the resolved project root, e.g. `{workspace}/compile_commands.json`), or a path relative to the project root — so one agent config can serve multiple workspaces. When set and valid, C++ init skips module discovery + `compileNative` sync entirely and clangd reads that compile DB directly (`--compile-commands-dir` = its parent dir). Invalid/missing file → warn and fall back to the default sync flow.
- `DEVECO_CLI_SMOKE_WAIT_MS` — settle wait in ms before `run`'s post-launch smoke check collects evidence (default `3000`; `0` checks immediately; non-numeric or negative values fall back to the default). See `src/smoke/smoke-inspector.ts`.
- `HTTP_PROXY` / `HTTPS_PROXY` — honoured by `global-agent` bootstrapped in `packages/cli/src/cli.ts`.

## Architecture

```
packages/
├── cli/                    # @deveco/deveco-cli (published)
│   ├── src/
│   │   ├── cli.ts          # Commander entry; global-agent bootstrap; preAction version check
│   │   ├── commands/       # One file per subcommand (doc.ts, update.ts, docs-update.ts, ...)
│   │   ├── docs-loader.ts  # Dynamic engine loader (findBundledDocs/findUpdatedDocs/loadDocsEngineModule)
│   │   ├── auth/ skills/ signature/ ui/ compat/ toolchain/ trace/ ...
│   │   ├── utils/          # cli-data-dir, http-client, semver, build-lock, logger, ...
│   │   └── internal/       # telemetry-upload-background.ts (tsup entry)
│   ├── mcp/src-server/     # Bundled stdio MCP server (ArkTS/C++ syntax checking via LSP)
│   └── templates/          # Project scaffold copied by `devecocli create`
├── docs-engine/            # private, search/read runtime
│   └── src/
│   │   ├── index.ts        # Runtime barrel — exports createDocsEngine + apiVersion + types only
│   │   ├── builder.ts      # Build-time barrel — exports buildSearchIndex etc. (for docs-index-builder)
│   │   ├── engine.ts       # createDocsEngine() factory + DocsEngine interface
│   │   ├── data-dir.ts     # cacheDir resolver (setCacheDir/getCacheDir/assertCacheDirSafe)
│   │   ├── portal/         # catalog constants (CATALOG_NAMES, CATALOG_TITLES)
│   │   ├── service/        # LocalDocService (search/readDocument)
│   │   ├── init/           # DocInitializer (awaitDocReady, lazy index install)
│   │   └── doc-index/      # sqlite-backend, tokenizer, query-normalizer, docs-zip-reader, etc.
├── docs-index-builder/     # private, index building
│   ├── packages/cli/src/cli.ts          # CLI entry (--docs-zip --output)
│   └── data/               # Lexicon files (harmonyos-terms.txt, synonyms.json, stopwords.txt)
└── docs-zh/                # @deveco/deveco-cli-knowledgebase (published, self-contained)
│   ├── dist/engine/        # Copied from docs-engine build (build.mjs)
│   ├── docs.zip            # Chinese docs data (CI-time download from gitcode release)
│   ├── index.zip           # Prebuilt search index (CI-time build via build-index.mjs)
│   ├── index.js            # Bridge re-export from dist/engine/
│   └── scripts/            # build.mjs, build-index.mjs
```

**Real entrypoints**: `packages/cli/src/cli.ts` is the user-facing bin. `src/internal/doc-init-background.ts` is a tsup entry spawned after install to populate the docs search index. `packages/cli/src/internal/telemetry-upload-background.ts` is a tsup entry spawned (detached) by the CLI when `isUploadDue` is true (OR: pending events >5min OR failed files due for 1h retry), to run `flush()` + `retryFailed()` for non-MCP commands. `packages/cli/mcp/src-server/index.ts → createMcpServer` is the MCP orchestrator started by `devecocli serve mcp`.
**Toolchain resolution**: [ToolProvider](packages/cli/src/toolchain/tool-provider.ts) owns Studio/CLT discovery and component paths consumed by the CLI and MCP. Linux has a CLT path; capabilities that require Studio still check `assertStudio()`. Do not infer that every component exists on every platform. hilog runs through `hdc shell hilog`.
**Build pipeline**: `commands/build.ts` runs `ohpm install --all → hvigor --sync → hvigor assemble*`. The artifact path resolver lives in `utils/project.ts → findArtifactPath`.
**Apply**: `commands/run.ts --apply <fileName>` fast-incremental-deploys changed files — writes the list to `.hvigor/<fileName>`, drives hvigor `assembleDevHqf` to produce signed hqf, installs via `bm quickfix -a -f -o`, then restarts. Modules auto-detected from file paths. Requires DevEco Studio ≥6.1.1 (hvigor `assembleDevHqf`); below is rejected with an upgrade hint. Prereq: `devecocli run` once first (full build; `--apply` generates and removes its own `buildConfig.json` per apply — normal `run`/`build` must NOT write it, or hvigor injects its `patchConfig` into every ArkTS build and haps gain an extra `ets/symbolMap.map`); on failure falls back to a full `devecocli run`.
**Device selection**: `service/device-manager.ts` is the single source for "what's connected". Commands that accept a device use a shared resolver that maps a user-supplied name or serial to a concrete serial.
**Skills / MCP init**: Commands use `src/skills/index.ts`. `SkillInstaller` handles installation, migration and removal; Agent paths and legacy locations come from `src/config/agents.json`.

- `init`: links `.agents/skills/deveco-cli` and separate Agent entries directly to the packaged Skill; `--path` links `<path>/deveco-cli` directly. Global startup migration is version-gated, preserves existing and legacy entries, and retries after failure.
- `skills add`: stores archives in `<dataDir>/skills/store/<name>` globally or `<project>/.deveco-cli/skills/store/<name>` per project. All Agent entries, including `.agents`, link to the entity through the same installation flow as `init`; `--path` extracts directly. Existing entities can serve new Agent links; forced updates affect all linked Agents.
- Installation skips existing entries by default. **`-f` / `--force` replaces them and deletes old content and local edits; copied Agent installations need this flag to become links.** Correct links are kept; link failures fall back to copying. `directory-installation.ts` stages replacements and rolls back failures. Forced installation cleans legacy entries only after the destination succeeds.
- `skills remove` cleans selected Agents (all supported Agents without `--agent`), including legacy entries; shared entries and stored entities stay while other Agents use them. Installation, updates and removal share a per-scope, per-Skill lock. Package sources are never removed.
- Project operations call `projectSkillChecker` after resolving their actual project root. It only warns about broken or stale bundled Skill links and suggests `init --project <path> -f`; it writes no records, performs no repair and preserves command results. Duplicate checks are suppressed only within the current process.
- MCP targets come independently from `mcp-targets.ts` / `MCP_TARGET_AGENT_ROOTS`; extending Skill support does not extend MCP support.

**Docs index**: `commands/doc.ts` calls `loadDocsEngineModule()` (from `src/docs-loader.ts`) to dynamically load the docs engine from `@deveco/deveco-cli-knowledgebase` (either the bundled baseline or an updated copy in `<dataDir>/doc-data/<version>/`). The engine lazily installs the index on first use — **no postinstall**. The engine is a separate workspace package (`packages/docs-engine/`); its `createDocsEngine({cacheDir})` factory returns a `DocsEngine` with `search/read/catalog/close`. `apiVersion` is the CLI+engine compatibility boundary. To refresh the index: `npm run build:index` (calls `packages/docs-index-builder/`) then republish docs-zh.
**Compat module**: `src/compat/compat.ts` (registered as `check compat` in `src/commands/check.ts`) drives DevEco Studio's bundled `apkanalyzer-apiscan` plugin via Node — `hvigor compileNative` for native side, then `node api-change-scan.js --startVersion/--endVersion/...` to produce a CSV report. Format values are `default | csv | json`; `default` writes csv to a file but renders text to console, `csv` requires `--output-path`, file extension must match `--format`. Directory output (`--output-path` is a directory, no extension) is format-aware: `--format json` writes `apiChange-res{N}.json`, `--format default`/`csv` writes `apiChange-res{N}.csv` (via `persistReportToDir`). Spinner uses `execa` (async) so the animation runs during the scan — do not switch back to `execFileSync` (sync blocks the event loop and the spinner freezes). `HvigorAdapter` is instantiated with `silent: true` for this command so hvigor's own output is suppressed.

## Standard paradigm: how to add a new domain module

When adding a new cross-command capability (UI inspection, screenshots, simulators, etc.), extract the domain logic out of `commands/` into a dedicated domain module under `src/`. Don't invent a new shape — use this structure:

```
src/<domain>/
├── index.ts                 # Single barrel — re-export adapters + types only
├── <capability-a>/
│   ├── types.ts             # Domain types
│   ├── <verb-or-noun>.ts    # One or more pure modules named for what they do
│   └── <adapter>.ts         # Adapter class wrapping external IO + the pure modules
└── <capability-b>/
    ├── types.ts
    └── <adapter>.ts
```

**Naming — name files after what they contain, not after a generic role:**

- Pick names that describe the content (e.g. `parsers.ts`, `collapse.ts`). **Never** use `helpers.ts`, `utils.ts`, `common.ts` — these are a smell.
- A capability **does not need a pure module** if the logic fits in `types.ts` or the adapter. Don't add files for symmetry.
- The adapter is usually the only file doing IO; the `-adapter` suffix is optional — use it only when it disambiguates.

## Rules

### Domain module rules

Rules (enforced by convention; not lint):

1. **One barrel per domain.** `src/<domain>/index.ts` is the only thing `src/commands/*` imports from. **Never** import from `src/<domain>/<capability>/*` directly.
2. **Three-layer split inside each capability**: `types.ts` → pure helpers (parsers, fold/collapse, normalizers) → adapter class that composes the helpers with external IO (hdc, http, fs). Test pure logic directly and test adapter orchestration, cancellation and cleanup through controlled IO dependencies.
3. **Cross-capability coupling goes through the adapter**, not through shared types. If capability A needs data from capability B, A's adapter instantiates B's adapter and calls it — don't duplicate B's types into A's `types.ts`.
4. **Adapter methods are case-shaped**, not verb-shaped. Expose specific methods like `getFullTree(serial, depth, windowId)` and `getCollapsedTree(...)`, not one generic `get(options)`. Keep the IO orchestration (`buildRemoteX → recv → parse → cleanup`) as private methods on the adapter.
5. **Commands stay thin**: `Options` interface + commander option chain + `handle*` async function that does spinner → call adapter → format output. Renderers (`renderTree`, `renderTable`, JSON shape) live in the command file or a small util, not in the domain.
6. **No business logic in commands.** If `commands/<x>.ts` grows past ~200 lines and is mostly orchestration, you're missing a `<domain>/<capability>/<adapter>.ts`. Follow the standard paradigm above instead.
7. **Adding the command**: put `import { ... } from '../<domain>/index.js'` at the top of the new `commands/<x>.ts`, register it in `packages/cli/src/cli.ts` alongside the other `program.addCommand(...)` calls. Don't touch the barrel beyond adding the new export.

### General rules

8. **No `process.exit` in business logic.** All code must throw or return a failure result. The single termination point is `packages/cli/src/cli.ts`. `utils/ora-fail.ts` is a legacy exception — **new or modified code must not call it**.
9. **Log every spawned command line.** Before spawning any external CLI (`hdc`, `hvigor`, `ohpm`, `emulator`, bundled `node`, etc.), emit `debugLog(`Executing: ${cmd} ${args.join(' ')}`)` from `utils/logger.ts`.
10. **Comments**: keep comments brief — state purpose only, no verbose explanations. Existing `Copyright (c) 2026 Huawei Device Co., Ltd.` SPDX headers are mandatory — preserve them.
11. **CLI flags**: kebab-case. `--device <name|serial>` accepts either. Multi-device hosts must list available devices and exit non-zero rather than pick a default.
12. **Format per file, not globally.** Use `npx prettier --write <file>` and `npx eslint --fix <file>` on changed files only. Never run `npm run format` or `npm run lint:fix` on the whole tree.
13. **Adding a flag or command?** Update the matching prose in **both** `SKILL.md` and `README.md`.

### How to migrate existing code to this shape (gradual)

The seven rules above are the **destination**, not a one-shot rewrite mandate. Most `commands/*` files today predate the paradigm and still hold orchestration that belongs in a `<domain>/<capability>/<adapter>.ts`. We migrate **opportunistically, one touch at a time** — every change to a legacy file should leave it a little closer to the shape, without growing the diff beyond what the change actually requires.

When you touch an existing `commands/<x>.ts` (or any module that doesn't follow the shape), apply this judgement in order. **Stop at the first step that already passes**; don't refactor past the line you're already crossing:

1. **Am I adding a new capability?** → Create `src/<domain>/<capability>/{types,pure-helpers,adapter}.ts` and the barrel export **first**; then write the thin `commands/<x>.ts`. (Rules 1–7 apply in full — this is the easy case.)
2. **Am I editing a file that already follows the shape?** → Respect the layer you're in. Don't reach across layers (helper from adapter is fine; adapter logic from pure helpers is not). No structural change needed.
3. **Am I editing a legacy `commands/<x>.ts`?** → Keep the change minimal, but if the touched block is clearly orchestration that belongs in an adapter (e.g. building a remote command, parsing device output, talking to `hdc`/`hvigor`/`ohpm`/`emulator`/bundled `node`), **move that block into a new or existing `<domain>/<capability>/<adapter>.ts`** and call it from the command. Don't move unrelated code in the same PR.
4. **Am I adding new logic to a legacy file for a brand-new capability that has no domain yet?** → Same as step 1, but it's OK to do it from inside the legacy command first **only if** the legacy command is being deleted/rewritten anyway. Otherwise, create the domain module and route through the barrel from the start.
5. **Am I doing a pure refactor with no behaviour change?** → Use a dedicated commit. The migration is the _point_ of the commit, not a side effect.

**What "closer to the shape" looks like, concretely:**

- A `commands/<x>.ts` block that does `hdc shell ... → parse stdout → return result` becomes one adapter call from the command.
- A duplicated type in two places gets removed; the second place imports it from the owning domain's barrel.
- A `commands/<x>.ts` that grows past ~200 lines and is mostly orchestration is the next migration target — but only migrate it when something in that file genuinely needs to change, or in a dedicated refactor commit.

**The bar is "each commit leaves the codebase a bit closer to the paradigm, never further."** New code follows the seven rules strictly. Old code converges one block at a time.

## Misc operational gotchas

- **JSON5 everywhere** for HarmonyOS configs (`build-profile.json5`, `module.json5`, `oh-package.json5`, `app.json5`) — use `json5` to parse, not native `JSON.parse`.

**Multi-package release**: The gitcode workflow (`.gitcode/workflows/npm-publish-daily.yml`) runs a 3-stage matrix on `daily/v*Test*` tag push. (1) `build-engine` — builds docs-engine, uploads dist as artifact; (2) `build-docs-zh` — downloads engine artifact + docs.zip from gitcode release, builds index.zip, publishes `@deveco/deveco-cli-knowledgebase` to npm; (3) `build-cli` — builds CLI, publishes `@deveco/deveco-cli` to npm. docs-engine and docs-index-builder are private, never published.
