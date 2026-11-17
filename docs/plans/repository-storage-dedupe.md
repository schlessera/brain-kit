# Evaluation — bounded deduplication for managed Git storage

Investigation for [#3514](https://github.com/schlessera/brain-kit/issues/3514).
It compares scheduled `duperemove`, `bees`, and no background dedupe plus
preventive sharing, for the reference pool and the native brain store. The
maintainer ruling it prepares is on
[#3515](https://github.com/schlessera/brain-kit/issues/3515). Nothing here is
built or enabled.

**Recommendation:** reject background deduplication on both volumes. Keep
preventive sharing (snapshots and reflinks, already measured by
[#3513](https://github.com/schlessera/brain-kit/issues/3513)) and add a
residual-growth alert on the pool's own accounting basis. Dedupe would save
real bytes only where it breaks a binding accounting or journal rule.

## What was measured

Both workloads are generated Odysseus Git repositories: 2,000 short files, an
80,000-line compressible voyage log and incompressible charts, packed once.
Content safety held in every run: the SHA-256 of every regular file and
`git fsck --full` were identical before and after each dedupe.

**Tool costs, on a real Btrfs filesystem** (`scripts/dedupe-bench.py`). This
run was unprivileged: Linux 7.0.0-42-generic, btrfs-progs 6.17.1,
duperemove 0.15.2, Git 2.53.0, mounted `compress=zstd:1`. Each scenario is its
own subvolume. Unique allocation is exclusive plus set-shared extents from
`btrfs filesystem du` over the bench directory; hash databases sit outside it.

| Scenario | Unique before → after | First scan | CPU | Peak RSS | Hashfile | Unchanged rerun |
| --- | --- | --- | --- | --- | --- | --- |
| Two independent clones (two domains) | 216.6 → 144.6 MB | 402 ms | 665 ms | 87 MB | 1.6 MB | 51 ms, 0 saved |
| Two snapshot worktrees of one source | 144.6 → 144.6 MB | 453 ms | 819 ms | 87 MB | 2.3 MB | 51 ms |
| Repack and linked Git worktree in one worktree | 216.7 → 144.8 MB | 502 ms | 901 ms | 120 MB | 2.4 MB | 51 ms |
| zstd-compressed independent copies | saved 40.6 MB | 251 ms | 423 ms | 120 MB | 1.6 MB | 51 ms |
| Sealed copy beside a writable copy | saved 33.5 MB | 50 ms | 124 ms | 120 MB | 0.07 MB | 51 ms |

After editing 50 small files, a rerun saved nothing. Short files are inline
metadata, which dedupe never touches. Metadata growth cannot be isolated on a
shared host filesystem; the pool cells below measure it.

**Pool behaviour, on the owned reference pool** (`scripts/native-proof/dedupe-experiment.ts`).
The real manager ran inside the pinned native fixture: kernel
7.0.0-1017-azure, btrfs-progs 6.6.3, hosted heavy-feedback run 42504379233.
Dedupe ran through `FIDEDUPERANGE` directly, with the destination opened
read-only as dedupers do.

| Cell | Physical (`chargedBytes`) | Owner charge | Observation |
| --- | --- | --- | --- |
| Identical 8 MiB in two roots A and B, dedupe B onto A, seal, release A | 17.3 → 8.9 MiB | A 8.0 MiB, B 16 KiB | A stays `deleted` with 8 MiB charged and is never reclaimed while B lives; both reclaim only after B. |
| Same, both sealed before dedupe | 17.3 → 8.9 MiB | both still 8.0 MiB | Dedupe into a read-only root succeeds. `O_RDWR` fails with `EROFS`, `O_RDONLY` does not. No refusal, so the sealed records are now stale. |
| Worktree copy deduped onto its source between two checkpoints | 17.40 → 17.43 MiB | — | Nothing freed, because the earlier checkpoint keeps the old extents. The checkpoint delta reports `charts/phaeacia.bin` and `charts/scheria.bin` as changed though no byte changed. |

Metadata went 256 → 224 KiB in the cross-root cell and rose 16 KiB in the
delta cell.

## Compatibility matrix

| Question | Reference pool | Native brain store |
| --- | --- | --- |
| Duplicates left after preventive sharing | Same repository in several domains (public and each private principal); repack or linked Git worktrees inside one worktree. Snapshot worktrees and refresh already share ([#3513](https://github.com/schlessera/brain-kit/issues/3513): worktrees add 1.6 %, changed refresh 0.39× cold). | Turn data trees copied across filesystems ([#2911](https://github.com/schlessera/brain-kit/issues/2911) owns their reflink placement). |
| Simple-quota attribution | Cross-root dedupe moves the destination's data onto the source owner. A released source then keeps the charge and is never observed reclaimed while the destination lives, which defeats per-root allowances and reclamation credit ([reference-pool-accounting](../decisions/reference-pool-accounting.md#mechanism-simple-quotas-for-attribution-and-enforcement)). | Separate filesystem without qgroups: no attribution, but see deltas. |
| Cross-domain or cross-principal sharing | Would share one principal's extents with another's root, widening a private sharing domain automatically. Not permitted without a new ruling. | — |
| Sealed and read-only roots | Read-only does not protect extent layout: dedupe into a sealed root succeeds and leaves its recorded owner charge stale. | Checkpoints are read-only snapshots; the same applies. |
| Checkpoint deltas and journal | Dedupe between checkpoints reports false content edits and frees nothing while the older checkpoint lives. | The journal is built on incremental-send deltas ([native-brain-storage](../decisions/native-brain-storage.md)); upstream, a send cannot start while a dedupe runs ([Deduplication](https://btrfs.readthedocs.io/en/latest/Deduplication.html)). |
| COW / checksums | Both files must share COW and checksum status (upstream). Pool roots are COW with checksums. | Same. |
| Tool availability in the pinned image | Ubuntu 24.04 packages duperemove 0.11.2, not 0.15.2, and no bees. | Same. |
| Concurrency hazards | `LOGICAL_INO` with concurrent dedupe or reflink can hang the kernel on every version so far ([bees kernel notes](https://github.com/Zygo/bees/blob/master/docs/btrfs-kernel.md)). The manager does not use `LOGICAL_INO`; a deduper would add it. | Same. |

## Options

1. **Bounded duperemove, nightly.** Recovers the multi-domain duplicates and
   repack loss measured above, at under a second of scan per 200 MB, with
   incremental reruns of about 50 ms. To be safe it needs a ruling that allows
   cross-root (and possibly cross-principal) sharing. It also needs an
   accounting change, so a released owner's retained charge is credited to the
   roots that now reference it. Every root holding checkpoints, every sealed
   root and the brain store must be excluded. That leaves only writable
   worktrees without retained checkpoints, which live at most their
   inactivity period (three days), so the eligible set is small and transient.
2. **bees.** A whole-filesystem daemon with the same attribution and delta
   effects, plus a persistent hash table. It is not packaged for the pinned
   image. Rejected on the same grounds; a nightly file-scoped tool being
   unsuitable is no reason to enable it.
3. **No background dedupe; preventive sharing plus a residual-growth alert
   (recommended).** Sharing is already preventive: worktrees and refreshes
   snapshot their source, and #2911 places data trees by reflink. The
   safeguard observes `chargedBytes` and per-root owner charge on the existing
   basis. It reports when unique allocation per retained source exceeds a
   measured threshold, and names the cause (duplicate domains, sharing lost to
   repack or linked worktrees). It never claims predicted savings as free
   capacity.

## Proposed safeguard (option 3)

- **Owner:** the existing native manager pool status and the `brain-native-store pool`
  CLI; no new seam or provider interface.
- **Observation:** each status read already yields `chargedBytes`, `ownerBytes`
  and per-root owner charges. The safeguard derives, per retained source
  lineage, the growth beyond its source's sealed charge. It counts duplicate
  sources of the same repository and revision across domains as separate
  lineages.
- **Thresholds, from #3513's hosted baseline:** a worktree adding over 25 % of
  its source charge (measured 1.6 %). A changed refresh over 0.75× a cold
  acquisition (measured 0.39×). More than two retained sources for one
  repository and revision across domains.
- **Status:** last observation time, result (`ok`, `growth`, `refused`,
  `skipped`) and the lineages that exceed a threshold, with measured bytes
  only. Exposing this through the CLI's `--json` is a contract addition
  ([integration contract](../integration-contract.md)), additive in a minor.
- **Out of scope:** any rewrite of extents, deletion, or reset of Git work.

## Changes to binding decisions

- Option 3 needs none. It adds a section to
  [reference-pool-accounting](../decisions/reference-pool-accounting.md)
  recording that background dedupe was measured and rejected, and why.
- Option 1 would change
  [reference-pool-accounting](../decisions/reference-pool-accounting.md) in
  three places: first-owner attribution with retained-owner credit; the
  sharing domain of private sources; and an exclusion rule for sealed roots and
  roots with checkpoints. It would also change the journal's delta trust in
  [native-brain-storage](../decisions/native-brain-storage.md).

## Not measured

App latency during a dedupe run; concurrent fetch, checkout or repack racing a
dedupe; and manager restart after one. Each is needed only if option 1 is
chosen, before any implementation.
