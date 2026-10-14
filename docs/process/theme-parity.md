# Theme parity coverage

Storybook owns reusable light/dark layout and interaction parity. Both
`storybook` and `storybook-light` execute the same story assertions and axe
gate with the pinned browser and fonts. A rendered image alone is not an
interaction oracle. Numeric bounds below are identical in both projects;
colours may differ, but accessibility is checked independently in each.

## Coverage map

| Guarantee | Central stories and assertions | Independent cases |
| --- | --- | --- |
| Intended theme actually paints | The preview's `afterEach` compares the runner's independent expected theme with resolved globals, the decorator's `data-theme`, and Chromium's computed `color-scheme`. | Story-level globals and `parameters.themes.themeOverride` are explicit overrides. `Blocks/In print` intentionally remains print in both projects; it is print coverage, not light/dark coverage. |
| Geometry, overflow and wrapping | `Chrome/ComposerRow/BothHalves320`, `BothHalves390`, `BothHalves900`: 8px gutter, 94px row, bottom alignment. `Chrome/SessionStrip/Phone320`, `Wide`, `LongContent`: state text fits, narrow two-line layout, long title truncation. `Chrome/PendingFollowUps/LongPrompt`: full text fits its half, at most 280px. | Narrow and wide component containers exercise different layout branches; every state need not repeat every width. |
| Composer sizing | `Chrome/Composer/GrowsWithNewlines`, `GrowsOnSoftWrap`, `StopsAtTheCap`, `StopsAtMaxRows`, `ShrinksBackAndRendersOnce`: newline floor, soft wrapping, 96px/default and custom cap, overflow scroll and shrinking. | Newline, soft-wrap and capped text are different sizing inputs. |
| Focus and tab order | `Chrome/PendingFollowUps/Keyboard`: Tab enters the one-stop group, arrows rove, Escape/Enter toggle full text. `Chrome/SessionStrip/Overflow` and `Chrome/PendingFollowUps/Three`: sheet focus and restoration. | The two groups have different keyboard behavior. Native pointer/media behavior remains in the pointer projects. |
| Input and selection in consumer CSS | `Conversation/Composer theme/Phone`, `Wide`, `Offline`: focus, a nonempty selected range, replacement in controlled state, clearing/typing and shrinking to one line. | 320px ready/offline and 720px ready: width and disabled state are independent inputs, not a Cartesian expansion. |
| Enabled/disabled and click/keyboard behavior | `Chrome/Composer/EnterSendsShiftEnterDoesNot`, `SendButtonIsOperable`, `Streaming`, `Reconnecting`, `Offline`, `Dictating`; consumer composer stories assert Shift+Enter does not send, Enter/click do send, and offline Enter/programmatic click remain inert while computed pointer events are disabled. | Streaming changes the action to Stop; offline and dictating impose different editing restrictions. |
| Attachments and actual consumer composition | `Conversation/Composer theme/Phone`, `Wide`, `Offline` mount the actual `ComposerView` with built consumer CSS in a shadow root: 64×64 attachment, removal, column width, no horizontal overflow, 96px cap and shrink. `Chrome/Composer/Recall` and `AttachIsAMenu` retain recall removal and attach callback/order assertions. | Kit CSS cannot satisfy missing consumer Tailwind classes inside the shadow root. A matching `data-theme` ancestor inside each shadow tree and its computed `color-scheme` are asserted, so consumer theme selectors participate. The attachment is an inline fictional fixture with no network dependency. |
| Follow-up/session rows in consumer CSS | `Conversation/Session theme/Phone`, `DesktopPane` mount actual `ChatComposerRow` and `SessionsPane`: pending pill is 44px and right-aligned, both tracker identities appear, phone row is 94px, desktop pane is 280px, no overflow, tracker Enter/click invokes the right identity. | Phone strip and desktop pane are distinct rendered implementations. The fixture supplies the branch explicitly; ChatPage's 1280px branch selection stays in runtime proof. |
| Empty, collapsed and overflow states | `Chrome/ComposerRow/Absent`, `LeftEmpty`, `KeyboardUp`; `Chrome/SessionStrip/Empty`, `Collapsed`, `AllStates`; `Chrome/PendingFollowUps/None`, `KeyboardUp`, `Three`, `Many`. | Zero, one/two and overflow records select distinct structures. State words, order, focus, counts and row dimensions are asserted where relevant. |
| Colour and accessibility | The unchanged preview `a11y.test: "error"` gate applies to both projects, including consumer shadow trees. Existing sanctioned per-story exceptions and their independent contrast tests remain. | Passing geometry does not replace contrast, accessible names or image baselines. |

