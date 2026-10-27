# OHMateKitProducer Agent Instructions

## Project Identity

- App name: `OHMateKitProducer`
- Bundle name: `dev.ohmate.kitproducer`
- Application model: Stage
- API level: `26`
- SDK version: `26.0.0`
- Model version: `26.0.0`
- API source: `sdk_pkg`
- Project root markers: `build-profile.json5`, `oh-package.json5`, `hvigorfile.ts`, `AppScope/app.json5`
- Initial module: `entry`
- Module markers: `entry/build-profile.json5`, `entry/oh-package.json5`, `entry/hvigorfile.ts`, `entry/src/main/module.json5`

## Required Development Baseline

- Use HarmonyOS Stage model and preserve the generated project structure unless an approved architecture change requires otherwise.
- New ArkTS UI uses state management V2. Do not introduce V1 decorators.
- Prefer documented HDS capabilities, then system preset components, then standard ArkUI components.
- Verify API signatures, versions, devices, permissions and system capabilities against the current SDK and matching HarmonyOS skills.
- Do not add dependencies, modules, permissions, routes or compatibility layers without a real requirement and verification plan.

## Project Facts To Maintain

- Keep this file synchronized with the actual products, modules, package types, public entry points and dependency directions.
- Record target devices, window forms, orientation, regions, network/account prerequisites and real-device requirements when they become known.
- Record the launch Ability, first page, navigation mode, external entry points, state/data/storage choices and permission inventory when implemented.
- Record project-specific HDS fallback decisions, accessibility/localization scope, performance budgets and release constraints when established.
- Record exact validated lint, build, test, run, UI and log commands when the project introduces custom products, modules or targets.

## Implemented Producer Baseline

- Purpose: a developer-only reference Producer for application confirmation,
  platform crypto, process-memory streaming, explicit CPU/system-event reading,
  registered HTTP/Web summaries, temporary masked response-body inspection,
  application-local temporary Network Mock, allowlisted Web resource responses,
  individually confirmed Console execution and masked Cookie counts
  and UI subtree inspection. This is not the
  published OHMate Kit and is not Release ready.
- `default` product, API 26.0.0 target/compatible, Stage Phone `entry:default`
  HAP; `entry:ohosTest` is the separate `entry_test` feature test target.
  No product/features/common layering or shared version manifest is needed for
  this single-module example.
- `EntryAbility` loads `pages/Index`; HdsNavigation hosts one scrollable page.
  Standard TextInput Password is used for the invitation because HDS has no
  corresponding secure input. Text/Button use platform semantics, V2
  `@Local`/`@ObservedV2`/`@Trace`; no V1 or persistent application state.
- Chinese resources, system semantic colors/fonts, inherited system color mode,
  default safe-area and keyboard behavior. No custom immersive extension,
  material, animation, theme storage or additional routes. Phone narrow/wide
  windows, large fonts, screen reader and dark mode need runtime verification.
- `ProducerController` is the shared page/Ability lifecycle owner. Its
  CryptoArchitectureKit keys, invitations and WebSocket stay in memory.
  Background/destroy/revoke cancels timers and rejects stale async completions.
  The development-only `DEV_AUTO_PAIR` fetch reads a workbench
  `/dev-invitation` on loopback port 50838 and calls the same review/confirm
  path; the workbench must be started with `debug start --dev-auto-pair`.
  Production workbenches do not expose that endpoint, and this mode is neither
  device/build authentication nor a Release feature. A transport that fails or
  closes after being connected is terminal: close is attempted best-effort and
  its failure no longer blocks a fresh invitation. `APP_BACKGROUND` and
  `USER_REVOKED` keep the original strict cleanup and retain responsibility on
  failed close.
- The only permission is `ohos.permission.INTERNET` for an explicit loopback
  WebSocket with `proxy: no-proxy` and user-triggered HEAD/body/Mock probes to its
  confirmed loopback workbench origin, with `usingProxy:false`; no cloud, accounts, LAN or system proxy.
  No user credentials, certificate paths or signing material are read.
  Required crypto, NetStack and HiDebug SysCaps are checked; unsupported devices
  and non-debug builds cannot pair.
- `hidebug.read` uses TaskPool to read PSS in KB and convert to
  bytes using bigint before checking the safe-integer range. Invalid readings
  fail collection. Maximum sample frequency is 1 Hz with one event awaiting ack; 10-second
  pairing/ack timeout, maximum ten-minute keys and 65536 frames. No automatic
  capture of bodies, hardware identifiers, storage, logs or screenshots.
  PSS and on-demand `ui.read` share one collection owner and one pending ack;
  UI events advance the same absolute sequence but do not count as discarded PSS.
