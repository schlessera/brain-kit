# Native journal capture investigation — 2026-10-16

This is the bounded keyless investigation for brain-kit #1752, not a product
performance patch. Production source is
`ff70ec1c2eda22e5e84593a5467fc85d0c385600`; the diagnostic overlay is archived
at `scripts/profiling/`. Markdown remains authoritative and no real instance,
provider credential, model request or external network is involved.

## Method and conditions

The predeclared plan was three samples of 300 distinct 1,024-byte files and
three matched-byte samples of three distinct 102,400-byte files: 307,200 bytes
per revision. Files contain only Odysseus fixtures at the pinned 2026-07-12
example date, including CRLFs. Each sample uses a new real SQLite UI database
and CAS. It records fresh admission/inventory, first changed capture, warm
unchanged capture and another changed capture. Cold means a fresh journal,
not a dropped kernel page cache.

A network-disabled owned container uses an identity-checked fully allocated
4 GiB loop1752 Btrfs filesystem and the actual production Unix native manager,
client, changed-only capture, journal objects and accounting. Journal SQLite
and objects are durable on the bind-backed ext2/ext3-family filesystem with
4,096-byte blocks; the brain is Btrfs with 4,096-byte blocks. This is not an
in-memory store or copied/synthetic manager. Bun is 1.4.2, Linux x64 with
32 visible CPUs; the kernel and immutable image ID are in the receipts. The
client/test runs as UID/GID 0, and AppArmor is unavailable. Other host work is
not controlled. These conditions do not represent typical-host latency.

Factory observers call every original method. Accounting reserve, finish and
external write timings are disjoint boundaries; object-retain timings INCLUDE
reserve/finish, so those columns must not be added together. Native delta timing
includes stream consumption. Source hashing, raw-object writes/fsync and
scheduling remain combined in the non-accounting object residual. Metadata
traversal/stat and classification are not separately isolated. No collection
pressure occurs; an absent removal call is not a measured collection latency.

The normal 15-second observer stays enabled. Consequently a warm unchanged
call can drain several observations queued during a long preceding capture;
the raw native call counts expose this. No interval, fsync, cap, active pin,
retained version or durability guard was disabled. A separate 100,000-call
counter diagnostic costs 4.94–6.22 ms versus a 0.07–0.89 ms bare loop. This
does not isolate factory-spy dispatch or storage perturbation, so total
profiling overhead remains unknown rather than being subtracted.

## Failures and sample accounting

The original 300-second pilot deadline expired after one completed small-file
sample and an incomplete second sample. Its failed test and complete owned
cleanup remain archived. The incomplete sample is not included in distributions.
Before measurement, separate bootstrap attempts also failed on an extra image
entrypoint argument, a missing writable workspace lease mount and missing
explicit native staging limits; none is a latency sample or a passing control.

A finite follow-on supplies two small and three large samples with a
900-second test deadline. Its timed production phases are unchanged. Outside
timing, verification directly reads immutable objects already protected by
active refs instead of creating/releasing a separate durable read lease per
verification. It also checks the exact expected before/after revision, rather
than merely membership in the authored revision set. The pilot and follow-on
remain separate raw receipts and their different verification methods are
explicit. Re-running creates new evidence; it does not replace these files.

The follow-on durable profiling test passes in 434.75 seconds. Its combined
command also includes an initial suspension-fixture failure before worker launch
(the required sessions foreign-key seed was omitted). That failure remains in
`complete-run.log`, separate from the passing profiling result; only the witness
is corrected and repeated. Its first independent retry then refused before launch
because the standalone fixture had not created the trusted runtime parent;
that failed attempt and cleanup also remain archived. The corrected independent
witness passes without repeating any profiling sample. Neither deadline nor bootstrap failures are called
green native proof.

## Measured results

Each cell is median [minimum, maximum] seconds, n=3. The small cohort combines
one completed pilot sample and the two declared follow-on samples; the failed
incomplete pilot sample is excluded and retained explicitly. See raw per-sample
counters in the two profile JSON files and `summary.jsonl`.

| Phase | 300 x 1,024-byte files | 3 x 102,400-byte files |
| --- | --- | --- |
| Fresh admission/inventory | 0.742 [0.413, 0.839] | 0.468 [0.460, 0.539] |
| First changed capture | 112.326 [55.803, 115.359] | 0.947 [0.941, 1.182] |
| Warm unchanged call | 2.238 [1.048, 2.847] | 0.302 [0.296, 0.338] |
| Warm changed capture | 94.072 [84.947, 94.675] | 1.049 [0.928, 1.124] |

