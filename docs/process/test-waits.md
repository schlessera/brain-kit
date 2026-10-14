# Deliberate waits in tests

Every delay beyond computation and IO needs an assertion, a completion condition
or a temporal boundary. A production interval does not justify spending that
interval in real time in its test. The controlled-clock ruling in
[#1855](https://github.com/schlessera/brain-kit/issues/1855) preserves production
policy and changes how tests advance it.

## Choose the observation before choosing a duration

| Wait role | Required proof | Clock or completion control |
| --- | --- | --- |
| Unconditional settling sleep | The operation whose completion matters, including later asynchronous work | Await its acknowledgement, saved revision, rendered state or completed finite animation; then measure stable geometry. |
| Production timer | Actual registration, before/at/after boundary, reset and cancellation | Advance a test clock through registered production callbacks. Assert default values independently; do not call the outcome directly or merely substitute shorter constants. |
| Debounce | Nothing before the deadline, latest edit after it, cancelled work cannot return | Controlled time plus completion of real promise/IO work between advances. |
| Animation/media progress | The browser has actually produced the frame/chunk/commit that the assertion observes | Animation lifecycle and decoded/persisted media events. JavaScript fake time does not advance audio capture or browser compositor/process time. |
| Negative observation | An asynchronous forbidden action had a real opportunity to occur and did not | Advance every relevant timer or await a causal completion barrier. Immediate absence, intermediate DOM state, or a held promise alone is insufficient. |
| Condition polling | A named event or state appeared | Exit on the condition; record actual iterations and elapsed time. The polling interval is latency granularity, not the whole test cost. |
| Failure maximum | An operation did not hang forever | Preserve the failure deadline. A losing timeout branch contributes no awaited deadline duration; clear it on completion. |
| Fixture hold | A native worker remains alive until released/cancelled | Count actual hold time and termination, not the advertised sleep. Retain process-boundary cancellation and cleanup. |

Keep real IO and event processing between clock advances. A fake clock must not
race past a native socket reply or a storage transaction and manufacture a
failure. Observe that reply on the receiving side, after its production handler,
before advancing again. Restore complete property descriptors on teardown;
dispose browser contexts and native workers even when assertions fail.

A real-time exception states the failure mode controlled time cannot reproduce,
a minimum justified observation window with its operational basis and chosen
margin, and its execution domain. State the relevant native opportunities or
completion boundary. One successful run or a mutation delayed by 250 ms does not prove that 500 ms
is the shortest reliable window. Keep native process freeze, browser navigation/download denial, media encoding and pointer
proof native. Expensive elapsed-time confirmation follows the execution-tier
policy in [testing.md](testing.md#required-proof-for-a-pr); it is not silently
removed from required proof.

## Attributed source inventory

The [source-site inventory](evidence/test-wait-sites.tsv) records immutable source
`5dc2595ca07042f2e2024c95bbc361f31637559f`: 597 executable-shaped call-site **lines**
in 248 files: 435 default, 84 runtime, 71 browser/layout and 7 experiment. These
are search domains, not disjoint CI jobs: runtime files can also be part of Bun's
default discovery. A line can contain multiple calls, a helper can be called many
times, and embedded child source is included. This census is not an execution
count, a duration sum, or a claim that every site needs changing. It excludes
mere type references and records the matching source so classifications can be
checked. Each row records the enclosing assertion or helper owner, its role (multiple
roles where the helper serves several contracts), and the neighbouring source
basis. Failure races and embedded child programs are distinguished from awaited
observation windows; fixed-count event-loop yields are not condition polls. All
execution counts and actual elapsed times in this source snapshot are explicitly
unmeasured. Focused execution receipts belong in the delivery PR. Named aliases (`wait`, `settle`, `pause`, `delay`) must also be followed
to their callers when measuring a file; counting their definitions once is wrong.
The [reviewed role annotations](evidence/test-wait-role-corrections.json) correct
specific historical classifications without changing that snapshot's source
identity. [Executed observations](evidence/test-wait-observations.json) keep each
measurement's checkout and file hash separate from the search inventory.

Reproduce the candidate search with `git grep -n -E
'setTimeout|Bun.sleep|waitForTimeout|sleep\(' <sha> -- tests experiments
':(glob)packages/*/tests/**'`; retain executable-shaped calls in TypeScript and
JavaScript. Inspect the surrounding test and callback before attributing a role.
`timeout: 15000`, test budgets and fixture hold loops do not establish fifteen
seconds of successful execution.

The following inspected families explain the actionable cost and the important
exceptions. Unmeasured means no saving is claimed.

| Source / assertion | Attributed role and retained proof | Completion control / native boundary |
| --- | --- | --- |
| SDK `ws-client-liveness.test.ts`, idle/reply/backoff cases | Production timers and negative windows; real registered callbacks, default 15000/5000 ms, early/at boundaries, reset, foreground, wrong nonce, retired sockets, close cancellation and explicit configuration | Fixed elapsed waits replaced by controlled time; fake socket remains the unit boundary. |
| Browser `answer-delivery-runtime.test.ts`, Liveness B | Default timer configuration through the real root/client, Chrome socket route, healthy correlated pong, no premature replacement, missing-pong replacement, replacement hello and actual session history resync | 35000 ms logical timer progression is controlled; native events are awaited separately. No native media or child clock is advanced. |
| `connection-continuity-runtime.test.ts`, repeated recovery | Fixed 500 ms rendering waits mixed with negative observation | Remove only startup and pre-navigation rendering sleeps, with actual ready/streaming composer state and fonts/finite animations/stable geometry. Recovery, queue, save, scroll and IME observations retain 500 ms for delayed focus/save/ghost and no-send effects; add final scoped-status/replay, released-queue and native wheel barriers. Held-history races keep their explicit release/status barriers. Both viewport paths and all ten cycles remain; theme-only copies follow the [central continuity assertion map](theme-parity.md#connection-continuity-runtime-matrix). |
| `html-preview-runtime.test.ts`, escape attempts | Two 1500 ms native negative windows per successful frame/tab pair, starting after the actual click lands | Retained. A browser-process navigation/download may arrive after the renderer's click handler or DOM settles; page JS clock does not drive it. 1500 ms is the existing bounded observation budget, not a newly measured universal browser latency guarantee. Expected escape controls await their actual hit independently. Candidate/runtime proof. |
| Same preview file, raw endpoint 500 ms | The raw route has reached `load`; the inline-script marker must remain unchanged | Retained. This is a separate load-boundary observation, not evidence that the iframe escape channels need the same duration. A missing-CSP mutation at the load boundary is needed before claiming equivalent completion; no speedup claimed. |
| `turn-scope.test.ts`, long Bash loop | Registered 15 s host observer is controlled; independent 20 ms observer, 50 ms writer and freeze windows remain native | [Scope observer proof](scope-observer-proof.md) retains actual dispatch, overshoot, confirmed freeze and copied-snapshot counts. Before capture, at least eight native observations span 150 ms; the final 150 ms no-progress window requires at least five ticks. Other scope cases retain their own timing obligations. |
| `draft-client.test.ts`, device-only/unsupported/conflict/retry | Actual debounce/retry timers and negative upload windows advance logically | The scheduler retains before/at-boundary, reset and cancellation observations. Real request/body promise completion is observed between advances; all original negative horizons remain or extend. Native completion turns are separate from logical milliseconds. |
| `ws-session-recovery.test.ts`, stalled backend lookup | Actual 3000 ms recovery registration and callback delivery advance logically in the named case only | The empty backend and its wrapper complete before advancing; silent reads stay pending at 2999 ms and fail at 3000 ms. A winning aggregate can leave losing bounded probes pending. Timed-out backend reads remain reusable because they have no cancellation API; teardown releases fixture reads, drains wrappers and restores descriptors. Native finalization, admission and revocation cases retain their existing clocks. |
| `recordings.offline.tsx`, hard duration cap and chunk drain | Native media progress, persistence and temporal limit correctness are distinct | [#1853](https://github.com/schlessera/brain-kit/issues/1853) owns their separation; 600 ms chunk waits are not automatically the ten-minute cap. Preserve real encoded/playable audio and committed boundaries. |
| `association-signout-runtime.test.ts`, 1100 ms capture and 300–600 ms post-release windows | Native media vs negative late-writer/deletion observation | Unmeasured. Await actual chunk commits for capture; a deletion window needs writer completion plus all delayed callbacks before it can be removed. |
| `auth-expiry-runtime.test.ts`, 400 ms entrances and 1800 ms post-restore observation | Login entrance settling vs no delayed navigation/restored-state observation | Unmeasured; no common shortened timeout is selected. |
| `parallel-sessions-runtime.test.ts`, 300–1000 ms observations and polling | Mixed no-send/security windows, pointer holds, readiness and socket completion | Unmeasured. Preserve the distinct pointer/auth/backend assertions; source literals are not summed. |
| Render/store suites' 0–30 ms ticks | Event-loop or React-effect drain; some are delayed negative checks | No large-duration claim. Prefer actual effects/receipts where available, preserving later forbidden work. |
| Native worker fixtures with 60000/120000 ms sleep, shell hold loops | Hold until cancellation, not a mandatory full wait | Count actual child lifetime; assert termination/exit and retain independent native witnesses. |
| `experiments/measurement-results.test.ts` | 1 ms byte-wise stdout chunk spacing and 10 ms post-write observation; 5000/500 ms child watchdogs | Experiment-only; watchdogs are maxima. No product-proof migration or measured saving. |
| `experiments/turn-surface-stdout.test.ts` | 25 ms delayed SDK-facing reader; child emits a second frame after 150 ms | Real stdout completion/order; retain child transport and exit. 150 ms is fixture scheduling, a candidate for an explicit release barrier, not a timeout claim. |
| `experiments/pi-schema-measurement.test.ts` | 60000 ms child-kill watchdog | Failure cap only; not a minute of mandatory waiting. Keyless harness only, no provider call. |

Other costs found in this census are not permission for a broad rewrite. Review
the enclosing assertions and file a bounded task before changing another family.
Existing issues #1242 (PDF effect readiness), #1685 (hygiene layout readiness),
#1837 (repeated build attribution), and the recording/matrix children retain their
ownership rather than being duplicated here.

## Continuity settling boundaries

The rendering helper (`finishRender`,
`packages/ui-react/tests/connection-continuity-runtime.test.ts:298-323`) waits
finite animation completion, fonts and two stable geometry frames. It does **not**
claim arbitrary asynchronous work is finished. The negative-window helper
(`settle`, `packages/ui-react/tests/connection-continuity-runtime.test.ts:332-342`)
retains the original 500 ms and two animation frames. It does not add a wait for
all finite animations at these negative-observation sites. The finite-animation
helper is limited to the four pure-render call sites and its readiness control.

| Call site | Causal completion before measuring | Observation retained |
| --- | --- | --- |
| Scene startup; snapshot startup | Connected host and advertised draft support; the ready Send action or streaming Stop state is observed before Enter (streaming keeps Enter available) | Rendering only; no recovery/no-send baseline exists yet. |
| Scene's first running text before New chat; snapshot's original running text before arranging its race | The expected text is rendered; next navigation/input is a real browser action | Rendering only; later race/recovery observations remain. |
| Scene after scrolling | Draft Saved plus host revision/content/attachment acknowledgement, then actual wheel movement | 500 ms; captures layout after delayed draft-save/ghost effects. |
| Drop | Upload abort processed, disconnected transport, unreachable host and visible banner | 500 ms; late focus, send and upload-state reactions remain observable. |
| Recovery | Connected host, removed banner, final scoped status and completed replay; intentionally held-history cases use their own release/status barrier | 500 ms; reconnect cannot hide a later focus/send/ghost effect. |
| Released queues | Every held queue frame is observed by the receiving page; expected upload state is awaited before its assertion | 500 ms; pending-pill identity/removal remains guarded through delayed work. |
| Snapshot turn end, newer turn text, released old status | Named streaming/text/status state from the test's native host/race | 500 ms; a late old status must not end the live turn or disturb focus. |
| Recovered turn completion | Terminal text, non-streaming state and queued follow-up text | 500 ms; node identity and disappearance of the consumed pill are checked after delayed rendering. |
| Native IME start/commit | CDP's real IME operation has returned; expected composition events, text and selection are checked afterward | 500 ms; no forced end/blur from a delayed reaction. Final committed draft also reaches the host. |

The held-history gap case intentionally releases its final history after the
recovery observation window. Its later node/text check proves replay continuity;
it is not the witness for delayed focus loss after final status. The ten-cycle
case observes that later effect through its retained native window.

The history and queue receiving observer is only a barrier for the current
synchronous production handlers, not a generic asynchronous-handler completion
claim: `session_history` and scoped `status` update the chat store synchronously
(`session_history`, `packages/ui-react/src/hooks/websocket-handlers/chat.ts:436-456`;
`status`, `packages/ui-react/src/hooks/websocket-handlers/chat.ts:457-481`), while
queue adoption updates the follow-up/draft stores synchronously (`if (msg.type ===
"session_queue")`, `packages/ui-react/src/connection.ts:379-391`). Native protocol
completion, committed store state and the retained observation window serve
different purposes. A future asynchronous handler needs its own committed-state
acknowledgement before this barrier remains sufficient.

## Measuring a replacement

Record the source SHA and exact changed inputs, Bun/browser versions, resources
and scenario count. Serialize comparable local runs; report uncontrolled host
load. Keep test-body, whole-file, setup/build and actual awaited delay separate.
A fixed wait's requested duration is only a lower bound on elapsed waiting;
polling needs its execution count. CPU time and maximum RSS describe resource
cost, while CI queue delay, runner consumption and critical path need their own
receipts. Historical runs from another SHA are context, not controlled gains.

For each changed temporal guarantee, preserve a named mutation/restoration
receipt: early and late registration, wrong interval, lost cancellation, and
premature readiness. A timeout or module-load failure alone does not demonstrate
the intended assertion. The delivery PR holds measurements and mutation receipts;
this document holds the durable rule and source attribution, not work status.

## Reading executed observations

The [measurement sample](evidence/test-wait-observations.json) records ten full
files at their actual source identities. It is historical evidence, not a list
of all tests or a repository-wide cost total. Each observation names its original
line and column or helper anchor, the scenario contexts captured when it began,
started and completed counts, and accumulated duration. Zero means an observed
zero; a null total means a started observation did not finish. Missing metrics
remain unmeasured. Source helper counts never stand in for execution counts.

The commands retained their existing offline guards, original waits and assertions.
The evidence records actual environment overrides and guard scope. These were
local commands, without a recorded network-namespace or container wrapper; the
Bun preload is not proof of native browser socket isolation. Hosted required
proof retains its own environment and is not replaced by these observations.
Temporary synchronous counters were removed byte-for-byte. Whole commands were
timed inside a shared benchmark lock; unrelated host load and observer overhead
were not controlled. Build time is inside the owned runtime commands but outside
the shared association command, whose build also served another file. CPU and
maximum RSS describe the timed command's process tree; maximum RSS is not the
sum of simultaneous process memory. These samples are attribution, not savings.

Several distinctions matter when interpreting the data:

- Association samples distinguish actual condition completion from native media
  capture and late-writer/deletion windows. Parallel-session samples distinguish
  physical pointer holds and host-stop transport drains from renderer settling,
  readiness and no-send/security observations. These measurements do not justify
  removing the later forbidden-effect assertions.

- Renderer phase-budget outcomes overlap fixture delays and each other. Their
  accumulated completion time can exceed test-body wall time. None of the
  45 failure watchdogs fired, so their configured maxima are not elapsed costs.
- The Unix-manager fixture started a 100 ms response delay, but the client
  reached its 20 ms deadline and the process exited before that delay completed.
  The fixture's total duration is unknown; it is neither zero nor 100 ms of
  measured awaited cost. Its real Unix transport and uncertainty assertion remain.
- PDF fixture timer delivery is registration-to-callback latency, separate from
  explicit awaited sleeps. Its 60000 ms error-control deadline does not mean a
  minute of successful execution. Silent-worker deadlines, late error delivery
  and retired-worker cleanup are different observations.
- Native condition completion includes IO and event processing. Its internal
  polling count is unknown unless that polling loop itself was instrumented.
  The in-memory recording-transcription tests do not prove native media encoding.

The unit samples also explain relative horizons without inventing native
exceptions. A keyed-lock 40 ms observation crosses its configured 30 ms cancelled
waiter deadline. Fake renderer delays separate overlapping acquisition/render
budgets; late-cleanup sleeps give continuations an opportunity to run. A PDF
retirement window observes disposal while a retry is still held. These
in-process doubles do not establish a need for real browser or process time;
clock or completion replacements must still preserve their negative assertions.

Native browser denial and continuity windows retain their existing bounded
observation policy. Actual navigation/download cancellation acknowledgements or
complete delayed-effect boundaries would be needed to replace them. A stable
DOM frame alone does not establish either. Scope's independent writer/observer
opportunities have a different, explicit native rationale in its proof document.
Execution ownership follows [required proof](testing.md#required-proof-for-a-pr);
an expensive negative window is not automatically an endurance scenario.


## Default-test observations with native network isolation

The [additional default-test sample](evidence/test-wait-default-observations.json)
records frozen source `04a659593379a0c8da9c049fa649124d6fd54f70`: 70 complete
files and five selected enrichment cases, plus a separate imported-await
observation of the already measured scrape client. These are 72 runs across
71 files. The first set passed 1009 cases and 5337 expectations; the imported
observation repeats 28 cases and 70 expectations. They are neither unique
repository-wide assertion counts nor a savings comparison. Each run retains
its file hashes, command, actual wait sites, case identities and resource data.

These commands used the existing preload and doubles inside an explicit user
and network namespace. The wrapper enabled only loopback, verified that no
routes existed, and timed the test after namespace setup and lock acquisition.
Early samples mapped namespace uid 0 to the ordinary host user. Later samples
retained uid 1000 and dropped setup capabilities before running Bun; each record
names its actual profile. No browser launched. Render samples use happy-dom and retain real React effect
processing with scripted transports; they make no Chromium paint or geometry
claim. Real SQLite/filesystem work,
scripted provider streams, local HTTP where used, native FIFO IO, and the
writer-gate dead-process fixture retain their respective boundaries. This environment does not amend the
earlier direct observations' isolation limitations or replace hosted proof.

`reportedBodyMs` sums only case timings emitted by Bun. A case with no emitted
timing has `bodyMs: null`; it is not assigned zero. Observation counts include
zero-execution source sites. Case indexes map the executed callback ordinal to
the runner's full case name; parameterized source-name patterns are retained.
Helper spans may overlap their leaf waits. For example, enrichment has six
measured helper spans containing 60 native event-loop turns, not 66 independent
turns. Concurrent fixture requests can likewise accumulate more elapsed time
than their shared test body.

The samples establish several useful distinctions:

- A scrape client's injected pacing clock did not control its imported HTTP
  retry sleep. The separate imported observation measured four native retry
  waits totaling 1462.284 ms and six controlled pacing completions totaling
  0.062 ms, with no observed default native pacing wait. Retry jitter was not
  pinned between attribution samples; their 2.31 and 1.58 second file durations
  do not measure a speedup. [The retry-clock scope](https://github.com/schlessera/brain-kit/issues/1918)
  preserves that distinction.
- Authentication and pricing race observations completed promptly despite
  100–500 ms watchdog branches. Those watchdogs did not win the measured races;
  callback execution later in the file was not counted. Session recovery did
  await its actual 3000 ms production deadline: 3001.349 ms observed, rather
  than the losing test watchdog's 6000 ms. [The recovery-clock scope](https://github.com/schlessera/brain-kit/issues/1922)
  retains concurrent probe ownership and unfinished-read reuse.
- A native FIFO test completed its readable-pipe race in 8.292 ms while 272
  other pipes remained idle. The 5000 ms watchdog did not win. Pi autonomous
  yield instead races work against cancellation without a timeout branch; its
  three completed races are operation spans, not watchdog budgets.
- The track-draft 5 ms delay separates wall-clock timestamps before reopening
  and adding to a queue. It does not observe a forbidden asynchronous action.
  Store helpers using `setTimeout(..., 0)` are native timer turns, even where an
  older source comment calls them microtask hops.
- A journal-copy test uses a native 1 ms interval as an event-loop responsiveness
  witness while copying 8 MiB. It observed 42 callbacks before the first copy
  completed and 80 before clearing the interval; three file-operation spans
  totaled 154.447 ms. It never sleeps for a chosen capture duration. Delivering
  fake callbacks after a blocking copy would not prove that other sessions
  could run during the IO. The requirement is at least one real callback before
  completion, not a universal minimum elapsed copy time.

Some relative horizons have a concrete source basis without establishing a
need for wall-clock time. The writer-gate's four 60 ms windows observe locking
and cancellation over its configured 10 ms polling interval; the revert-gate's
10 ms observation covers configured 1 ms polling. Inbox unsubscribe retains a
150 ms no-scan observation after cancelling a 100 ms foreign-write poller.
These native opportunities and existing margins identify what a replacement
must preserve. They do not prove that the margins are minimal or that controlled
registration/callback delivery would be insufficient.

The data leaves those replacement and minimum-window questions explicit. Test
file counters alone do not enumerate imported timers or embedded child work;
a source line with zero observed execution is not a proof of zero repository
cost. For example, the Claude held-result test reports about 3000 ms of body
time matching its imported acknowledgement grace, while the separately
observed 500 ms watchdog race completed promptly. Its imported timer
registrations and callbacks remain outside this sample. One nested authentication wait remains uninstrumented to preserve the
original enclosing await expression. Browser media, native fixture lifetimes,
independent process observations and experiment readers require their own
attribution. Higher measurement cost is not itself a reason to exempt them from
the rule or move them out of required proof.


## Native fixtures, renderer effects and experiment transports

The [native observation sample](evidence/test-wait-native-observations.json)
retains a separate frozen `04a659593379a0c8da9c049fa649124d6fd54f70` identity.
It records 103 command observations across 101 files, plus four unmodified
selected location controls. Ninety-nine observed commands passed and four failed;
the failed outcomes and repeated subsets remain explicit. Its render cases use happy-dom and real React effect processing; its native
cases exercise their existing child processes, filesystem, sockets and worker
boundaries. None launched Chromium. Experiment commands select three files,
after a separate build and copy installation of the same lock; they are not a
complete experiment-tier or release receipt. The data records exact commands,
file hashes, original observed expressions, case outcomes and resource use.

Each command ran inside the shared benchmark lock and an explicit user/network
namespace. The wrapper retained the ordinary user identity, enabled loopback
and dropped setup capabilities before timing Bun. One selected inbox control
also provided a namespace-local dummy interface at a reserved benchmark address:
no external link, gateway or default route was present, and all capability sets
were recorded as zero. This lets its original non-loopback bind/refusal oracle
run without giving the child external connectivity. The earlier loopback-only
run failed four fixture prerequisites; that is a harness mismatch, preserved
separately from the four-case passing control.

Four unsuccessful full-file commands remain in the sample. The other three
encountered the checkout-location-sensitive fixture oracles tracked in
[#1931](https://github.com/schlessera/brain-kit/issues/1931). Separate selected
controls use identical source in a non-temporary checkout. The host-boundary
case had already proved absence of the host sentinel; its failing text oracle
confused a same-spelled file in worker-private temporary storage with refusal
of a host path. Passing changed-environment controls neither repair temporary
checkout support nor turn an earlier full-file failure green. Passing siblings,
failed cases, repeated controls and unexecuted paths remain distinguishable.

The observations separate several temporal contracts:

- The native boot-probe suite keeps thirteen real process-deadline cases. Its
  existing lower oracle is 4950 ms for a 5000 ms deadline, with a 1500 ms
  settlement margin for loaded scheduling. The eight-second fixture holds do
  not run to completion. These bounds explain the present 66.73 second command;
  they do not prove that five seconds of wall time is necessary to test every
  deadline branch. A clock replacement still needs actual registered callbacks,
  real process termination, ineffective-killer behavior and cleanup witnesses.
- Seven stale-write watchdogs requested 20000 ms; none fired, and all seven were
  cleared after roughly 329–357 ms. A supplemental HTTP observation recorded
  four 3000 ms watchdogs, also cleared without firing. These registration-to-clear
  ages are lifecycle measurements, not awaited sleeps. The server-import
  watchdog likewise cleared without firing. A losing race alone would not have
  established whether its callback ran later; these records actually observe
  the local native timer handles.
- Native worker publication retained its 1 ms interval during the 16 MiB copy.
  It observed 65 callbacks before clearing the original handle after 72.851 ms.
  The oracle concerns actual destination publication during IO, not elapsed
  waiting for a chosen duration. This copied-manager fixture does not qualify a
  real Btrfs installation. Imported timers and embedded worker holds outside
  the observer remain unmeasured.
- Geo fixtures retain native pacing, cross-process lock behavior and deliberate
  provider latency. The stalled-operation races completed after approximately
  507 ms and 5023 ms; those are observed winners, unlike the unrelated losing
  watchdogs. The explicit 1 ms byte spacing, 10 ms post-write observation and
  150 ms late-EOF schedule in experiment children are fixture scheduling, not
  successful waiting for their larger kill deadlines. Child callback counts
  remain unmeasured where adding telemetry would change the transport oracle.
- Isolated renderer files preserve both the outer harness and embedded child
  suite. The outer case already contains child execution; child case counts,
  operation spans and reported body timings are separate. React `act`, helper
  completion and their inner timer turns can overlap. Neither two effect turns
  nor a stable DOM state establishes that a later forbidden effect is drained.

`reportedCaseBodyMs` sums only timings emitted for the recorded cases, including
failed cases when Bun reports their timing. Missing timings remain null. The
observations include zero-execution sites; they are not zero-cost claims about
imported or child work. Native timer callback ages and clear ages are distinct
from accumulated awaited durations. Source restoration and unchanged original
await/expectation expressions protect the existing test oracles, but temporary
observer overhead and shared-host load were not controlled. These are attribution
receipts, not before/after speedups or a replacement for required hosted proof.

Minimum-window review still follows the rule above: name the forbidden effect,
its real opportunities to occur, and a minimum justified observation window with
its operational basis and chosen margin. The source can establish a relative
ordering or an existing tolerance without establishing the smallest reliable
native duration. Native cancellation, publication and stdout ownership must
remain proven even when a registered host timer can advance logically. Missing
callback counts or imported-operation spans require their own scoped evidence;
expense alone is not an exception or a reason to move proof to endurance.


## Browser, callback and source-bound horizon observations

The [browser observations](evidence/test-wait-browser-observations.json) retain
70 selected project/file commands at frozen source
`04a659593379a0c8da9c049fa649124d6fd54f70`, plus four explicitly overlapping
leaf-observer supplements. The initial commands passed 5,599 case executions;
this is not a distinct-source test count or complete browser qualification.
Their 27 unexecuted cases are individually named: ten original fine-pointer
keyboard skips, sixteen deliberately excluded existing failures, and one reused
native endurance case. The supplements passed 102 case executions. All three
pointer projects remain represented. The pinned offline image, actual selection,
source hashes, per-case outcomes/body times, per-site observations and resources
are recorded separately. Scenario-indexed observation arrays use the columns
and label table supplied in each record.

The [completion observations](evidence/test-wait-completion-observations.json)
cover ten callback supplements, seven native host callers, five direct native
browser files, one selected artifact-frame case, the tracker counter repeat,
one selected delegated-cgroup case and one unchanged containment control.
Original child streams, exit assertions, native handles and test awaits were
retained. These are overlapping attribution records, not a new complete test
suite or a before/after speedup. Native-browser commands preserve their recorded
required-browser flags and explicit offline namespace; setup/build hooks are
separate spans inside the whole command where applicable.

Observation points matter. Bun's ordinary process-exit hook did not produce the
first ten callback sidecars, despite passing tests. Those missing counts remain
missing. The corrected `afterAll` records describe only that snapshot: later
teardown or callbacks can still occur. Ordinary child exit hooks can likewise
precede later exit listeners. A zero count means zero by the captured point;
an actual original timer clear/fire is stronger lifecycle evidence. Multiple
source candidates sharing a forwarded timer delay remain a candidate group,
not one execution attributed to each source site. Registration ages, callback
ages, operation completion and accumulated awaited time are different quantities.

Two diagnostic limitations remain visible. The first tracker command passed
12 cases and 128 expectations, but a post-run parser overwrote its direct
sidecar. Its empty arrays are invalid telemetry, not zeros. The separate unchanged
repeat passed the same assertions and records its own 78.47-second command (78.39 seconds reported by Bun),
setup and counters. The observed containment command passed three cases and
failed the Pi upstream-connection assertion; a separate unchanged selected
control passed one case and 69 expectations, with three cases filtered. The
six earlier listener counters do not cover the separate upstream, and the later
route/header assertions were not reached in the failure. Neither the control
nor a possible cross-namespace port collision establishes the cause;
[#1945](https://github.com/schlessera/brain-kit/issues/1945) retains that diagnosis.

The delegated-cgroup record is also selected proof: one case, 30 expectations,
and 22 filtered siblings. The original availability gate passed. The scoped
child recorded ordinary identity, loopback only, no routes and zero capabilities;
there is no claim of injected Bun preload through `systemd-run`. Its original
100 ms sampler fired twenty times and was cleared after 2,086.60 ms. The nested
shell's two-second lifetime and the CPU workload are separate, uncounted paths.
No cgroup capability or worker authority was broadened for the observation.

The [operational basis](evidence/test-wait-operational-basis.json) reconciles all
597 historical and 134 supplemental source rows, across 287 files. The original
inventory remains immutable. These 731 rows are source lines, not executions;
131 causal groups describe 309 rows sharing reviewed assertion paths. The other
rows retain their individual timer, sampler, frame, watchdog or fixture roles.
The records use epistemic classifications, source identities and missing
equivalence evidence. A measured site is not automatically a justified native
exception. A passing parent command does not count its embedded child's waits.
Retired source, source-candidate ambiguity, failed commands and unobserved
nested paths remain distinct from observed zero calls.

Several boundaries explain why elapsed cost alone cannot select an optimization:

- The retained HTML 1,500 ms windows follow acknowledged native actions and the
  established #1108/#1119 proof scope. Expected escapes await their actual hits
  independently. These are retained operational windows, not a measured physical
  minimum. The raw-route marker check uses its own native load boundary.
- Continuity's 500 ms windows guard delayed focus, save, queue, history and IME
  effects after their named acknowledgements. Two native frames or a completed
  animation do not establish that all later forbidden work is drained.
- Cold capture's 1,300 ms interval permits real audio capture and committed bytes;
  its 350 ms entrance preparation has a different role. The 150 ms held-write
  and no-premature-mount windows remain negative observations. A JavaScript
  clock cannot produce native media samples.
- The renderer phase-budget fixture uses browser doubles. Its production
  2,000 ms cleanup timer, delayed fixture phases and 45 cleared outcome watchdogs
  have separate owners. The 3,012.94 ms summed bodies, 642.85 ms fixture awaits
  and 3,269.64 ms overlapping outcomes cannot be added together.
- Native frame workloads, pipe backpressure, process freeze, filesystem
  publication and child termination need their actual opportunities. Embedded
  shell loops, killed fixture holds and imported helpers without telemetry retain
  explicit missing counts; their source literals are not elapsed totals.

A minimum justified observation window still needs its operational basis and
chosen margin. Source arithmetic can explain an existing allowance without
proving the smallest reliable scheduler bound. Where that evidence is absent,
the records say so; they do not declare the exception complete or move it out
of required proof. Controlled-time children and native harness diagnostics keep
their own source and mutation receipts. The execution-policy work in
[#1854](https://github.com/schlessera/brain-kit/issues/1854) does not make unrelated
measurement or equivalence gaps disappear.

## Selected child and imported-helper observations

The [child observations](evidence/test-wait-child-observations.json) add ten
selected commands at the same frozen `04a6595` source: fourteen passing case
executions, 72 expectations and 75.79 seconds of command wall time. They overlap
the earlier whole-file records. The commands retain the original test wrapper,
preload and assertions inside an explicit ordinary-UID network namespace with
loopback only, no routes and dropped capabilities. This is attribution, not an
optimization comparison or complete qualification of the selected files.

The observations distinguish the work actually awaited:

- Two fragmented native-result cases each completed 532 one-millisecond byte
  waits and one ten-millisecond pre-exit wait. Their actual SDK transport,
  stdout bytes, native exit and receipt assertions remain intact. In-memory
  observations add one diagnostic file write at ordinary child exit, within
  existing filesystem authority and without per-byte IO. Rejecting or killed
  callers are not covered by those two snapshots.
- Two real geo admission children completed their original 1,300 ms delays in
  2,603.18 ms accumulated time. Their separate clock origins cannot be compared
  as absolute timestamps. The parent still proves shared admission and native
  connection ordering.
- Six host-process helper calls completed 33 ten-millisecond polls, totaling
  551.92 ms. The 687.32 ms helper spans also contain `/proc` scans; both are
  included in the 14.42-second selected command total. Neither measures timers
  inside the discovered children.
- Five other selected cases observe a 30 ms fixture delay, two native zero-delay
  turns, a 350 ms late-response fixture and an actual 1,000 ms watchdog cleared
  after 0.40 ms without firing. The native browser case includes 49.88 seconds of
  mandatory setup/build within its 51.54-second command, rather than attributing
  that time to its 0.10 ms timer callback.

The same artifact recovers eight original dispatch-frame callback events from
two saved, two-device traces. These are earlier observations, excluded from the
ten-command totals. Their capture points establish callback counts, not callback
duration or later teardown completion. Original source, log and artifact hashes
retain the association; file timestamps alone are not execution attestation.

The [child source basis](evidence/test-wait-child-basis.json) gives causal roles
for all 75 embedded-program rows and sixteen additional reviews covering 29
imported, helper, race and control-input rows. The original 731-row artifact is
unchanged. A fixture that keeps a process alive for cancellation has no required
completed sleep duration. A watchdog is a failure ceiling; a denied shell string
and a logical scheduler declaration are not native waits. Conversely, a ready
file can precede timer registration or entry into an indefinite hold, and a
reached polling loop can execute zero iterations. Those source distinctions do
not manufacture missing runtime counts.

Exact nested counters remain absent where the existing receipt does not expose
them. Collecting those counters must preserve child authority, protocol streams,
native handles and every original assertion. Numeric minimum and equivalence
questions remain separate: a native negative window still needs the forbidden
effect, actual opportunities, minimum justified duration and chosen margin. The
source review does not complete those requirements or authorize moving proof
to another tier.

## Native child completion and deadline snapshots

The [native child supplement](evidence/test-wait-native-child-observations.json)
records fourteen further selected commands at frozen `04a6595`: nineteen passing
case executions, 191 expectations and 9.72 seconds of command wall time. These
observations cover nineteen source rows and overlap earlier full-file receipts.
The historical inventories and source reviews remain unchanged. Original native
streams, database operations, process exits and assertions remain intact inside
the explicit offline namespace. Ordinary child sidecars use existing filesystem
authority; their synchronous IO is included in command time but outside recorded
wait spans. No worker permissions or inherited descriptors were added.

The snapshot boundary matters as much as the count:

- Native late output fires one 150 ms timer; a slow pipe consumer fires fifteen
  2 ms resume callbacks. Two CI-runner 1,500 ms watchdogs and one 60-second
  keepalive interval clear without firing. Those lifetimes are not completed
  waits. The closed-input oracle completes one synchronous 1 ms poll.
- Six ledger reads each create and clear the original 5,000 ms watchdog, with
  one completed read and one chunk per call. Four are parent observations and
  two are separate child observations. Their overlapping ages cannot be added
  as elapsed test cost; other ledger callers are unmeasured by this selection.
- Four eager race deadlines have registered but remain pending at `afterAll`.
  That establishes no completion by the snapshot, not zero cost or what happens
  during later teardown. The original races and their expected results remain.
- The in-flight MCP gate completes seventeen 10 ms polls in 172.40 ms. The
  broken-output child completes its 50 ms wait before the original native exit
  code 7. Two unwind children complete their 50 ms waits in 100.20 ms combined;
  the diagnostic writes precede their unchanged readiness JSON publication.
  Their parents still assert native SIGKILL recovery and exact protocol output.
- Nine inbox and schedule children complete nineteen condition polls and one
  300 ms SQLite lock hold. Polling totals 157.06 ms and the hold takes 300.27 ms.
  Counts describe the selected interleavings, not a minimum required iteration
  count. The selected claim, restart and admission cases do not qualify the
  earlier failed listener-interface cases or unselected crash modes.

A separate pinned-browser observation logs the original canvas-load result:
22 completed CPU-work frames and 396 ms of main-thread work in one selected
979.40 ms case, within a 5.23-second command. The actual pointer, native encoder,
no-idle provider flag and every matcher remain unchanged under Docker's disabled
network. This is the helper's returned work count, not independent telemetry of
all animation-frame registrations or callbacks. Its time overlaps the body and
command; it is excluded from the fourteen-command child total.

Two rejected diagnostic arrangements remain separately recorded: a 0.16-second
observer recursion failure, caused by declaration hoisting in Bun's CommonJS
child mode, and a 0.15-second passing pricing probe rejected by the strict raw
matcher-identity check. The corrected observers preserve native callbacks and
original matcher expressions. Neither rejected arrangement is a product failure
or a behavior mutation; neither contributes accepted timer counts.

The same artifact contains a separate raw-HTML load-boundary experiment. Its
baseline observes the original 500 ms wait completing in 500.94 ms. With that
wait removed and the existing native `load` boundary explicit, allowing inline
script in the actual served CSP makes the unchanged marker assertion fail:
`Script ran in the tab` replaces the expected `Script did not run`. Restoring
the CSP makes the candidate pass. All source was then restored byte-identical.
The three commands cost 157.12 seconds, including each mandatory fixture build;
the 1,340.94 ms baseline and 571.14 ms passing candidate bodies are single
samples, so their difference is not wholly attributable to removing 500 ms.

The raw-route test now uses that explicit native load boundary and omits its
500 ms wait and bookkeeping. The marker changes synchronously before the first
await in its fixture script, so this boundary retains the original opportunity
to detect broken CSP. The immutable experiment remains tied to its historical
source; current-head qualification is recorded separately with the change.
This establishes no equivalence for the separate 1,500 ms acknowledged native
escape windows or continuity's delayed effects.
The remaining native observation windows still need their forbidden effect,
actual opportunities, minimum justified duration and chosen margin. Condition
samplers, unexpired deadlines and killed fixture lifetimes have different roles;
missing counters do not turn them into mandatory completed waits or excuse
unrelated evidence gaps.