- Optional `hiappevent.read` is negotiated only with HiAppEvent SysCap. A separate
  application action registers one unique, valid, at-most-32-character Watcher
  with native OS APP_CRASH/APP_FREEZE filters. Runtime null/undefined add failures
  and throws release the exact owner; synchronous registration callbacks are
  discarded. Callback projection never reads params, logs or attachment paths,
  sends frames or removes the watcher. At most 32 groups/32 event objects are
  inspected per callback and 32 projected summaries queued; invalid/overflow
  items and replaced latest summaries count as dropped. Timestamps describe
  observation, not authenticated fault occurrence; crash delivery may arrive
  at another launch. Revocation invalidates first; remove failures retain owner
  and block pairing until explicit retry. `dfxFile()` returns a defensive,
  latest-sent, memory-only event-name file, not a persisted ACK history.
- Optional `OHMateFaultLogExtension` is a separate non-exported `faultLog`
  entry and never imports Core, ProducerController or window APIs.
  EntryAbility only configures `faultLogHost` from actual application debug
  metadata. Host application code must explicitly call `confirm(true)` after
  application-local consent; there is no automatic or Want-based opt-in.
  It registers normal A `OHMateFaultNormal` and empty B `OHMateFaultDelayed`;
  the Extension processes the same B after system `onFaultReportReady`.
  A/B use only OS crash/freeze filters. Disconnect/detach stop callbacks and
  clear bounded memory summaries while preserving persisted filters.
  Explicit `revoke()` deletes owned filters and retains failed removal owners.
  Extension uses API21/Stage/FaultLogger+HiAppEvent SysCaps, literal debug true,
  a nine-second uptime budget and terminal invalid/regressing-clock handling.
  No params, paths, credentials, networking, archive writes or implicit cleanup
  retries. Summaries contain event names and observation uptime only; they
  are not a fault archive, build identity or proof of actual delayed launch.
  The reference page has no FaultLog consent control; integration is explicit
  application code. Device delay/restart/ten-second exit remain unverified.
- Independent `dfx/LeakWatcherHost` owns application-main-VM jsLeakWatcher only
  after exclusive host configuration, separate review/confirmation/start and
  actual API26/Phone/debug/HiChecker+Lang+Time+SystemInfo gates.
  Object monitoring sends the original object to the API with a fixed label,
  never stores it or proxies it through TaskPool. Manual check stores only
  empty/nonempty return observation, not a leak diagnosis or raw list.
  Component mode selects only CustomComponent, explicit 90000ms interval,
  foreground/background thresholds 5/1, one stored dump and 5000ms GC wait.
  Require independent raw-file consent; callbacks read only bounded array shape,
  never filenames. Thirty-second review and ten-minute run; lifetime 256 reviews,
  32 watch attempts and 3 checks, including failures, survive stop.
  Failed disable retains exact ownership for explicit stop retry; wrong-thread
  cleanup never calls a different VM. Invalid clocks permanently revoke admission.
  Ability startup configures only; destroy/background/window exit stop monitoring.
  Raw platform files may remain and stop is not file erasure. No Core, Bridge,
  frame, journal, ZIP or page consent control. Actual GC performance, Phone
  detection, raw-file cleanup and Release elimination remain unverified.
- Independent `dfx/RawHeapHost` supplies an explicit rawheap application-code
  gate, default closed without an application-owned non-main Worker and exclusive
  `RawHeapFiles`. No Worker starts from Ability or the page; ordinary TaskPool
  lifetime cannot carry unresolved file cleanup. configure/review('process')/
  confirm/collect require separate raw-file and Developer-options acknowledgments,
  never query or enable the system setting. API26/Phone/debug/SysCaps gate actual
  `dumpJsRawHeapData(false,false,true)` whole-process request; a worker-only
  two-argument dump does not establish main-VM capture. No GC, trimming or cache
  release request. Each Worker VM retains lifetime one attempt/256 reviews,
  including failures; host exclusive declaration cannot discover other collectors.
  RawHeapFiles.prepare owns partial/unreported/late output responsibility before
  native effects. Bounded adoption passes at most 16 paths/16384 characters only
  to that original host; paths do not prove ownership and the SDK cannot choose
  output placement. No generic filesystem reader, enumeration or deletion is
  implemented. The explicit host processes locally with bounds and immediately
  cleans its owned files. Thirty-second review/wait includes cleanup; cancel,
  timeout or drift stops waiting while preserving pending responsibilities.
  Failed cleanup retries only through explicit retryCleanup with a bounded wait.
  Wrong-thread cleanup cannot touch another VM. Literal cleanup true reports
  host-reported-clean only, never physical erasure or snapshot-cache release.
  Raw content/paths/error text never enter state, frames, logs, receipts or ZIPs.
  entry/build-profile.json5 declares RawHeapHost in only the debug
  buildOptionSet sourceOption.workers, ensuring independent worker compilation.
  This does not start a Worker; release has no worker declaration.
  No Core/Bridge/Agent/page/default file host integration. Actual worker lifetime,
  Developer options, VM coverage, native file processing and performance, Phone
  behavior and Release elimination remain unverified.
