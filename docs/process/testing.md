# Testing and proof

The full text of the testing rules that [AGENTS.md](../../AGENTS.md#testing-expectations)
states in short form, with the incidents behind them. AGENTS.md keeps the
obligations; this document keeps the detail and the reasons. The commands for
inspecting CI on a PR live in the `work-issue` skill's
[CI and merge reference](../../.agents/skills/work-issue/references/ci-and-merge.md).

## The offline test harness

- Every library keeps or gains unit tests. Integration tests run against
  `packages/core/fixtures/corpus/` — keyless, deterministic. Its retrieval
  goldens (`evals/retrieval.jsonl`, one query per class, and the ranks in
  `evals/expected-ranks.json`, asserted by
  `packages/core/tests/eval-corpus.test.ts`) make any ranking change a
  reviewed diff. Never add a test that needs an API key or the network.
- The test preload in root/package `bunfig.toml` and `scripts/test.ts` wraps
  real `fetch`, `Bun.spawn` and `Bun.spawnSync`. Real HTTP(S) fetches permit
  only the parsed hosts `localhost`, `127.0.0.1` and `[::1]`; every followed
  redirect is checked before dispatch, and explicit proxies are refused. Real
  curl execution is refused, including absolute executable paths and both
  spawn argument forms. Attempts are recorded: test hooks fail even when a
  client catches/retries the error. Saved originals and restored spies refer
  to the guarded functions; install mocks after preload and restore them in
  teardown. The test suite requires Bun >=1.4.0; CI pins 1.4.2, whose
  extra-stdio finalizer fix is exercised by the recycled-fd runtime probe
  (#1043, #1059).
- Run tests from the repository root with `bun run test [paths/flags]` or
  `bun test [paths/flags]` (the latter still needs the documented timeout).
  Each package's own `bun run test`/`bun test` also loads its local preload;
  new workspaces must include the same test config, because Bun does not
  inherit it from parent directories.
- Guarded Bun spawns add an absolute runtime preload to children, even with a
  different cwd or replaced environment. Child test hooks and ordinary child
  exit checks reject swallowed escapes; callers must assert child exit codes.
  This covers Bun executables named `bun` or matching `process.execPath`.
  Bun's `node:child_process` delegates to the patched spawn path too. Node
  transports, subprocess APIs in a Node runtime, shell commands, arbitrary
  executables, browser egress and deliberate replacement of the guard are not
  instrumented: use an explicitly offline harness for those, not a claim of
  sandboxing. Intentional measurement scripts launched outside tests retain
  normal transports. Guard regression probes use controlled native sentinels
  so failing-first and mutation runs cannot send external requests or start
  curl.

## Runtimes, browsers and doubles

- Predicate-only unit tests are not proof for anything with a runtime: the
  renderer's isolation holes were found by launching real Chrome, not by
  testing its allowlist function.
- Run real Chromium/Playwright/Puppeteer integration tests with command-scoped
  sandbox escalation when the agent's execution sandbox blocks Unix credential
  sockets or localhost listeners. These tests need both: a denied Crashpad
  `setsockopt` call can terminate Chromium with SIGTRAP before startup
  completes. Keep the test preload and offline browser guards enabled; run the
  targeted tests outside the restrictive execution sandbox rather than
  skipping them or disabling sandbox restrictions globally.
- Tests replacing browser globals must save and restore complete own-property
  descriptors, including originally absent properties. Install configurable
  writable test values; restore accessors/flags/value identity with
  `Object.defineProperty`, and delete only when the original was absent.
  Saving values or unconditionally deleting `navigator` leaks state between
  suites (#1158). Keep ordered native/absent/readonly restoration controls.
- Test doubles must replace the lowest shared request method (`get` for a
  `ScrapeClient`), or explicitly stub every inherited request path. Use the
  smallest collaborator that proves the behavior; borrowing a real adapter
  for a helper's test couples that assertion to unrelated adapter changes.

## Tests that cannot fail

A green test is evidence only if it could have been red. Each of these shapes
shipped with a green suite. The numbers are the PRs that found them, except
#192 and #974, which are issues:

- **An assertion that is not about the behaviour.** The test for whether pi
  tools load eagerly asserted that `Object.keys(tool)` does *not* contain
  `deferLoading`. That stays true for a deferred tool, an empty object or
  anything else without the key, so it could not tell eager from deferred.
  The fix asserts what does differ: the schema and the executor are already
  attached (#158).
- **A guard on the wrong object.** The test asserted the factory
  (`createBrainUiMcpServer`), not the `mcpServers` entry that the call site it
  was meant to protect actually builds (#158). A predicate-only test is the
  same shape.
- **An earlier layer answers first.** A 401 assertion kept passing with the
  route deleted, because the auth guard answers before routing. It proved
  nothing about the route, which a mounting test then did (#115).
- **The harness has nothing to observe.** "principal B is recorded for
  ordinary and always-allow approvals" passed with nothing stored anywhere,
  because its harness wired no store (#154).
- **The field under test is empty by construction.** A `toEqual` over a whole
  classifier request body passed with the threshold strip removed, because the
  test had built the request's `questions` map as `{}` (issue #192). An
  assertion over a whole structure is only as strong as its emptiest field.
  When a test builds the input and asserts the output, also assert that the
  part it covers is non-empty.
- **An expected value derived from the implementation under test.** The
  Button hover test resolved the same hover tokens the Button paints with.
  Pale text on amber still matched those tokens at 1.54:1 contrast, so green
  proved wiring without proving readability. Keep a wiring check explicit
  about that boundary; the independent browser contrast assertion holds the
  computed colours to 4.5:1 (#974, PR #1105).
- **An earlier assertion masks the one under test.** An `overflowing(card)`
  assertion fired before the document-overflow check it sat above (#102). A
  change meant to break the kind-naming assertion tripped the character budget
  first (#121). The test went red, but for a different reason.

Checking for these takes a mutation, not reasoning. Break the guard the test
protects: revert the fix, delete the route, empty the store. Run the named
test, watch it fail on the assertion you expect, then restore. Record the
mutation and the failing assertion in the PR.

## Failing first, for the reason claimed

A "failing first" receipt must fail **for the reason claimed**. A module-load
error — `SyntaxError: Export named 'X' not found`, because the code under test
does not exist yet — is not a behavioural failure: three of the five failures
one PR first presented were load errors (#144). Give the test something to
load (a stub export that keeps the old behaviour), then show the assertion
failing. Read which assertion failed: if it is not the one the test is named
for, reorder or split the assertions until it is.

## A finding is an instance

A review finding is one occurrence of a bug class. Before calling it closed,
grep the diff, and the file it sits in, for every other instance of the same
shape. #115 fixed a window that enforced `started_at >= since` with no upper
bound and left the same missing bound live twelve lines up in `lifetime`, which
only a second review found. In #136, `localeCompare` survived fifty lines above
the comment explaining why `breakdown()` had stopped using it.

## Required proof for a PR

The policy is [the CI decision](../decisions/ci-utility.md); the commands are
in the [CI and merge reference](../../.agents/skills/work-issue/references/ci-and-merge.md).

- Contract tests assert the `--json` envelopes. Automatic CI runs cheap
  metadata gates and complete affected hosted unit/integration/runtime,
  keyless funnel, pinned browser proof, strict types and packaging on ready
  PRs. Agents keep focused local behavioral proof.
- Run `bun run check:pr --base origin/main` before opening or marking ready.
  This is local preflight and affected fast feedback, including working-tree
  inputs. Agents retain targeted debugging, failing-first/restored mutation
  receipts and visual judgment; ordinary PRs do not duplicate complete types,
  packaging or browser/runtime suites locally.
- Ready PR CI supplies complete repeatable proof for affected workspaces and
  reverse dependencies plus root tests. Global/unknown changes expand to full
  discovery. Relevant pinned browser/accessibility/pointer, layout/offline/
  endurance, editorial, real Claude/Chrome and cleanup categories remain
  intact. The `proof` aggregate requires every selected job to succeed;
  missing tools, unavailable runtimes, failures, cancellations and unexpected
  skips are not green.
- Retain every test, default discovery, pinned offline image and failure
  artifact. Optional `check:pr --full` runs complete affected local proof;
  `--all` retains every local release/diagnostic category. Scheduled
  exhaustive CI is additional coverage, not a replacement for selected
  pre-merge proof.
- Keep drafts cheap and batch intermediate pushes. After cheap gates, run
  independent proof categories concurrently. Preserve per-browser file bounds;
  measure queue/elapsed time and cancellation/repeated work before adding
  shards. Different PRs never share cancellation groups. Metadata edits do not
  launch heavy proof, and every main SHA retains independent evidence.
- Record actual tested head/base, selected jobs/attempts/checkout logs and
  focused local receipts. Assess base changes before rebasing; unrelated main
  advancement alone does not require repeated long proof. Relevant
  input/dependency/harness changes require fresh checks; never call an old
  receipt a new combined-tree pass. Under #1333, complete browser/layout
  domains may retain validated equivalent successful automatic receipts. Read
  the current retention ledger and aggregate; original run/job/checkout
  identity remains distinct. Other categories stay fresh. Verify actual squash
  parent/tree and automatic main-push proof. Respect branch rules.

## GitHub Actions CI

CI and contract checks run from `.github/workflows/ci.yml` and `contract.yml`.
These are the source of truth for all main pushes and pull requests, including
forks. Project-board sync remains in `project-sync.yml`. Depot CI definitions
and generated fork fallback workflows are retired under #1320; do not restore
a second provider or duplicate workflow copies. The local pack command reads
the authoritative GitHub pack job rather than copying its probes.

Preserve cheap gates, complete affected hosted proof, focused local receipts,
action/runtime versions, pinned offline browser image and diagnostic
artifacts. Independent selected categories run after metadata; the final proof
aggregate rejects failures, cancellations, missing outputs and unexpected
skips. Tests-only changes may intentionally skip packaging while complete
affected tests run. Drafts run cheap gates only. Forks use ordinary
`pull_request`, a read-only token (`contents: read`, plus `actions: read` /
`checks: read` for bounded proof lookup), no secrets and nonpersisted checkout
credentials. A fork run awaiting maintainer approval has not passed.

Reading CI for a PR — the actual current head, the live base, checkout SHAs,
run/job/attempt IDs, retained #1333 receipts, refused-start jobs, and the
merge and post-merge checks — is the `work-issue` skill's
[CI and merge reference](../../.agents/skills/work-issue/references/ci-and-merge.md).
