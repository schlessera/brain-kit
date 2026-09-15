# The twenty mobile screens

Source: `Second Brain Mobile.dc.html` from the design drop (791 lines). Two
"turns": **turn 1** (`1a`–`1l`, 12 screens, "Second brain PWA — first pass") and
**turn 2** (`2a`–`2h`, 8 screens, "Async collaboration — Queue & Actions
flows"). Turn 2 appears first in the file; turn 1 is the older pass.

**All twenty screens are raw markup.** The file contains zero `dc-import`, zero
`sc-for`, zero `sc-if` — its only `DCLogic` is a four-line class that re-runs
`lucide.createIcons()` on a timer. Every screen is hand-written inline styles
inside a 390×844 device div (`border-radius:42px; border:9px solid #1c1d20`).
The kit was extracted *from* these screens afterwards, so the "kit components"
column below is a mapping of what each screen's elements became, not a record of
what it imports.

The repo column follows `github.md`'s screen map, checked against the actual
file list under `packages/ui-react/src/components/`.

---

## Flow A — Chat + inline UI

### `1a` Chat — the home surface
What it is: the default destination. Header with brain avatar, connection
status, filament rule; user bubble; collapsed tool trace ("4 steps · 3 files
touched · 2.1s"); an entity-coloured answer with `▹` bullets; an amber deadline
callout; three file citation chips; a response-action row (copy / share /
thumbs-up / retry); two suggestion chips; composer with attach, mic, send and
`/ for commands`; five-slot tab bar.

Kit: `ScreenHeader(title, filament)` · `MessageBubble(user)` ·
`Disclosure` · `PathRef` ×3 · `Callout(amber, deadline)` · `SuggestionChips` ·
`Composer(send)` · `TabBar` · `StatusDot(teal)`

Repo: `chat/chat-page.tsx`, `chat/message-bubble.tsx`,
`chat/brain-markdown.tsx`, `chat/composer.tsx`, `chat/tool-call-timeline.tsx`,
`layout/mobile-tab-bar.tsx` — **good coverage.**

### `1b` Inline elements — the in-chat UI gallery
What it is: one scroll containing every inline element: an "Brain needs your
input" ask card with a `Filing` tag and three options, a confirm-before-action
approval with a 4-line diff and an amber risk hint
("overwrites a field referenced by 2 other docs"), an inline 3-column table
(Client / Open AR / Days), and a "Was this filing right?" rating row.

Kit: `AskUserCard` · `ChoiceOption` ×3 · `ApprovalCard` · `DiffBlock` ·
`Callout(red, risk)` · `DataTable` · `FeedbackRow` · `Button(affirm/danger)` ·
`ScreenHeader(nav)`

Repo: `chat/ask-user-card.tsx`, `chat/tool-call-timeline.tsx`,
`chat/tool-views.tsx`, `chat/renderers/*` — **partial**: the ask card and tool
views exist; there is no inline table renderer and no rating row
(`FeedbackRow` has no counterpart).

### `1k` Light variant — warm paper
What it is: `1a`'s chat, re-tinted to a light theme. Same structure, an
"I'm forgetting before Friday?" answer as a numbered list, a "Pick one and I'll
draft it" choice block.

The inverted palette, read off the markup:

| Role | Dark | Warm paper |
|---|---|---|
| canvas | `#0c0e12` | `#f4f0e8` |
| surface | `#141619` | `#fffdf8` |
| line / edge | `#1f2229` / `#2a2d35` | `#e9e2d5` / `#ddd4c4` |
| ink | `#e8e4df` | `#231f1a` |
| ink dim | `#c0bcb5` | `#5b544a` |
| machine meta | `#8a8691` | `#8a8175` (also `#a69d90`) |
| amber → ink-brown | `#e09f3e` | `#9a6a1c` |
| gold | `#eab354` | `#c9a153` / `#e0b464` |
| teal (unchanged role) | `#5bb5a2` | `#2f7f6d` |
| red | `#f87171` | `#c0453f` |

Kit: `PhoneFrame theme="paper"` — and **only** `PhoneFrame`. The README's
"Known gaps" is explicit: "the component tones are dark-first. A second tone
table is the port-time work if paper becomes a real theme."

Repo: **no counterpart.** `use-graph-theme.ts` states the app is dark-only —
no `.dark` class, no `prefers-color-scheme`, no `[data-theme]`. This is the
screen that decides whether D9 (run every story in both themes) collapses to one
Vitest project or stays two.

---

## Flow B — Agent monitors

### `1c` Agents — orbit
What it is: the activity destination as an orbit. A breathing brain core
("4,812 docs") with four agent pills placed at a distance proportional to how
far from done they are (`researcher 72%`, `note-filer 2/3`, `source-watch done`,
`ledger failed`). Below: an "In flight" list with per-run step counts, token
counts, elapsed time, the run's task quoted, and a tool strip
(`✓ brain_search ✓ Read ×3 ▸ WebFetch`); then "Last 24h"; then a footer
"14 runs · 312k tok · ≥ $0.31 spent".

Kit: `AgentOrbit` · `AgentRunCard` ×2 · `ScreenHeader(title)` ·
`ListRow(plain)` ×3 · `TabBar` · `StatusDot`

Repo: `activity/activity-page.tsx`, `activity/activity-run-list.tsx`,
`chat/subagent-view.tsx`, `activity/span-bits.tsx` — **partial**: run lists
exist, **the orbit does not.**

### `1d` Agents — swim lanes + drill-in
What it is: the same data on an elapsed-time x-axis (0s / 30s / 60s / 90s), four
lanes, a legend distinguishing **running / waiting on you (hatched) / failed**,
and below it a drill-in into one subagent's tool timeline with per-call
durations and quoted output. Ends with the rule that makes this screen different:
*"Observation only. No composer here — you can approve a tool it stalls on,
nothing else."*

Kit: `LaneChart` · `ScreenHeader(nav)` · `AgentRunCard` · `TraceSteps(list)` ·
`PathRef`

Repo: `activity/span-bits.tsx`, `activity/activity-run-detail.tsx`,
`chat/subagent-view.tsx` — **partial**: span rendering exists, **the lane chart
does not.**

---

## Flow C — Files

### `1e` Files browser
What it is: a file manager over the real taxonomy. Header with doc count and
index age, a filter input, four pill filters (All / Unprocessed 3 / Stale 11 /
Orphans), then the tree: folders with counts, one `stale 38d` gold flag, one
open folder with an unprocessed badge, leaf files including an image and an
`_index.md` marked `index lag`, plus an add FAB.

Kit: `ScreenHeader(title)` · `FilterRow` · `Chip(pill)` ×4 · `FileRow` (all four
kinds: folder / open / file / image) · `TabBar`

Repo: `files/file-tree.tsx`, `files/file-panel.tsx` — **good coverage.**

### `1f` File viewer
What it is: a markdown document. Nav header with share and edit; frontmatter as
kv chips (`type: talk`, `status: active`, `relevance: primary`,
`deadline: 2026-09-07`) plus hashtags; prose with live wiki-links (`↗ marta-reis`,
`↗ talks/lisbon-2025`); "Open questions"; "Linked from · 4" backlinks; a primary
"Ask about this file" button and a bookmark.

Kit: `ScreenHeader(nav)` · `Chip(kv)` ×4 · `PathRef(link)` · `RelatedFiles`
(backlinks) · `Button(primary)`. **The prose body itself has no component** —
see `catalog.md` §4 for the type contract it implies.

Repo: `files/file-viewer.tsx`, `files/file-viewer-markdown.tsx`,
`files/frontmatter-panel.tsx`, `chat/brain-markdown-links.tsx` — **good
coverage**, and the repo's markdown vocabulary is the one that should absorb the
type contract rather than a new component.

---

## Flow D — Search / graph

### `1g` Search + graph
What it is: one query with three result tabs (Results 9 / Graph / Timeline).
Results are path + relevance score + a highlighted snippet. The Graph tab is the
same query as a 2-hop neighbourhood (34 nodes) with a person/company/project
colour legend — "the graph as a second tab on the same query rather than a
separate destination."

Kit: `SearchResultCard` ×2 · `GraphView` · `FilterRow` (the tab strip) ·
`ScreenHeader` · `TabBar`

Repo: `quick-actions/search-modal.tsx`, `graph/graph-page.tsx`,
`graph/graph-canvas.tsx`, `graph/node-popover.tsx` — **coverage exists but the
shape differs**: the repo has search as a *modal* and graph as a *destination
page*; this screen unifies them under one query. That is an information-
architecture change, not a component gap. The "Timeline" tab has no counterpart
at all.

---

## Flow E — Onboarding

### `1h` First run / empty state
What it is: a brain mark, "What do you need to know?", the reassurance line
("4,812 documents, indexed 2 minutes ago. Everything stays on your own
machine."), three launcher rows (What's new? / Process 3 loose notes / Brain
health), the hint line, and — **last, not first** — the PWA install prompt
("you earn it after one useful answer").

Kit: `EmptyState(first-run)` · `ListRow(launcher)` ×3 · `Callout` (the install
prompt) · `Button(primary)` · `Composer`

Repo: `chat/welcome-state.tsx` — **partial**: a welcome state exists; the
launcher rows and the deferred install prompt do not.

---

## Flow F — Share + notifications

### `1i` Share target + notification stack
What it is: two PWA surfaces on one artboard. Top: a lock screen with three
stacked notifications — a rich actionable one with inline `Health log / Drop it /
Open` buttons, a digest-ready one, and a failure one. Bottom: the incoming share
sheet, "Shared to Brain from Safari", the article's title and source, and one
question ("Two places this fits. Pick one and I'll file it with a summary.")
with two choice rows and Cancel / File it.

Kit: `NotificationCard` (rich + compact + dim) · `ChoiceOption` ×2 ·
`LinkPreviewCard` · `Callout(purple, trust)` · `Button` ×2

Repo: `share/share-menu.tsx`, `hooks/use-share-intake.ts`,
`activity/push-toggle.tsx`, `chat/share-card.tsx`, `dev/share-harness.tsx` —
**partial**: share intake exists, **the notification stack does not** (push is a
toggle in settings, not a rendered surface).

---

## Flow G — Settings

### `1j` Settings
What it is: five groups — **Connection** (Tailscale status with an `up` value,
Passkey), **Agent** (Model, "Ask before writing files" toggle, "Spend this
month" with a cap), **This device** (Push notifications toggle, Share target,
"Re-index now" with a Run action). "Kept to what a self-hosted brain actually
needs: reach, model, spend, push, index."

Kit: `ScreenHeader(title)` · `Label` ×3 · `Surface(pad=0)` ×3 ·
`ListRow(group)` ×8 (exercising all four trailing slots: value, toggle, action,
chevron) · `Toggle` · `TabBar`

Repo: `settings/settings-panel.tsx`, `settings/models-tab.tsx`,
`settings/passkey-tab.tsx`, `settings/devices-agents-tab.tsx`,
`settings/tool-permissions.tsx`, `settings/web-search-settings.tsx`,
`settings/skills-tab.tsx` — **good coverage**, in fact the repo has *more*
settings surface than the design shows.

---

## Flow H — Navigation

### `1l` Alt navigation — no tab bar
What it is: the composer as the only permanent chrome. A "Thursday, quiet so
far" hero with three stat chips (3 unfiled / 1 deadline < 14d / 1 failed run);
a "Picked up while you slept" card with Decide now / Later; a 2×2 launcher grid
(Files / Graph / History / Settings); "Back where you left off" with three
recent items; a thin live-agent ticker riding above the composer
(`researcher · WebFetch lxfactory.com · 72%` `+2`); and a voice composer.

Kit: `ScreenHeader(hero)` · `Chip` ×3 · `ActionCard` · `ListRow(launcher)` ×4 ·
`ListRow(plain)` ×3 · `AgentRunCard` (as ticker) · `Composer(voice)` ·
**no `TabBar`**

Repo: `layout/side-rail.tsx`, `layout/app-shell.tsx`,
`layout/mobile-tab-bar.tsx` — **no counterpart** for this navigation model. The
repo has no router; navigation is `useUIStore.activeView` plus `useHashRoutes()`.
This screen is an alternative that was never built.

---

## Flow I — Queue / Actions async loop (turn 2, `2a`–`2h`)

The whole turn is governed by three stated ideas: **the effect is the UI, not
the label** (every option shows the exact tool, input and target path plus its
effect type as a mono chip); **resolution is free** (a tap is a DB write, so the
UI promises "resolves instantly, no model call"); **trust is a server fact,
shown as provenance** (untrusted origin is a persistent purple label, never a
phrase inside model prose). One navigation change: **Actions takes its own tab
slot** next to Activity.

### `2a` Actions — the list
Grouped by thread, ordered by priority score, cap pressure as a quiet meter
("6 / 60 open") rather than an error. Four action kinds shown (approval, choose,
dead-letter, quarantined) plus a non-decision FYI strip.

Kit: `ScreenHeader(title)` · `Meter(bar)` · `Label(thread)` ×2 ·
`ActionCard` ×4 (`approval` / `choose` / `dead-letter` / `quarantined`) ·
`Chip(outline, purple provenance)` · `StatusDot` · `TabBar(active=Actions)`

### `2b` Approval detail — **the core screen**
The capability shown as a receipt (tool · path · scope), the run's checkpoint
quoted as evidence ("why it stopped": two `✓` steps and one `⏸`), and every
button naming its effect (`enqueue`, `cancel_blocked`). Footer:
"resolves instantly · no model call · execution runs later".

Kit: `ScreenHeader(nav)` · `Receipt` (with `DiffBlock` and scope footnote) ·
`TraceSteps(rail)` · `Button(primary + ghost + quiet ×2)` with `effect` chips ·
`Callout(banner, mono)`

### `2c` Choose + dismiss-reason sheet
A `choose` action on untrusted material with the dismissal sheet open. Five
reason chips, and a suggestion callout ("3rd 'already know this' on shared
articles. Make it a standing rule?" · `v2`).

Kit: `ScreenHeader(nav)` · `Callout(purple, trust, banner)` ·
`LinkPreviewCard` · `ChoiceOption` ×2 · `BottomSheet` · `Chip(pill)` ×5 ·
`Callout(boxed, suggestion, trailing)` · `Button` ×2

### `2d` Later + resurface
"'Later' is a rule, not a guess" — four snooze options each showing the clock
time it resolves to, with a timezone footnote. Below: a 24-day-old action back
from snooze with its premise broken, costed both ways ("re-check spends ~1k
tokens · closing spends none").

Kit: `ScreenHeader(nav/hero)` · `ListRow(card)` ×4 · `Callout(banner, mono)` ·
`ActionCard(kind="unverified", struck)` · `Surface(emphasis="dashed")` ·
`Button` ×2

### `2e` Policy quarantine
Hash mismatch stated plainly (`expected` vs `on disk`), the diff shown, a red
callout naming the escalation ("This edit would let receipt filing run shell
commands. Brain didn't write it"), a provenance block, and two actions. The
grant stays inert until a thumb says otherwise.

Kit: `ScreenHeader(nav, subTone=red)` · `Receipt(hashRows)` · `DiffBlock` ·
`Callout(red, failed)` · `Surface(label="Provenance")` ·
`Button(primary, effect="write_policy")` · `Button(ghost)` ·
`Callout(banner, mono)`

### `2f` Queue — read-only
The agent's side of the loop. Filter pills (all 9 / ready 3 / blocked 1 /
failed 1), then six queue rows covering **every state**: claimed (with lease),
blocked (pointing at the Action holding it), ready, scheduled, failed
(dead-lettered with a note), superseded. Footer: "Today's autonomy" with three
meters (spend / turns / reserve).

Kit: `ScreenHeader(title)` · `FilterRow` · `QueueItemRow` ×6 (all six states) ·
`Label` · `Meter(row)` ×3

### `2g` Budget stop
The hard stop. A hero explaining the pause, a segmented spend meter with a
**reserve segment red from the moment it exists**, a caveat about unpriced runs,
a "Where it went" attribution list, and the only two honest ways out — stated as
costs, not as a scary modal.

Kit: `ScreenHeader(hero)` · `Meter(bar, reserve)` · `Chip(legend)` ×2 ·
`Callout(unverified)` · `BarList` · `Button(ghost + subtitle)` ×2 ·
`Callout(banner, mono)`

### `2h` Push + intake
Both edges of the loop on one lock screen: a coalesced escalation push
("3 actions waiting — 1 approval, 1 choice, 1 failed run" · "coalesced over 10m ·
quiet hours respected") with inline actions, a dedupe receipt, a dim FYI, and a
"Notification rules" list stating the policy per kind (Approvals push now /
Choices coalesce 10m / Failed runs first only then digest / FYIs never push).

Kit: `NotificationCard(rich)` · `NotificationCard(compact)` ·
`NotificationCard(dim)` · `Label` · `ListRow(group)` ×4 · `Button` ×2

### Repo coverage for the whole of Flow I

**None of the eight screens has a counterpart.** Verified by grep over
`packages/ui-react/src`: no "dead letter", no queue surface, no Actions
destination, no snooze/later, no policy quarantine, no budget stop, no
notification stack. Tool approval exists only *inline in chat*
(`chat/chat-page.tsx`, `chat/tool-call-timeline.tsx`, `chat/risk-hints.ts`,
`settings/tool-permissions.tsx`), which is screen `1b`'s model, not `2b`'s.

This is the single largest gap between the design and the repo: **eight of twenty
screens, and the six kit components that exist only to serve them**
(`ActionCard`, `QueueItemRow`, `ApprovalCard`, `Receipt`, `Meter`'s reserve
segment, `NotificationCard`).

---

## Summary — screens with no repo counterpart

| Screen | Status |
|---|---|
| `2a`–`2h` (8 screens, the whole async loop) | **no counterpart** |
| `1l` alt navigation | **no counterpart** |
| `1k` light / warm paper | **no counterpart** (app is dark-only) |
| `1c` orbit | orbit metaphor absent; run lists exist |
| `1d` lane chart | lane chart absent; span rendering exists |
| `1i` notification stack | absent; share intake exists |
| `1h` launcher rows + deferred install | absent; welcome state exists |
| `1b` inline table + rating row | absent; ask card + tool views exist |
| `1g` unified query tabs, Timeline tab | IA differs; Timeline absent |
| `1a`, `1e`, `1f`, `1j` | good coverage |

Under **D4** (build everything the kit shows and no more) all of the above are in
scope as *components*, because every one of them is in `Brain Kit.dc.html`.
Under **D5** the missing *screens* are a separate question: `ui-kit` gets the
components; whether `ui-react` grows an Actions destination is a product
decision this plan does not need to make.