The added consumer assertions start at (`Phone`,
`packages/ui-kit/stories/conversation/ComposerTheme.stories.tsx:45-99`) and
(`Phone`, `packages/ui-kit/stories/conversation/SessionTheme.stories.tsx:54-87`).
The existing story files are under `packages/ui-kit/stories/chrome/`.
 No runtime assertion is removed by
establishing this map.

## Account and journal consumers

`Conversation/Account theme` and `Conversation/Journal theme` mount the actual
`AssociateRecordings`, composed `PasskeyTab`/`LocalWorkDialog`, and
`TurnJournal`. Their document uses the built consumer stylesheet with the kit
preview utility sheets disabled for the fixture lifetime. Pinned fonts remain
installed. The native dialog implementation renders inline: its top-layer box
belongs to the same document and inherits the intended `html[data-theme]`.
These cases do not use a shadow root or a narrow container as viewport proof.

Each case verifies `innerWidth`, the actual 900px pane media query, reduced
motion and computed `color-scheme`. `Account theme/Phone320`, `Phone390`, `Laptop900`, `Desktop1280`
use all four original widths; `Journal theme/Phone` and `Desktop` use
320/1280px. Both Storybook projects run all six stories (12 executions). They retain the
unchanged addon accessibility gate and additionally check every transient
state/dialog with the runtime's WCAG A/AA rule tags, including contrast.

The fixture guards against concurrent ownership of one document. Storybook
portable-story teardown and a Vitest test finalizer restore the original
stylesheet disabled states, viewport and media, and unmount/dispose consumer
roots, including after an assertion failure. The default runner keeps file
parallelism disabled; different projects have independent browser contexts.
Mock responses and inventory rows prove presentation and action dispatch only.

The following maps the account and journal assertions to central presentation
proof and native ownership. The account runtime uses 320px dark, 390px light,
900px dark and 1280px light, each with both fine and coarse pointers. The journal
runtime uses 320px dark and 1280px light, each with live and replay receipt
arrival, and both widths for steering and conflict operations. These
deterministic cells retain every native oracle below; the central stories own
the additional theme presentation checks.

