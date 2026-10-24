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
  real `fetch`, `Socket#connect` (shared by Bun's `node:net` factories and
  `node:tls`), `Bun.connect`, `Bun.spawn` and `Bun.spawnSync`. Socket connections
  permit `localhost`, IPv4 loopback addresses in `127.0.0.0/8`, IPv6 `::1`,
  Unix sockets and adoption of existing sockets. Real HTTP(S) fetches permit
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
  inherit it from parent directories. Run `experiments/` from the root too:
  `bun run test:experiments` and `bun run test experiments/<file>` both go
  through `scripts/test.ts`, which passes the preload explicitly.
- Guarded Bun spawns add an absolute runtime preload to children, even with a
  different cwd or replaced environment. Child test hooks and ordinary child
  exit checks reject swallowed escapes; callers must assert child exit codes.
  This covers Bun executables named `bun` or matching `process.execPath`.
  Bun's `node:child_process` delegates to the patched spawn path too. Separate
  Node runtimes, shell commands, arbitrary
  executables, browser egress and deliberate replacement of the guard are not
  instrumented: use an explicitly offline harness for those, not a claim of
  sandboxing. Intentional measurement scripts launched outside tests retain
  normal transports. Guard regression probes use controlled native sentinels
  so failing-first and mutation runs cannot send external requests or start
  curl. A socket sentinel redirects the deliberate non-loopback TCP attempt
  to an owned loopback listener, retaining real connection evidence without
  allowing the failing-first or mutated guard to dispatch externally.
- The shared preload disables fixture Git auto-maintenance with command-scope
  `maintenance.auto=false` and `gc.auto=0`. Guarded spawns carry those settings
  even when callers replace the environment, preserving their other Git
  configuration. This includes Bun's `node:child_process` path, inherited shell
  commands and explicitly preloaded child probes. Production invocations keep
  their own policy. The startup-view copier still refuses concurrent changes.

### Deliberate offline commands on Linux

Use the repository launcher when a manual test command needs OS-level network
isolation, including browser children that the Bun preload cannot instrument:

```sh
BRAIN_REQUIRE_CHROME=1 PUPPETEER_EXECUTABLE_PATH=/path/to/chrome \
  scripts/test-offline.sh -- bun run test \
  ./packages/ui-react/tests/share-draft-runtime.test.ts \
  ./packages/ui-server/tests/inbox-runtime.test.ts
```

It requires Bash, util-linux `unshare`/`setpriv`, iproute2 `ip`, `readlink` and
permitted Linux user/network namespaces. Escalate only the test command when
an agent sandbox blocks those prerequisites; a refusal is not a skipped test.
The dummy driver must already be initialized and visible at `/sys/module/dummy`.
The launcher refuses driver autoload: Linux's [dummy initialization](https://github.com/torvalds/linux/blob/v6.18/drivers/net/dummy.c)
can create a default `dummy0` in the initial host network namespace even when
requested from a private namespace. Driver loading is a host prerequisite,
outside this launcher's authority.
The launcher preserves stdin, arguments, cwd, environment, UID/GID and umask,
then returns the command's exit status. Namespace and link/address/route
inventories and the five capability sets go to stderr.

