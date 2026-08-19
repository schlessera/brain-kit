# Plan — Enforcement gates

Turn a set of architecture findings into deterministic mechanisms that make the
same drift impossible, and land the fixes those mechanisms require.

Status: in progress on branch `enforcement-gates`. Workstream status is tracked
in [Workstreams](#workstreams); every item carries its own state.

This plan exists because the findings below are not bugs — they are the residue
of decisions that were correct when made and were never re-checked. Fixing them
without a gate means re-deriving the same list in six months. The repo already
runs this pattern (`tests/release-manifest.test.ts`: "these encode release
pitfalls that have actually bitten, each of which was documented in prose first
and then walked into anyway"). The work here extends that pattern to the places
it was never applied.

## Findings

Numbered as they were surfaced in the architecture review. Kept verbatim so
later commits can reference a stable id.

- **F1 — `ui-server` backend asymmetry.** `@schlessera/brain-backend-claude` is
  a hard dependency (`agent/backend.ts:9`) while `-pi` is an optional peer
  behind a lazy `require` (`:430`). Every install pulls the Anthropic Agent SDK
  even with `AGENT_BACKEND=pi`.
- **F2 — `ui-server` configured by ambient env.** 31 distinct `process.env`
  reads across 59 sites against 5 `CreateAppOptions` fields. Three are frozen at
  module scope (`CLAUDE_CODE_PATH`, `VOICE_KEYTERM_LIMIT`, `BRAIN_PATH`) and
  cannot be varied per instance or per test, though the factory's own header
  names "another embedder" as a supported consumer.
- **F3 — direct `brain.db` reads across the package boundary.** Three
  `new Database(` sites in `ui-server`; only `graph/reader.ts` gates on
  `schema_version` (`MIN_SCHEMA_VERSION = 8`). The voice keyterm reader has no
  gate. core owns that schema and versions independently.
- **F4 — core exposes one export (`.`)** with 136 lines of re-exports spanning
  config, db, search, indexer, ingestion, taxonomy, providers and modules. No
  way to mark one subsystem experimental separately. Judgment call, not a
  defect.
- **F5 — the module contract drops its own generic.** `CommandContext.config`
  and `HygieneContext.config` are `unknown` even though `ModuleManifest<C>`
  already validated the block to `C`. Every module author writes the cast.
- **F6 — `process.env.GOOGLE_API_KEY` delete/restore across an `await import()`**
  in the Gemini embeddings and completions providers. Process-global mutation
  spanning a yield point.
- **F7 — doc drift.** ROADMAP says "Ten packages" and omits `module-images` and
  `render-template` from its table (12 ship). `docs/integration-contract.md:15`
  cites `server/src/brain/client.ts`, a pre-extraction path.
  `docs/extending/` documents 4 of the 7 seams ROADMAP claims.
- **F8 — lockstep `fixed` versioning.** A `ui-react` patch republishes the CLI.
  Deliberate ("one versioned contract"). Noise, not a defect. No action.

Found while surveying the existing gates, and folded into F7/RC1: the CI `pack`
job hardcodes a 10-package list in YAML that omits `module-images` and
`render-template`, so two published packages get no pack check and no
consumer-import smoke test. `tests/release-manifest.test.ts` guards
`scripts/publish.ts` and `scripts/build.ts` against exactly this and cannot see
into YAML.

## Root causes

Each gate below exists to close a root cause, not a finding. A finding fixed
without its root cause closed will come back under a different name.

- **RC1 — hand-maintained enumerations of the workspace, in places no test
  reads.** Sources of truth today: the `packages/*` glob, `scripts/publish.ts`,
  `scripts/build.ts`, `.changeset/config.json`, `.github/workflows/ci.yml`,
  `README.md`, `ROADMAP.md`. Three are guarded. Explains F7 and the pack gap.
- **RC2 — no mechanical statement of which internal dependency edges are
  allowed, or of what kind.** Nothing distinguishes a hard dep from an optional
  peer; `backend-claude` became a hard dep by being written first. Explains F1.
- **RC3 — ambient `process.env` is unbounded, undeclared and unlocated.** The
  only list of `ui-server`'s configuration lives in the *consumer* repo
  (`brain-ui`'s `.env.example` and CLAUDE.md). A published library whose config
  contract is documented only downstream drifts by construction. Explains F2 and
  the write half of F6.
- **RC4 — a schema read across a package boundary with no shared artifact
  binding the two sides.** core can change `brain.db` and nothing in either repo
  fails. Explains F3.
- **RC5 — no test exercises the module contract from a module author's seat.**
  `config: unknown` typechecks perfectly; the cost lands on a third party, and
  no first-party module feels it because they all cast too. Explains F5.
- **RC6 — the public API surface has no artifact, so surface changes are
  invisible in review.** 136 lines of re-exports grew one reasonable PR at a
  time. Explains F4.

## Gates

- **G1 — every enumeration is derived or asserted.** Extend
  `tests/release-manifest.test.ts` to parse the CI YAML package loop and the
  README/ROADMAP package tables, comparing each against the `packages/*` glob,
  using the same approach as the existing `scriptPackageList()`. Also fail on a
  prose package count that disagrees with the glob. Closes RC1.
- **G2 — internal dependency-edge table.** A test declaring, per package, which
  internal packages may appear in `dependencies` and which must be optional
  `peerDependencies`. Any edge outside the table fails. Companion check: every
  `@schlessera/*` specifier appearing in a package's `src/` (static import,
  dynamic import or `require`) is declared, and everything declared is imported.
  Closes RC2.
- **G3 — `process.env` chokepoint lint** (`scripts/check-env-access.ts`, joined
  to `bun run lint`). Three rules over `src/`:
  1. `process.env` may appear only in the package's `src/config/env.ts`.
  2. No top-level `const … = process.env…` anywhere, including that file.
  3. No writes at all — `process.env.X =` and `delete process.env.X` are banned.
  Rule 3 alone closes F6 permanently. Closes the enforceable half of RC3.
- **G4 — env parity test.** The chokepoint exports a typed descriptor of every
  variable it reads, and the package README's env table is GENERATED from it
  (`bun run env-docs`, checked by `tests/env-parity.test.ts`). Generating rather
  than diffing two hand-written lists is the stronger form: drift becomes
  impossible instead of merely detectable. The gate also asserts that every
  literal `process.env.X` inside the chokepoint itself is declared, so the one
  file allowed to read the environment cannot read something it does not
  document, and that every chokepoint package re-exports `ENV_VARS` from its
  package entry. That last rule came from the consumer side: the `brain-ui`
  shell had to read `process.env.BRAIN_UI_REVERSE_GEOCODE` raw because
  `ui-backend-claude`'s resolver was not exported, which moves the ambient read
  out of the library and straight into its consumer — RC3 one level out. Closes
  the documentation half of RC3.
- **G5 — one `openBrainDb()` wrapper, lint-enforced.** Ban raw `new Database(`
  in `ui-server/src` outside `src/db/`; route every reader through a wrapper
  that asserts `schema_version`. Makes the gate impossible to forget on the next
  reader.
- **G6 — cross-package schema integration test.** Run core's indexer over
  `packages/core/fixtures/corpus/`, then run every `ui-server` reader against
  the resulting database. Fails on the actual shape rather than on a number
  someone remembered to bump. Closes RC4, and retires the ROADMAP's open
  "integration tests need a populated brain" item.
- **G7 — module-author compile test.** A fixture module with a real
  `configSchema`, asserting `ctx.config` is the parsed type in both a command
  and a hygiene check. Fails to compile before F5's fix. Paired with a lint
  banning `as` casts in `packages/module-*/src` so first-party modules cannot
  paper over a regression. Closes RC5.
- **G9 — documentation path guard.** Over repo-level docs (`README`, `ROADMAP`,
  `AGENTS`, `CONTRIBUTING`, `SECURITY`, `docs/**`): relative links resolve, code
  spans naming a repo path resolve, no span cites the pre-extraction
  `server/src/…` layout, and a span written as a directory is one. Added during
  the pass, not in the original gate list: F7's stale path survived because a
  path in a table is not a link and nothing ever resolved it. Scope is narrow by
  design — package-relative and content-repo paths are addressed to a reader,
  and a gate that cries wolf gets deleted.
- **G10 — a changeset is required when shipped package files change.** A
  pull-request CI job (`scripts/check-changeset.ts`): what counts as shipped is
  read from each package's own `files` field, so `skills/`, `migrations/`,
  `templates/` and `docs/` count the moment a manifest says they ship, and the
  rule follows a package that starts shipping something new. It requires an
  ADDED changeset — editing one already on the base branch is someone else's
  work — and exempts `changeset version` release pull requests explicitly. Tests, fixtures and docs are ignored. Added
  during the pass for the same reason as G9 — CONTRIBUTING.md has asked for this
  since the repo opened, the commit that made `ui-server`'s exports breaking
  shipped without one, and a review caught it rather than the build.
- **G8 — API surface snapshot.** Each package's exported names are written to a
  checked-in report and diffed by a test, so every surface addition is visible
  in review. Does not fix F4; closes RC6.

## Decisions

- **D1 — gates and the fixes they gate ship together.** A gates-only pass leaves
  CI red (G2 fails on the F1 asymmetry, G7 fails to compile, G4 has no
  chokepoint to read) or the gates toothless.
- **D2 — both agent backends become optional peers.** `backend-claude` moves out
  of `ui-server`'s hard dependencies behind the same lazy require `-pi` already
  uses. This is consumer-facing: `brain-ui` gains an explicit
  `@schlessera/brain-backend-claude` dependency in the same pass so the
  deployment shell keeps working.
- **D3 — F2 goes to full injection.** Not just a chokepoint: a resolved config
  object threads through `createApp()` and its consumers, so two instances can
  coexist and tests can vary configuration without module-registry surgery. Env
  remains the default source, resolved once at the edge.
- **D4 — G6 is in scope now.** It is the only mechanism that catches a schema
  shape change that keeps its version number, and the `BRAIN_PATH` override it
  needs has already landed.

## Conventions this plan establishes

Written down here because three workstreams depend on agreeing:

- Every package that reads configuration from the environment does so in
  exactly one file: `src/config/env.ts`. It exports a typed descriptor of the
  variables it reads (name, meaning, default, whether required) and a resolver
  that returns a plain config object. Nothing else in the package touches
  `process.env`.
- A package's env documentation lives next to the package and is the artifact
  G4 diffs against. The consumer repo's `.env.example` is downstream of it, not
  the source.
- CLI entry points are not exempt from the chokepoint. A CLI reads its env in
  `src/config/env.ts` like everything else and passes the result inward.
- New guards are `bun test` files under `tests/` (repo-level) or the package's
  own `tests/` (package-level). New lints are `scripts/check-*.ts` joined to
  `bun run lint`.

## Workstreams

Ownership matters here: `ui-server` is touched by F1, F2, G5 and G6 at once, so
its source has a single owner for the duration.

| id | Scope | Owns | State |
| --- | --- | --- | --- |
| W1 | G1, G2, G3, G8 + CI yml package list | `tests/`, `scripts/`, `.github/` | done (f19f878) |
| W2 | F1, F2 (full injection), G5 | `packages/ui-server/src/` | done (73834da); review fixes in flight |
| W3 | F6, core env chokepoint (+ 5 more packages) | `packages/core/src/providers/`, `packages/core/src/config/` | done |
| W4 | F5, G7 | `packages/core/src/lib/module-*.ts`, `packages/module-*/` | done |
| W5 | G6 | `packages/ui-server/tests/integration/` | done |
| W6 | F7 docs, G4 env docs, G9 | `README.md`, `ROADMAP.md`, `docs/` | done |
| W7 | D2 consumer change | `brain-ui` repo | in progress |

## Adversarial review

The guards were reviewed by an independent model (gpt-5.6-sol, high effort)
against commit d809656, with the review prompt pointed at one question: how
could someone satisfy each guard while the thing it guards is broken. Three
findings, all real:

- **R1 — the env-parity read check had a hole where its own subject lives.**
  It scanned for `process.env.X`, but every resolver takes the environment as a
  parameter and reads `env.X`, so a variable added to the chokepoint and left
  out of the descriptor passed. Fixed with an AST detector covering direct,
  bracket, typed-parameter, defaulted-parameter and aliased reads, proven
  against `tests/fixtures/env-reads.fixture.ts` rather than assumed.
- **R2 — `check-module-casts.ts` matched raw lines**, so a cast inside a comment
  or a string failed the lint while a cast split across two lines by a formatter
  passed. Sent back to be rewritten on TypeScript assertion nodes, the way
  `check-env-access.ts` already works.
- **R3 — no changeset** for a release that changes exported module-author types
  and every package's environment handling. Written at the end of the pass.

A second review pass covered W2's `ui-server` refactor (commit `73834da`) with
auth equivalence as its first priority. It found **no** auth or injection
defect — it probed the `AUTH_MODE=none` loopback refusal, the WebAuthn handle
validation, CSWSH and trust-proxy handling, resolver-boundary coercion, and
two-instance isolation. Four other findings, all verified against the code:

- **R4 — the optional Claude peer is still mandatory at type-check time.**
  `BackendRegistry` is publicly exported and its `getModelSource()` references a
  type imported from `@schlessera/brain-backend-claude`, so the emitted `.d.ts`
  keeps that import and a pi-only TypeScript deployment must install the package
  anyway. Runtime is fine; half of F1's purpose is not.
- **R5 — a missing backend package now surfaces on first use, not at boot.**
  The registry is lazy, so `createApp()` succeeds and `/api/health` reports
  healthy while every agent turn is guaranteed to fail. Before the change the
  static import failed at boot. `require.resolve` is synchronous, so the
  boot-time guarantee costs nothing.
- **R6 — `app.config.dbPath` misreports** when `options.dbPath` overrides it.
- **R3 — no changeset**, which produced G10.

The first two of the earlier round are the useful kind of finding: a gate that is noisy is a gate
that gets deleted, and a gate with a hole where its own subject lives is worse
than no gate, because it reads as coverage.

## Progress log

Newest last.

- Branch `enforcement-gates` cut from `main` at 1934332 (0.13.1, clean tree).
- Plan written; findings, root causes, gates and decisions recorded above.
- W1-W4 started in parallel with disjoint file ownership. W1 owns repo-root
  `tests/`, `scripts/` and CI; W2 owns `packages/ui-server/src/`; W3 owns core
  providers/CLI plus the remaining package env chokepoints; W4 owns the module
  contract files. Docs (W6) wait on W1's parser so the two agree on format.
- W1 landed as f19f878: G1, G2, G3, G8, the lint aggregator, and the CI pack
  list now covering all twelve packages. Four assertions expected-red at its
  handoff (two on F1 pending W2, two on the ROADMAP pending W6).
- W6 part one: ROADMAP's "Ten packages" and its table now match the glob, so
  G1 is fully green. Three stale doc paths fixed —
  `docs/integration-contract.md` cited the pre-extraction brain-ui layout and
  `docs/extending/README.md` cited `shared/protocol.ts`, a workspace deleted in
  phase 4. G9 added to keep them fixed.
- `ui-backend-pi` had one unowned `process.env` read; folded into W3's scope.
- W3 landed: F6 removed (evidence — @google/genai 2.17.1 calls
  `getApiKeyFromEnv()` unconditionally from the constructor, so no option
  suppresses the dual-key warning and the hack spanned the `await import()` for
  nothing; the warning is now simply accepted), plus env chokepoints for core,
  module-images, module-jobs, ui-backend-claude, ui-render-puppeteer and
  ui-backend-pi. 521 pass / 24 skip / 0 fail over those six.
- W4 landed: `C` threaded through `HygieneContext`/`CommandContext`/
  `CommandModule`/`ModuleContribution`/`ResolvedManifest`/`LoadedModule`, with a
  `HygieneCheck<C>` method-syntax type so a typed contribution stays assignable
  to the erased one. G7 compiles today and failed with TS2315/TS7006/TS2345
  against the pre-change types. Three first-party modules dropped their re-parse;
  `module-jobs` also lost a silent `?? {criteria: …}` default the generic made
  unreachable.
- G4 built as a GENERATOR (`scripts/env-docs.ts`, `bun run env-docs`) rather than
  a second hand-written list. Every package README now carries a generated env
  table; `ui-server`'s 31-variable contract is documented in this repo for the
  first time, having previously existed only in the consumer's `.env.example`.
  W2's richer `required: false | string` (the CONDITION that makes a variable
  required) was adopted as the shared contract over W3's boolean.
- Non-ui-server work committed as d809656 so the review had a stable snapshot
  while W2 kept editing.
- R1 fixed and proven on a fixture; R2 delegated back to W4; R3 pending the end
  of the pass.
- W2 landed as 73834da: 32 env variables behind one chokepoint, `createApp()`
  returning a handle, `configureDb`/`configureWsHost` dissolved rather than
  half-migrated, `ws/handler.ts`'s module-global client set moved onto the host,
  both backends optional peers, and every `brain.db` read gated. 1421 pass /
  0 fail across the repo, tsc and lint clean, env docs in sync.
- Second review pass: no auth defect; R4/R5/R6 sent back to W2; R3 closed by
  writing the changeset and adding G10 so the next omission fails the build.
- W7 landed in the `brain-ui` shell (uncommitted there): explicit
  `@schlessera/brain-backend-claude` dependency, `createApp` handle wiring, and
  a shutdown path that only waits for the flush when a turn was actually
  cancelled. Typechecks clean against the local package via a temporary symlink;
  red against the published 0.13.x until this release ships, which is expected.
- Chokepoint reachability added to G4 and currently red for the six packages
  W3 is exporting from.
- W5 landed G6 as `packages/ui-server/tests/integration/brain-db-schema-contract.test.ts`:
  core's real `indexAll()` over the fixture corpus once in `beforeAll`, then
  every ui-server reader asserted on real content — 11 tests, 345ms. Graph
  precompute needed no separate step, and the test asserts `graphNodes > 10` so
  a future opt-out cannot hollow it out. Teeth proven against BOTH drift
  classes: a downgraded `schema_version` (10 of 11 fail, including the keyterm
  reader's silent degradation) and a renamed column with the version left
  untouched (6 of 11 fail) — the second is exactly what a version constant
  cannot see, and is the reason G6 was worth building rather than trusting
  `MIN_BRAIN_SCHEMA_VERSION`.
- Bookkeeping: W5's test file was swept into commit ce5044d by an `-A` stage
  while it sat in the tree, so that commit's message does not mention G6. The
  content is correct and the branch is unpushed; the record is here instead of
  in a history rewrite while other work is in flight.

## Third review round

Run over the whole delta since `73834da`, again asking how each new gate could
be satisfied while the rule behind it is broken. Five findings:

- **R7 — the optional-peer type leak was closed in `dist` but not in `src`.**
  `agent/backend.ts` still carried `import type` and `typeof import(...)`
  references to the Claude package, and the declaration-surface test inspected
  only the emitted `.d.ts`, so it was green while the source graph still
  required the package. Scope matters and was checked: the `brain-ui` shell sets
  no `customConditions`, so the shipped consumer resolves `types` → `dist` and
  is unaffected; the exposure is a consumer that sets the `bun` condition, as
  this repo's own tsconfig does. Fixing one of two resolution paths and calling
  the requirement removed is exactly the kind of half-measure a gate is supposed
  to prevent.
- **R8 — `dbPath: ""` regressed.** The effective-config fold used a truthiness
  check, and SQLite treats an empty string as a valid anonymous temporary
  database. The coercion bug the injection refactor was otherwise free of.
- **R9 — the changeset gate missed everything shipped outside `src/`.**
- **R10 — the changeset gate counted any changeset in the diff**, so a pull
  request could pass on one already sitting on the base branch.
- **R11 — the changeset named two packages** while eight had shipped files
  change.

R9 through R11 are the sharpest lesson of the pass: G10 was written to enforce a
rule that had been walked into, and was itself walkable within the hour. A gate
gets the same adversarial reading as the code it guards, or it is just a
comment that runs.