| Source case and oracles | Central presentation oracle | Native boundary retained |
| --- | --- | --- |
| `association-signout-runtime.test.ts`, `explicit association and scoped sign-out`: viewport/pointer, association title focus, no default selection, manual reopening empty; `accessible` helper's nonempty controls, ≥44×44 and scoped axe | All four account stories assert actual viewport, title focus, two named choices unchecked, disabled Add, selection changes and cancellation, empty manual reopening, actual controls ≥44×44 and scoped axe for association and sign-out. | Each original fine/coarse pointer condition at every width; update-reload hold; Not now retains both records; reload does not repeat association; retained audio still decodes. |
| Same case: sign-out's separate recording/transcript, accepted-receipt, draft and staged-reference warnings; optional deletion unchecked; Keep working focus; viewport bounds; cancel | All four account stories assert all four warning categories, unchecked optional deletion and its toggle, default Keep working focus, dialog/document bounds, cancel returns to opener without calling the fixture sign-out action, reopening resets deletion consent. | Count provenance from real inventory; cancellation preserves account work; real sign-out navigation and retained-count notice. Fixture inventory and untouched spies do not prove deletion/authentication. |
| Same case: no association upload/transcription, selected record moves, account records excluded, forbidden reassignment/account-to-unassigned moves; `assertEmpty` helper's records and size ledger; other partitions unchanged; egress | No replacement claimed. Choice selection and cancellation are presentation checks only. | Every host-write, association/ownership refusal, IndexedDB record/ledger deletion and byte-for-byte unassigned/other-account metadata/audio assertion, plus no external egress. |
| `turn-journal-runtime.test.ts`, `journal live/replay`: collapsed disclosure/count, no expanded Steering heading, ≥44px; incoming journal preserves composer focus and idle stream/run state | Both journal stories assert collapsed state/count/no Steering heading, ≥44px disclosure, bounds and Enter expansion. | Live/replay hydration and receipt arrival preserve native composer focus and do not reopen stream/run state. |
| Same case: Steering before Content, recorded taint only, no generic steering revert; outward heading, irreversible scope, approved/declined receipts, no external-action revert | Both journal stories assert every listed heading/order/warning/receipt/no-action fact in the expanded actual consumer, with scoped axe. | Server attribution, governance receipts and irreversible semantics remain runtime/server proof. |
| Same case: ordinary reader awaited text, title focus, per-file revert, HTTP download bytes, document/zoom bounds, Escape preserves disclosure and restores trigger, egress | Both journal stories open the actual ordinary reader by Enter, await diff text, assert title focus, document ownership/theme, reader/document bounds, raw download link semantics, ≥44px per-file revert, dispatched action, Escape return and open disclosure. | Real HTTP 200 download and exact CRLF bytes; document 200% zoom; native focus/navigation integration; no external egress. |
| Same file, `steering skill review and existing per-file revert`: awaited title/diff, focus, recorded taint, zoom, Escape return, Revert/Undo receipts and exact skill bytes | Both journal stories traverse the steering reader and assert awaited diff, title focus, recorded taint, reader bounds, explicit per-file revert dispatch, Escape return and visible Undo affordance after fixture receipt. | Actual Revert/Undo operations, exact before/after skill bytes and receipt completion, 200% zoom and egress. Fixture callbacks do not execute a filesystem operation. |
| Same file, `shared conflict reader chooses retained versions, keeps both and Undo`: title focus, truthful conflict copy, observation selection/diff, explicit Keep both, receipts, selected/companion bytes, zoom, Undo content/removal, egress | Both journal stories traverse the conflict reader, assert focus/copy/bounds/axe, switch observations, assert the Other observed version selector and explicit ≥44px Keep both action, dispatch selected/other/expected observation identities, and show Undo after a fixture receipt. | Exact selected and companion file contents, actual resolution/Undo receipt and execution, companion removal, index updates, stale/conflict handling, native 200% zoom and no egress. |

