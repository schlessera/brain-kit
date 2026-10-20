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

The [accounting model](../../plans/storage-accounting.md) supplies ownership,
object identity, capacity scopes and coverage. The [lifecycle model](../../plans/storage-lifecycle.md)
supplies action eligibility and recovery. Read both with the later
[native storage decision](../native-brain-storage.md): immutable native
checkpoints, writable output staging, turn temp and retained recovery objects
have distinct owners and capacity. A lower-only deletion does not release
writable-upper headroom. Neither discovery authorizes a new retention policy.

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
pixel baselines. Desktop retains the Settings section column and a 720px content
column; 320px uses 12px side gutters and a 296px map. Panels and labels wrap at
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