- `captureCpu()` is an explicit `hidebug.getCpuUsage` TaskPool read, multiplying
  finite nonnegative process usage by 100 without claiming an averaging interval
  or thread coverage. It shares collection/ACK/sequence ownership with other
  channels; errors and late/expired results cannot restore a sample. A native
  metrics owner remains pending across revoke until settlement and blocks pairing.
  CPU is never automatically polled. Latest CPU/PSS records share the unique
  memory domain path with a declared combined source; PSS-only stays compatible.
- The page registers its `bridge_capture_root` UIContext before invitation review.
  `ui.read` requires this registration, ArkUI.Full and explicit negotiation.
  `PlatformUi` reads only this subtree, at most 256 expanded nodes and depth 32,
  using API26 `ONLY_EXPANDED`/`NOT_EXPAND`; no lazy expansion, mutation, Inspector
  properties, application IDs, text, input values or source-code inference.
  Node IDs come from system unique IDs, unknown/custom types map to `Component`.
  The encrypted desktop event contains only node count, scope and a fixed summary.
  Local `uiFile()` holds one defensive structural snapshot with peer-reported
  source naming `UIContext.getFrameNodeById` plus FrameNode geometry/visibility
  methods. Positions are window-relative vp; measured px dimensions are converted
  through this UIContext. Native visibility is only the visibility attribute, not
  occlusion, transformed bounds or physical paint. Disposed/detached entities,
  nonfinite/negative geometry and invalid visibility are refused before sending.
  Replacements count prior nodes as dropped;
  failed reads clear the file, expiry is checked synchronously, and revoke,
  background or unregister clears the snapshot and UIContext reference.
  Runtime geometry/visibility and actual UI remain unverified.
- Host screenshot permission defaults to false in `registerUi`; this page explicitly
  permits only the fixed `bridge_snapshot_target` description subtree. No pairing
  information, whole-page capture or arbitrary ID selection. ArkUI.Full and Image
  Core/Packer SysCaps plus negotiated UI and a separate thirty-second application
  review are required. Capture uses the exact unique ID, checks ancestry and source
  before/after awaits and after cleanup, downscales to at most 512 pixels per side,
  and limits PixelMap to 1 MiB and PNG to 256 KiB. No Exif/property packing.
  Three-second timeout stops waiting; native work keeps its owner until settlement,
  blocking another capture or pairing and sharing the automatic collection budget.
  PixelMap/Packer release waits for all dependent operations; failed releases retain
  exact owners for explicit revoke retry, including late cleanup after background.
  The resulting base64 preview stays in memory for thirty seconds; cancel, background,
  expiry and revoke clear it. It is excluded from frames, journals and ZIPs because
  this example does not provide protected screenshot storage. Snapshot/render completion
  does not attest physical paint. Actual screenshot APIs/UI are runtime-unverified.
- `UiHighlightSession` owns an application-local R2 grant, default closed without
  the explicit `registerUi` host. Only `bridge_snapshot_target`, a fixed description
  Column under the current `bridge_capture_root`, is allowed. Platform source hashes
  system unique-ID ancestry within depth 32, checks attachment/visibility/positive
  geometry and never reads text/Inspector or mutates native nodes. Native proxy
  object identity is not stable; compare system unique IDs. Plan hashes bind source,
  window, identity/epoch/generation and earliest connection/review deadline.
  Review at most thirty seconds, display at most three seconds, 256 attempts,
  non-evicted command tombstones, one execution per second and single-use consent.
  Review, confirm, execute, cancel and cleanup retry are distinct V2 page actions.
  Responsibility precedes host effects; expiry/source checks every 250 ms and
  synchronously on status permanently revoke observed drift or backward clocks.
  Cleanup touches only its command. Failure retains the host and responsibility
  across stop and blocks pairing, registration and new UI capture until explicit
  retry. Effects clear earlier UI/screenshot and unsaved export; fresh UI reads
  first clear the outline. The page reserves a constant two-vp border and changes
  only its transparent/semantic emphasis color, without changing focus or touch.
  Host acceptance is not native rendering/paint evidence. Real Phone node identity,
  lifecycle, narrow windows, large fonts, reader and dark mode remain unverified.
- `SemanticReplaySession` consumes one explicitly registered ordinary test Adapter
  step and checks a named assertion after its action; no reflection, coordinates,
  system injection or raw user input. R3 plans bind the exact local build/source,
  identity/epoch/generation/window, descriptors, payload and earliest deadline.
  Review/confirm/execute/cancel/retry are independent; thirty-second review, one
  execution per second, 256 attempts and non-evicted tombstones apply. Action and
  assertion share one bounded wait up to three seconds. Recovery precedes even
  throwing preparation; timeout/cancel returns without claiming preemption or
  releasing unfinished host ownership. Recovery failure/unknown result is retained
  for explicit retry; observed source drift permanently forbids restoration into
  a changed source. Dispose keeps only an unresolved host and releases it after
  successful recovery. Effects clear UI/DOM/Storage/screenshot and unsaved export;
  responsibility blocks capture/registration/pairing. Latest command/assertion/
  recovery metadata stays in memory, excluded from frames and ZIPs.
  `registerReplay` defaults absent; the V2 page supplies only a fixed reversible
  `test.marker` action. Current `unverified:` Producer build has no compiled
  artifact binding, so review stays unavailable and the page displays manual
  steps. A matching invitation/build string never changes this gate. No new
  dependency, permission or route. Local Adapter callbacks and Node tests do not
  prove real application state, route recovery, physical paint or remote admission.
