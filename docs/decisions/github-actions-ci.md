# GitHub Actions owns CI

The maintainer selected GitHub Actions on 2026-10-09 under
[#1320](https://github.com/schlessera/brain-kit/issues/1320), after making the
repository public and verifying actual runner admission through project sync.
This supersedes the provider and workflow-location choices in #983 and #988.

`.github/workflows/ci.yml` and `contract.yml` are the authoritative definitions
for main pushes and ordinary pull requests from this repository and forks.
They carry the current Depot job definitions forward, with GitHub-hosted
Ubuntu 24.04 runners and no provider-routing predicates. Checkout credentials
are not persisted. The former fork-only copies and active Depot definitions
are removed, so there is one workflow definition and one execution provider.

The revised [CI utility policy](ci-utility.md) under #1326 binds. Automatic execution retains cheap metadata gates and runs complete affected
hosted proof on ready PRs. Independent packaging, types, test and browser/runtime
categories run concurrently after metadata; an aggregate rejects missing,
failed, cancelled or unexpectedly skipped proof. Drafts run cheap gates only.
Main pushes retain independent SHA-based concurrency groups; superseded PR
heads share their PR group and remain cancellable.

The migration preserves action and runtime pins, triggers, job phases,
environment data, deadlines, outputs and complete consumer probes. Local
packaging and declaration guards read the GitHub pack job directly. Every
existing unit/runtime/browser/layout/endurance/editorial category remains
covered by affected hosted proof under #1326. Focused local behavioral receipts
remain required; missing runtimes and unrelated failures cannot be called green.

> **2026-10-10 — Implementation context (the declaration guard reading the
> pack job).** The declaration guard read its Node/Bun partition from the pack
> job's inline smoke test
> (`ciImportList` in [`scripts/check-dist-types.ts` at that time](https://github.com/schlessera/brain-kit/blob/9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2/scripts/check-dist-types.ts)).
> Under #1384 the pack job runs one table-driven script,
> [`scripts/ci-pack.ts`](../../scripts/ci-pack.ts), and the guard reads that
> script's `PACK_TABLE`. Local packaging still reads the GitHub pack job, and
> what is probed is unchanged. This decision still binds.

Forks use `pull_request` with `contents: read` and CI's `actions: read` / `checks: read` for
bounded immutable proof lookup under #1333, no secrets, no job-level
permission escalation and no persisted token. Titles and labels reach the
contract script as environment data. A first-time contributor's approval-held
run has not passed. Project sync keeps its separate trusted token and event
workflow; ordinary CI does not acquire that token.

The workflow lint refuses duplicate or active Depot definitions, unsafe
credentials/triggers, missing job phases and provider predicates that exclude
forks. Its tests retain contribution selection, concurrency, intentional-skip,
failure/cancellation and real hostile-shell-metadata controls from the former
adapter coverage. Historical Depot billing and scheduler measurements retain
their original context; they are not new GitHub performance measurements.

Cutover requires actual current-head GitHub checks and checkout receipts,
followed by the automatic main-push receipt for the squash. Removing the
repository's active Depot definitions disables its configured CI workflows;
the cutover records actual provider execution rather than assuming that a
local YAML comparison proves event delivery. Unrelated Depot products and
other repositories are outside this change.