Artifact `FilePanel` is not represented by this central coverage. Its complete
`artifact-recovery-runtime.test.ts` matrix remains necessary: native title and
opener focus; status cardinality; document and 200% zoom bounds; retry size,
visibility and four edge hit tests; static reduced-motion loading; awaited
500/offline/403/413/PDF/404 states; status/alert/retry/download truthfulness;
native PDF painting; route/auth/retry/race/navigation and egress proof. The
loading wrapper currently fails `aria-prohibited-attr` in actual consumer
coverage ([#1884](https://github.com/schlessera/brain-kit/issues/1884)); it has no
passing central replacement. No artifact runtime reduction is justified by
this map.

The native helper and awaited-state assertions are part of this map even when
they are not standalone `expect` calls. Native hit/zoom/media, storage/auth,
HTTP/file bytes and operation execution are deliberately not approximated by
Storybook callback assertions. Central presentation coverage does not replace
these native proofs or change product/public interfaces.

## What this map does not prove

The stories do not prove reconnection, replay, DOM identity across recovery,
scroll preservation, persistence, authorization, upload ownership, session
association or server deadlines. Those guarantees keep their runtime tests
and independent oracles. A runtime matrix reduction must name the specific
assertions covered here and retain every unique runtime assertion. A new
consumer surface without a central case still needs its own rendering proof.

The native caret-at-cap assertion in
`packages/ui-kit/tests/visual/composer-caret.visual.tsx` remains necessary:
Storybook's testing-library events do not establish Chromium's native editing
scroll behavior. Native pointer hit targets, coarse/fine media and focus
behavior retain their pointer/browser projects. Component selection/input
assertions do not claim those boundaries.

Theme persistence, switching and first paint legitimately require application
proof. A theme-specific styling or contrast regression requires its reproducing
case. A consumer stylesheet boundary needs the actual consumer CSS, as above;
a kit-only render cannot stand in for it. The shadow fixtures cover descendant
`[data-theme]` selectors and inherited tokens; selectors requiring an actual
`html`/`body` ancestor inside the consumer document require an application
fixture, not an assumption that shadow isolation covers them. Reconnection, persistence or auth by
themselves do not justify running an otherwise identical scenario twice.

## Connection continuity runtime matrix

`packages/ui-react/tests/connection-continuity-runtime.test.ts` runs missed
progress, ten disconnect/reconnect cycles and native IME recovery at 320px in
dark and 1280px in light. Each family removes only its 320px light and 1280px
dark copies. The fixed themes keep both painted themes represented without
multiplying the independent phone-strip and desktop-pane recovery paths.

| Assertions in the removed copies | Coverage that remains |
| --- | --- |
| The selected theme paints; composer sizing, wrapping, editing, focus/selection, attachment rendering and send availability | The preview theme gate and `Conversation/Composer theme/Phone`, `Wide`, `Offline`, plus the composer sizing/action stories above, assert both themes with actual consumer styles. |
| Phone/desktop tracker and follow-up row geometry and interaction | `Conversation/Session theme/Phone`, `DesktopPane`, plus the `ComposerRow`, `SessionStrip` and `PendingFollowUps` stories above, assert both themes. Runtime still selects the actual application branch at both widths. |
| Composer/message geometry and scroll across recovery; textarea/message/image/pill identity; draft value, focus, alternating caret/selection and object URLs | Every `same` assertion remains in all three scenario families at both widths. Story geometry/editing checks do not replace recovery continuity. |
| Real browser offline events, listener/socket interruption, delayed history and queue reports, upload interruption/retry/completion, no unsolicited sends, retained drafts/trackers/follow-ups and ordered missed deltas | The original scenario bodies and native barriers remain at both widths, including all ten stress cycles and terminal replay/queue draining. |
| Native IME composition survives two outages and commits only when the user requests it | The original CDP composition/commit and host-saved draft assertions remain at both widths; Storybook input events are not an IME substitute. |

The three stale-history variants and the finite-animation readiness control
remain independently parameterized. This gives ten tests: six responsive
scenario cases, three stale-history cases and one readiness control. Cleanup,
negative observation windows and timing/deadline behavior are unchanged.

## Running and changing this coverage

Build the workspaces, then run both projects through the pinned runner. File
filters are repeatable and select the same files in both projects:

```sh
node scripts/visual.mjs --project=storybook --project=storybook-light \
  --filter=Composer.stories --filter=ComposerRow.stories \
  --filter=SessionStrip.stories --filter=PendingFollowUps.stories \
  --filter=ComposerTheme.stories --filter=SessionTheme.stories \
  --filter=AccountTheme.stories --filter=JournalTheme.stories \
  --filter=InPrint.stories
```

The default runner still discovers every story in both themes. Focused runs do
not replace the complete selected hosted proof or visual/accessibility gates.
For a new parity assertion, seed a theme-only geometry or interaction defect,
observe the named browser assertion fail, restore it and record source,
command and failure in the PR. Compare source-matched baseline/final runs on
the same runtime/resources; report added central cost separately from savings
in runtime suites that later use this map.
