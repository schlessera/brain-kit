# Experiment test tier

Tests that exercise only a measurement or eval harness live under
`experiments/`, outside default product discovery, and run as a required step
of preparing each release. Everything that protects what ships stays in
product proof. This record covers the ruling for
[#1386](https://github.com/schlessera/brain-kit/issues/1386), how discovery
keeps the two tiers apart, the release gate, and the file- and assertion-level
inventory behind the move. It follows [measurement-archive.md](measurement-archive.md),
which retained the fixtures and goldens these tests read at their paths.

## Decision

The maintainer ruled on 2026-10-09, on #1386:

- **Run the experiment tier when preparing each release, before publication.**
  Default product discovery and ordinary PR proof exclude genuine
  measurement-harness tests. Release preparation runs the complete retained tier
  on the post-version candidate. A nightly run or an old success does not
  substitute. No ready-PR or scheduled experiment job is required.
- **Classify by what a test proves, not where it came from.** A test that
  protects shipped behaviour, security, a contract, the native runtime, an
  offline boundary or release/CI tooling stays in mandatory product proof even
  if it began as an experiment. Mixed files are split without weakening an
  assertion.
- **Release evidence identifies what was tested.** It names the candidate
  source, the dependency lock and the test inventory, and a relevant change
  afterwards (including the lock refresh in `bun run version`) needs a fresh
  run.
- **Offline only.** The tier runs deterministic tests under the existing
  preload and namespace guards. No paid or live measurement, and no account
  login, enters it.

This is a scheduling exception for experiment-only tests. It does not relax a
product guarantee in [ci-utility.md](ci-utility.md).

## The boundary

A test is an **experiment** test when every assertion in it is about a
harness: spend and reservation ledgers, paid-entry grants, relay and observer
receipts, freeze manifests and review packets, prototype gates, scorers and
metrics, measurement-script arithmetic, and the bwrap or `unshare --net`
launchers that keep the harnesses offline. Those guards stop eval scripts from
spending money or reaching the network; no shipped code path goes through them
(`scripts/evals` is imported by no `packages/*/src` file).

A test is a **product** test when it asserts anything about a shipped command,
library, schema, runtime pin, offline boundary, or release/CI/docs tooling,
even when an eval fixture builds its input. `tests/audit-fix.test.ts` is the
model: the only test of `suggestAuditFix`, driven by the audit-capability
benchmark's fixtures, and product proof.

## Discovery

- **One root.** The tier is the top-level `experiments/` directory, including
  `experiments/core/` and `experiments/ui-server/` for the tests that used to
  sit in a package. Anything under `packages/` is product discovery, so a
  package-level experiment test cannot stay in its package.
- **Directory roots, not substrings.** Bun 1.4.2 treats a bare positional
  argument as a substring filter on the path: `bun test packages tests` also
  runs `experiment-tests/a.test.ts`. `bun run test` now passes the default
  roots as `./packages ./tests` (`DEFAULT_PATH_ARGS` in `scripts/test.ts`),
  which Bun treats as directory roots. That matches the directory walk in
  `scripts/test-shards.ts` (`discoverTests`) that balanced shards and hosted
  unit proof (`unitFiles` in `scripts/ci-proof.ts`) use, so `experiments/` is
  excluded by construction from `bun run test`, `check:pr` (including `--full`
  and `--all`) and every hosted unit shard. New files in either domain are
  discovered automatically; there is no allowlist.
- **Product CI is unchanged.** Any change outside `packages/`, `template/`,
  `api-report/` and prose, including one under `experiments/`, is global in
  `scripts/ci-plan.ts` and still expands to complete product discovery.
  `scripts/check-ci-workflows.ts` fixes the CI job set, so an automatic
  experiment job would fail lint.
- **Same gates.** `tsconfig.json`, oxlint, the frontmatter-parse gate and the
  docs-paths gate cover `experiments/`. The leakage and invisible-character
  gates already read the whole tree.

`tests/test-script.test.ts`, `tests/test-shards.test.ts`,
`tests/hosted-proof.test.ts` and `tests/experiment-tier.test.ts` assert the
partition: a file under `experiments/`, or under a sibling whose name merely
contains `tests`, never reaches the default run, a balanced shard or hosted
unit selection, and does run when the tier is named.

## The release gate

```sh
bun run test:experiments
```

`scripts/test-experiments.ts` refuses to start unless `python3`, `bwrap`,
`unshare`, `setpriv`, `ip` and `sh` exist and a user/network namespace can be
created, so a missing launcher fails the tier instead of becoming a skip. It
runs `./experiments` through `scripts/test.ts`, the same wrapper, explicit
offline preload and 30-second timeout as `bun run test`, with `CI=true` so a
`test.only` fails its file instead of hiding the rest. It takes no arguments;
`bun run test experiments/<file>` debugs one file and records nothing.

It deletes any earlier receipt first and writes
`tmp/experiment-tier-receipt.json` (ignored, never committed) only when the run
exited 0, Bun's JUnit report shows no failure and no skipped or todo test,
every inventoried file executed and nothing else did, and the candidate was the
same after the run as before it. The receipt records:

- **source:** the content tree of the working tree as `git add -A` would stage
  it, computed in a scratch index, plus the HEAD it was checked on;
- **lock:** the SHA-256 of `bun.lock`;
- **inventory:** the sorted `experiments/` test files and their hash;
- **runtime:** the Bun version.

`scripts/publish.ts` checks the receipt before its artifact, pin and registry
pre-flights and refuses the release unless source tree, lock, inventory and Bun
version all match the checkout it is about to publish. HEAD is recorded but not
compared, so committing the tested tree as `chore: version packages` keeps the
evidence; editing any source, the lock or the inventory does not. There is no
override flag. `bun run release -- --dry-run` stays an offline listing with no
gate, as `tests/release-manifest.test.ts` asserts. The release skill puts the
command after `bun run version` and the post-version build, typecheck and test,
and before the commit, push and `bun run release`.

Rejected alternatives:

- **Nest the tier under `tests/`** (`tests/experiments/`): the bare substring
  filter would still select it, and local and CI discovery would disagree.
- **An allowlist of experiment files:** the ruling requires directory
  construction, and a list goes stale silently.
- **A commit-based receipt:** it would force running the tier after the
  version commit; the content tree identifies the same bytes either way.
- **Treat a missing tool as a skip:** a skipped harness test is not evidence.

## Inventory

Classified at `c0c3bbc8`, after #1385's archival: root `tests/` held 205 test
files, 83 product, 108 experiment and 14 mixed.

### The experiment tier: 125 test files

| Family | Files | `experiments/<name>.test.ts` |
| --- | --- | --- |
| Audit capabilities | 9 | `audit-api-reservation`, `audit-capability-benchmark`, `audit-capability-controls`, `audit-capability-eval`, `audit-capability-live`, `audit-capability-review-packets`, `audit-review-admission-day`, `audit-review-artifacts`, `audit-scored-entry` |
| Note disposition | 3 | `note-disposition-eval`, `note-disposition-live`, `note-disposition-review` |
| Shared native paid harness | 2 | `native-grant`, `native-paid-policy` |
| Candidate extraction | 11 | `candidate-extraction-accounting`, `candidate-extraction-calibration`, `candidate-extraction-collector`, `candidate-extraction-disk`, `candidate-extraction-eval`, `candidate-extraction-gates`, `candidate-extraction-native`, `candidate-extraction-packet`, `candidate-extraction-paid`, `candidate-extraction-review`, `candidate-extraction-workload` |
| Canonical conflicts | 13 | `canonical-conflict-eval`, `canonical-conflict-freeze`, `canonical-conflict-freeze-cache`, `canonical-conflict-metrics`, `canonical-conflict-native`, `canonical-conflict-packet`, `canonical-conflict-paid-entry`, `canonical-conflict-paid-native`, `canonical-conflict-relay`, `canonical-conflict-review`, `canonical-conflict-scope`, `canonical-conflict-transport`, `canonical-conflict-workload` |
| Import enrichment | 12 | `import-enrichment-classification`, `import-enrichment-eval`, `import-enrichment-freeze`, `import-enrichment-freeze-cache`, `import-enrichment-native`, `import-enrichment-packet`, `import-enrichment-paid-entry`, `import-enrichment-paid-native`, `import-enrichment-relay`, `import-enrichment-review`, `import-enrichment-score`, `import-enrichment-semantic` |
| Job fit | 11 | `job-fit-accounting`, `job-fit-eval`, `job-fit-freeze`, `job-fit-freeze-cache`, `job-fit-native`, `job-fit-packet`, `job-fit-paid-entry`, `job-fit-paid-native`, `job-fit-relay`, `job-fit-review`, `job-fit-semantic` |
| Mechanical hygiene | 15 | `mechanical-hygiene-collector`, `mechanical-hygiene-effects`, `mechanical-hygiene-eval`, `mechanical-hygiene-freeze-cache`, `mechanical-hygiene-native`, `mechanical-hygiene-native-admission`, `mechanical-hygiene-native-capture`, `mechanical-hygiene-native-input`, `mechanical-hygiene-native-relay`, `mechanical-hygiene-observer`, `mechanical-hygiene-paid-native`, `mechanical-hygiene-paid-relay`, `mechanical-hygiene-research-runtime`, `mechanical-hygiene-runtime-freeze`, `mechanical-hygiene-workload` |
| Opportunity lifecycle | 5 | `opportunity-lifecycle-closure`, `opportunity-lifecycle-eval`, `opportunity-lifecycle-fresh`, `opportunity-lifecycle-paid`, `opportunity-lifecycle-preparation` |
| Speaking lifecycle | 13 | `speaking-lifecycle-accounting`, `speaking-lifecycle-atomic-effects`, `speaking-lifecycle-corpus`, `speaking-lifecycle-eval`, `speaking-lifecycle-freeze`, `speaking-lifecycle-freeze-cache`, `speaking-lifecycle-integration`, `speaking-lifecycle-native`, `speaking-lifecycle-paid-entry`, `speaking-lifecycle-paid-native`, `speaking-lifecycle-relay`, `speaking-lifecycle-review`, `speaking-lifecycle-task` |
| Tag aliases | 10 | `tag-alias-accounting`, `tag-alias-experiment`, `tag-alias-freeze`, `tag-alias-freeze-cache`, `tag-alias-native`, `tag-alias-packet`, `tag-alias-paid-entry`, `tag-alias-paid-native`, `tag-alias-relay`, `tag-alias-review` |
| Turn surface | 9 | `turn-surface-admission`, `turn-surface-capture`, `turn-surface-classifier`, `turn-surface-fixture-live`, `turn-surface-isolation`, `turn-surface-observation`, `turn-surface-overlap`, `turn-surface-routing`, `turn-surface-stdout` |
| Measurement scripts | 9 | `attribute-show-block-schema`, `measure-graph-boost`, `measure-kv-runs`, `measure-show-block-gate`, `measure-sonnet55-cost`, `measure-suggestions`, `measurement-results`, `pi-schema-measurement`, `show-block-live-credential` |
| From packages | 3 | `core/sync-judge-datasets` and `core/sync-judge-measure` (the E2 sync-judge measurement dataset and `scripts/measure-sync-judge.ts`; the judge itself stays proven by `packages/core/tests/sync-judge*.test.ts`), `ui-server/triage-eval-exit-code` (the unshipped `packages/ui-server/evals/triage` runner) |

Non-test files that moved with them: `experiments/mechanical-hygiene-offline-source.ts`,
`experiments/ui-server/helpers/triage-stub-preload.ts` and
`experiments/ui-server/helpers/triage-stub-providers.ts`, and the
#137 transcript `experiments/fixtures/show-block-137-tool-calls.json` with its
README. Eval freeze and review-packet manifests, `scripts/evals/candidate-extraction/prepare.ts`
and `scripts/pi-schema-runner.py` hash these files at their new paths; committed
measurement receipts keep the paths they recorded.

### Product tests with a measurement origin

These stay in product proof:

| File | Why |
| --- | --- |
| `tests/measurement-isolation.test.ts` | Runtime proof that `check:pr` and hosted CI run by name; "measurement isolation" is a ci-utility runtime guarantee. |
| `tests/measurement-fixture-lifetime.test.ts` | In `FAST_TESTS.tooling` (`scripts/ci-plan.ts`), an owner/exit regression (#1330). |
| `tests/show-block-schema-forms.test.ts` | The guarantee `packages/ui-sdk/src/tool-contracts/blocks.ts` names for the shipped `showBlockInputSchema`; only its live-credential describe moved. |
| `tests/audit-fix.test.ts` | The only test of `suggestAuditFix` and `audit --fix` output. |
| `tests/suggestions-strict-input.test.ts` | Shipped Claude and pi handlers reject unknown fields. |
| `tests/hygiene-fixture-cleanup.test.ts` | A product test fixture cleans up after itself. |
| `tests/template-eval.test.ts`, `tests/haiku-model-selection.test.ts`, `tests/test-network-guard.test.ts` | The template's `brain eval`, shipped model selection, and the offline test boundary. |
| `packages/core/tests/sync-scenarios.test.ts`, `packages/module-jobs/tests/fixture-records.test.ts`, `packages/ui-backend-claude/tests/measured-runtime.test.ts` | Real `brain sync run`, product-fixture privacy, and the shipped `MEASURED_RUNTIME` pin. |

### Mixed files, split by assertion

Each product block moved verbatim, with the helpers it needs, into a product
file; the rest of the file moved to `experiments/`. Before the split the
fourteen files ran 266 tests and 2,733 `expect()` calls. After it the same
blocks run 267 tests and 2,737 calls; the extra test is the shipped-pin half of
the research-runtime test.

| Original `tests/` file | Product assertions (test titles) | Product home |
| --- | --- | --- |
| `audit-capability-eval` | real generated-region handler…; real audit --fix ignores unverified provider claims…; actual module hygiene contributes detections…; actual tag migration fixes a configured alias… | `tests/audit-shipped-capabilities.test.ts` |
| `audit-capability-live` | shipped Anthropic text-block request and newline parsing…; real command ignores malformed provider responses… | `tests/audit-provider-completions.test.ts` |
| `audit-capability-benchmark` | actual audit invocation never calls a provider…; malformed truthy auto-fix provider claims…; actual current command ignores unsafe provider claims… | `tests/audit-fix-provider-claims.test.ts` |
| `note-disposition-eval` | actual process command returns proposals without applying… | `tests/process-command-proposals.test.ts` |
| `tag-alias-experiment` | existing chains resolve and cycles retain source bytes…; actual persisted full config drives the existing writer… | `tests/tag-alias-writer.test.ts` |
| `show-block-schema-forms` | everything except the live-credential describe | stays in `tests/`; the describe is `experiments/show-block-live-credential.test.ts` |
| `mechanical-hygiene-research-runtime` | the shipped SDK 0.3.293 / CLI 2.1.293 half | `tests/shipped-claude-runtime-pin.test.ts`; the whole original test stays in `experiments/` |
| `job-fit-eval` | real ingest normalizes configured currency and hourly ranges… | `tests/job-ingest-scoring.test.ts` |
| `opportunity-lifecycle-preparation` | fresh disk-backed module fallback agrees with actual config and pipeline CLI | `tests/opportunity-cli-agreement.test.ts` |
| `candidate-extraction-eval` | malformed selected index… (7 cases); missing key never touches…; real client timeout and failure… | `tests/jev-research-outcomes.test.ts` |
| `candidate-extraction-disk` | real config loads both modules and configured opportunity/assembly paths | `tests/configured-module-paths-cli.test.ts` |
| `mechanical-hygiene-eval` | the real reconcile CLI detects the row…; failedChecks prevents repair…; an unparseable existing log…; manual snooze survives… | `tests/hygiene-reconcile-shipped.test.ts` |
| `canonical-conflict-eval` | abstention retains an existing conflict through the real failed-check reconciliation path | `tests/hygiene-failed-check-retention.test.ts` |
| `canonical-conflict-transport` | none kept: its `no_key` check repeats `packages/core/tests/jev-client.test.ts` ("no key: disabled, answers no_key, sends nothing"), and its retry stop is the harness's `JevBook` | moved whole |

The per-fixture loop left in `experiments/canonical-conflict-eval.test.ts`
observes the real hygiene log incidentally; `packages/core/tests/hygiene.test.ts`
covers that log's retention and repeat behaviour directly.
