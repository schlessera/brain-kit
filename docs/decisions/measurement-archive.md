# Measurement archive

Historical measurement outputs and finished spikes live on a dedicated archive
branch of this repository, and decision records link to them by exact commit.
Active fixtures, executable inputs and regression goldens stay in the main tree
at their existing paths, even when they started out as measurement output. This
record covers the rulings for
[#1385](https://github.com/schlessera/brain-kit/issues/1385), the archive
commit, and the file-level inventory that decided what moved.

## Decision

The maintainer made three rulings on 2026-10-09, recorded on #1385:

- **Destination B: an archive branch in this public repository.** Historical
  result bundles are stored on the orphan branch `archive/measurements`, with a
  manifest and checksums. The branch name only helps readers find the archive.
  Durable links pin the **exact archive commit**. This replaced an earlier
  ruling for evidence releases, so measurement archives stay out of software
  Releases. No new repository, package version bump or history rewrite was
  chosen.
- **Fixtures and goldens A: retain active proof in place.** A file stays if a
  current test, script, eval or CI step reads it, or if it is an independent
  regression golden. This holds even when its name carries a date or it began as
  a measurement. Its path does not change in this task. Test-tier layout belongs
  to [#1386](https://github.com/schlessera/brain-kit/issues/1386). No test
  downloads an archive.
- **Spikes A: archive both spikes.** `scripts/site-model-spike/` and
  `scripts/policy-boundary-spike/` moved to the archive branch, with their
  source, lockfile and reproduction context. The durable conclusions stay in
  their records on `main`.

Rejected alternatives: GitHub evidence releases (superseded by B, to keep
Releases free of measurement data), a separate archive repository, rewriting
history to drop the bytes, and regenerating results instead of keeping the
original receipts. A rerun creates a new measurement. It does not replace an
original live receipt.

## The archive

Archive commit
[`48227b09076b350d70d9d20b8492ffcfb5b95771`](https://github.com/schlessera/brain-kit/tree/48227b09076b350d70d9d20b8492ffcfb5b95771)
on `archive/measurements` holds 94 files at their original paths. Each byte
sequence was copied from main commit
`9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2` and checked against it by SHA-256
before it was committed. Nothing was redacted. Its
[README](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/README.md)
explains citation, verification, the historical runtime for each spike, and
the evidence limits.
[`manifest.json`](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/manifest.json)
records each bundle's durable record, runtime provenance and limits. For each
file it records the size, SHA-256, git blob, introducing commit and last
changing commit. It keeps the source commit a measurement recorded about itself
(`measuredSource`) separate from the commits the archive was copied from and
created in.
[`SHA256SUMS`](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/SHA256SUMS)
checks the bytes with `sha256sum -c`. The archive content passed
`scripts/check-leakage.ts` before it was committed.

When something else is archived later, add it as a new commit on top of the
branch. Never rebase, squash or force-push the branch: every cited commit must
stay reachable. Link the new commit by its full SHA, never by branch name.

## How files were classified

Each file's consumers were searched in `tests/`, `scripts/`, `packages/`,
`.github/`, `website/`, `docs/` and the root configuration (`package.json`,
`tsconfig.json`, `bunfig.toml`, `.oxlintrc.json`, `.gitignore`). The search
looked for its path, its basename and its directory, and it read code that
builds paths dynamically (`join(import.meta.dir, …)`, `new URL("./…",
import.meta.url)`, directory listings in eval freeze and review-packet code).
A link from a document is a pointer, not a consumer: those links were moved to
the archive. Classification followed actual readers, not the directory name or
a date.

### Archived (94 files)

#### Claude Code 2.1.292 runtime receipts

- **Path:** `scripts/measurements/claude-runtime-2026-10-07/` (8 files)
- **Role:** historical output (sanitized native receipts).
- **Consumers before removal:** Linked from `docs/decisions/claude-code-runtime.md`. No code, test or CI reader.
- **Disposition:** archived.
- **Measured source:** `86ca7f2408993113f3cba4287b7a01846a8b26ee` (identity.json sourceBase). **Introduced by:** `7347c5d32b1d`.
- **Files:** [capability.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/capability.json), [delegation.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/delegation.json), [enforcement.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/enforcement.json), [identity.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/identity.json), [mode-mutation.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/mode-mutation.json), [mutations.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/mutations.json), [omitted-mode.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/omitted-mode.json), [runtime.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-07/runtime.json)

#### Claude Code 2.1.293 runtime receipts

- **Path:** `scripts/measurements/claude-runtime-2026-10-08/` (8 files)
- **Role:** historical output (sanitized native receipts).
- **Consumers before removal:** Linked from `docs/decisions/claude-code-runtime.md`. No code, test or CI reader.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `361320f15927`.
- **Files:** [capability.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/capability.json), [delegation.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/delegation.json), [enforcement.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/enforcement.json), [haiku.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/haiku.json), [identity.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/identity.json), [mode-mutation.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/mode-mutation.json), [native-model-mutation.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/native-model-mutation.json), [runtime.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/claude-runtime-2026-10-08/runtime.json)

#### pi show_block schema-form receipts (#563)

- **Path:** `scripts/measurements/pi-schema-2026-10-08/` (2 files)
- **Role:** historical output (sanitized six-request artifact and executed-input hashes).
- **Consumers before removal:** Linked from `docs/decisions/design-kit.md`. No code, test or CI reader.
- **Disposition:** archived.
- **Measured source:** `86ca7f2408993113f3cba4287b7a01846a8b26ee` (executed-inputs.json sourceBase). **Introduced by:** `0e4290f5d002`.
- **Files:** [executed-inputs.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/pi-schema-2026-10-08/executed-inputs.json), [results.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/pi-schema-2026-10-08/results.json)

#### Sonnet 5.5 suggestions measurement (#1193)

- **Path:** `scripts/measurements/suggestions-2026-10-07/` (24 files)
- **Role:** historical output (report, methods, receipts and executed-script snapshots).
- **Consumers before removal:** `report.md` linked from `docs/decisions/design-kit.md`; `README.md`, `methods.md` and `report.md` listed in `website/retired-docs.json`, which links them at the pinned commit `c577320cb4b9e3224a84a374e975ef5910db1edd`. No code, test or CI reader for these 24 files. The other four files in the directory are retained (below).
- **Disposition:** archived.
- **Measured source:** `db2f42cb50c4d220df0c2f5a23aaa8be8ab45a43` (results.json and provenance.json sourceCommit). **Introduced by:** `86ca7f240899`.
- **Files:** [README.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/README.md), [auth-probe.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/auth-probe.ts.txt), [capture-probe.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/capture-probe.ts.txt), [complementary-review.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/complementary-review.ts.txt), [fake-cli.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/fake-cli.ts.txt), [fixture-brain-wrapper.sh.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/fixture-brain-wrapper.sh.txt), [fixture-runtime.py.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/fixture-runtime.py.txt), [freeze.py.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/freeze.py.txt), [launch.py.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/launch.py.txt), [matrix-controller.py.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/matrix-controller.py.txt), [methods.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/methods.md), [pi-api-capture-preload.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/pi-api-capture-preload.ts.txt), [pi-api-capture.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/pi-api-capture.ts.txt), [pi-api-controls.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/pi-api-controls.ts.txt), [pi-api-launch-env.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/pi-api-launch-env.ts.txt), [pi-api-smoke.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/pi-api-smoke.ts.txt), [provenance.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/provenance.json), [query-capture.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/query-capture.ts.txt), [raw-capture-preload.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/raw-capture-preload.ts.txt), [report.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/report.md), [results.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/results.json), [server-smoke.ts.txt](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/server-smoke.ts.txt), [transport-amendment-receipt.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/transport-amendment-receipt.json), [verification.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/verification.md)

#### Live four-arm turn-surface routing comparison (#587)

- **Path:** `scripts/fixtures/turn-surface-live-2026-10-07/` (9 files)
- **Role:** historical output (live receipts, frozen run inputs, reviews and recomputed summary).
- **Consumers before removal:** Linked from `docs/decisions/turn-surface-routing.md`, whose reproduction passes `results.json` and `token-budget.json` to `scripts/measure-turn-surface-report.ts` by argument. No test, CI or default-path reader: `scripts/check-turn-surface-live-offline.ts` writes its own manifest, catalogue and review into a scratch directory.
- **Disposition:** archived.
- **Measured source:** `380ad6eaf2f05807e15a67410cae64daaba7be5b` (manifest.json, results.json and summary.json sourceCommit); `e8504586a152a8e2a2090accb132841f96a877aa` (protocol.json and review-input.json baselineSource.commit; not present in this repository's object store). **Introduced by:** `5ebbcd6ca443`.
- **Files:** [manifest.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/manifest.json), [native-catalogue.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/native-catalogue.json), [protocol.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/protocol.json), [results.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/results.json), [review-input.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/review-input.json), [review.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/review.json), [reviews.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/reviews.json), [summary.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/summary.json), [token-budget.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/token-budget.json)

#### Keyless turn-surface mechanics output (#970)

- **Path:** `scripts/fixtures/turn-surface-mechanics.json`
- **Role:** historical output (keyless scripted mechanics; no test compares against it).
- **Consumers before removal:** Linked from `docs/investigations/turn-surface-routing-investigation.md`. Output of `scripts/measure-turn-surface-keyless.ts` (stdout); no test or script compares against it.
- **Disposition:** archived.
- **Measured source:** `91995dcf1bbf0dbbc3aa7b0f3b2fda6a07c63e6a` (docs/investigations/turn-surface-routing-investigation.md (source inspected at)). **Introduced by:** `fec692bbd541`.
- **Files:** [scripts/fixtures/turn-surface-mechanics.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-mechanics.json)

#### Audit repair-capability arms (#841)

- **Path:** `scripts/evals/audit-capabilities/results/2026-10-10/` (15 files)
- **Role:** historical output (freeze, observations, physical calls, judge inputs/reports, analysis, billing).
- **Consumers before removal:** Linked from `docs/decisions/audit-repair-suggestions.md`. `scripts/evals/audit-capabilities/freeze.ts` skips `results` directories when hashing, and `analyze.ts` takes its inputs by argument. No test reader.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `2cf8508386fb`.
- **Files:** [analysis.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/analysis.json), [annotations.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/annotations.json), [billing.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/billing.json), [freeze.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/freeze.json), [judge/input-0.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/input-0.json), [judge/input-1.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/input-1.json), [judge/input-2.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/input-2.json), [judge/members.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/members.json), [judge/prompt.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/prompt.md), [judge/report-0.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/report-0.json), [judge/report-1.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/report-1.json), [judge/report-2.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/judge/report-2.json), [keyless-proof.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/keyless-proof.json), [observations.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/observations.json), [physical-calls.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/audit-capabilities/results/2026-10-10/physical-calls.json)

#### Note disposition live measurement (#840)

- **Path:** `scripts/evals/note-disposition/results/2026-10-07/` (7 files)
- **Role:** historical output (protocol, calibration, observations, physical calls, scorer output, audit, reviews).
- **Consumers before removal:** Linked from `docs/investigations/note-disposition-investigation.md`. No code, test or CI reader; the eval scripts take output directories by argument.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `fa6fee03b5ce`.
- **Files:** [audit.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/audit.json), [calibration.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/calibration.json), [observations.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/observations.json), [physical-calls.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/physical-calls.json), [protocol.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/protocol.json), [reviews.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/reviews.json), [summary.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/note-disposition/results/2026-10-07/summary.json)

#### Opportunity lifecycle keyless reports (#866)

- **Path:** `scripts/evals/opportunity-lifecycle/fresh-preparation-controls.json`, `scripts/evals/opportunity-lifecycle/keyless-report.json`
- **Role:** historical output (keyless control reports; expected.json, the golden, stays in main).
- **Consumers before removal:** `keyless-report.json` linked from `docs/investigations/opportunity-lifecycle-investigation.md`; `fresh-preparation-controls.json` referenced nowhere. `run.ts` and `fresh-run.ts` print or write to a path given by argument; neither reads these files.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `793a9ffeee88`, `b6f7d2e5f21d`.
- **Files:** [scripts/evals/opportunity-lifecycle/fresh-preparation-controls.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/opportunity-lifecycle/fresh-preparation-controls.json), [scripts/evals/opportunity-lifecycle/keyless-report.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/opportunity-lifecycle/keyless-report.json)

#### Jev T1 triage classifier runs (#848)

- **Path:** `packages/ui-server/evals/triage/experiment/results/2026-10-09-baseline.json`, `packages/ui-server/evals/triage/experiment/results/2026-10-09-panel.json`, `packages/ui-server/evals/triage/experiment/results/2026-10-09.json`
- **Role:** historical output (Jev runs, Sonnet baseline, label panel).
- **Consumers before removal:** Linked from `docs/decisions/triage-classifier.md` and the experiment README. `run.ts` and `panel.ts` require `--out`; `calibrate.ts` reads only the retained answers file.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `aed59874d5c0`.
- **Files:** [packages/ui-server/evals/triage/experiment/results/2026-10-09-baseline.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/packages/ui-server/evals/triage/experiment/results/2026-10-09-baseline.json), [packages/ui-server/evals/triage/experiment/results/2026-10-09-panel.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/packages/ui-server/evals/triage/experiment/results/2026-10-09-panel.json), [packages/ui-server/evals/triage/experiment/results/2026-10-09.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/packages/ui-server/evals/triage/experiment/results/2026-10-09.json)

#### show_block schema forms on Sonnet 5.5 (#336, #1210)

- **Path:** `docs/decisions/design-kit-schema-forms-2026-10-07.json`
- **Role:** historical output (sanitized per-turn artifact).
- **Consumers before removal:** Linked from `docs/decisions/design-kit.md`. No code, test or CI reader.
- **Disposition:** archived.
- **Measured source:** `6e49ff9e6c840b05b51277392dec6b438b4f1e6c` (sourceCommit (recorded abbreviated)). **Introduced by:** `4e3947897792`.
- **Files:** [docs/decisions/design-kit-schema-forms-2026-10-07.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/docs/decisions/design-kit-schema-forms-2026-10-07.json)

#### Website content-model spike (#611)

- **Path:** `scripts/site-model-spike/` (12 files)
- **Role:** spike source (standalone npm project with its own lockfile).
- **Consumers before removal:** Linked from `docs/decisions/public-website.md` and `docs/investigations/public-website-investigation.md`; `README.md` listed in `website/retired-docs.json` (pinned commit). Standalone npm project outside the workspaces; nothing imports it. The shipped site uses `website/model.mjs`, maintained separately.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `0a6389cf3f30`.
- **Files:** [.gitignore](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/.gitignore), [README.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/README.md), [astro.config.mjs](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/astro.config.mjs), [clean-cache.mjs](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/clean-cache.mjs), [model.mjs](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/model.mjs), [package-lock.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/package-lock.json), [package.json](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/package.json), [sample/media/route.svg](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/sample/media/route.svg), [sample/nested/links.md](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/sample/nested/links.md), [src/content.config.mjs](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/src/content.config.mjs), [src/pages/\[...page\].astro](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/src/pages/%5B...page%5D.astro), [verify.mjs](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/site-model-spike/verify.mjs)

#### Policy-write boundary spike (#750)

- **Path:** `scripts/policy-boundary-spike/` (2 files)
- **Role:** spike source (bubblewrap probe and fixture writers).
- **Consumers before removal:** Linked and run from `docs/plans/policy-write-boundary.md`. Nothing imports it. Current proof of the boundary is `tests/fixtures/policy-boundary-probe.ts`, driven by `tests/policy-write-boundary.test.ts`, which is separate and retained.
- **Disposition:** archived.
- **Measured source:** not recorded. **Introduced by:** `e8f94c6c1f1f`.
- **Files:** [probe.py](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/policy-boundary-spike/probe.py), [worker.ts](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/policy-boundary-spike/worker.ts)

### Retained in place (241 files)

Every file below is still tracked at its existing path. The consumer named is
the reason it stays.

| Path | Role | Actual consumer | Disposition |
| --- | --- | --- | --- |
| `scripts/fixtures/claude-core-default-launch.py` | executable input | spawned by `packages/core/tests/claude-runner-default-native.test.ts` | retain |
| `scripts/fixtures/claude-core-default-probe.ts` | executable input | run inside the sandbox by `claude-core-default-launch.py` | retain |
| `scripts/fixtures/turn-surface-cases.json` | active fixture | imported by `scripts/turn-surface-fixture.ts` (used by `tests/turn-surface-fixture-live.test.ts`, `tests/turn-surface-routing.test.ts`) and read by `scripts/measure-turn-surface-keyless.ts` | retain |
| `scripts/fixtures/turn-surface-live-cases.json` | golden | imported by `scripts/check-turn-surface-live-offline.ts`, which `tests/turn-surface-fixture-live.test.ts` runs, and by `scripts/measure-turn-surface-live.ts` | retain |
| `scripts/measurements/suggestions-2026-10-07/input-review-snapshot.json` | golden | `tests/pi-schema-measurement.test.ts` compares `PI_SCHEMA_PROMPT` with its reviewed prompt | retain |
| `scripts/measurements/suggestions-2026-10-07/executed-manifest.json` | executable input | `scripts/pi-schema-runner.py` refuses to run if the corpus drifted from its `corpusFiles` | retain |
| `scripts/measurements/suggestions-2026-10-07/review-receipt.json` | provenance named by an executable | `scripts/pi-schema-runner.py` writes this path into its manifest as `promptReview` | retain (borderline) |
| `scripts/measurements/suggestions-2026-10-07/shared-corpus-review-receipt.json` | provenance named by an executable | `scripts/pi-schema-runner.py` writes this path into its manifest as `corpusReview` | retain (borderline) |
| `scripts/evals/audit-capabilities/benchmark.json` | active fixture | `scripts/evals/audit-capabilities/benchmark.ts`, `freeze.ts`; `tests/audit-fix.test.ts` | retain |
| `scripts/evals/note-disposition/benchmark.json` | active fixture | `scripts/evals/note-disposition/benchmark.ts` (tests `note-disposition-*.test.ts`), `review.ts` `REVIEW_PATHS` | retain |
| `scripts/evals/note-disposition/fixtures.json` | active fixture | `scripts/evals/note-disposition/fixture.ts`, `run.ts` | retain |
| `scripts/evals/opportunity-lifecycle/expected.json` | golden | `scripts/evals/opportunity-lifecycle/run.ts`, run by `tests/opportunity-lifecycle-eval.test.ts` | retain |
| `scripts/evals/candidate-extraction/keyless-report.json` | executable input | embedded by `scripts/evals/candidate-extraction/prepare.ts` in its review packet; cited by `docs/investigations/candidate-extraction-investigation.md` | retain (borderline) |
| `scripts/evals/candidate-extraction/README.md` | eval documentation | listed by `prepare.ts`; describes the eval in place | retain |
| `packages/ui-server/evals/triage/experiment/results/2026-10-09-answers.json` | executable input | `packages/ui-server/evals/triage/experiment/calibrate.ts` recomputes the calibration from it offline | retain |

Executable eval source is not measurement output. These 226 files are imported
by `tests/*.test.ts` or run as eval entry points, and all of them stay:

| Directory | `.ts`/`.py` files |
| --- | --- |
| `scripts/evals/` (top level: `native-grant.ts`, `native-paid-entry.ts`, `native-paid-policy.ts`, `native-pricing.ts`) | 4 |
| `scripts/evals/audit-capabilities/` | 20 |
| `scripts/evals/candidate-extraction/` | 26 |
| `scripts/evals/canonical-conflicts/` | 22 |
| `scripts/evals/import-enrichment/` | 24 |
| `scripts/evals/job-fit/` | 23 |
| `scripts/evals/mechanical-hygiene/` | 36 |
| `scripts/evals/note-disposition/` | 7 |
| `scripts/evals/opportunity-lifecycle/` | 20 |
| `scripts/evals/speaking-lifecycle/` | 25 |
| `scripts/evals/tag-aliases/` | 19 |

That is 241 files: `git ls-files scripts/evals scripts/fixtures scripts/measurements`
lists 240 of them, and the triage answers file under
`packages/ui-server/evals/triage/experiment/results/` is the 241st.

### Considered and left alone

- `packages/ui-server/evals/triage/benchmarks.json` is a result ledger, but it
  carries no date. `packages/ui-server/evals/triage/run.ts` appends to it by
  default, and its README and `docs/plans/async-collaboration.md` cite it.
  Moving it changes how the runner behaves, so it is outside this archival
  task.
- `scripts/test-shard-costs.json`, `scripts/browser-shard-costs.json` and
  `scripts/unit-shard-observation.json` are active CI scheduling inputs.
- `tests/fixtures/policy-boundary-probe.ts` is the current, active proof of
  the policy-write boundary. It is separate from the archived spike and is
  not a snapshot of it.
- `website/public/demo/library.json` is demo content, not a measurement.
- `website/retired-docs.json` sends three retired website routes to
  suggestions documents and one to the site-model spike's README. It links them
  at the pinned commit `c577320cb4b9e3224a84a374e975ef5910db1edd`, which still
  contains them, so those links stay valid and were not changed.

## Pointers moved to the archive

These records now link the archive commit instead of main-tree paths:
`claude-code-runtime.md`, `design-kit.md` (the schema-forms artifact, the pi
schema receipts and the suggestions report), `turn-surface-routing.md`,
`audit-repair-suggestions.md`, `triage-classifier.md`, `public-website.md`,
`docs/investigations/note-disposition-investigation.md`,
`docs/investigations/opportunity-lifecycle-investigation.md`,
`docs/investigations/turn-surface-routing-investigation.md`,
`docs/investigations/public-website-investigation.md`, `docs/plans/policy-write-boundary.md`
and `packages/ui-server/evals/triage/experiment/README.md`. Reproduction
instructions that need archived bytes now restore them at their original
paths first:

```sh
git fetch origin 48227b09076b350d70d9d20b8492ffcfb5b95771
git restore --source 48227b09076b350d70d9d20b8492ffcfb5b95771 -- <original-path>
```

Each record keeps its measurements, failures and limits. Only the location of
the evidence changed.

## Keeping new output out

`.gitignore` ignores the archived paths and their dated siblings:
`scripts/measurements/*`, `scripts/fixtures/turn-surface-live-*/`,
`scripts/fixtures/turn-surface-mechanics.json`, `scripts/evals/*/results/`,
the two opportunity-lifecycle reports, the triage `results/` directory, the
schema-forms artifact pattern and both spike directories. Negated entries keep
the retained files above tracked. A local run, or a file restored from the
archive, therefore cannot slip back into a commit. None of the producer scripts
writes into these paths by default: each one takes `--out` or prints to stdout.

## Evidence limits

Archived receipts show what was measured, on the runtimes and at the times
they record. Archiving them does not make them a claim about the current
product. The policy-boundary spike does not establish current containment, the
site-model spike does not establish current website correctness, and the
runtime receipts describe only the Claude Code, Agent SDK, pi and Bun versions
they name.