- `registerNetwork` wraps one host-owned `HttpRequest.request` instance in
  `PlatformNetwork`; options, response and thrown error pass through without
  changing an existing interceptor chain. Only method, response code and
  STARTUP uptime duration are observed, with completion clocks. URL, headers,
  body, cookies and performanceTiming are never read by default summary observation. This is
  a registered-adapter source, not a process-wide HTTP hook; requestInStream,
  RCP, third-party clients and other instances remain outside coverage.
  It requires explicit `app.network.read` negotiation, discards pre-confirmation,
  late-generation and expired completions, queues at most 32 summaries, drops
  the oldest on overflow and alternates with PSS at a combined maximum 1 Hz.
  Both use one pending ACK. `networkFile()` holds one defensive, latest-sent
  summary; its dropped count includes overflow, invalid readings and replaced
  local summaries. It is not acknowledged-history evidence. Failure, background,
  revoke or unregister clears reference, queue and file without destroying a
  host-owned business request. The page owns a separate native test request
  and destroys it on close; failed destruction retains its reference and blocks
  replacement. The explicit HEAD expects the workbench's 405 response, caps
  received bytes at 1024 and connection/read timeouts at 3 seconds.
- `NetworkBodyCapture` is an application-local memory owner, not a remote write
  path or authenticated Kit source. Review binds the current negotiated identity,
  epoch, generation, `network-main`, exact rule hash, revision and expiry; confirm
  accepts only this hash and cannot reset byte/sample budgets. At most 256 reviews
  per registered connection owner, 32 samples, 64 KiB per body, 256 KiB total and
  thirty seconds. Unknown/sensitive requests, query strings, non-GET methods,
  custom methods, upload/body/query data and non-allowlisted header names are refused.
  Cache must be disabled and maxRedirects zero; native redirectCount zero is also
  required. Request scope is rechecked after native settlement. Unknown response
  evidence, 3xx/auth/payment status, Object/ArrayBuffer and other encodings/types
  stay uncollected. This is only a directly integrated host-owned adapter, not
  assurance against an arbitrary third-party interceptor rewriting a request.
  JSON projection is bounded to 256 nodes/depth 32 and identifier keys. Strings,
  sensitive key values and numbers with magnitude at least ten million are masked;
  plain text is entirely masked. It is a conservative projection, not general
  semantic deidentification of every numeric field. Raw UTF-8 is size checked
  before projection; temporary encoded bytes are erased without mutating the
  business response. Only the latest masked body remains in application memory.
  Cancellation, expiry, backward or non-safe-integer clocks, background/stop and
  replacement invalidate pending tickets and clear owner/UI state. Invalid readings
  never replace the last valid clock. After valid time recovers, a fresh review
  and confirmation may authorize only new tickets; old consent never returns.
  Bodies never enter frames, journals,
  problem ZIPs, storage, approvals or Agent tools.
  The page separately reviews a single 1024-byte GET to the confirmed loopback
  `/ohmate-body-sample` missing asset, which yields the workbench's fixed 404 JSON.
  It shares the one native request with the HEAD probe; either consumes the
  instance once and another test requires a new connection. No account/private
  endpoint, resource route or permission was added. Confirmation, masking, native
  redirect evidence, runtime requests and Phone UI remain device-unverified.
