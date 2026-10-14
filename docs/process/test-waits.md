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
| `connection-continuity-runtime.test.ts`, repeated recovery | Fixed 500 ms rendering waits mixed with negative observation | Remove only startup and pre-navigation rendering sleeps, with actual ready/streaming composer state and fonts/finite animations/stable geometry. Recovery, queue, save, scroll and IME observations retain 500 ms for delayed focus/save/ghost and no-send effects; add final scoped-status/replay, released-queue and native wheel barriers. Held-history races keep their explicit release/status barriers. All theme/width and ten-cycle cases remain. |
| `html-preview-runtime.test.ts`, escape attempts | Two 1500 ms native negative windows per successful frame/tab pair, starting after the actual click lands | Retained. A browser-process navigation/download may arrive after the renderer's click handler or DOM settles; page JS clock does not drive it. 1500 ms is the existing bounded observation budget, not a newly measured universal browser latency guarantee. Expected escape controls await their actual hit independently. Candidate/runtime proof. |
| Same preview file, raw endpoint 500 ms | Native denial observation, no scripts/remote arrival | Retained, same native-boundary rationale; no speedup claimed. |
| `turn-scope.test.ts`, long Bash loop | Registered 15 s host observer is controlled; independent 20 ms observer, 50 ms writer and freeze windows remain native | [Scope observer proof](scope-observer-proof.md) retains actual dispatch, overshoot, confirmed freeze and copied-snapshot counts. Before capture, at least eight native observations span 150 ms; the final 150 ms no-progress window requires at least five ticks. Other scope cases retain their own timing obligations. |
| `draft-client.test.ts`, device-only/unsupported/conflict/retry | Actual debounce/retry timers and negative upload windows advance logically | The scheduler retains before/at-boundary, reset and cancellation observations. Real request/body promise completion is observed between advances; all original negative horizons remain or extend. Native completion turns are separate from logical milliseconds. |
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
