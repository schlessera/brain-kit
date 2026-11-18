# CI evidence archive, delivery and cadence

## Context and authority

[The evidence epic #2948](https://github.com/schlessera/brain-kit/issues/2948)
requires continuous measurements that remain reproducible after GitHub's
retention window. Hourly timing artifacts alone cannot provide that permanent
record. This decision records the maintainer's
[2026-10-25 storage, delivery and cadence ruling](https://github.com/schlessera/brain-kit/issues/2948#issuecomment-6403979242)
and the [2026-11-08 selections on #2951](https://github.com/schlessera/brain-kit/issues/2951#issuecomment-6720282369).
The later ruling replaces the earlier unspecified red-main duration threshold.

This is measurement only. The archive is never an input to proof, selection or
merging. Recording this decision creates no archive ref, workflow or scheduled
delivery. The [CI utility decision](ci-utility.md#exact-candidate-integration-reservation)
provides the existing reservation-ref precedent for guarded Git publication;
it does not make measurement data authoritative for integration.

## Durable archive and schema evolution

The durable store is the append-only data ref `refs/heads/brain-ci-metrics`.
A daily compaction job downloads the last day's hourly artifacts and merges
them into compact normalized files partitioned by UTC calendar month:
`YYYY-MM/<record-kind>.json`. Raw and intermediate artifacts are retained for
90 days; the measurement data ref is retained permanently. Full job logs are
outside the permanent archive: retain normalized records and bounded failure
excerpts only.

Each record carries its record kind's integer schema version.
[The inventory and schema task #2950](https://github.com/schlessera/brain-kit/issues/2950)
assigns the numeric versions per kind. Readers refuse unknown versions.
Schema evolution appends a new version without rewriting prior archived
records. Compaction preserves those immutable records rather than migrating
history in place.

Before publication, archive content passes the repository leakage screen.
No personal data, names, hostnames or email addresses belong in the archive,
reports or delivery comments; worker, task and orchestrator identifiers stay
opaque. Each update is parented by the inspected remote state and uses exact
`--force-with-lease` against that inspected ref identity, as for the reservation
ref. Competing writers must not overwrite an unobserved update. Append-only
history and immutable prior records remain requirements even though Git uses
a force-with-lease push for the comparison.

## Reports, cadence and delivery

Daily digests and full weekly reports are generated from the data ref. Each
report is produced as Markdown and JSON, uploaded as an artifact and written
to the job summary. Report artifacts are produced daily regardless of whether
a comment is due, and retain the same 90-day artifact retention split.

The full weekly report always posts as a comment on one pinned tracking issue.
The daily digest posts only when something changed:

- Any newly observed red-main incident qualifies for the next daily digest,
  including a brief incident, with no minimum duration. Re-observing the same
  unchanged incident does not qualify it as new or repeatedly trigger delivery.
- A change in the Phase B gate state independently qualifies for delivery.
- A collection gap independently qualifies for delivery.

[The report task #2956](https://github.com/schlessera/brain-kit/issues/2956)
consumes this newly-observed-incident rule; the earlier threshold wording is
superseded. Runner-slot wait is a first-class metric, as ruled in
[#2939](https://github.com/schlessera/brain-kit/issues/2939). Every report states
coverage gaps, including missing collection hours, expired sources, failed
acquisitions and unknowns. Absent data never reads as zero. Collection and
reporting stay within the collector's shared API budget, reading the archive
instead of the API wherever possible.

GitHub's own subscriber notifications deliver the pinned issue's comments.
There is no recipient list, email address, mail secret, SMTP server or
third-party mail action. Delivery uses GitHub Actions, artifacts, refs and
issues without a new external service, dashboard host or database.

## Job-scoped write permissions

Write authority is granted only to the individual job that needs it:

| Job responsibility | Write permission | Boundary |
| --- | --- | --- |
| Write the measurement data ref | `contents: write` | Only the job that writes `refs/heads/brain-ci-metrics`. |
| Post report comments | `issues: write` | Only the job that posts reports on the pinned tracking issue. |

Neither permission is granted at workflow scope or to other jobs. Collectors
and report-generation jobs do not acquire write authority merely because they
share a workflow with a publisher. These grants are recorded here before any
workflow implementation introduces them.

## Alternatives and limits

Artifact-only retention loses the long-term measurement record after 90 days,
so artifacts remain the raw/intermediate layer rather than the durable store.
A dedicated append-only data ref keeps the permanent record inside GitHub
without adding an external storage service. Monthly compact files bound the
partitioning while preserving old records and their schema versions.

Pinned-issue comments use existing subscriptions for delivery; SMTP and
third-party mail actions would introduce addresses, secrets and another
service. Weekly delivery always provides a regular report, while daily
comments are limited to the ruled changes. The 2026-11-08 ruling deliberately
includes brief newly observed incidents instead of inventing a duration
threshold or repeatedly notifying on unchanged incidents.

## UTC-day run layout amendment — 2026-11-17

The [maintainer's option B ruling on #4130](https://github.com/schlessera/brain-kit/issues/4130#issuecomment-6943090694)
amends the monthly layout: new run records use `YYYY-MM/run/DD.json`,
partitioned by `run.createdAt` converted to UTC, including late arrivals and
repeated attempts. Other kinds retain `YYYY-MM/<kind>.json`. Collection and
compaction time never choose a run's partition.

Legacy `YYYY-MM/run.json` blobs remain readable and are neither rewritten nor
deleted by compaction. When layouts coexist, readers join run/attempt identities
with the same deterministic observation/conflict rules as the writer before
reporting; a newer or richer legacy observation survives a replay into a daily
file. All historical commits remain intact. Per-kind schema versions and record
payloads are unchanged, and unknown versions still refuse reading.

The 95 MiB limit applies separately to every output file: exactly the limit is
allowed; any larger daily file refuses the complete publication before a push.
There is no fallback partition or compression. Leakage screening and publication
parented by the inspected head with an exact ref lease remain unchanged.
Numbered monthly parts were rejected because late arrivals can reshuffle them;
compression hides text diffs and only postpones the size ceiling.
