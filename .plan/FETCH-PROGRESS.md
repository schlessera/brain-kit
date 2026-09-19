# Design-file fetch — re-fetched 2026-09-19 (sixth pass)

All 66 files are on disk (same 66 paths as the 2026-09-18 drop; the fifth drop
changed ten of them in place, the sixth eight). Nothing outstanding.

## Sixth pass, 2026-09-19 — the rulings

Re-fetched after the maintainer forwarded the twelve remaining questions.
Same 66 paths. **Eight files changed**: `README.md` (two new sections:
"Sixth pass — rulings", "Where truncation is allowed"), `AskUserCard`
(`state` pending/answered/typed, `otherOpen` field, `answer`/`answerMeta`),
`MapView` (height clamped 110–260 with the envelope arithmetic), `InlineToast`
(the target wraps, `overflow-wrap: anywhere`), `FileRow` and `TraceSteps`
(`title` on the ellipsised span), `Brain Kit.dc.html` (new §13 "A question is
an exchange · a mask is a receipt"; three demo rows dropped from §12),
`Brain Kit Desktop.dc.html` (D3 rail-never-collapses sentence; D6 `Colour`
FilterRow topic · distance · folder · entity and the gold "stale needs mtime
· untrusted needs provenance" footer). Fetched selectively this time: the
README first, then only the files its rulings name plus the ones the
truncation rule lists; `GraphView`, `Receipt`, `ListRow`, `SearchResultCard`,
`CommandPalette`, `QuoteCard`, `EmptyState`, `Composer`, `Brain Kit Light`
were fetched and are unchanged. Digested in `design-feedback.md` ("The sixth
drop"); decided as D38. The harvest trap below still applies and was
re-applied.

## Fifth pass, 2026-09-19 — the desktop screens and the navigation answers

Re-fetched after the maintainer forwarded the fifth round of questions. **Ten
files changed**: `README.md` (new sections: Navigation: five destinations,
The palette's contents, The composer is kit-owned, Snooze and the third
button, Focus after the last decision, The off switch, Location fixes, Three
values the palette owed, One closing row per answer; the Desktop section now
lists six layouts), `Brain Kit Desktop.dc.html` (21 KB → 49 KB: D3 Files, D4
Activity-as-Actions-lens, D5 Settings, D6 Graph, D7 scale-up rules — the
1440/1280 pane rule), `Brain Kit.dc.html` (§11 keys table: `a / d` while
focused, `s` only if nothing blocks; §12 chat screen ends in SuggestionChips;
weekly review carries an InlineToast; TabBar `active=1`), `Brain Kit
Light.dc.html` (neutral fill `#a59d8f` stated; `well-on-fill` is
`rgba(255,255,255,.28)` in both themes), `CommandPalette` (real `<input>`,
`cost` and `why` rows, scrolling list, aria-modal), `Composer` (kit-owned:
`state`, provider chip, recall chips, attach menu, stop), `MapView`
(`accuracyM` ring, `note` inside the card, `maxWidth` 420, span
`max(1.6, 6×accuracy)`), `SideRail` / `TabBar` (Chat · Actions · Files ·
Graph · Settings/More), `Toggle` (comment only: no fallback name). Digested
in `design/desktop.md` and `design-feedback.md` ("The fifth drop"); decided as
D37.

**Harvest trap found this pass:** the extractor reads the persisted
`tool-results/` first and the transcript second, so an OLDER inline copy of a
file in the transcript overwrites a NEWER persisted one. After running it,
re-apply the persisted results (newest by mtime) on top. The three catalogs
are the files this bites, because they are the ones large enough to persist.

**Where:** a `design-import/design/` directory under the session's own
project directory outside the repo (the path is in the session's environment
block — deliberately not written here, because `scripts/check-leakage.ts`
scans the whole tree including untracked files and the home-directory path
contains a banned personal string). It is NOT in the repo and will not survive
a machine move; re-fetch as below.

## Fourth pass, later still on 2026-09-18 — the answers

Re-fetched all 66 files after the maintainer forwarded the open questions to
the design. **Fifty-nine files changed**, fifty of them by one substitution:
the machine-meta ink `#8a8691` → `#9a96a1` in every tone map. Beyond that:
`README.md` (rewritten sections: tone table, interaction/keys table, light
theme with a three-value-per-accent table, "Dark inks are stated against
tinted grounds too", "Hover on a toned card", "MapView label collisions",
"Stacked tints of one hue", "Keyboard scope"), `Brain Kit.dc.html` (§11 keys
table, five rule cards, labelled toggles), `Brain Kit Desktop.dc.html` (D3
keyboard and focus rules), `Brain Kit Light.dc.html` (§L1/§L5 generated from
one `PALETTE`; teal/purple/red inks; seven dots; aliases), `AgentRunCard`
(no `?? 72`), `Button` (white well, opaque subtitle), `Surface` (`hover` per
tone, handler → role/tabIndex/focus), `Toggle` (`label`/`labelledBy`, fallback
name), `ListRow` (title id → `labelledBy`), `QueueItemRow` (no opacity),
`MapView` (clustering + meta drop). Applied under D35/D36; the ledger's
"fourth drop" section has the per-question status.

## Third pass, later on 2026-09-18

Re-fetched all 66 files and diffed against the previous copies. Two changed:
`kit/Brain Kit Light.dc.html` and `kit/README.md`. No palette change. The
Light file now computes its ratio column at render time ("ratios are
COMPUTED, never typed … hardcoding these is how the table drifted from the
palette once already"), against the worst ground (red fill at 16% over
canvas), adds an `html body { background }` guard so a light host page beats
the per-component `body{background:#0c0e12}` helmets at (0,0,2) — a DC-runtime
trap, irrelevant to the kit — and fills out the two paper screens: a
"Resolved today" list, a "How we got here" timeline, and a row of suggestion
chips. Two of those drawn values replaced derived ones in the generator
(`suggestion-border-amber` .42 in the ink hue, `suggestion-tint-amber` .14 in
the fill hue). The README carries the same `html body` note.

## What changed since the first fetch (2026-08-26 drop)

- **Three new files:** `kit/Brain Kit Light.dc.html` (the paper theme — digest
  in `design/light.md`), `kit/Brain Kit Desktop.dc.html` (two desktop layouts
  and the scale-up rules — `design/desktop.md`), and `kit/browser-window.jsx`
  (an inert Claude Design starter scaffold for a browser chrome mock; not a
  kit component, ignore it).
- **The catalog moved:** `Brain Kit.dc.html` now lives under `kit/` beside
  the components, not at the project root.
- **`kit/README.md` grew** sections for the tone vocabulary (ten members,
  `neutral` is the grey accent only), interaction states and accessibility
  (the hit-target rules: reach not box size, inset-shadow hairlines,
  per-axis constraint), the light theme, the desktop, contrast auditing (the
  `> 0` vs `> 1` leaf filter), copy constraints (no vendor names), and known
  gaps.
- **Component files that changed in ways the kit had to follow** (third pass;
  the fourth pass is listed above):
  `FeedbackRow` (inset-shadow hairline, `inset:-9px -8px`), `InlineToast`
  (`text-decoration` underline, `inset:-16px -10px`), `ContactCard` (facts take
  the full tone set with a `dim` fallback), `Chip` (count badge takes near-black
  ink), `StatTiles` / `ComparisonTable` / `Receipt` / `SuggestionChips` /
  `ScheduleList` / `Label` (tone tables carry `ink` / `dim` / `edge` explicitly;
  `neutral` is `#8a8691` everywhere; the dead `muted` entries are gone),
  `TabBar` / `SideRail` (badge ink near-black), `MapView` (graticule label
  suppression — already in the kit from the earlier drop).
- **Not changed, and worth knowing:** `AgentRunCard` still carries both the
  `?? 72` fallback and the gate (design-feedback §3 unanswered); `ApprovalCard`
  still renders its two buttons at `50%` each (the even split stands);
  `Toggle` still has no text; `AgentRunCard`, `StatTiles` layouts unchanged.
  The catalog's digest fixture is now three tiles (was four) and its
  `digestToday` count agrees with its `Label` (design-feedback §14).

## How it was done, and the trap to avoid repeating

`DesignSync` is **main-session only** and needs the `/design-login`
authorisation, which cannot be performed from a headless session — it was done
once from an interactive Claude Code session on the same machine and this
session reused it. Subagents do not get the tool at all.

Relaying 66 files by hand would have cost roughly double their size in context.
It was avoided the same way as last time: the harness persists any large tool
result to a file, every inline result is in the session transcript, and
`design-import/extract.ts` (beside the `design/` directory) harvests every
`get_file` payload from both sources and writes them to disk. Re-run after any
further fetch batch:

```sh
bun "$IMPORT_DIR/extract.ts" <session>.jsonl <tool-results-dir> "$IMPORT_DIR/design"
```

It reports `!! TRUNCATED <path>` for any file that hit the 256 KiB `get_file`
cap. Nothing was truncated.

## If a fresh session needs these again

Re-fetch with `DesignSync get_file` from the main session, project
`998d0e7e-1644-48e0-aa35-26dd3022d565` (`list_files` gives the current list —
59 `kit/*.dc.html`, `kit/README.md`, `kit/support.js`, `kit/browser-window.jsx`,
`Second Brain Mobile.dc.html`, `support.js`, `github.md`), then run the
extractor. The three digests under `design/` (`catalog.md`, `light.md`,
`desktop.md`) plus `screens.md` and `runtime-to-react.md` carry everything the
kit was built from, so a re-fetch is only needed to diff a NEW drop.
