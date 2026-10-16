# Inspect and manage Storage

Open **Settings → Storage**, after Modules, or choose **Jump to → Storage**
in the command palette. Storage is available to the human owner. The pane
includes Brain files, observable app stores and configured backups; it does
not infer remote usage or unobserved host storage.

## Read the measurements

Choose **Measure** for the first observation and **Refresh** to request another.
Opening the pane does not start a scan. During collection the previous result
stays visible; **Show new measurement** adopts the new result and clears old
selections. Measurements older than a minute say **Out of date**. Partial results
show known subtotals and their missing evidence; unknown is never zero.

Each capacity has its own bar and write-target caption. Available filesystem
space is not a quota guarantee. Shared or aliased capacities are not added,
and memory-backed temporary storage is labelled separately from disk.

**On disk (estimate)** is the default. It uses reported allocated bytes and
counts a known hard-linked object once; it does not promise exclusive or
reclaimable space. **File size** uses logical file bytes. Sizes use decimal
units: 1 MB means 1,000,000 bytes. Inspect a file for exact bytes.

**All**, **Brain** and **App** are views over the inventory. They are not values
to add. Open map tiles or list rows to explore folders, then use breadcrumbs to
go back. The list supports name/size sorting, search and pages of 200 entries.
**Use list only** provides the same inspection and navigation without the map.
Small tiles remain accessible through the list; unknown sizes have no tile area.

## Find and review large files

**Find large files** starts with PDF filenames strictly larger than 5 MB in Brain
files. The extension comparison ignores case; it makes no claim about MIME type
or whether a document is safe. Exactly 5,000,000 bytes does not match. Entry totals
may count multiple names of a shared object; the separate object union does not.

1. **Inspect** a file to see its current Git state, reference evidence, eligibility
   and recovery coverage. Inspection does not reserve a removal receipt.
2. Select eligible files and choose **Review selected files**. Protected, shared,
   ignored or uncovered files remain unselectable. Unknown references do not mean
   there are no links.
3. Read the fresh review, including exact versions, broken links and unchecked
   consumers. **Keep files** dismisses it without removal. Changed or expired
   reviews require fresh inspection and review.
4. Confirm the eligible selection. Originals must be retained before removal.
   The result lists each file independently, including changed, protected,
   cancelled and unconfirmed outcomes. **Cancel remaining files** stops new
   admissions; an already acknowledged file can remain removed.

A request with an unconfirmed response keeps its original identity. Use
**Check original receipt**; do not submit another removal to guess the outcome.
A refreshed or reopened pane can recover the latest receipt for the same owner.

**Undo removal** is offered only for a confirmed removal whose original is still
retained. Undo has its own fresh review. It never replaces a file that has since
appeared at the target, and it is subject to existing journal retention. Keep
backups for recovery beyond that retention. Hosts without qualified recovery
still allow inspection, Preview, Open in Files and copying the visible file list.

## Maintenance and storage deltas

Maintenance uses existing owners: packing Git, pruning eligible scratch files,
and cleaning eligible upload staging. Each row explains its effect, headroom
and latest receipt. Packing preserves refs, history and reflogs; it can need
additional temporary space. Scratch keeps pinned answer files and the existing
seven-day / 1,073,741,824-byte policy. Staging cleanup respects active uploads.

The result separates working files, retained journal bytes, Git storage and
filesystem availability. Removing a file may increase journal use and leave Git
history or backups unchanged. Other writers can affect before/after values.
Index refresh, a deletion commit and remote sync are separate outcomes; removal
does not automatically commit or sync.

Scans and operations have finite bounds. A scan can stop with partial evidence.
Removal admits at most 32 paths, 64 MiB per file and 128 MiB per operation;
review lasts ten minutes. Durable receipt capacity can refuse new operations
while existing receipts remain readable. The pane never erases recovery data
or expands retention policy to make room. If protected stores dominate, capacity
provisioning or the store owner's existing controls may be needed.