- `NetworkMock` is a separate application-local memory owner for the registered
  `network-main` adapter. Exact version-1 rules use target/origin/path/method,
  allowlisted headers, fetch/xhr and stable priority; at most 32 rules/128 unique
  supplied samples, 256 KiB UTF-8 each, 64 KiB fixed body and 3-second delay.
  GET/HEAD/OPTIONS only, HEAD fixed bodies empty, explicit STRING output required.
  Deterministic text templates expand only `{{test.name}}` from explicit string
  variables once; no code/request/environment/file lookup. At most 16 KiB template,
  16 variables/2 KiB each, 64 references, 64 KiB rendered body and 256 KiB whole
  rendered table. Missing/unused variables, malformed syntax and invalid UTF-8
  are rejected; HEAD output must be empty. Reviews bind response/rendered-body
  hashes without retaining body or variable values in public state.
  Fixed/template/timeout/network-error responses do not invoke native HTTP, body capture
  or native summary callbacks. Synthetic responses carry `mock`, source and ruleId,
  empty cookies and ten NaN timing fields to avoid a false native measurement.
  They remain outside frames, journals, ZIPs and Agent tools.
  Unknown/sensitive requests, query/body/upload/customMethod, client certificates
  and non-allowlisted headers pass through untouched without credential-value
  reads. Unselected requests preserve the original URL/options/response/error
  and host destroy ownership. No global interception or chain replacement.
  Independent review binds identity/epoch/generation, table revision, raw and
  canonical rule/sample hashes and a fixed deadline; only its plan hash confirms.
  Up to 256 attempts per connection owner, ten minutes bounded by the connection,
  128 hits and 8 pending delays. Repeated confirmation cannot renew or reset.
  Cancel, replacement, background/stop, expiry, source/identity drift and backward
  clocks invalidate before rejecting pending delays. An observed backward or
  non-safe-integer clock permanently closes this connection owner; clock recovery,
  cancel and a new review cannot revive it. Valid-clock cancel/expiry still allow
  fresh review, with separate review/confirmation and unchanged quotas.
  Changed request matching
  parameters, headers or maxLimit also cancel a delayed response. Selected
  cancellations/quota errors never trigger native fallback or revive old consent.
  Page review/confirmation/probe/cancel are distinct actions with visible state
  and counts; one fixed loopback `/ohmate-mock-sample` GET expects a template-generated
  202 and checks the exact STRING result before showing success.
  HEAD/body/Mock share the one test-request allowance per connection. Scope is
  thirty seconds and maxLimit 1024, without raw response rendering or copying.
  Runtime platform HTTP, Phone layout, large fonts, reader, dark mode and
  lifecycle remain unverified. No remote write admission or device/build attestation.
- `WebResourceOverride` consumes an explicit host-owned, memory-only allowlist,
  empty by default. Registration copies at most 32 exact same-origin ordinary
  text/plain or text/css resources, 64 KiB each and 256 KiB total, with random
  128-bit resource IDs. No general filesystem/remote reads, scripts, HTML,
  global proxy or automatic injection. The default one-shot rule targets a non-main,
  non-redirect GET. Native header arrays are temporary; only allowlisted names
  are inspected, never values. Initiating frame and resource type are unavailable
  in onInterceptRequest, so coverage stays registered/request-intercepted and
  frame/type unverified; this is not a general sensitive-page classifier.
  Review binds exact resource/hash, raw and canonical rule/sample hashes,
  identity/epoch/generation, target and document revision. At most 256 attempts,
  128 samples, 128 hits and 1 MiB response bytes; TTL is at most ten minutes and
  no longer than the connection. Repeated confirm cannot reset or renew.
  Rebuild/navigation, wrong replacement, source drift, revoke/background/expiry
  and backward clocks invalidate first. Observed backward or non-safe-integer clocks
  permanently close this resource owner in both response and scheme paths;
  cancel, clock recovery and fresh review cannot revive it. Normal valid-clock
  expiry/cancel does not permanently close the owner.
  Request fields and allowed header names
  are rechecked before and after native response construction. Unselected
  requests retain the original host callback response/error. Selected errors
  never call that fallback; actual ArkWeb handling of callback errors is unverified.
  Responses are fully ready, UTF-8/200/OK with no-store/nosniff and an explicit
  resource marker. They never enter frames, native timing summaries, journals or
  ZIPs. Revocation removes future replacements; returned bytes cannot be recalled.
  `registerWebFiles` reads only the host-declared packaged ohmate-resources/
  css/txt allowlist through ResourceManager raw descriptors. Validate descriptor
  offset/length, read in at most 4 KiB buffers, accept only canonical UTF-8 with
  the manifest byte count/hash, and close every exact name before registration.
  At most 32 files/64 KiB each/256 KiB total; no dynamic paths or enumeration.
  Failed descriptor close survives stop and blocks pairing; only explicit stop
  retries. The page uses one 28-byte comment CSS file with its fixed SHA-256.
  It fails preparation and closes the session rather than falling back to text.
  The page explicitly grants exclusive scheme ownership of its dedicated Web.
  Attach only in onControllerAttached; no Service Worker/global registration.
  `WebResourceStream` requires exact GET/current frame URL/empty referrer under
  the workbench no-referrer policy/STYLE_SHEET or XHR/null request body stream/
  allowlisted header names. Redirect state is unavailable and stays unverified.
  At most four buffered requests; 4 KiB chunks retain native buffer ownership
  until exact request-stop and return of all reentrant native calls. Finish,
  abort and clear returns alone do not prove request release. Cancellation stops
  later chunks and revokes consent; failed abort/clear survive background and
  block registration/pairing, retry only explicitly. Clearing is limited to
  the dedicated host-owned instance because the API clears all its handlers.
  Ordinary hosts without the explicit grant keep their original callback path.
  No request body stream initialization/read or requestInStream capture.
  The page independently reviews,
  confirms and cancels it for thirty seconds with visible state/hit count.
  The fixed loopback test page explicitly fetches its existing CSS without cache,
  credentials or redirects, cancels the unread body and never applies its styles.
  Runtime callbacks, headers, Phone UI and source/identity remain unverified.