Small changed captures perform 600 retained-version operations, versus six for
the matched-byte large control. The next changed capture also performs 600/six
operations: before versions already present in CAS still enter the original
reserve/digest/write/finish path. Native checkpoint/delta/release operations
remain hundreds of milliseconds, not the tens of seconds of this fixture's
small changed capture. The disjoint accounting boundaries account for
81.15–81.73% of small first-changed wall time and 78.81–79.25% of small warm-changed
wall time. The measured bottleneck is per-version durable accounting work in
this fixture. Its internal SQLite allocation scans, checkpoint/commit/fsync
subcosts are not individually separated, and no particular one is declared
proved dominant. The object residual combines hashing, object I/O/fsync and
scheduling; it is not an independent pure hash benchmark.

The small warm unchanged calls include four/eight/eight native checkpoints
because prior long captures queue the ordinary observer. The large calls each
perform one. These are end-to-end calls with the production scheduler, not a
single-checkpoint microbenchmark or a direct comparison to an old 20 ms warm
walk. Baseline CAS count is zero in all six samples. Retained logical object
bytes after two changes are the same 921,600 bytes for both workloads; the
small cohort has 900 distinct objects and the large cohort nine. Raw bytes,
hashes and active refs are verified before finish; the follow-on additionally
checks exact before/after revision position. All finished journals report
complete. Each measured usage remains below the unchanged 10 GiB aggregate
logical cap; the raw files retain exact usage/headroom. Cap-overflow/partial and
active-reference behavior additionally passes the existing journal safety
suite: 18 tests, 112 assertions. No collection-pressure performance was measured.

## Independent suspension evidence

The final witness uses the real native manager, journal/scope controller and
actual governed Bash worker. A separate Bun process samples kernel shell/sleep
states and changed-file count every 20 ms. With a 20-file cap and 50 authored
writes, it observes actual stopped tasks **14,139 ms** after the threshold,
then a retained receipt **4,431 ms later**. The receipt truthfully counts 50
paths and 30 overshoot. This differs from the historical 296-path lead and
must not be read as a universal retention bound. The sample period limits
timestamp precision; the receipt's observedAt is not the suspension time.
The final native witness passes 1 test / 7 assertions, the existing scope
safety control passes 1 / 34, and full TypeScript checking passes. All owned
native invocations record unmounted/detached/removed-loop/deleted-backing
cleanup with no errors and unchanged parent namespace quota. No worker or
container is intentionally left active.

## Reproduction

Use a full checkout of the measured source with frozen dependencies and the
existing offline native image/prerequisites prepared. Restore this archive's
`scripts/profiling/` into that checkout; the archive branch itself has no full
monorepo and is never merged into main. With distinct output directories:

```sh
python3 scripts/profiling/run-journal-profile.py --source . --out /tmp/odysseus-journal-pilot --mode pilot
# Original pilot expected exit 1 at its finite deadline; retain its partial receipt.
python3 scripts/profiling/run-journal-profile.py --source . --out /tmp/odysseus-journal-complete --mode complete
```

The wrapper reuses the measured native fixture's ownership/cleanup checks,
changes only its owned loop number and selected keyless investigation commands,
and requires an unused exact loop1752. It mounts the source/Bun read-only,
retains normal repository network guards and the writable workspace lease,
and uses --network=none/--pull=never with the existing pinned seccomp policy.
A host with AppArmor must supply the existing named enforced proof profile.

## Interpretation

The earlier 10.752/7.617-second lead and 296-path retention receipt predate the
current native changed-only baseline. The older 5,000-file warm 19–20 ms and
20,000-file warm 87–104 ms observations use different workloads and capture
conditions; they are historical attributed receipts, not like-for-like controls
for this durable end-to-end capture. A new baseline retains no unchanged CAS
content. The worker suspension witness is separate from these latency samples
and does not attribute the later retention timestamp to actual freeze time.

No optimization, SLA or interval change is selected. Candidate remedies remain
hypotheses: safely coalescing accounting/pin transactions could reduce durable
per-version work, but must reserve capacity before bytes and make active refs
durable before collection; avoiding duplicate before-version writes must retain
integrity and collection-race protection. Neither remedy was implemented or
measured here, so there is no supported gain or new release-blocker claim.
The immediate result is attribution and a reproducible fixture, with durability
and truthful partial-history behavior preserved.
