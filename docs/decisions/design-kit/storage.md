# Design kit — Storage

## 2026-10-16 — Storage inspection and recoverable attachment removal (#1782)

The maintainer approved the [two-part design](https://github.com/schlessera/brain-kit/issues/1782#issuecomment-6206643236)
and [its completion](https://github.com/schlessera/brain-kit/issues/1782#issuecomment-6206649330),
with [four controlling amendments](https://github.com/schlessera/brain-kit/issues/1782#issuecomment-6206739315):
Settings placement (S1=A), On disk by default (S2=A), decimal units (S3=A),
and first delivery only with safe removal (S4=B). This record consolidates that
approval; it is a design, not evidence of a shipped pane or removal operation.
The screenshots in the original brief illustrate the proposal; the rulings
and layouts here control where the proposal differs.

The [accounting model](https://github.com/schlessera/brain-kit/blob/5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0/docs/plans/storage-accounting.md) supplies ownership,
object identity, capacity scopes and coverage. The [lifecycle model](https://github.com/schlessera/brain-kit/blob/5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0/docs/plans/storage-lifecycle.md)
supplies action eligibility and recovery. Read both with the later
[native storage decision](../native-brain-storage.md): immutable native
checkpoints, writable output staging, turn temp and retained recovery objects
have distinct owners and capacity. A lower-only deletion does not release
writable-upper headroom. Neither discovery authorizes a new retention policy.

> **2026-11-02 — Both discoveries left `docs/plans/` ([#2511](https://github.com/schlessera/brain-kit/issues/2511)).**
> #1779, #1780, #1781 and #2013 are closed, and the inventory, owner
> maintenance and recoverable removal they informed are built (#2009 in #2017,
> #2010–#2013 in #2172). Their recommendations and constraints that
> still bind are in this entry, chiefly under
> [Maintenance and ongoing management](#maintenance-and-ongoing-management) and
> [Implementation boundaries and deferred capabilities](#implementation-boundaries-and-deferred-capabilities);
> the shipped command and HTTP shapes are in the integration contract
> (`docs/integration-contract/cli.md`, `docs/integration-contract/http.md`).
> Read the discoveries unchanged at the pinned links above. The accounting
> experiment moved to the
> [measurement archive](../measurement-archive.md#storage-design-experiments-2511);
> the lifecycle experiment is still `experiments/storage-lifecycle.ts`.

### Placement and alternatives

Storage is the eighth Settings pane, in **This brain**, immediately after
Modules. It uses the existing desktop section column and, below 900px, the
same horizontal tab strip. The [navigation amendment](navigation.md#2026-10-16--approved-storage-placement-1782)
preserves the default Models pane, lazy activation, focus, scrolling, Modules
leave guard, credential protection and D52 N3. Palette **Jump to > Storage**
and contextual **Open Storage** links target this pane. There is no new rail,
phone-bar or shortcut slot. Contextual capacity links become available with
the later low-space feature, not an invented initial alert.

| Alternative | Why it was not selected |
| --- | --- |
| A Storage view within Files | Files represents canonical content; app state, transcripts and recovery stores would be omitted or misrepresented. |
| A main-navigation destination | An occasional management task does not justify amending D52's destination inventory. |
| A separate More/palette panel | No persistent Settings home and another panel type. |
| Ship an inspection-only pane first | S4=B requires the complete review/removal/result journey at first public delivery. |

The selected placement adds a tab and a compact-strip scroll step. It amends
#1773's seven-pane inventory; it does not amend D52's main destinations.

### Numbers, ownership and capacity

All Storage sizes use decimal **kB / MB / GB**, normally three significant
figures; file details also expose exact bytes. One MB is 1,000,000 bytes.
The proposed MiB selector is superseded by S3. Rounding never decides a filter
or eligibility. Existing owners' byte policies stay unchanged: scratch's
1,073,741,824-byte cap can be displayed as **1.07 GB** with exact-byte detail.

| Display | Meaning and denominator |
| --- | --- |
| **On disk**, the default map/largest-list basis | Filesystem-reported allocated bytes, `512 × st_blocks` on qualified Linux filesystems. Deduplicate physical objects within the inventory union. This estimates attribution, not exclusive extents or reclaimable bytes. |
| **File size**, the alternative map basis | Logical regular-file bytes in that same object union. Directory/link metadata is labelled separately; it is not file content. |
| PDF filter and selection totals | Logical bytes **per regular-file entry**, even when entries share a hard-linked object. Also disclose known shared objects/aliases; do not present the entry sum as deduplicated allocation. |
| Tile area / row percentage | Known bytes in the active basis divided by the measured parent union in the selected ownership scope. Never divide by whole-volume capacity. An alias is a named row referring to an already-counted object, not another area. |
| **All / Brain / App** | Views over one inventory. All is the deduplicated union, not Brain plus App. Staging is App-owned even when physically under the brain root. Configured operator backups have their own ownership label. |
| **Disk · data volume** | One capacity row per resolved physical/quota identity, with provenance. Bind aliases add no second bar. Unknown identity equivalence never licenses adding capacities. |
| Capacity segments | Measured allocation, other used space, unavailable/reserved free space and available-to-caller. `used + free = total`; available can be less than free. Other is `used − measured` only with compatible, disjoint attribution and valid observations. |
| Unknown allocation/capacity | Text, not zero and not a logical-size substitute. If allocation cannot be reconciled with volume usage (including shared extents), omit the attributed segments and show known capacity separately. Negative or inconsistent differences never become a bar. |
| Remote copy / host backups / container stores | **Not measured** unless explicitly observable through the permitted scope. Local Git bytes cannot stand in for remote usage or quotas. |

Give each capacity its own row: Data, Private/app, then Temporary where those
are distinct. Tmpfs says **memory-backed, not disk**; it is not extra persistent
capacity. A shared disk's caption names its write targets, for example
“Brain, app data and backups share this disk.” Store totals and capacity bars
are separate facts, and observed filesystem availability is not quota headroom.

Every result carries measurement time, interval and complete/partial coverage.
After 60 seconds the display says **Out of date**. Partial logical totals and
counts say **at least**; an allocation estimate also retains its estimate label.
The display's freshness window does not authorize background polling. Unknown
subtrees are outside proportional geometry, with their reason printed below it.

### Exploration and selection

The map shows one level of children; breadcrumbs identify the current node.
Enter or activation drills into a directory. Show labels only in tiles at
least 62 × 40 CSS pixels, and make a tile an activation target only at
44 × 44 or larger. Smaller items remain reachable through the equivalent list.
Desktop children below 1% of the parent aggregate into a dashed **N smaller**
tile. Phone shows at most six individual tiles plus N smaller. That tile opens
the sorted smaller-item list, preserving every entry and its measured subtotal.

Brain tiles use a solid outline; App uses hatching and an owner label; backups
use a neutral dashed outline. The legend spells out ownership. Existing dark
and paper tokens apply, and neither ownership nor state depends on color.

> **2026-11-25 — Superseded by D8 ([the composed pane](#2026-11-25--the-composed-pane-volumes-history-breakdown-and-tools-4537-4549)).** Ownership
> is tint, edge and label; App is a dotted edge, never hatching.

The list has the same hierarchy and denominator as the map, with name, owner,
size, percent and a bar. Sort by size or name; search within the current node.
Lists over 200 children page in 200s. Refresh reports changes without reordering
the focused row under the user. A revision change cannot silently transfer a
selection to another file. Keep the previous scan during collection and mark it
as previous. The list alone supports every navigation, inspection and action.

**Find large files** opens Type, Larger than and Where filters. Initial values
are **PDF (filename extension), > 5 MB, Brain files**. Extension matching is
case-insensitive; there is no MIME claim and no attachment read to compute
size. Exactly 5,000,000 bytes does not match. Ignored and untracked files can
appear without changing indexing policy; symlinks are link rows, not PDF targets.
Filter count and total describe measured entries, with partialness retained.

Rows expose folder, Git facet, link evidence and an eligibility word. A pin,
live owner or protected target disables selection with a reason at rest.
Unknown references say **unknown**, not “no links.” **No Undo** means recovery
coverage is unavailable, not simply “untracked”: Git tracking and journal
coverage are independent. The initial operation must refuse any selected version
it cannot retain under the existing journal policy, including excluded ignored
files. It does not widen coverage to make a checkbox available.

### Desktop and 320px layouts

These are annotated wireframes using synthetic Odysseus content dated
2026-07-12. They specify content order and behavior, not exact text raster or
pixel baselines. Desktop retains the Settings section column; Storage is a
[wide Settings pane](navigation.md#2026-11-25--wide-settings-panes-4538) of up
to 1200px, with prose at the 68ch measure. 320px uses 12px side gutters and a
296px map. Panels and labels wrap at
200% zoom. Review is a dialog on desktop and a pushed view on phone.

**Overview, desktop (1280px):** capacity remains above ownership and metric.
This worked ordinary-allocation fixture has 64.0 GB total, 40.0 GB used,
24.0 GB free and 20.0 GB available. Its 12.0 GB measured union leaves 28.0 GB
other used and 4.00 GB reserved; the four segments sum to 64.0 GB.

```text
Settings             Storage                         [Find large files]
This device          Measured 09:41 · complete                 [Refresh]
 Appearance & input  Disk · data volume                20.0 GB available
This brain           [ measured 12 | other 28 | reserved 4 | available 20 ]
 Models              Brain, app data and backups share this disk.
 Accounts            [All | Brain | App]                      [On disk v]
 Skills              All                         12.0 GB measured
 Modules             +--------------------+----------------+------------+
 Storage <           | Brain files 6.00   | Git 3.00       | App 2.00   |
Access               | solid outline      | solid outline  | hatched    |
 Security            +--------------------+----------------+------------+
 Devices & agents    | Backups 1.00 GB · dashed                          |
                     +--------------------------------------------------+
                     CONTENTS        owner       on disk    % measured
                     Brain files     Brain       6.00 GB    50.0%    >
                     Git             Brain       3.00 GB    25.0%    >
                     App stores      App         2.00 GB    16.7%    >
                     Backups         Operator    1.00 GB     8.33%   >
                     Remote copy · not measured
                     MAINTENANCE · owner, effect, last receipt
```

**Drill-down, desktop:** the same column after All > Brain files > attachments.
Folder size remains the measured denominator; going up restores the originating
tile/row. Dense folders keep paging and N smaller separate from unknown entries.

```text
All > Brain files > attachments                         [On disk v]
5.00 GB measured · 2,103 entries · complete
+--------------------------------+-------------------+------------+
| papers 3.00 GB                 | photos 1.50 GB    | 132 smaller|
| 60.0% of attachments           | 30.0%             | 0.500 GB   |
+--------------------------------+-------------------+------------+
CONTENTS         owner       entries       on disk     % of parent
papers           Brain          412        3.00 GB     60.0%       >
photos           Brain         1559        1.50 GB     30.0%       >
[Search this folder]       [Name | Size]          [Next 200 items]
```

**Filtered list, file sheet, review and result, desktop:** each is reachable
without the map. A sheet returns to its row; review keeps exact selected versions.

```text
Find large files      [PDF: filename] [> 5 MB] [Brain files]
3 PDFs · 102 MB file size · exact total 101,500,000 bytes
[x] Ithaca-harbor.pdf       48.2 MB   tracked     2 links       [Inspect]
[x] Troy-charts.PDF         48.2 MB   untracked  links unknown [Inspect]
[ ] Sirens-score.pdf        5.10 MB  ignored    no Undo       [Inspect]
2 selected · 96.4 MB · file size, not space freed              [Review]

FILE SHEET: Ithaca-harbor.pdf                           [Close]
48.2 MB · 48,200,000 bytes · On disk: measured value or unknown
Tracked · removing keeps Git history
Linked from: voyage note, harbor plan · index measured 09:41
Conversations and other workspaces not checked
Undo: retained before-version required, subject to journal retention
[Preview]                         [Open in Files]       [Select]

REVIEW: Remove 2 files? (heading receives focus)
Ithaca-harbor.pdf · 2 links will remain broken
Troy-charts.PDF   · references unknown; show unchecked scope
Current files: -96.4 MB file size. Journal keeps Undo bytes.
Disk use may not drop yet. Git history stays. Links are not rewritten.
[Keep files]                                      [Remove 2 files]

RESULT: 1 removed · 1 changed since review
Ithaca-harbor.pdf · removed · [Undo removal]
Troy-charts.PDF   · changed · [Review file]
Measured after: working files -48.2 MB logical; journal +48.2 MB logical
Git: deletion not committed · history retained · remote not measured
Data volume: available before -> after (fresh observations, not a promise)
Index refresh: queued                     [Return to filtered list]
```

**Phone overview and drill-down (320px):** the compact tab strip remains outside
the pane's vertical scroll. Rows, chips and buttons have 44px effective targets.
The schematic tiles below still use proportional geometry in implementation.

```text
< Modules [Storage] Security >
Storage
[Find large files]
Measured 09:41 · complete
[Refresh]
Disk · data volume
20.0 GB available
[measured|other|reserved|available]
Brain, app and backups share
this disk.
[All | Brain | App]
[On disk v] 12.0 GB measured
+--------------+-----------+
| Brain files  | Git       |
| 6.00 GB      | 3.00 GB   |
|              +-----------+
|              | App 2.00  |
+--------------+-----------+
| Backups 1.00 GB · dashed |
+--------------------------+
Contents (same as map)
Brain files · Brain        >
6.00 GB · 50.0% measured
Git · Brain                >
3.00 GB · 25.0% measured
App stores · App           >
2.00 GB · 16.7% measured
Backups · Operator         >
1.00 GB · 8.33% measured
Remote copy · not measured
Maintenance
[Pack Git objects]
Needs headroom · last receipt

All > Brain files >
attachments
5.00 GB measured · On disk
+----------------+---------+
| papers 3.00 GB | photos  |
|                | 1.50 GB |
+----------------+---------+
| 132 smaller · 0.500 GB   |
+--------------------------+
[Search this folder]
papers · Brain             >
3.00 GB · 60.0% of parent
[Next 200 items]
```

**Phone filter, sheet, selected review and result (320px):** long paths wrap;
the sticky selection bar reserves space so it never covers the last row.

```text
Find large files
[PDF: filename extension]
[Larger than 5 MB]
[Where: Brain files]
3 PDFs · 102 MB file size
[x] Ithaca-harbor.pdf
    48.2 MB · 2 links
    tracked · [Inspect]
[x] Troy-charts.PDF
    48.2 MB · links unknown
    untracked · [Inspect]
[ ] Sirens-score.pdf
    5.10 MB · no Undo
    ignored · [Inspect]
----------------------------
2 selected · 96.4 MB
File size, not space freed
[Review]

< Back to results
Ithaca-harbor.pdf
48.2 MB · 48,200,000 bytes
On disk: measured / unknown
Tracked · history stays
Linked from (index 09:41):
voyage note, harbor plan
Conversations not checked
[Preview] [Open in Files]
[Select]

< Keep files
Remove 2 files?
Ithaca-harbor.pdf
2 links will remain broken
Troy-charts.PDF
References unknown
Current files: -96.4 MB
Undo kept in journal.
Disk use may not drop yet.
Git history stays.
Links are not rewritten.
[Remove 2 files]

Removal finished
1 removed · 1 changed
Ithaca-harbor.pdf · removed
[Undo removal]
Troy-charts.PDF · changed
[Review file]
Measured after
Files -48.2 MB logical
Journal +48.2 MB logical
Git deletion not committed
History retained
Remote not measured
Data: before -> after
Index refresh queued
[Return to filtered list]
```

Nearly empty brains keep the same structure: one or two measured tiles, empty
categories marked **none**, an ordinary capacity row and **No PDFs larger than
5 MB**. No chart area is manufactured for zero or unknown bytes. Separate-volume
fixtures replace the one capacity row with independently named rows, including
the explicit memory-backed tmpfs row.

### Review, execution and recovery

The file sheet exposes logical and allocated size, Git state, reference evidence
with its timestamp/unchecked scope, and actual Undo eligibility. Preview and
Open in Files reuse the existing readers. Do not invent a per-file commit count:
exact historical attribution is deferred. The selection bar always says
**file size, not space freed**.

Review refreshes each selected version and its consequences. Protected/live
items and versions without retained recovery coverage are removed from the
executable selection with visible reasons; the removal button counts only the
remaining exact set. Changed content or consequences require refreshed review.
Known references can be removed only with the broken-link consequence shown;
unknown dependencies remain disclosed and can make a file ineligible. There is
no implicit reference rewrite or sidecar cascade.

Execution binds the authenticated principal, operation identity and selected
versions. Recheck authority/revocation, root/parent/file identity, protected and
live ownership, and recovery eligibility. Establish verified retained before
bytes and durable intent before unlinking. Coordinate actual writers across
processes; shared gate admission alone is not an exclusive removal lock.
If space or retention admission fails, leave the file intact. No extra approval
is required solely for an explicitly requested, fully journaled reversible edit;
an unretained delete cannot use that rule. G5 outward-sync authority is unchanged.

The result reads a durable receipt, including after a lost response or restart.
Distinguish **removed / changed since review / protected / failed / not started**
and an unresolved outcome that still needs reconciliation. Keep successes in a
mixed batch. Cancellation stops new items and completes critical reconciliation
for the current item; never silently retry a changed file or widen the set.
Undo is a new version-checked operation that cannot overwrite a replacement,
and only appears while the retained before-version remains available.

After-measurement reports working-tree, journal and local-Git observations plus
per-volume availability, each with basis, time and coverage. A volume delta can
include concurrent writes and is not attributed savings. Index refresh, local
deletion, commit and remote sync are separate outcomes. Retained Git history,
other hard links, journal copies and backups may keep all the original bytes;
the disk can initially grow. Refresh failure cannot turn a successful removal
into a zero-byte reclamation claim.

The first public pane requires this complete flow and its crash, stale-Undo,
mixed-failure and real constrained-space proof. Internal read-only components
may be developed earlier. **Remove · unavailable** remains an explicit state
for an unsupported host after the operation exists; it is not an interim
shipping plan. It prints “This host can't remove attachments yet” and keeps
Preview, Open in Files and copying the list available.

### Maintenance and ongoing management

Show only owner-supported operations, each with owner, effect, last run and
durable receipt: **Pack Git objects** (can grow before it shrinks; needs
headroom), **Prune eligible scratch** (pinned answers kept; existing seven-day
and 1,073,741,824-byte policy), and **Settled share staging cleanup** (live work
and settlement protected). Reuse their existing admission and locks; revalidate
at execution. Claude archival is automatic upkeep; unavailable Pi archival
points to its existing #1637 work. Do not invoke archival as emergency rescue.

There is no generic Reclaim button, scratch clean, journal clear, backup purge,
session deletion or workspace sweep. No history rewrite, ref/reflog expiry,
force push or host/container prune is added. Capacity provisioning is a valid
answer when protected stores consume the space.

Initial ongoing management is explicit Refresh, measurement age and refresh
after completed owner operations. Later aggregate growth history, low-space
signals and alert cadence/thresholds require their own design. Proposed bounded
history is server-owned, not a new use of core's corpus-history contract or
disposable `brain.db`. Do not invent polling or retention knobs in this pane.

### States, accessibility and proof

| State | Visible text and behavior |
| --- | --- |
| Never measured | **Not measured yet** and Measure; no numeric chart. |
| Scanning | **Measuring… 18,400 items · 12 s**, Cancel; previous result stays labelled previous. |
| Cancelled / budget hit | **Partial · Stopped after 100,000 items**, known subtotal/count marked at least; the limit text comes from the collector's actual receipt. |
| Permission denied / changing | Partial with the unreadable path or changed-item count; unknown geometry omitted. |
| Older than 60 seconds | **Out of date · Measured…**; Review rechecks selected files, not a whole-tree snapshot promise. |
| Low space | Name the affected capacity and its write targets; eligible owner operations only, with headroom warnings. Automatic signals await later design. |
| Unsupported capacity | **Capacity unknown on this filesystem**; preserve known store bytes without a capacity bar. |
| Unobserved remote/host store | **Not measured**, never zero. |
| Empty filter | **No PDFs larger than 5 MB**, scope and freshness; partial adds “none found in what was measured.” |
| Unsupported removal | Explicit unavailable reason; inspection remains available, under the shipping boundary above. |

Pane order is heading/state, capacity, scope, metric, breadcrumb, map, list,
maintenance; Find large files belongs to the heading. The map is a named
`role="group"` (**Storage map, scope, node**) with one tab stop. Arrow keys
move through tile centers in reading order, Enter drills down, and Backspace
or Alt+Up goes up when the map holds focus, never while editing a filter.
Each tile names **name, owner, size, percent of parent**; the aggregate names
**N smaller items, size. Open list.** Its description points to the equivalent
list, which can be used without geometry.

> **2026-11-25 — Pane order superseded ([the composed pane](#2026-11-25--the-composed-pane-volumes-history-breakdown-and-tools-4537-4549)).** Header,
> banner, volumes, history, breakdown (with Find large files as its mode), Free
> up space, About these numbers. The map, list and keyboard rules below hold.

The sortable table uses `aria-sort`; selection checkboxes name file, size and
status. Space toggles; Enter opens the file sheet. Disabled reasons are
descriptions visible at rest. Drilling down focuses the current breadcrumb;
going up returns to the originating tile/row. Sheets/review focus their heading;
Escape/back restores the trigger, or the nearest surviving row/heading if it
disappeared. Results focus their summary and politely announce the outcome.
Selection count/size announcements are debounced. No new shortcut hints print;
existing [D36](components-and-interactions.md#2026-09-18--d36-single-key-shortcuts-are-focus-scoped-a-resolved-decision-hands-focus-to-the-next-card-or-the-empty-heading)
and pointer policy still apply. All effective row/chip/button targets are at
least 44px, with no overlapping target areas.

The implementation matrix below is a required proof specification, not a
receipt that these browser/runtime checks have already passed.

| Scenario | 320 dark | 320 paper | 1280 dark | 1280 paper |
| --- | --- | --- | --- | --- |
| Dense shared-volume overview | yes | yes | yes | yes |
| Separate volumes and tmpfs | yes | | yes | |
| Nearly empty brain | | yes | | yes |
| Three-level drill-down and N smaller | yes | | yes | |
| PDF filter, exact boundary and uppercase extension | yes | yes | yes | yes |
| Partial scan and EACCES | yes | | yes | |
| Referenced / unknown / protected file sheet | yes | yes | yes | |
| Review heading focus and Escape return | yes | | yes | yes |
| Mixed removal and changed-since-review result | yes | yes | yes | yes |
| Unsupported-host removal | yes | | yes | |
| Stale, scanning/cancel and low-space states | yes | yes | yes | |

Each scenario also requires list-only keyboard completion, 200% zoom at 320px,
accessible-name/screen-reader review and a greyscale capture. Use real browser
layout/accessibility checks and restore complete browser-global descriptors in
fixtures. Accounting/cleanup tests require failing-first/restored mutations,
and real crash/restart and constrained-volume tests where runtime is the claim.

The synthetic walkthrough includes 4,900,000, 5,000,000, 5,100,000 and 48,200,000
byte PDFs; `.PDF`, ignored and untracked entries; a hard-linked alias; nested
folders; an old Git blob after deletion; shared/separate capacities; unknown
remote data; a retained-answer pin; an unreadable subtree; and a budget stop.
The filter excludes the first two sizes. Adding a second 48,200,000-byte name
for the same object produces three matching entries / 101,500,000 logical
bytes but only two matching objects / 53,300,000 logical bytes. The mock list
uses those values. The alias cannot qualify for the initial single-link removal
operation; the review/result mock instead uses two independent 48.2 MB files
and the same count/total. These are separate fixtures, not a promise that alias
removal is supported. Stale review changes one selected version, leaving one
success and one conflict. Every step is available from a row and a button.

### Implementation boundaries and deferred capabilities

Tracked implementation belongs under [#1779](https://github.com/schlessera/brain-kit/issues/1779);
the issue tracker owns sequencing and completion. Core owns deterministic
content/Git inventory via the supported CLI and metadata-only public reader.
The host reader never runs Git or repository configuration. ui-server resolves
its configured owners, merges capacities, authenticates transport and owns
receipts. Backends keep transcript layout/lifetime ownership. ui-react composes
the Settings pane; ui-kit supplies presentational map/list pieces if required.
No cross-package internal import, new provider seam or core dependency on the
operational database follows from the design.

Required read data includes paged children, both metrics, object/entry/capacity
identities, evidence and coverage, capacity provenance, filters and reference
freshness. Required action data includes exact reviewed versions/consequences,
eligibility, operation/idempotency identity, per-item durable outcomes,
retained recovery availability and after-observations. Final command names,
HTTP/SDK schemas, resource bounds and compatibility changes belong to the
implementation issues, with same-commit contract documentation and changesets.
Do not broaden ordinary content-read authority into deployment inventory.

Build inventory first, then owner maintenance and journaled binary removal;
the pane's internal read components can proceed against fixtures. Public pane
registration and the full journey wait for those operations and their proof.
Future growth history/low-space implementation waits for cadence/threshold
design. No generated-host change is established by this work; file a public
hosting-template counterpart only for a concrete requirement.

Deferred: remote/provider usage; host/container inventory; exact per-file Git
history attribution; derivative grouping until provenance exists; workspace
cleanup; new journal/backup/session expiry; and retention defaults. These need
separate scope and, where they remove recovery or broaden access, separate
maintainer decisions. The approved S1-S4 choices and complete UI design do not
need another approval round.

## 2026-11-25 — The composed pane: volumes, history, breakdown and tools (#4537, #4549)

The maintainer's [epic rulings](https://github.com/schlessera/brain-kit/issues/4537)
(D1–D16, 2026-11-24) and the [composition brief and its decision](https://github.com/schlessera/brain-kit/issues/4549)
(2026-11-25) replace the prose pane above. The 2026-10-16 entry still binds
for numbers, ownership semantics, eligibility, review, removal, recovery and
maintenance ownership; where the two differ, this entry controls. The
components are the kit's (#4542–#4545); the derivations are ui-react's
(#4546); the pane composes them in `StorageSession`
(`packages/ui-react/src/components/settings/storage-tab.tsx:63-377`).

| Ruling | What the pane does | Supersedes |
| --- | --- | --- |
| D2 | The map and the ranked list sit side by side from 840px of section and stack below it; below 560px the map is a 120px strip. The owner switch (All · Brain · App · Operator), the size basis and search sit above them. | "list only" and map-above-list ordering |
| D3 | **Available space over time** is a main section after the volumes, following the selected volume, with Recent, Daily and Weekly. The exact endpoints sit behind **Measurements behind this chart**. | The always-visible observations section |
| D4 | One attention banner, only when a volume is Low or Very low: one sentence and one link, **Free up space ↓**. | Cleanup prose above the fold |
| D5 | The wording is **available**, never "free": "16.4 GB available of 161 GB". | — |
| D6 | Storage is a wide Settings pane (#4538); the pane has no width cap of its own. Prose keeps the 68ch measure. | The 720px column |
| D7 | Volumes are named from their contents on the client (Brain disk, App data disk, Backups for a volume holding only Operator backups, Memory (tmpfs), Unidentified volume), never after the loudest store. A sole volume is Disk. | "Disk · data volume" for every card |
| D8 | Ownership is tint, edge and label: Brain solid, App dotted, Operator dashed, the smaller aggregate a neutral outline, an owner letter on tiles large enough to carry it. No hatching. | "App uses hatching" (Exploration and selection) |
| D9 | One dashed line per qualified window, labelled with its window. The volume card's Runway names the window it comes from the same way (`~40 days · 30-day rate`); see [storage guidance](../storage-guidance.md#2026-11-25--scenario-drawing-and-shared-constants-4537-4539-4549). | — |
| D10 | The UI derives names, threshold bytes, series, markers, unmeasured rows and before → after deltas. The chart ships with derived markers, before the events timeline (#4541, #4548). | — |
| D11 | **Find large files** is a mode of the breakdown and the pane's single primary button. | Find large files in the pane heading |
| D12 | The chart is hand-rolled SVG in ui-kit with pure, unit-tested geometry. | — |

### Section order and layout

At every width: header (title, **Measure again**, one mono status line, the
Alerts row), banner, volume cards, available space over time, what's using
space, Free up space, then **About these numbers** (collapsed). The cards are
one radiogroup (`auto-fit, minmax(260px, 1fr)`); the selected card drives the
chart, and with more than one volume the section says they are never added
together. Tool rows reflow inside `ToolList`. No element sums capacities,
draws a gap as zero or prints an unknown as `0`.

**Free up space** lists a tool when its operation's scope categories overlap
the stores on the selected volume or on any Low or Very low volume. A tool
with a run in progress stays listed. Without inventory, or for a volume whose
stores are unknown, every tool stays listed: an unknown never hides a tool.
When none applies, one line says so: "No owner-supported tool frees space on
{volume}."

An active refusal (the owner refused a write: no space, quota or inodes) is
stated in words on a line under the volume cards, naming its volume, its
severity, the cause, when it happened and that no matching write has
succeeded since. It does not depend on the chart: empty history or a refusal
older than every tier still shows it.

The list stays equivalent to the map for folded databases: each `-wal`,
`-shm` or `-journal` member follows its database as its own row, marked
"part of {database}", with its own drill or inspect action. The database row
keeps the combined size; the legend counts each row once.

The status line's glyph carries its state: `●` complete, `◑` partial (`≥`
entries, stores not measured), `◷` out of date (from `staleAfter`), `◐`
measuring (with Cancel in place of Measure again), `○` not measured yet (with
the primary **Measure**), `!` last measurement failed. A new measurement waits
behind **New measurement ready · Show**, as before
(`storageStatusLine`, `packages/ui-react/src/components/settings/storage/storage-pane-model.ts:45-99`).

The Alerts row follows the server, not the brief's first draft: notices go
out only at Very low; the 22:00–08:00 quiet hours hold Very low too; an
unknown timezone sends nothing (`packages/ui-server/src/storage/notify-writes.ts:62-69`).
The bounds are read from the guidance response's `quietHours`. **Change**
reveals this device's push switch, the reported devices and, behind a
disclosure, the delivery receipts
(`storageAlertsLine`, `packages/ui-react/src/components/settings/storage/storage-pane-model.ts:121-137`).

### Find large files mode

**Find large files** in the section heading switches the section: Type,
Larger than (presets 5, 10, 100, 500 MB and 1 GB, plus Custom…), Where and
search replace the owner switch, basis, legend, map and list. The heading
becomes **Find large files** with **Back to overview**. The basis is file
size, because removal is per file; the basis select is hidden, not disabled.
D11's bound filters (PDF · > 5 MB · Brain files) are the defaults. Rows are
the kit's filter rows; an unverified row's checkbox opens its inspection,
whose sheet carries **Select file**, so every step is reachable from a row
and from a button. The selection bar is `{n} selected · {size} file size ·
not space freed`, Clear and **Review removal**; with no selection its slot
shows the last removal and its receipt. On a host that cannot remove, one
line says so and the rows have no checkboxes.

| Action | Focus | Announced (polite) |
| --- | --- | --- |
| Find large files | the mode's heading | "Find large files. {n} matching PDFs." |
| Back to overview | the Find large files button; owner and breadcrumb restored, search cleared | "Overview. {folder}." |
| Back with a selection | first "Discard {n} selected files?" with Keep selection (focused) and Discard | — |
| Changing a filter | stays on the control | "{n} matching PDFs" |

### Where every caveat went

The pane no longer prints caveats inline. Each line the old pane printed is
kept (reworded where noted), moved to a legend, tooltip or disclosure, or
dropped with a reason; the full table is the brief's item 3 on #4549. The
moved paragraphs live in **About these numbers**, in order: units, On disk vs
file size (and capacity provenance), partial coverage with each root's error
and the omitted count, the Find large files matching rules with the exact
entry sum and object union, maintenance scope (including scratch's seven-day
/ 1,073,741,824-byte policy), and the history's own rules. Two lines are
dropped: **Use list only**, because the list is always present and
equivalent, and the per-unknown-store sentences, which the `?` rows replace.
The sort buttons became the sortable column header with `aria-sort`.

### Proof

The proof matrix above holds, as real-browser baselines in the pinned
container (`packages/ui-react/tests/browser/storage-pane.layout.tsx`), with
these chart states added in `storage-guidance.layout.tsx`: full, gap, no
projection, one window, two windows and scope change, at 320 and 1280 in
dark and paper. Each matrix scenario also runs a list-only keyboard pass
(every row reached by Tab, no map), 200% zoom at 320, a greyscale capture and
a control-name review. The default state has exactly one primary-tone
button.

### Rejected alternatives

| Alternative | Why it was not selected |
| --- | --- |
| Map above a full-width list (3250-D1) | At wide widths the list fell below the fold; side by side shows both, and stacking keeps the narrow layout (D2). |
| A **Use list only** switch | The list is always present and equivalent; at 320 the map is a 120px strip, so there is nothing to opt out of. |
| History behind a closed section (3250-D6) | "Is it getting worse" is the second question the pane answers; only the exact endpoints are evidence on demand (D3). |
| A banner in every state, or one per volume | Noise when all is well; one sentence and one link suffice (D4). |
| Naming a volume after its largest store | Repeats the bug #3250 reported; contents name it (D7). |
| Full-tile hatching for App | Made the map unreadable when App dominated; tint, edge and label survive greyscale (D8). |
| A filter chip on the list instead of a mode | The removal journey needs its own controls, selection and receipt slot; a mode keeps the overview uncluttered (D11). |
| A chart library | A dependency for one chart, with gap and scope semantics it does not model; the geometry is unit-tested instead (D12). |
| Keeping the selection silently on Back | A hidden selection could be reviewed later without the user seeing it; Back asks first. |
| A separate Storage destination for width | Settings panes go wide instead (D6, #4538). |