- One registered system Web instance loads the confirmed loopback fixed page
  with incognito mode and domStorage default disabled. API26 getFullDom projects only
  tag/tree metadata within 65536 characters, 256 nodes and depth 32. Native
  default URL/title/text/attributes remain temporary; never retain native IDs.
  Three-second timeout retains the native owner until settlement, blocking
  another read/register/review. Rebuild, source drift, expiry and revoke make
  snapshots unavailable; failed sending immediately closes the session.
  Console checks native source category, exact registered page/script path,
  bounded line and level. Only category/role/line metadata plus a fixed mask
  may survive summary redaction; source URL, message text, parameters and
  error description do not. Frame/column attribution remains unverified. Network is
  main-frame STARTUP callback duration, no status or full HTTP claim. A navigation
  started before confirmation cannot be reported. Web queues at most 32 records,
  rotates with HTTP and DFX and alternates with PSS at a combined automatic 1 Hz using
  one ACK/absolute sequence. The page owns its navigation restriction;
  Storage is limited to the explicit incognito Cookie count below; remote
  DevTools mutations remain unavailable.
- `WebConsoleSession` is application-local and default closed at registration.
  Only the fixed debug loopback page explicitly opts in. Each review/confirm/
  execute checks the current debug build, connection identity/epoch/generation,
  document revision and exact URL; local consent never authenticates peers.
  Code is at most 4 KiB valid UTF-8, 256 attempts including failed input, random
  128-bit command IDs and one native call per confirmation. IDs are not evicted.
  TTL is at most ten minutes and the connection deadline; confirm cannot renew.
  Execution is at most 1 Hz. String results have 4 KiB/64 KiB cumulative bounds;
  only type/byte-count/fixed mask survive. Numbers/booleans retain type only;
  arrays, ArrayBuffers, objects and exception descriptions are not inspected.
  All code, result and command receipts stay in memory, outside frames/ZIP/logs.
  A three-second timeout or cancellation ends waiting without preempting native
  scripts. The exact Web owner stays busy until settlement, including after
  background/stop, and blocks Console/DOM/screenshot/register/pairing. Late
  getters are not called. Completion updates pending UI state without restoring
  consent. Navigation, source/debug/identity drift, expiry and backward or
  non-safe-integer clocks invalidate the current plan. Valid time recovery requires
  a new review and independent confirmation; duplicate execution never repeats
  a native call. Script execution clears prior DOM and frozen export before effects;
  irreversible page side effects cannot be rolled back.
  The page uses a labeled standard TextArea (HDS lacks a script editor),
  independent review/confirm/execute/cancel and permanent state/type indicators.
  Editing cancels the old plan; navigation/background/disappearance clears input.
  Real ArkWeb return types, native execution/source behavior, cancellation,
  Phone layout, large font, screen reader and dark mode remain unverified.
