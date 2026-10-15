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
| `connection-continuity-runtime.test.ts`, repeated recovery | Fixed 500 ms rendering waits mixed with negative observation | Rendering preparations use actual ready/streaming composer state and fonts/finite animations/stable geometry. The two old-slot snapshot preparations await fresh scoped native idle, and the two newer-turn preparations await current-socket resync completion plus finite rendering, and the three held-snapshot recoveries await current draft acknowledgement and held-read admission. Snapshot drop preparations retain native offline/status/banner checkpoints and use finite rendering; scene drop/recovery, queue, save, scroll and IME observations retain 500 ms for delayed focus/save/ghost and no-send effects; add final scoped-status/replay, released-queue and native wheel barriers. Held-history races keep their explicit release/status barriers; their final selection boundary requires all owned history/error completions and the actual native selected-context commit followed by its postcommit publication. Both viewport paths and all ten cycles remain; theme-only copies follow the [central continuity assertion map](theme-parity.md#connection-continuity-runtime-matrix). |
| `html-preview-runtime.test.ts`, escape attempts | Positive navigation and every original denial attempt retain native completion evidence and original escape assertions | Exact destination load for self-navigation; original call return plus native correlated denial for popup/form/top. Downloads require complete native tracing with the sandbox-denial event inside the exact anchor call on the same document and renderer thread. Missing evidence fails; actual escape reaches original assertions. Delayed-call, premature-completion and real-policy mutations cover the boundaries. |
| Same preview file, raw endpoint | The former 500 ms wait is removed; explicit native `load` retains the original inline-script marker assertion | The actual served-CSP mutation fails that unchanged marker at the load boundary, and restoring CSP passes. See the [raw-load experiment](#native-child-completion-and-deadline-snapshots) and its [source-bound evidence](evidence/test-wait-native-child-observations.json). This does not shorten the separate denied-action windows. |
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
helper serves the four original rendering call sites, its readiness control,
the two newer-turn preparations after their scoped resync acknowledgement,
the three held-snapshot recoveries after current draft acknowledgement, and
their drop preparations after the native offline/status/banner checkpoints, and
the three released-snapshot cases after their native selection and history
completion boundary.

| Call site | Causal completion before measuring | Observation retained |
| --- | --- | --- |
| Scene startup; snapshot startup | Connected host and advertised draft support; the ready Send action or streaming Stop state is observed before Enter (streaming keeps Enter available) | Rendering only; no recovery/no-send baseline exists yet. |
| Scene's first running text before New chat; snapshot's original running text before arranging its race | The expected text is rendered; next navigation/input is a real browser action | Rendering only; later race/recovery observations remain. |
| Scene after scrolling | Draft Saved plus host revision/content/attachment acknowledgement, then actual wheel movement | 500 ms; captures layout after delayed draft-save/ghost effects. |
| Scene drop | Upload abort processed, disconnected transport, unreachable host and visible banner | 500 ms; late focus, send and upload-state reactions remain observable. |
| Snapshot drop | Original native offline/status/visible-banner checkpoints; no held upload or immediate offline geometry oracle | Existing finite-native rendering. Current draft acknowledgement remains on recovery; final no-send and identity observations remain. This does not certify every Motion banner animation or drain future work. |
| Scene recovery | Connected host, removed banner, final scoped status and completed replay; intentionally held scene histories use their own release/status barrier | 500 ms; reconnect cannot hide a later focus/send/ghost effect. |
| Snapshot recovery | Connected host and removed banner; initial native restore, acknowledged current draft, and actual current-socket resume/connect reads admitted to the held backend gate | Scoped acknowledgement plus finite rendering. The released-history/selection boundary remains separate; no history or storage drain is claimed. |
| Released queues | Every held queue frame is observed by the receiving page; expected upload state is awaited before its assertion | 500 ms; pending-pill identity/removal remains guarded through delayed work. |
| Snapshot old turn end | Non-streaming UI plus fresh native idle for the exact old session and turn | Actual host-slot completion before the peer starts its successor. |
| Snapshot newer turn text | Initial reconnect reads are held; subsequent current-socket resume/history/detail completion, committed newer turn and clean current draft | Actual scoped acknowledgement plus finite-render readiness before selection; released-history/native-selection completion remains separate. |
| Snapshot released old status | All held current-socket history/error completions plus the captured old-turn status; exact selected-context native commit and its associated postcommit publication | Scoped operation readiness then finite rendering, with original streaming, retained-node, focus, draft, selection and no-send assertions. Later context work can remain pending; this is not a global drain. See [selection completion](#continuity-snapshot-selection-completion). |
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

## Positive HTML navigation completion

The [native navigation experiment](evidence/test-wait-html-navigation-boundaries.json)
separates three positive navigation halves from the seven denied-action windows.
Each fixture makes one synchronous location assignment; the attacker destination
is static HTML with no scripts or subresources. After the original actual-hit
gate, the test observes that exact document's native `location.href` and
`document.readyState === "complete"`. For the iframe, an actual changed app URL
instead returns the escape result to the original assertions. Detachment alone
never establishes completion. This boundary is specific to the fixture and does
not claim to drain arbitrary browser or application work.

Two native controls establish different parts of that guarantee. Holding the
response body for two seconds after its headers and hit makes each of the three
destinations visibly `loading`; the candidate returns only after body release
and native completion. Omitting completion fails an additional diagnostic check
with expected `complete`, received `loading`. Separately, enabling top navigation
in both actual sandbox guards and changing the self-navigation fixture's target
makes the original app-URL and exact-hit-list assertions fail. The helper does
not replace those escape failures with a detached-frame timeout. All mutation
sources were restored; the final runtime source omits experiment-only logging.

At source `085d8cc`, both full-file runs pass the same 12 cases and 134
expectations. Whole command time is 73.36 to 67.59 seconds; summed case bodies
are 22.313 to 17.566 seconds, while mandatory setup/build is 50.517 to 49.514
seconds. The ten original windows total 15,013.88 ms; the seven retained windows
total 10,507.44 ms. The three new native completion observations take 0.828,
0.748 and 0.754 ms in the ordinary passing run. Top-navigation's denied iframe
half retains 1,500 ms, as do both contexts for popup, form and download in that
historical source pair. The subsequent popup experiment below separates its
specific native denial boundary.

CPU user plus system time is 97.95 to 95.52 seconds and maximum RSS is 1,252,716
to 1,240,324 KiB. These are single paired observations on a shared host, with
the same runtime, namespace and required builds. Setup and native scheduling
also vary, so the entire command difference is not attributed to removed waits.
The five commands cost 303.35 seconds including builds and deliberate mutants.
No whole-CI speedup, global drain or universal minimum for the retained negative
windows follows from this experiment. Their operational justification remains
separate from the demonstrated positive-navigation completion boundary.

## Native popup denial completion

The [popup experiment](evidence/test-wait-html-popup-boundaries.json) covers only
the fixture's single `window.open` call in each context. The original pointer
and click acknowledgements remain. Completion requires both the call returning
null and the exact destination's native sandbox-denial message on the initiating
page. Null alone is insufficient: successful noopener creation can also return
null. In the observed Chrome 140 implementation, this denial occurs before
auxiliary-context creation. An actual extra native page **or** attacker arrival
instead returns to the original escape assertions, including a popup whose
navigation never reaches the attacker. No quiet-DOM or shorter-window fallback
qualifies ambiguous denial.

Delaying the original call by two seconds after the click mark establishes that
both completion and denial are initially absent in each context. The candidate
waits for the actual call and native denial; omitting that wait fails the added
completion diagnostic with all three expected flags still false. Separately,
allowing popups in both actual iframe and CSP sandbox guards makes the original
empty attacker-hit assertion fail with both popup destinations. These controls
retain the original call arguments, click marker and every original matcher.
All mutated guards and fixtures were restored. Diagnostic timestamps, setup
logging and delayed actions are absent from the final runtime source.

At source `df0864655`, both full-file runs pass 12 cases and 134 expectations.
Seven native windows totaling 10,514.04 ms become five totaling 7,513.24 ms.
The ordinary popup completion spans are 0.919 and 0.813 ms; these observe
already-delivered native events, not their total latency from the click. The
popup case falls from 3,736.92 to 745.61 ms. Command wall time is 67.48 to 64.94
seconds, while Bun reports 67.38 to 64.84 seconds. Summed case bodies are 17.719
to 14.733 seconds and mandatory setup/build is 49.212 to 49.688 seconds.

CPU user plus system time increases from 94.95 to 96.06 seconds, and maximum
RSS increases from 1,238,672 to 1,249,976 KiB. The five commands cost 289.15
seconds including mandatory builds and deliberate failures. These are single
observations with the same runtime, dependencies and offline namespace on a
shared host; setup and scheduling vary. They establish neither a whole-CI gain
nor a universal minimum for the five windows retained at that recorded source.
Form, download and denied frame-to-top actions have separate proof obligations;
the following experiment addresses only the single form submission.

## Native form denial completion

The [form experiment](evidence/test-wait-html-form-boundaries.json) keeps the
original native submit call, GET method and fields. Its return marker and the
exact destination's sandbox-denial message establish that Chrome rejected this
submission before scheduling it. Both contexts submit the same URL, so each
has its own initiating-page observer and fresh attacker-hit cursor. A new
matching hit returns to the original hit-list and tab-URL assertions; losing
the old evaluation context is never completion by itself.

Delaying the original submission by two seconds leaves its return marker and
denial absent before the candidate wait and present afterward in both contexts.
Omitting that wait fails the explicit completion diagnostic with both flags
false. Enabling forms in both actual iframe and CSP sandbox guards and removing
the actual `form-action 'none'` restriction makes the original empty hit-list
assertion fail with two form arrivals. Navigation has already removed the old
markers in that control, demonstrating why the escape path uses actual new
arrivals. All guards and fixtures were restored; final source omits diagnostic
logging, timestamps and delayed actions.

At the frozen popup candidate `c13d59b36`, both full runs pass 12 cases and 134
expectations. Five windows total 7,505.23 ms; the three retained windows total
4,503.49 ms. Native form completion observations take 0.630 and 0.642 ms after
the acknowledged click, while the form case falls from 3,731.37 to 698.39 ms.
These short observations do not measure the full native latency from the click.
Command wall time is 64.87 to 61.25 seconds (Bun: 64.78 to 61.16); summed bodies
are 14.698 to 11.659 seconds and mandatory setup/build is 49.654 to 49.083
seconds. Setup variation is separate from removed waiting.

CPU user plus system time is 95.44 to 94.37 seconds; maximum RSS increases from
1,231,784 to 1,250,848 KiB. The five commands cost 283.30 seconds. This single
pair uses the same runtime, dependencies, offline namespace and shared host.
It demonstrates neither a whole-CI gain nor a minimum for the three windows
retained at that source. The following experiment separately addresses only
the denied frame-to-top assignment; download proof remains independent.

## Native frame-to-top denial completion

The [frame-to-top experiment](evidence/test-wait-html-top-boundary.json) leaves
the original uncaught location setter unchanged. A passive observer on the app
Page requires its native `SecurityError`, exact attacker destination and
permission-denial text. In the observed Chrome implementation, that exception
returns before the navigation request is issued. An actual changed app URL
instead returns the original escape result. An attacker hit, detached frame or
unrelated error alone cannot complete this boundary. The tab's allowed top
navigation still uses the existing actual-hit and native document-completion
gates.

Delaying the same setter by two seconds proves the native error is initially
absent and then delivered. Omitting the candidate wait fails the added denial
assertion with expected true, received false. Enabling top navigation in both
actual iframe and CSP sandbox guards makes the original app-URL assertion fail
after the app commits the attacker destination. It does not become a missing
error timeout or a later missing-link failure. The fixture gains no exception
handler or new return marker. All source mutations were restored; final source
omits diagnostic logging and the delay control.

At frozen combined popup/form source `60da0afe2`, both full runs pass 12 cases
and 134 expectations. Three windows total 4,503.99 ms; the two retained
download windows total 3,002.79 ms. The top case falls from 2,236.57 to 768.04
ms. Its ordinary error observation takes 0.037 ms because the event is already
delivered; this is not click-to-error latency. Command wall time is 62.07 to
60.44 seconds (Bun: 61.97 to 60.35), summed bodies are 11.685 to 10.428 seconds,
and mandatory setup/build is 49.843 to 49.463 seconds. CPU user plus system
time is 95.99 to 95.29 seconds; maximum RSS increases from 1,243,320 to
1,246,396 KiB. The five commands cost 279.87 seconds.

These are single observations with matched runtime, dependencies and offline
namespace on a shared host. Setup variation is separate from the removed wait.
The artifact binds the observed error transport to installed Playwright 1.63.0
source and Chrome 140.0.7339.127. It does not establish a global browser drain,
whole-CI speedup or minimum justified duration for the two download windows.

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


## Query deadline and late-database completion

The [search deadline evidence](evidence/test-wait-search-deadlines.json) records
eight commands at source `bb4578a7`. The private search tests drive production's
actual timeout registrations at 19/20 ms and, in a separate added control,
2999/3000 ms. Real SQLite, provider promises, FTS fallback, hybrid fusion and
all original assertions remain. Successful embedding crosses its cancelled
deadline; removing the actual cancellation fails the original abort assertion.
Both one-millisecond registration faults fail the configured and default checks.
The production default remains 3000 ms.

The original late-completion test passed a structural fault that moved the race
around the whole vector search. Its closed-database exception was insufficient
as an oracle. The candidate forwards the real database's `prepare` method after
closing it and explicitly counts attempts. The same fault now fails with two
attempts: the original KNN query and its existing fallback. After releasing the
provider, one native event-loop turn covers the inspected promise continuation,
which has no intervening timer or I/O before its first synchronous prepare. This
is a source-specific completion boundary, not a global asynchronous drain.
Timer and database property descriptors restore even on assertion failure.

The full file changes from 34 tests / 145 expectations to 35 / 158. The matched
command takes 0.50 → 0.43 seconds; summed bodies take 256.58 → 184.23 ms. The
three original case bodies take 90.07 → 10.05 ms, and the added default control
costs 3.33 ms. CPU increases from 0.53 to 0.56 seconds and peak RSS from 121520
to 122788 KiB. These are one shared-host pair, not a whole-CI improvement.
Setup and individual native-turn spans were not separately measured. The
3070 ms advanced across four independent case clocks is source arithmetic,
not elapsed time. Three native `setImmediate` boundaries remain; no native
provider conformance proof is replaced.


## Native robots-policy completion

The [robots completion evidence](evidence/test-wait-browser-robots-completion.json)
records five commands at source `a2b0cdb2`. The original 800 ms native robots
fetch remains. The test waits for its original `forUrl` promise, the original
matching main-frame interception handler, and destruction of the same native
page target on the same attached connection. Synchronous observers return the
original native operation promises. An actual forbidden HTTP arrival instead
returns control to the original no-hit assertion; an absent destruction event
does not conceal an escape.

The original retained-window test and the candidate both fail that assertion
when the real policy cancellation, post-policy abort guard and page closure are
removed together. Both additionally report a leaked target in their original
teardown check. Omitting the candidate completion fails an explicit diagnostic:
the actual robots lookup started and remains pending even though its handler
and page target have already finished. These controls establish this load's
causal boundary, not a global network drain.

The restored full file retains 14 tests / 66 expectations. The matched command
takes 9.28 → 8.98 seconds; the selected case takes 1105.38 → 844.33 ms. Its
actual completion wait is 561.22 ms, because the original fetch still has work
to finish after budget expiry. The removed 820 ms observation is therefore not
an 820 ms saving. CPU increases from 1.87 to 2.01 seconds and peak RSS from
191952 to 193836 KiB. Setup and the baseline wait span were not separately
measured; these are one shared-host pair, not a whole-CI claim.

At that recorded source, the other case retained its 1300 ms native observation.
It also allowed the real 1200 ms rate limit to become eligible before the original
next load's 300 ms budget. Handler completion and target destruction alone do not
establish that eligibility. The separate pacing evidence below covers both roles.


## Native pacing cancellation and subsequent eligibility

The [pacing completion evidence](evidence/test-wait-browser-pacing-completion.json)
records six commands at source `ec381c94`, after the robots change. The pacing
case retains its original native sleep, 300 ms page budget, Chrome interception,
HTTP requests and capacity assertions. Synchronous timer observers return the
actual native handle, preserve callback arguments and `this`, and restore full
global property descriptors. The supplied rate-limiter clock forwards production's
original sleep promise; no global clock or browser timer is advanced.

Completion requires the matching policy and interception-handler promises, the
same native page target's destruction, and the original pacing sleep's settlement.
An actual forbidden HTTP arrival instead reaches the original no-hit assertion.
That assertion precedes the added checks for native registration, cancellation
and callback suppression. The actual remainder plus the preceding clock read
minus the first grant must equal 1200 ms. Only afterward does the existing
rate-limiter clock's `now` offset advance beyond that grant's eligibility, allowing
the original next load to exercise real page capacity within its 300 ms budget.

The original and candidate both reject the same compound production guard fault
at the original late-request assertion; their independent teardown also detects
leaked targets. Omitting the eligibility advance fails the original next load on
its real 300 ms page budget, not the test runner watchdog. Removing production's
native `clearTimeout` fails the explicit cancellation assertion. Only after that
failure does cleanup clear the original outstanding handle, separately counted
in the diagnostic receipt. All production mutations were restored.

The full file retains all 14 cases and increases expectations from 66 to 73.
The matched command takes 8.93 → 7.63 seconds, summed bodies 8572.97 → 7258.24 ms,
and the pacing case 1664.57 → 366.44 ms. CPU takes 1.87 → 1.81 seconds, while peak
RSS increases from 192036 to 192472 KiB. These are one shared-host pair; setup
and the baseline 1300 ms span were not separately measured. The measured
completion await is only 0.020529 ms because its native events had already
arrived; it is not the whole case or native page-budget duration. The 879 ms
eligibility offset is logical time, not additional elapsed savings.

The restored observation records one native 1175 ms timer registration, one
production clear, no callback, and rejection of the original sleep promise. The
clock read occurred 25 ms after the first grant, preserving the full 1200 ms
pacing rule. Other native delay/crawl-policy cases remain unchanged. The final
source removes only diagnostic logging, timing and unused snapshot counters;
all original matcher expressions and seven added assertions remain. This is a
boundary for the inspected load and subsequent eligibility, not a universal
minimum negative window or a global browser/network drain.

## Selected native child lifecycle observations

The [native lifecycle evidence](evidence/test-wait-native-lifecycle-completion.json)
records seven selected commands at source `95b951aa`: seven cases and 28 expectations,
3.33 seconds of command time, and 106 immutable raw receipt entries. These are
source-specific observations, not a full child-process census or a speedup pair.
Original worker permissions, mounts, protocol stdout and assertions remain.

Three commands leave every test/source byte unchanged and use external syscall
tracing inside the ordinary-UID offline namespace. The version-probe shell's
original 20 ms sleep completes one syscall in 20.124 ms before its original exit
3 and exact stdout/stderr assertions. The closed-stdin fixture's original 50 ms
sleep completes in 50.161 ms before its late reply; its native pipe and fallback
assertions pass. Four separately identified 1 ms synchronous polls total
4.383 ms on that fixture's original parent process. Those polls map to the
previously observed row 336, not additional row 674 coverage. Ptrace overhead
and process topology affect these timings; they are not untraced cost estimates.

The governed peer trace follows both original shells through their namespace
transitions and successful exits. In this invocation, both readiness conditions
were reached before either 10 ms sleep call, so both observed sleep counts are
zero. The real protected-file handoff still executes. Complete traced lifetimes
support those scoped zeros; they do not show that future invocations need no
polling or that a missing trace segment should count as zero.

Two sync cases retain their original SSE bytes and use only their existing
writable control files for numeric observations. Each first child completes one
10 ms poll (10.126535 and 10.153390 ms); each released retry completes zero. The
reservation test appends metrics after its original end marker. The client test
appends only after release, after the exact `yes` readiness predicate has already
been consumed; the synchronous retry-launch forwarder captures the first record
before the next child overwrites that file. Final reads follow the original
response completion. Namespace PIDs repeat, so invocation identity comes from
actual launch/exit ordering. Added diagnostic I/O remains outside each child's measured poll spans,
but enclosing response and command phases include it; no binding, FD or write permission is added.

The selected 50-percent SDK hook case observes the original native registrations
and callbacks through its existing stderr channel. Its 20000 ms failure watchdog
has no callback at natural exit 0, 26.012092 ms after registration; no clear is
inferred. The original post-result 10 ms timer fires at 10.211114 ms and natural
exit follows at 10.303885 ms. The callback age differs from an exact await span,
which was not separately measured. The 80-percent case is unselected.

SDK instrumentation changes only the generated fixture runtime argument and a
temporary passive host observer. Numeric stderr bytes still feed the original
sticky error classification and tail before bounded, chunk-aware diagnostic
parsing; the entire stderr stream is therefore not byte-identical. Original
stdout protocol operations, native handles, callback arguments and assertions
remain, and both files were restored after observation. Missing natural-exit
records would remain missing rather than imply cancellation. None of these
receipts establishes a universal minimum delay or replaces native runtime proof.

The nested-ledger case retains its original owner and attached-worker death,
reservation refusal and recovery assertions. Parent and owner each register the
original 5000 ms watchdog and clear it without firing, at 61.759012 and
30.728070 ms from the registration call. Their original reader awaits complete
in 61.584364 and 30.577138 ms. Those spans overlap and cannot be added as command
cost. Each local span excludes its adjacent diagnostic writes, but child logging
can occur inside and prolong the enclosing parent wait and alter scheduling.

The attached worker's original 1000 ms interval registration is captured, with no
callback entry captured before its original SIGKILL. There is no inferred clear,
natural exit or completed 1000 ms lifetime. Its readiness JSON precedes interval
registration, so a missing registration record would remain missing. The observer
reads the existing inherited stderr pipe only after the original owner kill,
attached-worker kill and death polling, and final recovery assertion. No pipe or
permission is added. The ledger helper extends row 333's earlier caller evidence;
the attached interval adds row 722. Together with the repeated RTK row 336,
source-row overlap is explicit in the artifact rather than counted as new work.

## Native sandbox download completion

The [download completion evidence](evidence/test-wait-html-download-completion.json)
records six commands at source `1b2a2e81`, following the earlier HTML navigation,
popup, form and top-frame work. All twelve expanded native cases and all original
matcher expressions remain. The two remaining 1500 ms download observations now
require positive native evidence for each original anchor invocation. Production
CSP, iframe policy, pointer actions and context lifetimes remain unchanged.

Each attempt starts a native Chromium trace immediately before its original
pointer click. Unique user-timing marks surround the unchanged synchronous
anchor call. Completion requires exactly one before/after pair on the same
renderer thread and document, and feature 2975 inside that bracket. Chromium's
actual sandbox-denial branch records that feature before returning without
starting the download. The artifact records inspected primary-source URLs and
hashes for local Chrome 140.0.7339.127 and the actual hosted-unit versions
154.0.8037.97 and 155.0.8059.39. Source review across those versions is separate
from current-head hosted execution.

Trace completion flushes recording; it does not drain the browser. The test
rejects lost records, a full capture buffer, missing markers, mismatched document
or thread, and ambiguous witnesses. Without a correlated denial, it awaits an
actual observed download so the unchanged original count assertions fail. It
never treats an absent event as success. Native listeners, trace watchdog and
session are cleaned up before the original context/browser/host cleanup. Future
Chromium changes that remove this evidence fail closed and require maintenance.

The original and candidate both reject the actual policy mutation that adds
`allow-downloads` to the served CSP and iframe sandbox. Both original native
anchor invocations are delayed 750 ms; each version fails the original frame
download count with one instead of zero. The candidate records no denial in
either context and observes the actual escaped downloads. Stopping the trace
before the original click fails the named exact-start-marker assertion, despite
a completed trace with zero loss. Delaying each real anchor invocation together
with both markers by 2000 ms passes, with 4039.66 ms combined boundary waiting.
Per-half await durations were not separately measured; the initial proposal's
per-half timing requirement is not claimed as observed. Both exact native
witnesses are captured after their delayed calls.

The full matched file changes from 12 cases / 134 expectations to 12 / 154.
Command time is 60.00 to 57.18 seconds, summed bodies 10.232 to 7.116 seconds,
and the download body 3704.61 to 691.32 ms. Mandatory setup/build takes
49.256 to 49.503 seconds. CPU user plus system is 95.52 to 95.18 seconds and
maximum RSS is 1248856 to 1243360 KiB. The original two windows total
3003.28 ms; candidate boundary awaits total 18.37 ms, because native events
can arrive before those awaits begin. Full trace-session lifetimes total
93.67 ms and overlap the clicks and boundary awaits. Neither number is
whole-test duration. The native anchor brackets themselves are 180 and 98
microseconds; these are a different, synchronous span.

All six commands cost 328.80 seconds; their 198 immutable receipt entries
include source variants, commands, original logs, measurements and restoration
identities. The earlier 54.07-second observer feasibility command retained both
1500 ms windows and is recorded separately with eighteen receipt entries.
Timing diagnostics and after-assertion trace-file writes are included in command
cost; final source omits those diagnostics. These are single shared-host
observations, not a whole-CI speedup or a universal minimum negative window.

## Continuity snapshot slot completion

The [slot-completion evidence](evidence/test-wait-continuity-slot-completion.json)
records five native commands at source `1b2a2e81`. Only the two newer-turn
snapshot preparations replace their fixed 500 ms window and following two
frames. The original non-streaming UI predicate remains; a fresh native idle
frame must match both the original session and old turn before the existing
peer socket starts the successor. All three snapshot cases, every original
matcher expression, and all later streaming, answer/field identity, focus,
caret and no-extra-chat assertions remain.

A result can finish the UI stream before the backend promise and host
finalization finish. The scoped idle follows actual journal, governed and
failure-recording completion. With no queued request, the rest of this slot's
removal is synchronous before the host processes the later peer request. This
matters because a queued successor mutates the old slot's turn identity; the
held connection snapshot must retain the original identity. Neither unscoped
connect idle nor a no-slot resume response can satisfy the exact old-turn
predicate. This boundary does not establish general browser, React or storage
quiescence.

The control holds the actual production completion continuation for 2000 ms,
after its existing failure-recording await and before scoped idle, only for the
first snapshot prompt. Original preparation and the candidate with its boundary
omitted both fail the unchanged assertion that the held snapshot reports its
captured old turn. The intact candidate passes all later original assertions.
Synchronous observations order the actual hold release, exact old-turn idle
and readiness; the candidate awaits 2012.22 ms in that control. The temporary
production hold is absent from the restored and final source.

The selected baseline passes 3 cases / 30 expectations; the restored candidate
passes 3 / 32. Seven other expanded cases are filtered in each selected run.
These snapshot cases construct their own pages and do not call the initial
upload scene; their receipts do not qualify that separate upload scenario.
At that recorded source, the two later new-text preparation windows and all
three released-history negative windows remain, along with the original
drop/recover observations.
The selected window count changes from 13 to 11 and actual accumulated window
time from 6513.12 to 5511.63 ms. Actual new boundary awaits are 10.38 and 10.14 ms;
these are not whole-case durations. The corresponding post-window two-frame
observations also change from 13 to 11.

Command wall time is nearly flat: 82.85 to 82.69 seconds. Summed bodies change
from 33.858 to 33.050 seconds, while mandatory setup/build increases from
48.509 to 49.141 seconds. CPU increases from 93.14 to 94.22 seconds; maximum
RSS changes from 1250024 to 1247624 KiB. All five commands cost 362.04 seconds.
The artifact preserves ninety immutable receipt entries and actual per-case
selection, source hashes, native namespace guards, failures and restoration.
Observer timing/logging overhead is included. This single shared-host pair
shows neither a whole-file/whole-CI gain nor a justified numeric minimum for
the remaining negative windows.

The fixture's explicit configuration object omits the classification key, so
its classifier returns no blocks; that conclusion does not follow from auth
mode alone. The scripted backend emits no promotion event. Native local-work,
focus and render paths are not globally drained by the scoped idle, and their
later observation windows are unchanged.

## Continuity newer-turn preparation

The [preparation evidence](evidence/test-wait-continuity-preparation.json)
records a subsequent, narrow change at source `65d05a55`: the two newer-turn
preparations await their actual resync response before the existing finite-render
helper. At that recorded source, all three released-history negative windows
and every drop/recover window remain. The original selection, focus, answer/field
identity, streaming and no-additional-chat assertions retain their order and
observation interval.

Before the old turn is released, the test acknowledges that the connect snapshot
and every actual initial resume on the current socket have entered the held
backend read. It then records a fresh cursor. Only the old result's subsequent
resync can supply the current socket's replacing history and detailed completion
status while those original reads remain held. Peer connect history belongs to
another socket. The probe checks committed replay/current-turn state and the
acknowledged current draft as well as the bounded frame metadata. Synchronous
history/status reducers have run before the later page task; this is not a claim
that a microtask or matching frame counts drain arbitrary work.

The fixture observes successful native sends without replacing the native
WebSocket prototype or changing return/throw/argument identity. At that recorded
source only the two newer cases opt in; the subsequent recovery boundary also observes the quiet
case. Explicit teardown restores and verifies the fixture method's
complete descriptor or original absence; initialization failure also disposes
observation. The existing restore promise is awaited without flushing storage.
Native context writes can still follow scroll, selection or focus. This fixture
has one local writer, an unchanged acknowledged draft, no device-version action
or draft-referenced acceptance, and no account switch; the later negative windows
remain the proof for late native effects. There is no global storage drain.

The positive control delays the actual server `session_resume` response for
2000 ms, after its positive backend read and before response publication. Its
native hold completes before the new readiness boundary; all original later
assertions pass. Omitting only that readiness wait fails the added hold-finished
assertion while the response is still held, even after finite rendering. That
control does not reach the later product assertions. Its hold remains unfinished
at both teardown snapshots, and neither callback completion nor a process-exit
record is observed; source restoration does not establish cancellation or drain.
The separate captured-terminal/ended-guard mutation still fails the original
newer-stream assertion after the original final 500 ms observation.

The historical baseline passes 3 cases / 32 expectations; the restored candidate
passes 3 / 38, with the same seven other cases filtered. Exact original source,
configuration, harness and terminal mutations were verified before reuse.
The baseline fixture hash was checked after its original run, an inherited
limitation retained in the artifact. This is one historical shared-host pair,
not a simultaneous resource-controlled experiment.

Selected bodies change from 32.86182 to 32.23022 seconds; command time changes
from 82.13 to 81.07 seconds, including setup from 48.74872 to 48.32704 seconds.
CPU changes from 93.96 to 93.74 seconds and maximum RSS from 1245892 to
1239200 KiB. Actual fixed-window calls change from eleven to nine and accumulated
window time from 5508.43 to 4520.64 ms. Two original window-plus-two-frame calls
become resync readiness plus the existing finite-render loop; they are not
counted as retained pairs in the old counter. Restored readiness spans are
5.39 and 1.43 ms, followed by 221.74 and 228.21 ms of finite rendering.

Four corrected commands cost 264.26 seconds. An additional 47.79-second attempt
failed the mandatory build because a temporary control inferred a boolean as a
literal; no scenario or expectations executed. Its erased-only correction emits
identical JavaScript and passed exact-variant typechecking before execution.
Both that failure and its checker failure remain recorded. The 142.62 seconds
of reused original controls are historical cost, not new execution. The artifact
indexes 186 immutable receipt entries. The modest observed gain establishes no
whole-file/whole-CI saving or justified minimum for the remaining native windows.

## Continuity snapshot recovery preparation

The [recovery evidence](evidence/test-wait-continuity-recovery.json) records the
three held-snapshot recoveries at source `44d2aab6`. They await acknowledgement
of the current draft edit, admission of the actual current-socket resume and
connect-snapshot reads to their held backend gate, and finite rendering. At that
recorded source, all three drop and three final negative windows remain, as do
the scene recovery windows and every original action, matcher expression and
test name.

The draft is filled immediately before drop; there is no assumed earlier save.
Its actual 800 ms save, failed request or zero-delay reconnect retry may overlap
the outage. A current positive host revision and matching edit acknowledge the
content. Busy serialization and host-sequence checks fence older save/list/get
continuations. This does not claim that all timers are cleared or native storage
has drained. Initial restore is awaited without flushing; later context writes,
selection, focus and captured-history effects retain their final observation.
The quiet case keeps its first backend turn live and its initial history held;
it does not require the newer-turn resync. Answer-delivery replay sends ask
responses/status requests, not chat messages; ordinary chat resend requires an
explicit action. The original no-additional-chat assertion remains unchanged.

A quiet-turn control holds the actual successful save continuation for 2000 ms,
before current-generation checking and saved-state publication. Readiness waits
1717.08 ms and all original downstream assertions pass. Omitting only that wait
fails the added completion assertion while the save remains held. This diagnostic
runs **before** finite rendering and does not reach later product assertions.
The hold is still unfinished at the last pre-close snapshot, with no observed
completion event; context closure does not prove cancellation or drain. The same
captured-terminal/ended-guard fault separately fails the original newer-stream
assertion after the retained final window.

The historical restored baseline passes 3 cases / 38 expectations; the new
candidate passes 3 / 41, adding the existing observer setup/cleanup checks to the
quiet case. All seven other cases remain filtered. Exact test/fixture,
production, configuration and harness identities bind reuse; the older terminal
fault stays explicitly historical. In this single shared-host pair, body time
changes from 32.23022 to 30.93437 seconds and command time from 81.07 to 79.70,
including setup from 48.32704 to 48.24153. CPU changes from 93.74 to 93.07 seconds,
while maximum RSS **increases** from 1239200 to 1243784 KiB.

Actual fixed-window calls change from nine to six, with accumulated time from
4520.64 to 3003.61 ms. Their three frame pairs are replaced by existing finite
rendering, not retained under the old counter: frame pairs change from nine to
six and finite-render calls from eight to eleven. The three restored readiness
spans are 1.36, 1.43 and 1.09 ms, followed by separate finite-render work. Four new
commands cost 258.14 seconds; the reused 81.07-second baseline and 60.49-second
original fault are not new execution. The artifact indexes 179 immutable receipt
entries. These observations establish neither a whole-CI saving nor a justified
minimum for the remaining native windows.

## Continuity snapshot drop preparation

The [drop evidence](evidence/test-wait-continuity-drop.json) records a narrow
change at source `7e5bfa2a`: three snapshot drop preparations use the existing
finite-render helper after the original native offline, status and visible-banner
checkpoints. At that recorded source, scene drop observations and all three
snapshot final windows remain, as does every original matcher expression and
test name.

These snapshots contain no held uploads, confirmed shares or held composer sends,
and make no immediate offline geometry or banner-position assertion. The SDK
has no queued chat outbox. Its close/status handling and the actual reachability
request remain native; the existing unreachable sample is not called a newly
numbered probe. The current draft may still be saving: its acknowledgement and
held-resume admission remain owned by the recovery preparation. The original
no-additional-chat interval and final streaming, node, focus, text and selection
oracles remain. This does not substitute elapsed recovery time for a proof of
no asynchronous work.

Finite rendering covers the helper's native animations, fonts and existing
composer/transcript geometry. It does **not** certify completion of every Motion
JavaScript banner animation. The unchanged visible-banner checkpoint suffices
for this preparation; scenes that inspect offline geometry retain their window.
The helper and its real finite-animation control are byte-identical to delivered
source `fd8f030f`. The historical two-frame mutant failed the named original
animation-finished assertion, but its driver did not prehash the full executed
source or record the current explicit offline namespace. That limitation remains;
the unchanged positive helper control runs again under the current harness.

The same real captured-terminal/ended-guard fault fails the original streaming
assertion with 11 expectations reached. Restored execution passes the three
snapshots plus the helper control: 4 cases / 43 expectations, with six other cases
filtered. The three snapshot bodies total 30.08234 seconds versus the historical
source-matched 30.93437 seconds. The extra helper case takes 336.51 ms. Whole
command time is 79.69 versus 79.70 seconds, but these commands select different
case counts: this is not an equal-selection command or resource gain. Setup
increases from 48.24153 to 48.76674 seconds and CPU from 93.07 to 93.82 seconds;
maximum RSS changes from 1243784 to 1231080 KiB. Shared-host load is uncontrolled.

Fixed-window calls change from six to three, with accumulated time from 3003.61
to 1501.63 ms; their frame pairs change from six to three. The three drop render
spans are 228.96, 230.41 and 228.87 ms. Total render calls include the additional
helper case and must not be attributed solely to the replaced sites. Two new
commands cost 138.88 seconds. The artifact indexes 125 entries: 68 new receipts,
32 reused baseline entries, 23 historical original-fault entries and two preserved
historical helper files. No remaining-window minimum, whole-file speedup or
whole-CI gain is established.

## Continuity snapshot selection completion

The [selection evidence](evidence/test-wait-continuity-selection-completion.json)
records the three captured-history cases at source `d7b10393`. Their final
500 ms windows become an explicit native operation boundary followed by finite
rendering. Every original matcher expression, test name, browser action and
no-additional-chat assertion remains. Scene recovery, queues, scrolling, IME
and ten-cycle negative windows are unchanged; these snapshot results do not
resolve the separate initial-upload prerequisite in
[#1956](https://github.com/schlessera/brain-kit/issues/1956).

The fixture observes existing partition operations and local-work status
publication. It returns the original handles, plans and promises; only the
mutation callback identity changes, with its original arguments and return
preserved (`const open`,
`packages/ui-react/tests/fixtures/continuity-selection-observer.ts:42-86`).
Native IndexedDB transactions stay native. The observer correlates
the selected tab/session/draft context at selection 6–12 with its actual commit
and subsequent normal postcommit publication (`const setState`,
`packages/ui-react/tests/fixtures/continuity-selection-observer.ts:87-102`).
It includes operations already
in flight before selection, rejects account/lock/error/fork transitions, and
restores complete own-method descriptors and subscriptions on failure or cleanup
(`replace`,
`packages/ui-react/tests/fixtures/continuity-selection-observer.ts:16-27`).
It neither flushes nor disposes work to manufacture readiness. Promise reactions,
bounded diagnostic snapshots and logging add overhead inside the measured cost.

Completion also includes every held response on the current socket. Empty
resumes deliver history then terminal status; failed resumes deliver only
`SESSION_LOAD_ERROR`, without a request ID, turn ID or failure payload. The
separate connect snapshot still reports its captured turn. Correlation uses
that exact error shape, socket/session, the release cursor and the number of
actual held resume requests; it does not invent a protocol request identifier.
These synchronous handlers finish before the later page task reads readiness.
An observed bad streaming state reaches the unchanged original assertion
without a new render wait masking it; a supplementary assertion rejects healing.

The native commit alone is insufficient: a real 2000 ms postcommit hold and an
omitted-publication control establish that the continuation matters. Cancelling
the actual selection callback produces no matching commit and fails the named
readiness cap. The unchanged captured-terminal fault still fails the original
streaming assertion. These controls were first measured with the empty case;
the same 127-line observer, including its measured version, is reused unchanged
for the failed cases. A delayed real failed-resume error passes only after its
completion. Omitting that requirement fails before rendering despite a completed
native selection commit; its hold remains unfinished at the last teardown
snapshot, with no later completion or cancellation inferred.

An initial fault removed the entire special history-error guard. Both original
cases passed their streaming checks but failed the original retained-node
progress wait. Source inspection explains how an unscoped error can append a
separate failed message while the original answer keeps the buffer streaming;
the intermediate message array was not captured in that run. This contradicted
the predicted oracle, so the sequence stopped. Its 128.35-second cost and checker rejection
remain evidence. The revised fault instead calls the actual finish operation
inside the unchanged special handler, incorrectly treating a history failure
as terminal. It fails the original streaming assertions in both the original
and candidate cases. No assertion or awaited text was weakened to obtain that
failure.

**Later work remains pending.** All three final lifecycle snapshots report
`pending: true`, after the original success assertions and turn release. At
the readiness boundary, the selected commits and their publications were
complete with no fork. The exact single-writer, stable-account, clean-draft
fixture and host-sequence fences make later context-only scroll/selection writes
unable to fork or adopt a different draft: context changes pass through the
planner, while draft changes compare actual stored versions/content
(`const staleRecord`, `packages/ui-react/src/lib/local-work.ts:383-400`), and
postcommit publication refreshes the committed versions (`const previousCommitted`,
`packages/ui-react/src/lib/local-work.ts:467-508`). This is a source-specific argument,
not an observation that all timers or native work drained. A second native
writer, account transition or changed production publication shape requires
review of this fixture boundary.

The historical source-matched helper-plus-three-case baseline passes 4 cases /
43 expectations; the restored candidate passes 4 / 49. All six other cases stay
filtered. Snapshot bodies total 30.08234 → 29.36794 seconds; per-case changes are
−224.38, −156.18 and −333.84 ms. Command time is 79.69 → 78.83 seconds, including
setup 48.76674 → 48.61535 seconds. CPU is 93.82 → 93.49 seconds; maximum RSS
**increases** from 1231080 to 1249220 KiB. Shared-host load is uncontrolled.
Actual fixed windows change from three / 1501.63 ms to zero; the three semantic
boundaries take 252.46, 251.73 and 270.06 ms, with finite-render calls increasing
from fifteen to eighteen. Nominal removed time is not net saving.

The one-case prototype added 166 net lines and was held from integration. A
small failed-history predicate extension shares the observer across all three;
the final implementation adds 177 net lines. Its source coupling is a deliberate
maintenance cost for explicit causal proof and the modest measured improvement.
The artifact indexes 429 receipt entries: 238 shared-study/historical entries,
31 unexpected-fault entries and 160 revised-extension entries. New native command
costs are 322.24, 128.35 and 332.68 seconds respectively; reused historical
controls are not charged again. No whole-file/CI speedup, measured minimum for
remaining windows, or completion of the broader wait audit is claimed.
