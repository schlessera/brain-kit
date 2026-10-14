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

## Running and changing this coverage

Build the workspaces, then run both projects through the pinned runner. File
filters are repeatable and select the same files in both projects:

```sh
node scripts/visual.mjs --project=storybook --project=storybook-light \
  --filter=Composer.stories --filter=ComposerRow.stories \
  --filter=SessionStrip.stories --filter=PendingFollowUps.stories \
  --filter=ComposerTheme.stories --filter=SessionTheme.stories \
  --filter=InPrint.stories
```

The default runner still discovers every story in both themes. Focused runs do
not replace the complete selected hosted proof or visual/accessibility gates.
For a new parity assertion, seed a theme-only geometry or interaction defect,
observe the named browser assertion fail, restore it and record source,
command and failure in the PR. Compare source-matched baseline/final runs on
the same runtime/resources; report added central cost separately from savings
in runtime suites that later use this map.