- `WebStorageCapture` reads only the exact registered URL through API26
  `WebCookieManager.fetchCookie(url, true, false)`, after native incognito,
  document, debug and negotiated identity/epoch/generation checks. This is a
  URL-related nonpartitioned Cookie list, not an instance-exclusive store.
  At most 4 KiB valid UTF-8 and 64 name/value pairs are projected to count plus
  a fixed mask. Names, values, attributes and exception text are not retained.
  Empty output is captured zero entries; malformed/oversized output fails.
  One read per second, 256 attempts including failures per registered owner;
  cancellation does not reset budgets. Thirty-second memory expiry starts
  with the read and cannot exceed the connection deadline. Rollback invalidates
  the owner permanently. Navigation, background, disconnect, source/debug/
  incognito drift, failure and expiry clear metadata without reviving it.
  Three-second timeout/cancel ends waiting; the same Web native lock remains
  until settlement and updates Storage/Console controls, blocking DOM,
  screenshot, registration and pairing. Late results are never projected.
  Console effects clear earlier Cookie metadata before invocation.
  HdsNavigation/V2 Text/Button show masked counts, scope, disabled/uncaptured
  storage, timeout/failure and cancel/retry actions. No HDS Storage template
  exists. Keep domStorage default disabled, no global origins/quota/usage enumeration
  or deletion. The page can explicitly permit its two ordinary ohmate-test-local
  and ohmate-test-session keys before pairing, and revoke permission any time;
  stop/background resets the page permission. ControlledStorageAccess is default
  absent and defensively copies at most 16 distinct ordinary ohmate-test- keys.
  Its current enabled callback plus page/debug/incognito/identity/epoch/revision
  is checked at dispatch and settlement. A fixed runJavaScriptExt getItem script
  never enumerates, creates, writes or deletes keys. The strict result binds URL,
  exact key order and fields, at most 4 KiB UTF-8 and 1024 characters per value.
  Null/missing and empty values remain distinct. Raw values stay in private capture
  memory for at most thirty seconds, with no raw public getter, UI state, frames,
  journals or ZIPs; revoke clears references without claiming physical erasure.
  Cookie and controlled-page reads share the native owner and rate/attempt/deadline
  budget. Failures, permission/source drift, expiry and clock rollback clear raw
  references and stale getters are not accessed. Replacement revokes prior Cookie
  files and unsaved exports; never relabel page counts as Cookie platform metadata.
  `StorageWriteSession` now implements the application-local R3 core under the
  desktop WriteSession contract, with UUID command tombstones (256 attempts),
  one captured allowlisted key, original/payload/plan hashes, source/identity/
  epoch/generation/capture binding and a deadline no longer than the capture.
  Its fixed synchronous compare/mutate/verify script preserves absent versus empty.
  Restoration compares against the attempted replacement or already-restored
  original, and never overwrites a concurrent value. Responsibility exists
  before the native call; timeout/cancel ends waiting while retaining the native
  owner, and late effects retain recovery. Failed recovery requires explicit retry.
  Recovery raw references are bounded by the original thirty-second capture
  deadline; expiration leaves unresolved responsibility and blocks replacement/
  pairing instead of claiming successful restoration. This does not prove
  physical string erasure or native script preemption. The controller has
  distinct review/confirm/execute/cancel/retry methods, and effects clear earlier
  capture/export snapshots. No raw getter, frame, journal, ZIP or remote scope.
  Observed source/identity/epoch/document/permission drift permanently revokes
  recovery, even if the old binding returns. Disposal clears references but
  retains unresolved responsibility; late restoration cannot certify a timeout.
  Stop disposes this grant before asynchronous close and source destruction.
  Unresolved storage responsibility keeps `cleanup-failed` with
  `STORAGE_RESTORE_REQUIRED` after transport closes; repeated stop and late native
  settlement cannot restore the destroyed source or report successful cleanup.
  Application-owned in-flight mutation fields clear at the original deadline,
  while native engine scripts and physical string erasure remain unverified.
  The V2 page selects the two test keys and a fixed marker, empty value or
  removal, with separate review/confirm/execute/cancel/explicit retry controls.
  Selection revokes old consent; no automatic seeds or side effects.
  Standard Select/vertical Button support long confirmation text and scrolling;
  HdsActionBar's icon-oriented buttons/fixed primary width do not fit this
  narrow Phone flow. Persistent status remains outside the connected section,
  showing pending/failed/permanently unavailable recovery without raw values.
  Actual page mutations/restoration and Phone UX remain unverified.
  A distinct explicit Cookie publish sends the count and generated
  fixed scope summary once per current read, using the shared sequence and ACK
  owner. Sending does not renew the dispatch deadline or reset capture budgets.
  `webStorageFile()` exposes only a defensive latest-sent record while its
  source and snapshot remain current. The generated arkweb.jsonl path declares
  WebCookieManager.fetchCookie as peer-reported, not authenticated platform capture.
  Explicit export review shows Storage inclusion. Cancel, replacement, source
  drift, Console effects and expiry clear pending exports; Picker callbacks
  recheck source/expiry before FileIO. Late sends cannot restore the record.
  Clearing app metadata does not retract desktop history or user-owned saved
  ZIPs. No device/build authentication or remote write admission.
  Actual Cookie values, ArkWeb scope/lifecycle and Phone UI remain unverified.
- Local `ProducerController.memoryFile()` exposes a defensive copy of only the
  latest successfully sent summary for each PSS/CPU metric during the confirmed
  connection. It declares `hidebug.getPss`, `hidebug.getCpuUsage` or their combined
  API as a peer-reported platform-api source, uses the
  generated memory-domain path, reports sampling and replaced-record drops, and
  excludes fingerprint. No sample means undefined; revoke/failure clears it.
  It does not imply that a sent sample was acknowledged.
- Explicit ZIP export freezes PSS/CPU, DFX, current UI/DOM snapshots and latest registered
  HTTP/Console/main-navigation and current explicitly published Cookie summaries for an application review.
  `KitProblemArchive` emits a bounded (1 MiB) stored ZIP with the current public
  manifest, schemas and Kit profile. PSS-only exports retain `app-memory-summary`;
  CPU, DFX, UI, Web or HTTP selects `app-readonly-summary`, with only provided domains
  captured/summary-only and all other domains not-captured. HTTP and navigation
  share one network-summary file with a declared combined adapter source.
  DOM export validates unique aliases, prior parents and child counts. Memory
  export rejects duplicate metrics and foreign scope; DFX export allows only
  fixed event-name summaries with matching session and collecting API.
  Package identity includes changed UI, Web and HTTP records even when
  PSS is unchanged. Its empty events journal makes no desktop
  durability or clock-calibration claim. Old desktop Kit 1.4 schema layouts
  remain readable; the application source has its own generated session schema.
  Desktop validation checks the raw application session before minor field
  projection, so forbidden stream, authentication, history or calibration claims
  cannot be discarded and then accepted.