Each invocation verifies fresh user/network namespaces before changing links.
It brings up loopback and a `proof-dummy` interface at `198.18.0.1/32` with
`noprefixroute`, setting `addrgenmode none` on that dummy before link-up.
Both IPv4 and IPv6 main route tables must be empty. This keeps external
networking unavailable while letting real Chrome report `navigator.onLine`
as true for local fixtures. Loopback alone reports false and correctly pauses
share upload before the ownership assertions (#2401). Keep browser egress
guards and the test preload enabled.

Setup needs `unshare --keep-caps`, but retaining those capabilities for tests
makes bubblewrap refuse with `Unexpected capabilities but not setuid`.
The launcher drops inherited, ambient and bounding capabilities through
`setpriv`, then requires all five sets, including effective and permitted, to
be zero before executing the command. Do not remove that drop or bypass its
verification to get past a fixture failure.

`scripts/test-offline.sh --mount -- <command>` also creates and verifies a
private mount namespace with private propagation. It does not provision
storage. For a caller-owned tmpfs, mount it in a separate private user/mount
namespace before invoking the launcher; it inherits that filesystem while
still creating fresh user/network namespaces and dropping capabilities before
tests. This supports the storage-capacity controls in #2394 without changing
the caller's mounts, interfaces, IPv6 configuration or DNS. Generic test runs,
hosted unit workers and `check:pr`'s existing probe namespaces keep their
current launch paths.

For example, explicitly provision a 4 GiB fixture filesystem for one command:

```sh
proof_tmp=$(mktemp -d)
trap 'rmdir "$proof_tmp"' EXIT
unshare --user --map-current-user --keep-caps --mount sh -eu -c '
  mount --make-rprivate /
  mount -t tmpfs -o size=4g tmpfs "$1"
  export TMPDIR="$1"
  shift
  exec scripts/test-offline.sh --mount -- "$@"
' offline-storage "$proof_tmp" bun run test ./packages/ui-react/tests/share-draft-runtime.test.ts
```

### Capacity for fixtures that require running turns

The connection-continuity, parallel-sessions and Claude cancellation fixtures
explicitly call the test-only `requireTurnFreeSpace` helper before their first
turn. It reads `statfs` on the actual brain path and requires available bytes
(`bavail * bsize`) to meet `max(5% of total bytes, SCOPE_FREE_BYTES)`.
`SCOPE_FREE_BYTES` is the production 2 GiB minimum. Equality passes. On a large
filesystem the 5% term can require much more than 2 GiB free.

Below that floor, `TurnFixtureFreeSpaceError` names the brain path, available
bytes, required bytes and the remedy: point `TMPDIR` at a sufficiently
provisioned filesystem. Provision storage explicitly before starting proof;
neither the helper, `createFixtureApp` nor the offline launcher mounts it for
you. Suites that do not need running turns have no blanket capacity check.
This is a test prerequisite selected in
[#2394](https://github.com/schlessera/brain-kit/issues/2394), not a replacement
for the real runtime monitor. The production floor and its Stop-only behavior
remain enforced, including if free space falls during a turn.

For the negative control, use the private tmpfs recipe above with `size=3g`
and run `fallocate -l 1600M "$1/fill"` immediately after mounting. The affected
fixtures must refuse with the named error before sending their first turn,
without reaching a recovery/approval timeout. Remove the explicit helper call
temporarily to reproduce the original timeout, then restore it. The unfilled
arm must pass every original behavioral assertion. Keep both arms offline via
`scripts/test-offline.sh`, with setup capabilities dropped, and record total,
available and required bytes alongside the runtime and mutation receipts.

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
- Persistence fault fixtures retain their storage failure through the original
  failure and persisted-state assertions. Track and drain the actual native
  transactions, then restore complete storage method descriptors in cleanup.
  A queued autosave can legitimately clear a failure after successful recovery;
  include a real queued writer to prove its position in the fault window (#2355).
- Test doubles must replace the lowest shared request method (`get` for a
  `ScrapeClient`), or explicitly stub every inherited request path. Use the
  smallest collaborator that proves the behavior; borrowing a real adapter
  for a helper's test couples that assertion to unrelated adapter changes.

## PDF optimizer startup regression

For #1897, an empty-cache pass alone misses the failing state: Vite can accept
an incomplete cache created by a smaller test discovery. Late PDF discovery
then replaces dependency URLs during an executing test. A lazy graph can
receive a different React default export and internals from the active
renderer, leaving its hook dispatcher null. React package deduplication does
not prevent this URL transition. Both PDF modules belong in the eager inputs
in `packages/ui-kit/vite.config.ts`.

Keep this bounded native regression recipe when changing browser optimizer
inputs. Use an isolated checkout with its own frozen dependencies, completed
build and no generated `packages/ui-kit/node_modules/.vite/**` cache. Run from
the repository root, using the pinned offline runner and its locked fonts:

1. Save `packages/ui-kit/vitest.config.ts` outside the tree. Temporarily replace
   only the `ui-react-layout` project's discovery array with
   `["../ui-react/tests/browser/graph-labels.layout.tsx"]`.
2. Seed the partial cache (all four cases must pass):

   ```sh
   timeout --signal=TERM --kill-after=10s 180s node scripts/visual.mjs --project=ui-react-layout --filter=graph-labels.layout
   ```

3. Restore the saved configuration byte for byte, retaining the generated cache.
   Save its `_metadata.json` and hash the lockfile/config/test inputs. Run this
   command twice, recording each exit code, complete log and optimizer metadata
   separately, even when the first fails:

   ```sh
   timeout --signal=TERM --kill-after=10s 180s node scripts/visual.mjs --project=ui-react-layout --filter=remaining-buttons.layout
   ```

The corrected seed already contains both PDF modules. Both target invocations
must pass all 38 cases without `optimized dependencies changed. reloading`,
Vitest's unexpected-reload warning or hook errors. Also run the target once
from an empty cache. Preserve graph assertions and pointer/theme coverage.

For mutation proof, remove both PDF entries from the eager optimizer inputs
**before seeding a fresh cache**, then repeat the recipe. The partial-cache
arm reproduces two graph-row failures and null `useRef` dispatcher errors;
the identical prepared-cache arm passes. Retain the first failed assertion;
the second run demonstrates recovery, not correction. Restore the entries
and repeat the seed/target pair. Merely removing entries against an already
prepared cache does not exercise this guard.

## Light and dark parity

Storybook is the central owner of reusable light/dark layout and interaction
parity: run the same meaningful geometry, focus, input and action assertions in
both projects, with the accessibility gate enabled in each. Include actual
consumer compositions and their shipped styles where kit-only fixtures cannot
cover the painted result. The [coverage map](theme-parity.md) names the cases,
assertions, explicit theme overrides and remaining runtime boundaries.

Choose runtime dimensions by independent failure mode. Repeating a scenario
in another theme requires a named theme-sensitive defect or integration
boundary and a narrow reproducing case. Legitimate examples are theme
persistence/switching/first paint, theme-specific styling or contrast, and a
consumer stylesheet boundary not already covered centrally. Reconnection,
persistence or auth alone does not justify a theme multiplier. Before reducing
one, map every assertion to retained runtime or central coverage; preserve
unique behavior, security, responsive and native-browser proof.

## Deliberate waits

Follow [the wait classification and clock rules](test-waits.md): distinguish
actual awaited delays from failure caps and fixture holds, preserve negative
temporal guarantees, and measure native exceptions separately.

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

## The experiment tier

Tests that exercise only a measurement or eval harness live under
`experiments/`; everything else stays in `tests/` or a package's `tests/`. The
boundary, the reasons and the file- and assertion-level inventory are in
[the experiment-tier decision](../decisions/experiment-tier.md).

- **What belongs there.** A file whose every assertion is about a harness:
  spend and grant ledgers, relays and observers, freezes and review packets,
  prototype gates, scorers, measurement-script arithmetic and the offline
  launchers around them. A test that protects shipped behaviour, security, a
  contract, the native runtime, an offline boundary or release/CI tooling
  stays in product proof, whatever experiment it came from. Split a mixed file:
  move each product block verbatim into a product test and keep its assertions.
- **Discovery.** `bun run test` passes `./packages ./tests` to Bun as directory
  roots, so `experiments/` is excluded by construction from the default run,
  every `check:pr` mode and hosted unit shards. New files in either domain are
  discovered without a list.
- **Running it.** `bun run test:experiments` runs the complete tier offline
  through the same wrapper, preload and timeout as `bun run test`. It needs
  `python3`, `bwrap`, `unshare`, `setpriv` and `ip`, permitted namespaces and a
  built workspace (`bun run build`), and refuses to start without them. `bun run test experiments/<file>` runs one
  file while debugging.
- **The release gate.** Release preparation runs the tier after
  `bun run version` and before `bun run release` (the
  [release skill](../../.agents/skills/release/SKILL.md) has the sequence).
  Only a run with no failure, skip or todo that executed every inventoried file
  writes `tmp/experiment-tier-receipt.json`; `scripts/publish.ts` refuses to
  publish unless it names the current working-tree content, `bun.lock`,
  experiment inventory and Bun version. A failing experiment test is a failing
  release check, not a skip.

## Optional bubblewrap upgrade for local Linux proof

On hosts with large mount tables, bubblewrap 0.13 or newer avoids the older
per-mount read-only remount walk by using `mount_setattr()` on Linux 5.12+.
This is a local tooling recommendation, not a new product minimum or an
automatic installer. User/network namespaces must still be permitted.
The [0.13.1 release](https://github.com/containers/bubblewrap/releases/tag/v0.13.1)
publishes the archive checksum used below; the
[upstream build instructions](https://github.com/containers/bubblewrap/blob/v0.13.1/README.md#installation)
use Meson.

For Ubuntu 24.04, install the build prerequisites before entering offline proof:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential meson ninja-build pkg-config libcap-dev
```

Build a private, ordinary executable from the verified archive:

```sh
set -eu
bwrap_build=$(mktemp -d)
curl --fail --location --output "$bwrap_build/bubblewrap-0.13.1.tar.xz" \
  https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz
(cd "$bwrap_build" && printf '%s\n' \
  '0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d  bubblewrap-0.13.1.tar.xz' \
  | sha256sum --check -)
tar -xJf "$bwrap_build/bubblewrap-0.13.1.tar.xz" -C "$bwrap_build"
meson setup "$bwrap_build/build" "$bwrap_build/bubblewrap-0.13.1" \
  --prefix="$HOME/.local/opt/bubblewrap-0.13.1" \
  -Dman=disabled -Dbash_completion=disabled -Dzsh_completion=disabled
meson compile -C "$bwrap_build/build"
meson install -C "$bwrap_build/build"
PATH="$HOME/.local/opt/bubblewrap-0.13.1/bin:$PATH" bwrap --version
PATH="$HOME/.local/opt/bubblewrap-0.13.1/bin:$PATH" bun run check:pr --base origin/main
```

The archive checksum identifies upstream source; compiler and dependency choices
can change the resulting binary hash. Keep the selected binary/version and source
checkout beside native proof receipts. Do not make `bwrap` setuid: upstream
removed that installation mode in 0.12. The separate test-only identity broker
uses its own setuid helper; it does not require a setuid `bwrap`.

Upstream 0.12 also changed absolute-symlink resolution during setup. Qualify the
existing launcher, filesystem-filter, protected-path/symlink containment, egress,
identity and staged-output assertions with the chosen binary rather than assuming
an upgrade preserves them. Keep normal sandbox flags: `--not-a-security-boundary`
permits setup failures and does not belong in proof. A PATH change on the host
does not upgrade a fixed `/usr/bin/bwrap` inside a container; qualify that runtime
separately before changing its supplied binary. Hosted CI images stay unchanged.

## Required proof for a PR

The policy is [the CI decision](../decisions/ci-utility.md); the commands are
in the [CI and merge reference](../../.agents/skills/work-issue/references/ci-and-merge.md).

- Contract tests assert the `--json` envelopes. Automatic CI runs cheap
  metadata gates and complete affected hosted unit/integration/runtime,
  keyless funnel, pinned browser proof, strict types and packaging on explicit
  ready-candidate confirmation events. Agents keep focused local behavioral proof.
- Run `bun run check:pr --base origin/main` before opening or marking ready.
  For an upper stack layer, substitute its verified immediate parent ref;
  see [stack rules](github.md#stacked-pull-requests). Each included PR needs
  its own selected proof and actual base/head/checkout evidence.
  On Linux, every executing local preflight mode times three real sandbox
  setup probes and requires the fastest to take less than 1000 ms. Slow setup
  can consume the workers' fixed runtime deadlines. Refusal reports the fastest
  time, bubblewrap version, mount count and dominant mount-point parent prefix.
  A probe that reaches its 5 s budget refuses with an elapsed lower bound and
  the same host diagnostics; failed setup remains a separate prerequisite error.
  Use bubblewrap 0.13 or newer to avoid the older per-mount remount cost, or
  restart Docker Desktop (on WSL2, `wsl --shutdown`) to clear leaked bind mounts.
  Mount count alone does not decide whether setup is affordable. The guard
  never unmounts host paths or requires root. This local CLI prerequisite is
  separate from hosted category checks; container-backed proof uses its pinned
  runtime and does not acquire a host bubblewrap prerequisite. Linux focused checks now require
  `bwrap` and permitted user/network namespaces; `--plan` stays inspection only.
  Default preflight includes working-tree inputs and runs lint/leakage,
  environment documentation, pending changeset package validation, contribution
  changeset validation and affected fast invariants. Import-graph affected
  feedback is skipped by default under the maintainer's 2026-10-23 ruling
  ([#2707](https://github.com/schlessera/brain-kit/issues/2707)). Add
  `--import-graph` to run isolated local unit workers. Each worker runs the
  offline wrapper with `--changed=<merge-base-sha> --shard=i/N`; Bun applies
  changed selection before weighted sharding. The queue seeds Bun's timing
  format from `scripts/test-shard-costs.json`, converting seconds to
  milliseconds, rather than reconstructing the import graph.
  Refresh the reviewed table and its source receipt only with
  `bun scripts/refresh-unit-costs.ts <run-id> <attempt>` and qualified exhaustive
  hosted artifacts; [the refresh guide](ci-timings.md#refresh-reviewed-unit-weights)
  explains the attribution checks. Local completed-file times remain comparison
  evidence. The recorded full source must have one positive weight per file;
  files added afterward retain ordinary unseeded behavior until a later refresh.
  `--import-graph-workers=N` overrides the CPU/memory-derived local worker
  count. `--plan` lists the selected commands and arguments and
  explains when feedback is skipped and how to enable it. Bun includes
  committed, staged, unstaged and untracked changes; no affected test files
  prints its reason and succeeds with `--pass-with-no-tests`. Directory roots
  remain `./packages ./tests`, and the optional changed value uses `=`. This
  feedback misses spawned commands and inputs read from disk or named as
  strings; complete hosted discovery remains the required proof. Full/all
  modes retain their existing suites without this extra step. Every worker
  receives the same committed tree plus separately captured index, worktree
  and untracked inputs. Source changes during capture refuse the run; workers
  may not change their captured inputs. Each worker reports Bun's pre-shard
  selection count and its shard count. JUnit and timing paths must agree,
  shard counts must reconcile, and the union must match the selected count
  without duplicate files. Empty selections and empty shards retain explicit
  zero-file receipts. The CLI prints its private report destination outside
  the source tree; reports, build receipts, output logs and existing failure
  diagnostics survive worker removal. The queue requires Linux mount/user
  namespaces, the frozen install and real Chrome, like hosted unit workers.
  Changed-mode queues prepare one tree by default; `--private-tree` selects
  ordinary private builds for comparison. The default budgets four CPUs and
  two GiB per worker while reserving 30% RAM (eight on the measured host),
  with `--import-graph-workers=N` as the override. It builds one clean
  snapshot, then mounts an overlay view for each worker with a private upper/work directory
  and Git index. The lower tree is read-only. Each view still owns its write
  lease, nonce, output generation and maintenance ledger; explicit nested
  builds revoke its copied authority. A local Unix socket lets the live
  builder validate its descriptor and lease across user namespaces. The
  offline client verifies the kernel peer PID, receipt digest and owner
  lifetime. This mode additionally requires unprivileged overlayfs with
  `userxattr` and Python 3; it never shares writable builds or dependencies.
  Reports separate the common checkout/copy/build from each worker's setup
  and test time. The [measurement decision](../decisions/ci-utility.md#isolated-local-import-graph-feedback)
  records the sweep and the 900-second gate for default feedback.
  The [timing refresh](../decisions/ci-utility.md#reviewed-timing-refresh) covers
  1,180 hosted files. Its single wide replay stopped on a fixture failure after
  599.166 seconds, with incomplete reports; that is not a successful sub-900s
  qualification. The subsequent #2747 readiness repair's one wide preflight
  reconciles 626 files, including all 464 historical reference files, but fails
  two unrelated sandbox-note assertions after 1289.718 seconds. Its
  [receipt and qualification limits](../decisions/ci-utility.md#rollback-writer-readiness-and-the-subsequent-wide-recheck)
  preserve both failed observations. The subsequent runtime-cost profile's
  eight-worker attempt stops after 857.654 seconds on an unchanged
  parallel-session assertion and cancels three workers. Only 324 of 626
  selected files have completed reports; this is time to failure, not a
  successful sub-900s qualification. Its
  [measurements and partial coverage](../decisions/ci-utility.md#runtime-test-costs-and-the-incomplete-eight-worker-replay)
  retain all observed failures and mutation controls. Feedback remains opt-in.
  Agents retain targeted debugging, failing-first/restored mutation
  receipts and visual judgment; ordinary PRs do not duplicate complete types,
  packaging or browser/runtime suites locally.
- Ready-candidate confirmation supplies complete repeatable proof for affected workspaces and
  reverse dependencies plus root tests. Global/unknown changes expand to full
  discovery. Relevant pinned browser/accessibility/pointer, layout/offline/
  endurance, editorial, real Claude/Chrome and cleanup categories remain
  intact. The `proof` aggregate requires every selected job to succeed;
  missing tools, unavailable runtimes, failures, cancellations and unexpected
  skips are not green.
- Retain every test, default discovery, pinned offline image and failure
  artifact. Optional `check:pr --full` runs complete affected local proof;
  `--all` retains every local release/diagnostic category. The one exception
  to default discovery is [the experiment tier](#the-experiment-tier), which
  release preparation runs instead of PR proof. Scheduled
  exhaustive CI is additional coverage, not a replacement for selected
  pre-merge proof.
- Drafts run cheap gates. Ready `opened`, `reopened` and `ready_for_review`
  events request full affected confirmation. Ready `synchronize` runs affected
  fast invariants and types only; `proof` remains nonpassing until the author
  converts to draft and marks ready after the final push. A push invalidates
  the request. Main pushes retain full affected proof; scheduled/manual runs
  remain exhaustive and have a distinct aggregate name.
- Keep drafts cheap and batch intermediate pushes. After cheap gates, run
  independent proof categories concurrently. Preserve per-browser file bounds;
  measure queue/elapsed time and cancellation/repeated work before adding
  shards. Different PRs never share cancellation groups. Metadata edits do not
  launch heavy proof, and every main SHA retains independent evidence.
- Record actual tested head/base, selected jobs/attempts/checkout logs and
  focused local receipts. Confirmation metadata applies the existing identity
  guard before product-proof dispatch; draft and synchronize feedback retain
  their cadence. The final gate repeats validation, since admission does not
  freeze live refs. The guard validates the actual merge checkout's immutable head/base/tree
  and live PR readiness/head plus the independent live base ref. Any base advance
  requires a new confirmation request (a rebase is not inherently required). Relevant
  input/dependency/harness changes require fresh checks; never call an old
  receipt a new combined-tree pass. Under #1333, complete browser/layout
  domains may retain validated equivalent successful automatic receipts.
  Inclusion fingerprints recompute each immutable tree's complete supported
  import/declaration closure and tracked path/blob/mode, build/discovery/partition
  and runner identities. Unknown generated/runtime inputs execute fresh; a
  graph-structure hash or unchanged imported files alone cannot authorize reuse.
  Before naming a source run as passing proof, verify its workflow name/path,
  event, head, conclusion and complete job inventory. Repository synchronization
  jobs do not provide CI proof. Read the current retention ledger and aggregate;
  original run/job/checkout
  identity remains distinct. Other categories stay fresh. Verify actual squash
  parent/tree and automatic main-push proof. Respect branch rules. A writer can bypass checks when protection is absent;
  agents still require passing candidate proof and must re-read head/base before
  matching-head merge. This change does not alter repository protection.
- Endurance runs separately with `bun run test:endurance` and its own mandatory
  selected job. Ordinary layout shards exclude `.endurance.tsx`; their real-time
  cost cannot distort ordinary weights. Keep per-browser concurrency unchanged.
  `bun run test:inventory` emits discovered execution ownership and source
  navigation; see [the assertion/domain mapping](proof-domains.md). Dynamic test
  counts and passing assertions come from actual suite reports, not AST counts.

## Stable Docker proof inputs

Docker Desktop on WSL2 retains a host mount for each distinct bind source, even
when a container exits. Local proofs bind stable checkout directories and select
fresh run directories inside the container. The first use of a checkout can add
mounts; repeating a proof must not add sources solely because its run ID changed.
Restarting Docker Desktop or `wsl --shutdown` clears older leaked mounts.

| Caller | Stable host source | Run selection |
| --- | --- | --- |
| Native hosted admission | `tmp/native-host-proof/` | Container-only bind of the selected run to `/proof` |
| Worker identity | `tmp/worker-identity-proof/` | Same `/proof` projection, with read-only helper and variant projections inside the container |
| Editorial capture | `tmp/capture-share/` | A staging directory name selects outputs; verified files are copied to destination-local staging before atomic publication |
| Native diagram export | Private tar-filled named volumes and copied captured Bun bytes | Only source and filtered installation volumes are mounted read-only; output is copied out and owned containers/volumes are removed |
| Pinned workspace lease test | `tmp/workspace-lease-container/` | Container working directory selects the fresh fixture |

The stable source checkout, installed Bun binary, font cache and lease directory
retain their existing mounts. Browser, raster and audio callers already use stable source paths. Images, isolation flags and proof assertions remain the
same. Container-only projections create no new Docker host bind source. The private
diagram copy transport additionally requires host `tar` for its input archives. A new
checkout still introduces its own stable sources; this does not clear old mounts
or promise zero growth across distinct checkouts.

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

Environment setup via `scripts/ci-runtime-setup.sh` has its own 12-minute
step limit in `unit`, `runtime` and `runtime_host`. Proof retains a separate
30-minute unit allowance or 15-minute runtime allowance. The job caps are
45 and 30 minutes respectively, including three minutes for the remaining
steps. The [timeout basis](../decisions/ci-utility.md#separate-environment-setup-and-proof-budgets)
records the slow-mirror observations and margin. Each job always reports setup
and proof outcomes separately in its summary: setup failure/cancellation is an
infrastructure prerequisite failure with proof skipped, while proof failure
after successful setup belongs to the proof phase. Both leave the job and
selected aggregate nonpassing. Browser/layout do not call this setup script
and retain their existing pinned-container proof budgets.

Hosted unit partitions run up to two serial Bun test processes through
`scripts/unit-workers.ts`. Each owns its source checkout, copied frozen
install, build output and workspace lease. Full preparation now runs after
namespace entry inside the test wrapper, under one continuous build/test lease;
the two workers keep independent invocation identities and serial compilers.
A prepared worker may start tests while its sibling is still building. Account
for that scheduling change separately from duplicate hook builds. Runtime hooks
verify the live invocation and successful closure receipt before reuse; missing
authority rebuilds, and a failed preparation stops before tests without retry.
See [the invocation rule](../decisions/ci-utility.md#one-fresh-build-per-test-invocation).
The wrapper preserves the caller's
umask, drops setup capabilities and binds a private maintenance ledger without
changing within-worker child limits or hiding the host's `/tmp` from Docker.
Its checkout container lives outside host `/tmp`, which native workers replace
with private storage. Namespace setup is a real prerequisite, never a skipped
runtime. JUnit and timings must each match the complete discovered file set;
combined reports and per-worker diagnostics are uploaded. Local `bun run test`
and `check:pr` defaults keep their existing behavior. Use the internal unit
proof `--workers=1` diagnostic for a serial measurement, preserving the actual
source identity; performance qualification and remaining evidence live in
[#2121](https://github.com/schlessera/brain-kit/issues/2121).

Screenshot evidence includes kit, consumer and repository-root attachment
directories. Hygiene commands keep their local scratch captures and retain the
same bytes in separate `tmp/hygiene-proof/capture-*` directories for the layout
artifact. Browser artifacts also retain exactly the prepared native diagram
`release.svg/png/pdf`, `origin.svg/png/pdf` and `producer.json` files under each
preparation session and engine. This preserves the producer's checkout,
source, installation and runtime identity even if a later browser case fails.

The other consumer screenshot destinations have these explicit boundaries:

- Fixture-owned temporary `artifact-*.png` captures show the recovery UI before
  later zoom and keyboard assertions. Retain their exact returned bytes in
  `packages/ui-react/.vitest-attachments/artifact-recovery/capture-*`, preserving
  the original scratch captures and fixture teardown. Unique directories keep
  repeated names from replacing earlier evidence (`artifactRecoveryCapture`,
  `packages/ui-react/tests/fixtures/artifact-recovery-capture.ts:5-12`). The
  existing unit-worker attachment handoff and unit artifact upload collect
  these copies even after a later assertion fails and the fixture is removed.
- Opt-in external captures stay **local-only**: `BRAIN_ARTIFACT_SCREENSHOTS`
  directs additional artifact captures to a caller-chosen directory
  (`if (process.env.BRAIN_ARTIFACT_SCREENSHOTS)`,
  `packages/ui-react/tests/artifact-recovery-runtime.test.ts:333-333`), while
  `BRAIN_REVIEW_CAPTURES` does the same for association/signout review
  (`if (process.env.BRAIN_REVIEW_CAPTURES)`,
  `packages/ui-react/tests/association-signout-runtime.test.ts:219-219`;
  `if (process.env.BRAIN_REVIEW_CAPTURES)`,
  `packages/ui-react/tests/association-signout-runtime.test.ts:253-253`). Hosted
  proof sets neither variable. These are optional manual review exports;
  collectors do not search arbitrary external directories.
- Standalone navigation/software diagnostics stay **local-only**. The manual
  navigation probe writes `navigation-*.png` to its caller-supplied output or
  `/tmp/brain-navigation-recovery` (`const output`,
  `scripts/probes/navigation-recovery/harness.ts:22-22`;
  `await p.screenshot`, `scripts/probes/navigation-recovery/navigation.ts:124-130`).
  It is outside default test discovery and is not invoked by hosted proof.
  The selected software-identity tests still run normally; their
  `/tmp/brain-kit-software-*.png` exports occur only after every case assertion
  has passed (`expect(result.values)`, `tests/stats-answer-render.test.tsx:192-197`).
  Those successful-state review conveniences cannot diagnose an earlier failed
  assertion and are not automatic failure screenshots. Keep their local paths;
  do not collect broad `/tmp` contents as hosted failure evidence.

Verify retention from downloaded artifact ZIPs: compare the archive SHA-256 to
the Actions artifact digest, check ZIP CRCs and safe paths, then record each
PNG's nonzero dimensions, byte size and SHA-256. Match checkout receipts to
the actual job checkout; compare native exports with `producer.json` hashes.
Report generated captures separately from unchanged tracked references, and
name any still-missing automatic failure screenshots. Passing cases, local
files and upload patterns alone do not establish hosted retention.

Reading CI for a PR — the actual current head, the live base, checkout SHAs,
run/job/attempt IDs, retained #1333 receipts, refused-start jobs, and the
merge and post-merge checks — is the `work-issue` skill's
[CI and merge reference](../../.agents/skills/work-issue/references/ci-and-merge.md).


Shared browser proof discovery follows literal relative CSS imports and local
asset URLs. Plain relative `@source` directories own their recursively scanned
bytes and directory membership; scanned TypeScript is not executed or imported.
The common build consumes both stylesheet entries. Their exact package-import
ownership is recorded in `scripts/css-proof-inputs.json`: the installed
Tailwind stylesheet is backed by the dependency manifests and lockfile, with
`source(none)` disabling implicit scanning, and the kit token export names its
source. An edited or duplicate statement invalidates its declaration. Missing
inputs, symlinks, escaped paths, globs, remote URLs, dynamic sources and unknown
build directives remain unresolved and require fresh proof. This discovery
support does not itself establish a complete retainable browser domain.


Retention's bounded browser-command audit must preserve imported top-level
execution. Its tests import a real config in a Bun child and observe a transitive
module input even while the registered callback remains dormant. Activating a
command through a selected spec, inherited setup or configuration must force
fresh execution; registration alone is not invocation. Registered dormant
callbacks require the same complete call/escape audit, and a mutation of that
activation guard must fail the named assertion.
The exact audited configuration/source guard makes unsupported edits fresh.

## Cross-PR timing collection

The read-only [CI timing collector](ci-timings.md) archives job, step and optional
command observations independently of proof gates. Its reports distinguish
elapsed time, observed runner consumption, missing evidence and historical
full-proof estimates; timing archives never replace candidate proof.

## Focused native scratch-mask proof

The separately named scratch variant uses the existing identity/Btrfs fixture:

```sh
bun scripts/prove-worker-identity.ts --image="$NATIVE_PROOF_IMAGE" \
  --shared-git --private-git-inputs --native-phase-only \
  --application-qualification --scratch-mask --boot-prune-capture
```

It joins the captured real boot prune before opening its governed turns. The
fresh turn checks native agent identity and Git ignore, exact browser PNG
application, genuine nonignored refusal, pin retention and pruning, then
failed-query and unavailable-worker refusals without overwriting the applied
mask. The warm turn repeats both refusals against the second server boot.
The dedicated backend drives the real host bridge; it does not call an image
provider. The ordinary native SDK fixture remains unchanged.
All selected phase deadlines, final joins, diagnostics and owned cleanup remain
required. This partial composition does not replace complete PR proof.
