# Navigation and background-session recovery evidence

Discovery for [#942](https://github.com/schlessera/brain-kit/issues/942), supplying
[#943](https://github.com/schlessera/brain-kit/issues/943) under
[#929](https://github.com/schlessera/brain-kit/issues/929). This is measured input
to the design, not a navigation amendment or an implemented recovery contract.
The [navigation ruling](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973564827)
and later [parallel-session ruling](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973572791)
provide the projected placements. The latter takes precedence. The later
maintainer decisions in [#929](https://github.com/schlessera/brain-kit/issues/929)
select authoritative host recovery A and per-session host-backed draft storage C.
They supersede the earlier discard-confirm proposal; the measurements below
describe incumbent behavior, and the selected contracts still require implementation.
The adopted design built on this evidence is
[D52 in the design-kit record](../decisions/design-kit.md#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943).

## Evidence boundary and reproduction

Package source measured: `94c3719608d68a7ccbe99d8ca6a7b0028b5c357d`.
The checked-in probes under `scripts/probes/navigation-recovery/` use public
package exports, built styles, the shared Odysseus raft fixture and the real
`createApp`/WebSocket/SQLite paths with a scripted `AgentBackend`. No model,
provider credential, private application, deployed host or usage telemetry is
involved. Sync and briefing endpoints return fixture SSE rather than performing
repository sync or paid generation. Search, stats and session/history/activity
routes use the real disposable fixture host. Opening Add is measured; submitting
it is not part of this probe.

The consumer composition mounts ChatPage, ActivityPage or GraphPage according
to `activeView`, inside AppShell/BrainUiProvider. It deliberately holds a root
connection lease across those mounts. Consequently, composer unmount observations
apply to this composition; AppShell accepts children and does not prescribe a
consumer's page-retention policy. Files and Settings are currently owned by
ChatPage. Visiting them from Actions/Graph needs a Chat activation in this
composition; changing a store flag alone is not proof of a visible destination.

Run from an installed checkout with built packages and real Chromium:

```sh
bun run build
bun scripts/probes/navigation-recovery/store.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/navigation.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/paths.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/live.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/away.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/terminal.ts /tmp/brain-navigation-recovery
bun scripts/probes/navigation-recovery/races.ts /tmp/brain-navigation-recovery
```

The optional last argument is the output directory. Each phase writes its own
JSON receipt; navigation also writes screenshots. Output records the checkout
SHA and browser version. The browser permits only its loopback fixture origin;
external attempts are counted and blocked. No remote fonts are loaded. Viewports
are CSS pixels with a viewport meta tag, height 900, reduced motion, fine versus
coarse pointer, and dark versus light theme. The six widths are 320, 390, 480,
900, 1280 and 1440. Keyboard injection into a coarse-pointer context proves the
registered keyboard route, not a physical phone keyboard or operating-system
soft-keyboard geometry.

Receipts: 24 layout cases, 84 act paths plus 60 destination paths, 37 handler/store
scenarios, 17 draft paths, 20 live-host observations, two offline-completion
observations, two terminal/pruning observations and four delayed-frame races.
Inputs include nonempty streams, one pending approval, all four pending question
kinds, real 64×64 image attachments and nonempty draft text. Chromium 140.0.7339.127 reported no page errors or attempted external requests. A zero-message or zero-question input is not used as proof of retention.
The handler-only matrix calls the actual root/demux but is not a browser or host
restart. JSON observations are evidence, not a new application wire format.

Existing controls: 20 tests/65 assertions across session-demux and root-isolation;
85 tests/379 assertions across parallel sessions, history, failure replay,
approval persistence, list/rank/form, revocation and multi-backend session routes;
33 tests/169 assertions across turn correlation, Activity routes and boot sweep.
The last group verifies pruned rollup resolution, unknown-run 404 and orphan
interruption. These are existing behavioral tests, not new implementation guards;
no fix or failing-first mutation is claimed by this documentation spike.

## Destinations, acts and frequency provenance

S means session-level, D daily, O occasional. These classes come from the
maintainer's supplied preferences, not observed counts. Search's S is provisional;
Graph's O includes the explicit preference that it is never used. No quantitative
frequency distribution was collected or inferred.

| Destination | Current rail / phone | Projected rail / phone | Availability and effect | Class |
| --- | --- | --- | --- | --- |
| Chat | slot 1 / slot 1 | slot 1 / slot 1 | Local view change; no turn dispatch | S preference |
| Sessions | palette / More | slot 2 / slot 2 | Opens session selection; history reads on selection; no turn dispatch | S preference |
| Actions | slot 2 / slot 2 | slot 3 / slot 3 | Activity/decision destination; its own actions retain their authority checks | No measured class |
| Files | slot 3 / slot 3 | slot 4 / slot 4 | Opens file browser; reads are distinct from edits | O preference |
| Graph | slot 4 / slot 4 | palette / More | Opens graph; graph edits are separate actions | O preference |
| Settings | slot 5 / More | slot 5 / More | Opens settings; saving configuration is separate | No measured class |

Sessions is currently one of the palette's seven acts, and becomes a destination
in the ruling. This is one command with two inventory roles, not an eighth act.

| Act | Current visible homes | Projected homes | Availability and actual effect | Class |
| --- | --- | --- | --- | --- |
| New chat | occupied Chat disc, Sessions New conversation, desktop palette | occupied Chat below 1280; Sessions pane at ≥1280; palette/selection | Local transcript selection resets; no cancel/send. Current local composer is retained | S preference |
| Sessions | desktop palette; phone More | destination; wide pane | Opens history list; selecting replays history, does not restart the agent | S preference |
| Search | empty welcome, slash, desktop palette | both rails; occupied phone disc; welcome | Opening remains allowed during streaming/socket loss. REST search still requires a reachable authorized host. No model dispatch or write | S provisional preference |
| Add a note | slash, desktop palette | both rails; welcome; phone More | Opening has no write, including during streaming/socket loss. Submit writes/indexes and retains its own errors/authority | D preference |
| Daily briefing | welcome, slash, More, desktop palette | expanded rail; welcome; More; palette on collapsed rail | Handler requires connected/quiet active buffer; opening starts its streaming job. Paid-generation possibility must keep `spends` visible | D preference |
| Sync | slash, More, desktop palette | More and palette | Handler requires connected/quiet active buffer; opening starts repository sync. Keep `sync` visible when unavailable | O preference |
| Brain statistics | welcome, slash, More, desktop palette | More/palette | Quiet active buffer; REST data plus local software identity, no inference. Adds a local exchange and can persist it to the host; no Markdown write | O preference |

The expanded rail currently contains no dedicated act rows. The desktop palette
has 12 commands: five destinations and seven acts in Jump to / Ask / Run groups.
The five slash commands are sync/search/whatsup/add/stats; slash provides neither
New chat nor Sessions. Current More has Settings/Sessions/Sync/briefing/stats,
without Search/Add. Current welcome has briefing/Search/stats, without Add.

Opening a Search/Add panel is not evidence of executing its operation. Conversely,
Sync/briefing opening starts a job; the harness substitutes those two job responses
and therefore makes no claim about real job success or cost.

## Browser reach and activation counts

A count is an activation of a control, including opening the palette or More;
setup/reset and typing a slash query are excluded. Slash paths therefore include
an explicit typing prerequisite and are not equivalent to one visible tap.
Each counted route was executed without forced clicks. Panel dismissal counts.

| CSS width | Visible primary controls | Observed target dimensions | ⌘K cap click/tap | Keyboard palette |
| --- | --- | --- | --- | --- |
| 320, 390 | Chat/Actions/Files/Graph/More | Tabs: 48.06–59.16 wide, 50.5 high | No cap | Hidden, including after modifier-K |
| 480 | Collapsed five-destination rail | Every destination 43×36 | 0 palette openings | 12 commands |
| 900, 1280, 1440 | Expanded five-destination rail | Every destination 183×36 | 0 palette openings | 12 commands |

Both themes and pointer modes gave the same control geometry. Fine pointers
print chords; coarse pointers omit printed destination chords but the injected
keyboard still opens the desktop palette. The passive cap's glyph box is
23.40625×17.5, not a button. Its position is x=17.796875 at 480, x=12 at expanded
widths, y=866.5. The occupied New chat target is 44×44 at x=`width−60`, y=11 at all
six widths. Welcome Search opened the Search panel in every layout case.
The More dialog wrapper has zero height because its docked sheet child is
absolutely positioned; measuring the child/rows proves visibility. Treating the
wrapper's `isVisible()` as proof that the sheet failed to open was a harness
error, corrected before recording the matrix.

Current observed act paths at 390 (coarse), from the six entry states:

| Entry | New chat | Sessions | Search | Add | Briefing | Sync | Stats |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Empty Chat | 3: More → Sessions → New conversation | 2 | 1: welcome | 1 + slash typing | 2 via More | 2 | 2 |
| Occupied Chat | 1: disc | 2 | 1 + slash typing | 1 + slash typing | 2 | 2 | 2 |
| Actions | 2: Chat → disc | 2 | 2 + slash typing | 2 + slash typing | 2 | 2 | 2 |
| Files open over Chat | 2: close → disc | 3 | 2 + slash typing | 2 + slash typing | 3 | 3 | 3 |
| Graph | 2: Chat → disc | 2 | 2 + slash typing | 2 + slash typing | 2 | 2 | 2 |
| Settings open over Chat | 2: close → disc | 3 | 2 + slash typing | 2 + slash typing | 3 | 3 | 3 |

At 900, modifier-K plus the act row takes two activations from all six states;
`inChat` closes the other panels through the UI view setter. The occupied Chat
disc separately takes one. These keyboard measurements do not establish a
pointer-only desktop route: clicking the cap never opens anything. Welcome or
slash alternatives require Chat/composer access. Sync/briefing/stats cannot
execute merely because a visually present row was clicked when the handler's
availability guard refuses it.

Current destination paths at 390: Chat/Actions/Graph take one activation from
uncovered pages; Files takes one from Chat and two from Actions/Graph in this
composition; Settings takes More plus its row, with an extra Chat activation
from Actions/Graph. Dismissing an open Files/Settings drawer adds one. At 900,
rail Chat/Actions/Graph takes one; Files/Settings takes one over Chat, or Chat
then the destination from Actions/Graph. These distinctions are recorded in
`paths.json`, including the resulting UI state, not inferred from labels.

Projected counts below are source/ruling projections, not runtime measurements:

| Width/view | Search | Add | Briefing | Sessions | New chat | Rare commands |
| --- | --- | --- | --- | --- | --- | --- |
| 320/390 occupied Chat | 1 disc | 2 via More | 2 via More | 1 destination | 1 disc | 2 via More |
| 320/390 empty Chat | 1 welcome | 1 welcome | 1 welcome | 1 destination | Selection → New conversation; a reset of an already empty view needs no act | 2 via More |
| 320/390 Actions/Graph | Chat → Search, 2 | More → Add, 2 | More → briefing, 2 | 1 destination | Chat → disc or Sessions → New conversation, 2 | 2 via More |
| 480 collapsed rail | 1 rail | 1 rail | 2 visible palette | 1 destination | 1 occupied Chat; selection needed from other views | 2 visible palette |
| 900 expanded rail | 1 rail | 1 rail | 1 rail | 1 destination | 1 occupied Chat; selection needed from other views | 2 visible palette |
| 1280/1440 Chat | 1 rail | 1 rail | 1 rail | Visible Sessions pane | 1 pane action | 2 visible palette |

Open-panel dismissal, already active Sessions behavior, New chat from other
views at ≥1280 and focus/selection outcomes need the exact table in #943.
The report does not assume that a hidden or covered control fulfills reach.
The later ruling's two-activation phone daily acts and collapsed briefing are
settled exceptions, not grounds for adding unspecified controls.

## Session and run recovery matrix

The 36 primary store cases cross running, queued, approval, question, list,
rank, form, success and failure with A→B, New chat, twelve idle buffers and a
fresh root. The 37th verifies nonempty background A completion leaves B untouched.

| Transition | Actual evidence | Consequence |
| --- | --- | --- |
| A→B / New chat | Running A and all pending cards remain in its in-memory buffer; terminal success/failure remain too. Live backend-start count does not change | Navigation does not abort or redispatch work |
| Twelve idle buffers | Six real live sessions, including approval and all four ask kinds, survive; idle buffers evict down to eight. Handler-only queued/terminal A can evict while queued runStates remains | Buffer presence and badge presence are different facts; MAX_BUFFERS is not a tracker retention policy |
| Fresh root without a connection | Stored selected ID survives with a stable prefix; transcripts/runStates/cards do not | Local storage currently holds resume identity, not history or a pending-card snapshot |
| Same-root reconnect, six open turns | Host retains and resends all pending kinds; existing question buffers retain cards | Warm reconnect is stronger than cold reload, but history replacement can overwrite live content |
| Fresh root / reload, six open turns | Only selected running session history materializes; other pending frames leave run badges but no cards because their buffers do not exist | Multiple-open-turn reconnect does not reconstruct every background transcript |
| Background session_resume | History materializes without changing selected running transcript; backend starts remain 6 before/after. It does not resend interactive requests | Replaying history is not restarting work, nor complete pending-request recovery |
| Reconnect after background histories | Question/list/rank/form cards return. Approval still does not appear when replay ends in a user-only message | Approval rendering needs an assistant target; it cannot rely on a later delta existing |
| Success/failure reload | Finished selected session replays two nonempty history messages; no new turn starts | Successful replay does not by itself correlate every historical message to its original turn |
| A succeeds/B fails while socket is closed, C still running | Activity records success/error; warm client can retain stale A/B running badges. Explicit background replay clears their run state without selecting them or starting a turn | Missed terminal frames require authoritative per-turn reconciliation |
| Cancel pending approval | Host Activity run ends cancelled, distinctly from error; client badges can remain stale after interactive cleanup | A badge is not terminal proof; cancelled must not be guessed to mean succeeded/failed |
| Missing backend history | Scoped SESSION_LOAD_ERROR; selected transcript preserved | Show unavailable/unknown with recovery action; do not fabricate empty successful history |
| Pruned Activity detail | Actual fixture REST returns 200, detailPruned=true and terminal rollup; never-existing run returns 404 | Pruning is not deletion or an unknown outcome |

The scripted backend's partial running history deliberately ends in a user row.
This is a valid `getHistory` result and exposes the approval target dependency;
it is not a claim that a particular live provider always persists that shape.
All four question kinds were nonempty before transition. The existing
[#910](https://github.com/schlessera/brain-kit/issues/910) already owns question
identity/deduplication, post-resume redelivery and honest submitted-answer
recovery. Its approved policies are not reopened here. Tool approval recovery is
outside its scope and needs separate scoping with the tracker prerequisites.

The browser fixture uses ambient loopback authorization, not a browser login
claim. The host's real revocation tests establish authorization leases, pending
reply refusal after revocation and no history emission after async revocation.
The API auth guard covers session and Activity routes. Session IDs and turn IDs
are correlation, never grants. session_resume rechecks connection authorization
after asynchronous history/replay waits. Rehydration must remain read-only and
must not reply to questions/approvals, create a turn or restore revoked authority.

A root recreation is not a host process restart. Host pending interactions and
queued follow-ups live in coordinator maps. Boot-sweep tests prove that persisted
orphan Activity roots become interrupted after reopening the database, not that
pending backend execution or interactive prompts resume. No host restart or
browser reload should claim to resurrect those maps.

## Terminal and seen-turn proof

The real host probe observes a turn's session_info `turnId` equal to Activity's
`runId`. The same ID progresses from live (outcome/endedAt null) to terminal
success. A second request updates catalog lastActiveAt and creates a different
live run with null outcome/endedAt while the old success remains in history.
A queued follow-up also leaves the earlier live Activity root in place while the
client session badge becomes queued. Queue acceptance is not terminal success,
and its requestId is not yet a new executing turnId.

Thus `lastActiveAt > leftAt`, a missing runStates entry, history existence,
replay-generated message IDs and lastTouched cannot prove latest-turn completion
or visibility. Both catalog stub and result persistence update lastActiveAt.
Activity already provides terminal identity/outcome/end time for a known run,
including after detail pruning. It does not prove which accepted queued request
is latest, that successful history contains that turn, or that it was on screen.

Recommended minimal truthful strategy:

1. Persist root-scoped tracker identity and known request/turn IDs, never
   credentials, transcripts or a global unpartitioned `brain-trackers` key.
   A default root gets a random prefix; an embedder needs an explicit stable
   prefix for reload continuity. Changing principal must remove replay authority.
2. Use a current authorized pending request for **needs you**; a current queue
   entry for **queued**; a live matching Activity turn for **running**. Use a
   matching terminal rollup for **done** or **failed**, with its actual endedAt.
   A known old success cannot hide a newer queued/running/unknown request.
3. Preserve **unknown/unavailable** when the latest accepted identity, authorized
   pending state or replay linkage is unproved. Missing Activity support is
   unknown, not done. Existing failure taxonomy includes error/timeout/interrupted;
   cancelled and denied are user dispositions. Revocation is an authority event,
   not an additional Activity terminal outcome: work can continue after it.
4. Clear a tracker only after the recovered latest turn is rendered at the
   adopted foreground/viewport position. Guard that observation with the exact
   identity so a newer request cannot be erased by an older visibility callback.
   Merely selecting a session or reaching the bottom of an unrelated replay
   does not establish this proof.

For full cold latest-turn semantics, selected recovery A requires executable
identity proof while retaining honest unknown states when evidence is absent.
#943 supplies the exact design and durable amendment; #964 implements the selected read-only
`GET /api/sessions/:id/recovery` envelope with:

```ts
{
  sessionId: string;
  backendId: string | null;
  revision: number; // host-owned per-session accepted-work ordering
  latest: {
    requestId: string | null;
    turnId: string | null; // absent/null before queued work dispatches
    state: "queued" | "running" | "terminal" | "unknown";
    outcome: ActivitySpanOutcome | null;
    startedAt: number | null;
    endedAt: number | null;
  };
  pending: Array<{
    kind: "approval" | "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
    requestId: string;
    turnId: string;
  }>;
}
```

This is selected future scope under recovery A, not an existing endpoint. Latest/revision provenance must be
host acceptance plus the coordinator and durable catalog/Activity records;
backend mtime is insufficient. Unknown remains explicit after lost queue state
or uncorrelated imported history. Successful `session_history` messages need an
optional host-proven `turnId` (or an equivalent replay boundary) before a cold
viewport can claim that turn seen. Do not manufacture linkage from message count,
content equality or timestamp ordering. Missing evidence omits linkage.

Authorization must cover the whole envelope and every pending identity; denial
must not disclose protected work. Recheck leases after asynchronous reads and
retain interactive principal/session/turn binding. The endpoint grants no action.
A compatible host advertises optional recovery support; unsupported peers keep
unknown state. New endpoint/optional history fields/capability require the SDK
schemas, HTTP reference, same-commit integration contract, CONTRACT: commit and
minor changeset. No such machine surface changes in this evidence PR.

## Draft measurements and design input

The ordinary draft cases run at 390/coarse and 900/fine; each starts with `Unsent raft plan` and one valid image.

| Path | Text / image after navigation | Transcript result |
| --- | --- | --- |
| New chat disc | Preserved / 1 | Active session null |
| Sessions New conversation | Preserved / 1 | Active session null |
| Palette New chat | Preserved / 1 | Active session null |
| Drawer A→B selection, including background row | Preserved / 1 | B selected and history replayed |
| Files or Settings and back | Preserved / 1 | A remains selected |
| Actions or Graph and back | Empty / 0 | A's store survives; this composition remounts Composer |

The store's clearMessages does not clear Composer's useState input/images and
does not clear pendingDraftId. Current New chat therefore does not discard an
ordinary unsent local draft, while session selection can carry its text into B.
The later maintainer choice replaces discard confirmation with a separate draft
per session: New chat saves A and opens empty; returning to A restores its text
and attachments. #943 supplies exact restore/delete/focus behavior, #951 owns
composer/send correlation, and #979 owns selected authenticated host storage C
with revision/idempotency, durable attachment bytes and cross-device conflict handling.
Preserved content must not be labelled lost or described as saved before acceptance.

The delayed-frame probe holds actual host frames after a first Composer send:

| Race | Observed result |
| --- | --- |
| Edit a newer draft before acceptance | Newer text remains; submitted image is removed; matching session announcement binds the first turn |
| New chat before acceptance | Newer text remains, old submitted image is consumed on receipt; new view remains unbound but pendingDraftId remains stale |
| New chat, then local stats creates a draft | Old matching announcement adopts the recreated stats draft and selects the old session, undoing New chat; newer text remains |
| Attempt another send while acknowledgement is held | Pending-send guard prevents a second dispatch; it is not evidence of two simultaneous first sends |

The selected per-session draft lifecycle must coordinate local input lifetime,
accepted versus unconfirmed send ownership, correlation invalidation and receipt consumption. Preserve an
unknown send for review rather than silently resending it. A background result
cannot own a new draft. Explicit draft removal and accepted-send consumption must target the matching
identity/revision, retaining newer unsent edits and another session's attachments.
No discard confirmation for preserved drafts or streaming-only backend cancel
is selected by the later ruling.

## Source anchors

The ranges below describe the measured package snapshot, not an inferred future
implementation. Any PR moving these lines owns their citation repairs.

- Palette commands: [`const jumpTo: PaletteItem[] = [`](https://github.com/schlessera/brain-kit/blob/18d5ddee154b5dbebb3dbd6c487bc8ea1fc036db/packages/ui-react/src/components/layout/desktop-palette.tsx#L84-L117), before #946 moved the destinations into `desktop-routes.ts`.

- Palette opening: [`function onKey(e: KeyboardEvent) {`](https://github.com/schlessera/brain-kit/blob/18d5ddee154b5dbebb3dbd6c487bc8ea1fc036db/packages/ui-react/src/components/layout/desktop-palette.tsx#L52-L59), before #946 moved the open state into the root's UI store.

- Phone destinations/More: (`const items: TabItem[] = [`, `packages/ui-react/src/components/layout/mobile-tab-bar.tsx:92-148`).

- Command availability/effects: (`export function useChatCommands(): (command: string) => void {`, `packages/ui-react/src/components/chat/use-chat-commands.ts:18-56`).

- Stats local exchange: (`export async function runStats(root: BrainUiRoot, sessionId: string | null): Promise<void> {`, `packages/ui-react/src/components/chat/use-chat-commands.ts:70-156`).

- Welcome alternatives: (`label="Start with"`, `packages/ui-react/src/components/chat/welcome-state.tsx:46-55`).

- Session selection: (`const handleSessionResume = useCallback(`, `packages/ui-react/src/components/chat/chat-page.tsx:445-452`).

- New chat: (`{hasMessages && !wide && (`, `packages/ui-react/src/components/chat/chat-page.tsx:650-657`).

- Buffer eviction: (`function evictStale(`, `packages/ui-react/src/stores/chat-state.ts:1016-1032`).

- Root namespace: (`const prefix = options.storagePrefix ??`, `packages/ui-react/src/root.ts:180-214`).

- Clear transcript selection: (`clearMessages: () => {`, `packages/ui-react/src/stores/chat-state.ts:1907-1916`).

- Composer draft/acknowledgement: [`const [input, setInput] = useState("");`](https://github.com/schlessera/brain-kit/blob/7bfdc71074f4ff6243e0d7133e83dbb36eb2a971/packages/ui-react/src/components/chat/composer.tsx#L62-L85), before #951 moved the draft into the root's draft store (`stores/draft-state.ts`).

- Receipt consumption: [`if (!receipt || !pendingSend) return;`](https://github.com/schlessera/brain-kit/blob/7bfdc71074f4ff6243e0d7133e83dbb36eb2a971/packages/ui-react/src/components/chat/composer.tsx#L161-L176), before #951 moved send settlement into the draft client (`lib/draft-client.ts`).

- Draft announcement correlation: (`function isOurDraftAnnouncement(`, `packages/ui-react/src/connection.ts:79-90`).

- Demux: (`const frameSessionId = (msg as { sessionId?: string }).sessionId;`, `packages/ui-react/src/connection.ts:458-532`).

- History replay: (`session_history: (msg, context) => {`, `packages/ui-react/src/hooks/websocket-handlers/chat.ts:409-419`).

- Single background drawer row: [`const backgroundSessionId =`](https://github.com/schlessera/brain-kit/blob/ea8506b0eb511a3e16dba685d250d34e5340afa4/packages/ui-react/src/components/chat/session-drawer.tsx#L59-L60), before #950 replaced it with the Working group.

- Host reconnect: (`const runningTurns = [...coordinator.running].filter((t) => t.sessionId);`, `packages/ui-server/src/ws/connection.ts:125-191`).

- Host resume: (`case "session_resume": {`, `packages/ui-server/src/ws/dispatch.ts:592-653`).

- Catalog activity: (`persistSessionStub(sessionId, promptText, providerId, backendId) {`, `packages/ui-server/src/ws/session-catalog.ts:219-258`).

- Session summary shape: (`export interface ChatSession {`, `packages/ui-sdk/src/protocol.ts:1455-1471`).

- Run identity: (`const runId = turn.turnId;`, `packages/ui-server/src/activity/recorder.ts:106-107`).

- Outcome vocabulary: (`export type ActivitySpanOutcome =`, `packages/ui-sdk/src/protocol.ts:2713-2736`).

- Activity resolution: (`.get("/activity/runs", (c) => {`, `packages/ui-server/src/routes/activity.ts:130-266`).

- API authorization: (`app.use("/api/*", authGuard(authMode, auth, db));`, `packages/ui-server/src/app.ts:551`).

- Queued acceptance: (`// Queue it as the session's next turn; report queued immediately.`, `packages/ui-server/src/ws/run-session.ts:683-727`).

- Approval target: (`function mutateLastAssistant(`, `packages/ui-react/src/stores/chat-state.ts:1124-1154`).

## Bounded follow-up ownership

[#964](https://github.com/schlessera/brain-kit/issues/964) implements the selected
latest-turn/replay proof and pending-approval recovery after #943 supplies its exact design.
[#910](https://github.com/schlessera/brain-kit/issues/910) retains the four ask
recovery paths; #951 retains New chat draft/receipt coordination.
[#965](https://github.com/schlessera/brain-kit/issues/965) records the currently
unnamed Files drawer close button found while measuring dismissal. These scopes
consume the later recovery A and draft-storage C rulings in #929. This report
implements neither contract and does not waive their separate design, compatibility
or runtime proof requirements.