- `PlatformProblemExport` opens the system DocumentViewPicker only after
  confirmation, disables empty-file pre-creation, then writes the chosen URI.
  FileIO, UserFileService and FolderSelection SysCaps gate export independently
  of streaming. No extra permission, cache staging, background export or cloud
  transfer is configured. Nonempty existing destinations are refused.
  Short writes must make progress; fsync and close must succeed before saved.
  Failure may leave a partial user file and is never reported as saved.
  Revoke, background and expiry invalidate pending selection and erase bytes.
  Failed file closes retain their owner for retry and block a new pairing/export.
  User-selected saved files are user-owned and are not deleted by revoke.
  Actual Picker URI/lifecycle behavior and Phone UI remain runtime-unverified.
- Encrypted ready explicitly requests `eventBatch:events-v1` and
  `retention:rolling-v1`. Collection starts only after a connected reply with
  exactly the selected fields and epoch. Missing, wrong or extra fields close
  the session. Sampling still sends individual events at 1 Hz; no automatic
  resume, reconnect or throughput change is implied by batch negotiation.
- After encrypted confirmation, `four-timestamp-v1` answers bounded clock probes
  using STARTUP uptime in milliseconds and declares 1 ms quantization. It needs
  `SystemCapability.MiscServices.Time`; probe replies never consume event ack.
  Probe IDs are remembered only in memory, at most 128 per connection. Desktop
  alignment carries its explicit drift assumption; it does not attest clocks.
- `device` is a random run alias, `process` comes from this process PID,
  `sessionId` is random, and build ID is explicitly `unverified:<bundle>:<version>`.
  Matching these fields is not attestation. No authenticated device/build claims.
- Realtime Schema/capability constants and all current public problem schemas
  (including 19 Kit schemas) come from desktop `debug-protocol` and
  `problem-package` sources via root `npm run generate:kit-contract`. Do not edit
  `GeneratedContract.ets`, `rawfile/ohmate-protocol.json` or
  `rawfile/ohmate-problem-schemas.json`. The same generator embeds the app export
  schema layout and domain coverage names; --check rejects generated drift.
- Root `npm run test:kit` runs actual `.ets` protocol/controller logic with
  explicitly substituted Node platform adapters. It is not a device test.
  `OHMatePlatformCrypto` contains four platform known-vector/interop cases;
  an ohosTest build does not mean these cases ran.
- Keep generated default dependencies (`@ohos/hypium` 1.0.25 and
  `@ohos/hamock` 1.0.0); no new dependency or signing profile. Existing backup
  extension remains generated. Invitations, keys and raw text are never
  persisted; only an explicitly confirmed summary can be saved to a chosen URI.
- Release obfuscation is disabled in the generated profile. Runtime debug gate
  does not prove release artifact elimination; distribution remains prohibited.
- `code-linter.json5` explicitly enables `eqeqeq` and `prefer-const` alongside
  generated rules. Studio 26 skips its ESLint engine for the exact default
  config. Prove checks with negative controls; the CLI's `filesChecked` counts
  paths in defect reports, not the number of successfully scanned files.
  CLI 1.3.5 also returns exit 0 for a report containing errors; inspect the
  complete diagnostic report rather than using its exit code as the lint gate.

## Verification Commands

Run project preflight using the workspace's `harmonyos-deveco-cli` skill, then
run these commands in this real application root:

```sh
devecocli check arkts
devecocli check lint entry/src/main/ets
devecocli build --product default --modules entry@default --build-mode debug
devecocli build --product default --modules entry@ohosTest --build-mode debug
```

Current CLI `check compat` only compares a later target version; 26→26 is
rejected. Verify current signatures with the API26 SDK and builds, not a fake
older source version. `check arkts` emits conservative exception/permission
warnings; failure paths and declared INTERNET permission must be reviewed.
No run/UI/log command may target an existing device in this task. Runtime,
platform crypto execution, actual HDC transport and hardware/UI performance
remain unverified until a dedicated authorized target is available.

## Change Synchronization

- Review this `AGENTS.md` for every APP or module change.
- Update it in the same change whenever architecture, API baseline, devices, modules, dependencies, commands, routes, state/data design, permissions, public contracts, performance budgets, validation matrix or known constraints change.
- If a change does not alter durable project facts, do not add timestamps or task logs; report that this file was reviewed and required no update.
- Never store passwords, tokens, certificates, private keys, real accounts, device identifiers or transient command output here.

## Verification

- Before editing, run the HarmonyOS project preflight through `harmonyos-deveco-cli`.
- After changes, run affected-path lint, affected module build and the tests required by the change risk.
- UI and user-flow changes require application run, UI/layout evidence and error-log checks on an appropriate emulator or authorized device.
- Build success alone does not prove tests, UI, functionality, performance or real-device behavior.
- Mark unavailable checks as unverified and document the remaining risk.
