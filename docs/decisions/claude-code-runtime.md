# Decision — the Claude Code binary is the one the Agent SDK ships

Why the Claude backend should run the Claude Code binary that arrives inside
`@anthropic-ai/claude-agent-sdk`, pinned by the lockfile, instead of one the host
installs and updates on its own; why the server records which version ran; and
how the behaviours measured against one version get re-checked when it moves.
Decided by the spike in #183 on 2026-09-23. This is the design record, not a
status file — the work it implies is in the issues linked at the end.

## The problem

Several places in the tree carry behaviour measured against one runtime pair,
Claude Code 2.1.280 / `@anthropic-ai/claude-agent-sdk` 0.3.278, and the
permission design in #124, #141, #154, #162 and
[voice-permission.md](voice-permission.md) rests on those measurements. They
describe a live `query()` against an installed binary. The suites are keyless
and offline by rule (`keyless, deterministic`, `AGENTS.md:135-136`), so no test
re-measures them, and nothing in the tree knew which binary a deployment
actually runs. If the binary moved and a measured behaviour stopped holding,
nothing would notice.

## How the binary is located, invoked and updated today

Every line below was read on `origin/main` at `fe5a225` or shown by the command
next to it.

> **2026-09-30 — Implementation context (the problem and binary baseline).**
> The missing version record and mandatory host-binary override describe the
> [original server configuration](https://github.com/schlessera/brain-kit/blob/fe5a225a6f83b775d8180f3f6e9515ca5052e9bb/packages/ui-server/src/config/env.ts)
> and its problem frame, before this record's changes landed. The
> [runtime implementation](https://github.com/schlessera/brain-kit/commit/d33492e9d6680a7cb3c1e8a204aed7183431bc3d)
> added version observation; making the override optional followed in
> [#213](https://github.com/schlessera/brain-kit/commit/5f7dbb5f329634de46e2dfd7f5ff0a5659c1d8e6). The
> [current runtime probe](../../packages/ui-backend-claude/src/runtime-probe.ts)
> and [keyless re-check decision](#2026-09-23--the-re-check-runs-without-credentials-209)
> replace the claimed gaps. The runtime decision still binds. Later corrections
> already embedded in the bullets remain current; the baseline assertions and
> recorded package versions are historical evidence.

- **Located.** `CLAUDE_CODE_PATH` was declared with default
  `/usr/local/bin/claude` and resolved with
  `env.CLAUDE_CODE_PATH || "/usr/local/bin/claude"`. Since #213 it has no
  default (`name: "CLAUDE_CODE_PATH"`,
  `packages/ui-server/src/config/env.ts:411-416`) and is null when unset
  (`claudeCodePath`, `packages/ui-server/src/config/env.ts:932`). The whole `agent` block is copied into the backend's module
  config (`config: { ...agent }`,
  `packages/ui-server/src/agent/backend.ts:488`), read back as a string
  (`const claudeCodePath`, `packages/ui-backend-claude/src/module.ts:266-270`)
  and handed to the SDK (`backend.claudeCodePath`,
  `packages/ui-backend-claude/src/sdk-options.ts:178-179`). Because of the `||`
  default the value was never empty, so **the server always overrode the SDK's
  own binary**. The variable is withheld from every subprocess
  (`CLAUDE_CODE_PATH: NONE`,
  `packages/ui-sdk/src/server/subprocess-env.ts:123`), as
  [the container privilege record](https://github.com/schlessera/brain-hosting-template/blob/main/docs/decisions/container-privilege.md) (brain-hosting-template) assigns it.
- **Invoked.** The SDK spawns it. With an exec wrapper configured,
  `spawnClaudeCodeProcess` puts the wrapper in front
  (`Route the Claude Code subprocess`,
  `packages/ui-backend-claude/src/spawn-wrapper.ts:2-18`); without one the SDK
  spawns it directly.
- **Updated.** Nothing in the tree installs, updates, pins or reads the version
  of this binary. The only version probe in the server is for the `brain` CLI
  (`Probe the selected content CLI`,
  `packages/ui-server/src/brain/client.ts:109-161`, called at
  `probeBrainCliVersion(config.brainPath`, `packages/ui-server/src/app.ts:259`).
  `brain doctor` runs `claude mcp list` from `PATH` (`which("claude")`,
  `packages/core/src/cli/commands/doctor.ts:497-501`) — the user's own Claude
  Code on their own machine, to check the MCP registration, not the server's
  binary.
- **Two moving parts.** The SDK is a runtime dependency of
  `@schlessera/brain-backend-claude` at `^0.3.241`
  (`"@anthropic-ai/claude-agent-sdk"`,
  `packages/ui-backend-claude/package.json:48`), resolved by this repo's
  lockfile (`"@anthropic-ai/claude-agent-sdk": [`, `bun.lock:421`): 0.3.278 when
  this record was written, 0.3.280 from 0.37.0, 0.3.283 from 0.38.0.
  The binary at `CLAUDE_CODE_PATH` is whatever the host put there.

### What the SDK already ships

The part that decides this record, found by reading the installed SDK rather
than recalled:

- `pathToClaudeCodeExecutable` is documented as "Uses the built-in executable
  if not specified"
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1887-1889`).
- The built-in executable is a real Claude Code release, shipped as per-platform
  optional dependencies pinned to the SDK's exact version
  (`optionalDependencies`, `bun.lock:421`, eight
  `claude-agent-sdk-<os>-<arch>[-musl]@0.3.278` entries), each with an integrity
  hash in the lockfile (`"@anthropic-ai/claude-agent-sdk-linux-x64": [`,
  `bun.lock:431`). The SDK carries a manifest naming the release and a checksum
  per platform (`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`:
  `"version": "2.1.278"`, `linux-x64` checksum `5c47359…`).
- It is byte-identical to the standalone release. `sha256sum` of the SDK's
  `linux-x64/claude` and of a standalone native install of 2.1.278 both give
  `5c4735937844e84f8a93306e841a5b0e12252909b07870f789b190468da147ab`, the
  manifest's value.
- The two version series move in lockstep. On 2026-09-23 the registry listed
  the same patch numbers for both packages across 0.3.260–0.3.280 and
  2.1.260–2.1.280, with the same gaps (262, 264, 279), and each pair published
  minutes apart (`npm view @anthropic-ai/claude-agent-sdk time`,
  `npm view @anthropic-ai/claude-code time`: 0.3.278 at 01:49:39Z and 2.1.278
  at 01:48:59Z on 2026-09-19; 0.3.280 at 15:51:11Z and 2.1.280 at 15:44:39Z on
  2026-09-22).
- Every turn reports the version that ran. The SDK's `system`/`init` message
  carries `claude_code_version` (`sdk.d.ts:5590`). The Claude backend already
  receives that message and keeps only a status line from it
  (`msg.subtype === "init"`,
  `packages/ui-backend-claude/src/stream-adapter.ts:245-250`).

So the pair the measurements name — 2.1.280 with SDK 0.3.278 — is one the SDK
never ships together. It can only arise when the binary is chosen separately
from the SDK, which the server's default override makes the normal case.

### The live probe

Run on 2026-09-23 on a Linux x64 workstation, from a worktree of `fe5a225`
after `bun install`:

| Command | Reported |
| --- | --- |
| `claude --version` (standalone native install on `PATH`) | `2.1.280 (Claude Code)` |
| `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version` | `2.1.278 (Claude Code)` |
| `ls -l ~/.local/share/claude/versions` (the standalone install's own store) | four files, `2.1.270`, `2.1.271`, `2.1.278`, `2.1.280`, modified 2026-09-12, 09-15, 09-21 and 09-22; the `claude` on `PATH` links to `2.1.280` |
| a `query()` under Bun with no `pathToClaudeCodeExecutable`, an empty `HOME` and no credentials, stopped at the first `system`/`init` message | `claude_code_version: "2.1.278"` |
| the same `query()` with `pathToClaudeCodeExecutable` set to the standalone binary | `claude_code_version: "2.1.280"` |
| a `query()` with no `pathToClaudeCodeExecutable` whose `spawnClaudeCodeProcess` records what it is handed and throws a sentinel error | the sentinel reaches the caller; `command` is the absolute path of `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, `args` begin `--output-format stream-json --verbose` |
| `time claude --version` | 0.009 s |

The versions directory shows a host-installed binary that took four versions
in ten days on one workstation. It does not show who or what installed each
one, and it says nothing about how a deployment image installs its binary. The
two `query()` runs show the built-in binary resolves under Bun from this
workspace, and that `init` names the binary actually spawned, not a guess. Both
ran with no credentials and stopped at `init`, so neither made a model call.

## The decision

**Run the SDK's built-in binary. The lockfile is the pin; a version moves only
when the SDK version does, and it reaches a host only when the host rebuilds
from a new lockfile.**

1. `CLAUDE_CODE_PATH` unset means "the SDK's built-in binary". The
   `/usr/local/bin/claude` default goes. Setting it stays supported, as the
   override for a host that deliberately wants a different binary — and the
   version that host runs is then recorded as unmeasured (below).
2. The server knows the version (next section).
3. The measured pair lives in one constant, and a keyless test fails when the
   installed SDK is not the one it names (the section after).

This does not contradict [the container privilege record](https://github.com/schlessera/brain-hosting-template/blob/main/docs/decisions/container-privilege.md)
(brain-hosting-template). Its row for the CLI, `/opt/claude/bin/claude` in "1.
Directory ownership map", asks for a real, root-owned, non-writable file, not a
symlink into a home directory. The built-in binary lives under the
application's own install, which that record already requires to be
root-owned and non-writable at runtime (its `/opt/brain-ui` row). The
invariant holds; only the path changes, and the separate install step becomes
unnecessary.

### Why this one

- **One moving part instead of two.** The measured "pair" collapses to one
  number, because the SDK and its binary are the same release by construction.
  The question "which SDK talks to which CLI" stops being a deployment variable.
- **The version is checkable in this repo.** It is in this repo's lockfile, so
  a test here can read it. A host-installed binary can be pinned too, but the
  pin lives in the host's build file, where no test in this repo can see it or
  compare it with the SDK it has to agree with.
- **Reproducible and reversible.** The lockfile hash pins the bytes; npm versions
  are immutable — a name and version cannot be reused even after an unpublish
  ([npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)) — so
  rolling back is reverting the lockfile and rebuilding.
- **No new updater.** Nothing runs at boot or on a timer, and nothing needs
  network access at runtime.

### The alternatives, and why each lost

| Mechanism | Failure mode | Why it lost |
| --- | --- | --- |
| **Keep a host-installed binary, pinned** (`claude install <version>` in the image build, bumped by hand) | The pin and the SDK lockfile drift apart in either direction, and nothing checks that they agree. | The runner-up, and what the `CLAUDE_CODE_PATH` override still allows. Lost because it adds a second pin to coordinate, in a file this repo's tests cannot read. |
| **Rebuild on release, installing `latest`** | The version is whatever was newest at build time. Two builds of one commit can differ; a rollback cannot rebuild the old binary. | Not reproducible. |
| **Entrypoint updates before serving** (`claude update`) | Boot needs the network and fails or stalls when the download does; the version changes on a restart with no code change; a partial download at boot. | The executable prefix is immutable at runtime ("Immutable executable prefix" in the container privilege record, brain-hosting-template), so the entrypoint would have to write it; and a version that moves on restart is exactly the invisibility this spike is about. |
| **Sidecar or scheduled updater** | The binary changes under a running server, possibly between two turns of one conversation, with no deploy event to attach a re-check to. | Same immutability conflict, and the worst observability of the set. |
| **`npx`/`bunx` resolution at spawn** | Unless run with `--no-install` against a preinstalled package, a spawn can download (`bunx --help`: "automatically installing into a global shared cache if not installed"), and the resolved version can change between turns; the package cache is a writable place the spawned executable comes from. | Without `--no-install` it makes the registry a runtime dependency. With it, over a preinstalled Claude Code package, it is the pinned host install above plus a resolution step on every turn — still a second pin, and no longer the SDK's binary. |
| **Do nothing** | Today's state: whatever binary the host installs, pinned or not, and nothing in this repo knows which. | The problem this record exists to fix. |

### What this costs

- **Measured Claude Code upgrades arrive at brain-kit's cadence.** A CLI
  version that has been re-probed reaches a deployment when this repo bumps the
  SDK, releases, and the host rebuilds. The two series have published in
  lockstep so far (above), so the delay has been ours rather than upstream's;
  that is observed history, not a promise. A host that needs a fix sooner can
  take it without us — by moving the SDK inside the published range in its own
  lockfile, or by setting `CLAUDE_CODE_PATH` — and runs an unmeasured pair,
  with the warning, until we catch up.
- **Optional dependencies must be installed.** The SDK looks for its platform
  package relative to its own module: on Linux it tries the glibc package
  first and then the musl one, reversed when the runtime reports no glibc, and
  takes the first that exists. It does not fall back to the other if the one it
  found will not launch. When none is installed — `--omit=optional`, or an
  image that copied `node_modules` built for another platform — the query
  fails before spawning with "Native CLI binary for … not found. Reinstall
  @anthropic-ai/claude-agent-sdk without --omit=optional". When one is
  installed but cannot run — a musl binary with no musl loader — it fails with
  "exists but failed to launch". Both strings are in
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`. The boot probe below
  turns either into a refusal to start, for the same reason a missing backend
  refuses to boot (`A missing (or unrecognized) agent backend`,
  `packages/ui-server/src/app.ts:239-244`).
- **The published range is still a caret, and that bounds what this repo can
  guarantee.** `@schlessera/brain-backend-claude` depends on `^0.3.241`, and a
  host resolves it in its own lockfile. A host can bump the SDK — and so the
  binary — inside that range without any release of ours, and this repo's CI
  never sees it. What the host gets then is the per-turn record and the boot
  warning below, not a re-measurement. Committing the host lockfile makes the
  version reproducible; it does not make it measured. Whether the published
  package should pin the SDK exactly, which would close this, is out of scope
  for #183 and filed as its own question (#210).
- **Not measured: the CLI's self-updater under the SDK.** Whether a spawned CLI
  tries to update itself was not tested. It cannot change which file the SDK
  spawns — that is an absolute path under a root-owned install — and whatever it
  does, the per-turn version below records what ran.
- **Adopting it moves the version.** The built-in pair at the current lockfile
  is 2.1.278 / 0.3.278, which nobody has measured. The re-check below runs
  before the default changes, not after.

## The server knows the version

**Yes, the pair and not only the CLI, from two sources; and it warns rather
than refuses on a mismatch.**

- **Per turn, from `init`.** `claude_code_version` is recorded on the run the
  turn belongs to, beside the SDK version the backend loaded. The CLI version is
  the binary that actually ran and costs nothing to learn. The SDK version is
  needed too: a host can move the SDK while `CLAUDE_CODE_PATH` holds the CLI
  at the measured version, and then the CLI number alone looks right while the
  pair is one nobody measured.
- **At boot, from the binary a turn would spawn.** The same shape as the
  `brain` CLI probe (`Probe the selected content CLI`,
  `packages/ui-server/src/brain/client.ts:109`). The SDK's
  resolver is not exported, so the probe must not re-implement it. The SDK
  resolves the binary when a query is built, and fails there if none is found
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:228`); it then hands
  `{ command, args }` to `spawnClaudeCodeProcess` instead of spawning
  (`sdk.mjs:127`), the seam `spawn-wrapper.ts` already uses. A probe can
  supply a callback that records what it was handed and throws a sentinel
  error, so no process starts, and must tell that sentinel apart from a
  resolution error. For the native binary `command` is the binary itself. For
  a JavaScript `CLAUDE_CODE_PATH`, `command` is the interpreter and the script
  path leads `args`, so the probe keeps every argument up to the session
  arguments and replaces only those with `--version`. It then runs that through
  the same exec wrapper and environment a turn uses, so a binary the agent's
  uid cannot execute fails here and not on the first turn.
- **What boot does with the answer.** A missing binary, or one that will not
  run `--version`: **refuse to start**. A pair other than the measured one: one
  warning naming both pairs, and boot continues. A clean `--version` shows the
  binary launches, not that a session works; the first turn's `init` is the
  first proof of that.
- **Where it shows.** `/api/status`, which is behind the auth guard and already
  reports the source commit (`Operational status`,
  `packages/ui-server/src/routes/health.ts:50-66`), and the run record. Not
  `/api/health`: it is public and deliberately carries no version
  (`Public liveness probe`, `health.ts:11-13`). Not `brain doctor`: it runs on
  the user's machine against a different binary.

Why warn rather than refuse an unmeasured pair, given that what was measured is
a permission boundary:

- **A refusal would not buy what it appears to.** The measured version is not
  known-safe either: the list of mechanisms that skip `canUseTool` is what has
  been measured, not a closed set (`AT LEAST three`,
  `permission-hooks.ts:72-75`). A version gate would separate "probed" from "not
  probed", not "safe" from "unsafe", and it would say the second thing to
  whoever reads it.
- **It would block the path a CLI fix takes.** The built-in binary moves only
  when somebody changes a lockfile, which is deliberate. One reason to do that,
  or to set `CLAUDE_CODE_PATH`, ahead of a brain-kit release is a CLI security
  fix, and a refusal would stop exactly that deployment. A `CLAUDE_CODE_PATH`
  binary is different: the variable names a path, not a version, so the file
  behind it can be replaced or updated with nothing in the server's
  configuration changing. Warning rather than refusing accepts that too; the
  per-turn record is what shows it happened.
- **The control belongs where the version is chosen.** In this repo that is the
  guard test below, which does fail. For a published consumer it is the
  exact-pin question (#210). A boot gate is the wrong place to make up for
  either.

This is a judgement against `ROADMAP.md`'s "fail closed on exposure", and it is
recorded as one. That rule refuses a configuration known to be exposed; an
unmeasured runtime is unknown rather than known-exposed. If a probe ever finds a
version that re-opens a measured bypass, refusing that version is a refusal for
a known fact, which the rule does cover — and the issue to build it gets filed
then. Nothing needs refusing today.

Whether the run-record field reaches a documented `--json` or `/api/activity`
envelope is for the follow-up to settle, and if it does it is a `CONTRACT:`
change there.

## Re-checking a measured behaviour when the version moves

The measured pair moves into one exported constant in
`@schlessera/brain-backend-claude`. Every live site below cites the constant by
name instead of repeating the numbers. Two mechanisms hang off it:

- **A keyless guard test** fails when the SDK the backend actually imports is
  not the one the constant names. It locates that SDK by resolving the backend's
  own import, then reads `package.json` and `manifest.json` from the directory
  beside the resolved entry, by filesystem path. Neither is an exported package
  subpath (`node_modules/@anthropic-ai/claude-agent-sdk/package.json:6-29`): Bun
  lets `package.json` be imported anyway and Node does not, and `manifest.json`
  fails in both. A path hard-coded to the root `node_modules` could read a
  different copy from the one the backend loads. CI installs with
  `--frozen-lockfile` (`bun install --frozen-lockfile`,
  `.depot/workflows/ci.yml:88`), so bumping the SDK in this repo fails CI until
  somebody re-measures. It needs no key and no network, so it is allowed
  (`keyless, deterministic`, `AGENTS.md:135-136`). It is the only automatic check
  this has.
- **A committed probe**, run by hand with credentials, replays the measurements
  with real `query()` calls and writes the SDK version, the `init`-reported CLI
  version, the date and each result as JSON. It is not in CI, by the keyless
  rule. The PR that bumps the constant carries its output. The precedent for a
  committed, hand-run measurement is `scripts/measure-show-block-server.ts`.
  Until now these probes were run ad hoc and described in PR bodies (#141,
  #154).

A probe that can report success without observing anything is worse than none,
so it holds itself to these rules:

- **Every result needs its own control in the same harness, and the control
  depends on the property.** Every case first needs the model to have requested
  the tool under test and the hooks and callback it involves to have been seen
  firing or not firing as the case expects. Then:
  - *a bypass* (the tool runs without `canUseTool`): the control is the same
    call with the `ask` registered, where the callback must be consulted;
  - *an override* (the `ask`, or an in-process `deny`, stops it): the control
    is the same call without the overriding hook, where the tool must run;
  - *not a bypass* (`touch <path>`, `permissions.allow`,
    `defaultMode: "bypassPermissions"`): the observation is that the callback
    was consulted, and the control is an allowing callback, under which the
    tool must run.

  Anything else — no tool request, an auth or `init` failure, a hook that never
  fired — is **inconclusive**, and an inconclusive case fails the probe.
- **Both command shapes, as #154 learned.** The classifier case runs `echo hi`
  and `touch <path>` in the same harness; one probe command proves nothing
  about another.
- **Composition, not only parts.** The enforcement hook's `ask` must leave
  another hook's `updatedInput` intact (`An explicit "ask" beats all three`,
  `permission-hooks.ts:99-101`; `(e) a hook's`,
  `allowlist-enforcement.test.ts:17-20`). That is its own case: a rewrite, an
  `ask` and a `canUseTool` decision in one call, asserting the input the
  callback saw and the input that executed.

What the guard and the probe do not cover, stated so nobody reads more into
them:

- The guard reads metadata. It does not prove a platform binary is installed,
  launchable, or byte-for-byte the release the manifest names; the boot probe
  covers the first two.
- A host that sets `CLAUDE_CODE_PATH`, or resolves a different SDK in its own
  lockfile, passes this repo's guard whatever it runs. The per-turn record and
  the boot warning, both of which compare the pair, are what it gets.
- Nothing stops a constant being bumped without a fresh probe. The PR carrying
  the probe's output is a review rule, not a check.

### The sites

The issue named four. There are seven places whose truth depends on the
runtime on `fe5a225` — five naming the pair, one (D44) naming only the SDK, one
restating the behaviour with no version — plus historical anchors that are
deliberately left alone. D44's CLI version was not recorded, so it is unknown
until re-measured.

| Site | What it asserts | Re-checked by |
| --- | --- | --- |
| `DO NOT WEAKEN THIS INTO A FALLTHROUGH`, `packages/ui-backend-claude/src/permission-hooks.ts:71-102` | Three things admit a tool before `canUseTool` — the safe-command classifier (`echo hi` with an empty allowlist), a built-in tool's own check (`ToolSearch`), a project-settings `PreToolUse` hook returning `allow` — and an explicit `ask` beats all three. `permissions.allow` rules and `defaultMode: "bypassPermissions"` do not bypass. | Probe cases for each of the three, each with and without the `ask`, plus the two negative controls. |
| `Both hooks exist to rewrite`, `packages/ui-backend-claude/src/input-rewrite-hooks.ts:8-15` | A hook's `updatedInput` applies with no decision, and the permission path sees the rewritten input. | Probe case: rewrite with no decision; assert the executed input and the `canUseTool` input. |
| `The runtime precedence modelled by`, `packages/ui-backend-claude/tests/allowlist-enforcement.test.ts:10-19` | The precedence `runToolCall` models, (a)–(e). The test cannot re-measure it. | The cases above plus the composition case. A changed result changes the model in the test in the same PR. |
| `the one answer that beats`, `packages/ui-backend-claude/tests/no-grant-surface.test.ts:12-17` | The same three opinions, and that `ask` is what forces the decision. | Same probe cases. |
| `That third vector is stated here`, `docs/decisions/voice-permission.md:628-638` | An in-process `deny` beats a project-settings `allow`. | Probe case: settings `allow` against in-process `deny`, with the positive control of the settings hook alone running the tool. |
| `Three measured examples from the Claude SDK`, `docs/extending/agent-backends.md:250-263` | The same three mechanisms and the `ask`, restated for backend authors with no version attached. | Updated in the same PR as the constant whenever a probe result changes. |
| `createSdkMcpServer({ alwaysLoad: true })`, `docs/decisions/design-kit.md:2710-2733` (D44) | Two different kinds of claim. That `createSdkMcpServer({ alwaysLoad })` stamps `_meta["anthropic/alwaysLoad"]` is SDK behaviour, asserted keylessly by `"anthropic/alwaysLoad"`, `packages/ui-backend-claude/tests/sdk-options-mcp.test.ts:79` and `"anthropic/alwaysLoad"`, `tests/bridge-tools.test.ts:782,800`. That the CLI honours the stamp, and that first-frame latency did not move, is CLI behaviour. | The SDK half by the existing tests. The CLI half needs a live run of both arms — stamp set and unset — on the new pair, recording the pair from `init` and observing whether the bridge tools reached the model undeferred. `scripts/measure-show-block.ts` can run either arm (with and without `--always-load`; `ALWAYS_LOAD`, `scripts/measure-show-block.ts:304,369`), but it records no version and nothing in it compares the two arms or checks deferral, so it does not re-check this as it stands. Extending it is part of #209. `--tokens` prices schemas through the API and never runs the CLI, so it re-checks nothing here. |

> **2026-09-30 — Implementation context (D44's harness gap in the sites table).**
> The [old harness](https://github.com/schlessera/brain-kit/blob/af2affb2e939cc39446abeaccc704b617d9e6fd7/scripts/measure-show-block.ts#L304-L369)
> lacked runtime recording and an arm comparison. The
> [#209 implementation](https://github.com/schlessera/brain-kit/commit/e08a3ba172307f86bb0e9785414c84d99147ddc9)
> added both and a keyless CLI case. The
> [re-check decision below](#2026-09-23--the-re-check-runs-without-credentials-209)
> is the current guidance; the row and its opening unknown-version claim describe
> the pre-#209 harness. Live-model rate and latency measurements remain separate.

Historical anchors, **not** re-checked because they describe what was true when
a record was written, not what the code relies on now: `Claude Agent SDK 0.3.241 typings`,
`docs/decisions/agent-observability.md:128` (SDK 0.3.241 typings). The
container privilege record's own version anchors moved with it to
brain-hosting-template.

None of the live sites is accepted as unverifiable. What stays unverifiable is
the absence of a *fourth* mechanism — `AT LEAST three`,
`permission-hooks.ts:72-75` already says three is what has been measured, not a
closed set — and no probe can close that.

## Where the work goes

| Repository | What |
| --- | --- |
| brain-kit | #209: the measured-runtime constant, the guard test and the probe. #211: the per-turn version record and the boot probe. #213: `CLAUDE_CODE_PATH` unset runs the built-in binary, after both. #210: whether to pin the SDK exactly — a question, not yet a task. |
| brain-hosting-template | [brain-hosting-template#1](https://github.com/schlessera/brain-hosting-template/issues/1): the image installs no separate Claude Code, commits its lockfile, installs optional dependencies for the image's libc, and rebuilds when the lockfile moves. That rebuild is the update mechanism. |
| Each deployment | Applying the release, and removing any deployment-specific Claude Code install or `CLAUDE_CODE_PATH` setting. Tracked by the deployment; not restated here. |

## 2026-09-23 — Subscription billing and authentication

**Requirement (maintainer, 2026-09-23).** Claude turns run on **subscription**
billing, not API billing, and the subscription account has a reliable way to
log in and back in. This binds the decision above: a runtime that cannot meet
it is not an acceptable runtime, whatever else it does. The sections above did
not cover auth or billing. This one does, and it is added rather than edited
into them.

### How the subscription authenticates today

> **2026-09-30 — Implementation context (the credential/profile baseline).**
> The ambient-key pass-through, billing classification and API-key-first roster
> below describe the pre-#253 implementation. The original
> [profile environment](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/sdk-options.ts#L85),
> [billing classification](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/module.ts#L226-L234)
> and [model-discovery precedence](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/ui-backend-claude/src/model-discovery.ts#L86-L104)
> preserve that evidence. The
> [#253 implementation](https://github.com/schlessera/brain-kit/commit/af2affb2e939cc39446abeaccc704b617d9e6fd7)
> clears API credentials for credential-free subscription profiles and prefers
> the subscription token for discovery; declared API profiles remain explicit.
> [The subscription rules below](#what-binds) still bind. The later billing corrections
> in the original bullet are preserved, and the hosting table's counterpart
> correction is [brain-hosting-template#8](https://github.com/schlessera/brain-hosting-template/issues/8).

- **The credential is one environment variable.** `CLAUDE_CODE_OAUTH_TOKEN` is
  declared at `name: "CLAUDE_CODE_OAUTH_TOKEN"`, `packages/ui-backend-claude/src/config/env.ts:91-95` and admitted
  to every subprocess audience (`CLAUDE_CODE_OAUTH_TOKEN: ALL`, `packages/ui-sdk/src/server/subprocess-env.ts:58`).
  `ANTHROPIC_API_KEY` is admitted to the agent and brain-CLI audiences
  (`ANTHROPIC_API_KEY: AGENT_AND_BRAIN_CLI`, `subprocess-env.ts:59`). The container privilege record's
  environment table (brain-hosting-template) keeps both.
- **The default profile passes both through.** The built-in `claude` profile
  declares no credential (`DEFAULT_PROFILES`, `packages/ui-backend-claude/src/profiles.ts:138-140`).
  A turn's environment is the filtered agent environment plus the profile's
  additions (`export function turnEnv`, `packages/ui-backend-claude/src/sdk-options.ts:47-53`,
  `envSnapshot`, `packages/ui-backend-claude/src/config/env.ts:182-190`), handed to the SDK
  whole (`sdkOptions.env = childEnv`, `sdk-options.ts:204`). A declared bearer-token profile clears both
  ambient credentials (`input.authTokenEnv !== undefined`, `profiles.ts:115-121`); a declared API-key profile sets
  the key on purpose (`input.apiKeyEnv !== undefined`, `profiles.ts:122-124`).
- **Billing originally relied on ambient credential classification.** The
  server assumed API credentials won over OAuth. #253 made credential-free
  turns clear the API key and enforce subscription auth, so the backend
  stopped consulting that classification; #289 removed the server's unread
  `ambientBilling` config field. #293 removes the last environment fallback
  from non-session rollups and deletes its resolver. Missing/invalid recorded
  billing now stays unknown for every origin; server credentials and an
  observed runtime version cannot establish a child's billing. The recorded
  root-span attribute is the source of truth
  (`const attrBilling`, `packages/ui-server/src/activity/store.ts:526-527`);
  [cost-tracking.md](cost-tracking.md#recorded-billing-is-the-rollup-source-of-truth-293)
  records the 2026-09-30 ruling and frozen-history semantics.
- **Model discovery prefers the API key** and describes that as "mirroring the
  Agent SDK" (`name: "ANTHROPIC_API_KEY"`, `packages/ui-backend-claude/src/config/env.ts:83-87`,
  `function authHeaders`, `packages/ui-backend-claude/src/model-discovery.ts:86-104`). A 401 there
  becomes an empty roster, silently (`4xx is terminal`, `model-discovery.ts:147-148`).

### The precedence, measured

Run on 2026-09-23 against the SDK's bundled Claude Code 2.1.278 and a host
install of 2.1.280, with the same results on both. Each run was a `query()`
with an empty `HOME` and `CLAUDE_CONFIG_DIR`, bogus credentials of the right
shape, and `ANTHROPIC_BASE_URL` pointed at a loopback HTTP server that logs
request headers and answers 401. No request left the machine, so nothing was
billed. A second set of runs without the loopback server sent the same bogus
credentials to the real API. They got 401s and recorded the same
`apiKeySource`/`tokenSource` values, but a 401 cannot show which credential
was sent. The header column comes from the loopback runs only. Nothing in the
binary was found that picks the credential differently for a non-default base
URL. That is a static reading, not a wire observation against the real
endpoint.

| Credentials in the CLI's environment | `init.apiKeySource` | `accountInfo().tokenSource` | What `/v1/messages` carried |
| --- | --- | --- | --- |
| OAuth token only | `none` | `CLAUDE_CODE_OAUTH_TOKEN` | `Authorization: Bearer sk-ant-oat01-…` plus the OAuth beta header |
| API key only | `ANTHROPIC_API_KEY` | `none` | `x-api-key` |
| **Both** | **`ANTHROPIC_API_KEY`** | `CLAUDE_CODE_OAUTH_TOKEN` | **`x-api-key` only** |
| Neither | `none` | `none` | no request; the turn ends "Not logged in · Please run /login" |

**The API key silently wins.** With both present the OAuth token is not sent at
all, and nothing warns: `accountInfo()` still reports the OAuth token as the
token source. Only `apiKeySource` shows it. So an `ANTHROPIC_API_KEY` that
reaches the CLI for any reason moves every default-profile chat turn to API
billing. The tree gives it reasons to be set: the core CLI's `anthropic-haiku`
completion provider reads it (`"anthropic-haiku": "ANTHROPIC_API_KEY"`, `packages/core/src/cli/brain.ts:97`), and so does
model discovery. The cost record then says `api`, which is accurate
bookkeeping of the thing the requirement forbids. Chat is not the only path.
The core CLI's Claude runners, which `brain sync` uses under cron, spawn
`claude` with the inherited environment
(`Bun.spawn(args`, `packages/core/src/providers/agents/cli-runners.ts:37-43`; `Bun.spawn([...CLAUDE_BASE_ARGS`, `cli-runners.ts:66-72`), and that
environment admits the API key (`ANTHROPIC_API_KEY: AGENT_AND_BRAIN_CLI`, `subprocess-env.ts:59`).

> **2026-09-30 — Implementation context (the core runner paragraph above).**
> The [old Claude runners](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/providers/agents/cli-runners.ts#L37-L72)
> inherited the ambient key. [#253](https://github.com/schlessera/brain-kit/commit/af2affb2e939cc39446abeaccc704b617d9e6fd7)
> replaced that path with cleared API credentials and a handshake check before
> releasing the prompt, as the [current runners](../../packages/core/src/providers/agents/cli-runners.ts)
> show. The measured binary precedence above remains evidence for that policy,
> not a claim that current runners pass the key through.

The SDK's bundled binary honours `CLAUDE_CODE_OAUTH_TOKEN` exactly as the host
install does, in every row above. The runtime decision does not change how the
subscription authenticates.

### What the token is, and how it fails

- **Lifetime.** `claude setup-token` asks for an inference-only token
  (`scope=user:inference` in its authorize URL) with a lifetime of 31536000 s by
  default. The binary's OAuth module has `var vV=31536000`, and the login flow
  passes `expiresIn: N==="setup-token" ? W ?? vV : void 0`. The CLI says
  "valid for 1 year".
- **An invalid token.** Measured with a bogus token. An expired or revoked real
  token was not available to test, so treat that case as unmeasured; it is
  expected to take the same path, but that is an inference. What the bogus token
  produced: two `api_retry` messages with status 401 and `authentication_failed`,
  then an `assistant` message with `error: "authentication_failed"` and the text
  "Failed to authenticate. API Error: 401 OAuth access token is invalid.", then
  a `result` with **`subtype: "success"`** and `is_error: true`. The adapter
  branched on `subtype` alone, so an auth failure reached the client as a
  successful turn with no text. That was #191's failure, and an auth failure is
  one of its cases. Since #575 the adapter reads `is_error` on either subtype
  (`msg.subtype === "success" && !msg.is_error`,
  `packages/ui-backend-claude/src/stream-adapter.ts:205`) and ends the turn on a
  `failure` carrying the class, the status and this text.
- **`claude auth status` cannot detect it.** It reported `loggedIn: true`,
  `authMethod: "oauth_token"` for a bogus token, so it checks for presence, not
  validity.
- ~~**Logging in needed a TTY in the one run without one.** On 2.1.278 with stdin
  from `/dev/null`, `setup-token` printed nothing until it was killed at 20 s. Under a pseudo-terminal it
  prints an authorize URL and a "Paste code here if prompted" prompt. The
  redirect is a manual code page, so the browser can be on a different machine
  from the host.~~
- ~~**It can complete with nobody at the keyboard.** Under a pseudo-terminal on
  a workstation whose browser was already signed in, the flow opened that
  browser, completed, and printed a real 1-year token. That probe minted a live
  credential; it was reported for revocation, and nobody should repeat it.
  Probes of the login flow must run where no signed-in browser can be reached.~~

  **Corrected 2026-09-23.** Both bullets above got the flow wrong, and the
  second was false. There were two `setup-token` runs, both on 2.1.278, each
  with an empty temporary `HOME`:

  1. **Without a TTY** (stdin from `/dev/null`, killed at 20 s). It printed
     nothing to the terminal, but it was not inert. It opened the host's
     browser at the authorize page and started a local callback listener on
     an ephemeral port. The account holder approved in the browser. The
     browser was then redirected to `http://localhost:<port>/callback?code=…&state=…`,
     which did not load. The run had been killed at 20 s; which of that or the
     host's network set-up stopped the callback was not established. No token
     resulted.
  2. **Under a pseudo-terminal.** It opened the browser again and also printed
     the manual authorize URL with a "Paste code here if prompted" prompt. The
     account holder approved this one too; the flow completed and printed a
     real token. That token has been revoked.

  So the flow has two completion paths, and **both need the signed-in account
  holder to approve in a browser** — neither completes on its own. The
  automatic path redirects to the CLI's local callback listener, so it
  completes only while that process is running and only if the browser can
  reach it. Without port forwarding, a browser outside the host's network
  namespace (a WSL host browser, a container, a headless server) or on another
  machine cannot. The manual path — the
  printed URL, whose redirect goes to a code page, and the code pasted back
  into the CLI's prompt — works across machines, but it needs an interactive
  terminal to paste into. Probes of the login flow are credential-minting
  actions and are not run by agents.
- **Rotation is a restart.** The token lives in the environment, so replacing
  it means changing the host's secret and restarting. `claude auth login`
  (subscription by default, `--console` for API billing) stores refreshable
  credentials under `CLAUDE_CONFIG_DIR` instead. That path was not measured
  here.

### What binds

1. **An ambient credential never bills an API key.** A Claude profile that
   declares no credential must never send an API-authenticated inference
   request. With no usable subscription login the turn fails as an auth
   failure; it does not fall back to an API key. API billing happens only
   through a profile that declares `apiKeyEnv` or `authTokenEnv`. A host that
   today bills an ambient API key on purpose has to declare that profile.

   Clearing `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the CLI's
   environment is necessary, whether or not a subscription credential is
   present. It is not sufficient: the CLI also takes an API key from an
   `apiKeyHelper` in settings — the backend loads the brain repo's project
   settings (`settingSources: ["project"]`, `sdk-options.ts:135`) — and from a stored Console login, reported
   as `/login managed key` (`sdk.d.ts:5585`). So the turn has to check which
   credential the CLI selected **before the prompt is sent**, and end the turn
   if it is not a subscription. The check reads the account from the SDK's
   `initialize` handshake — `accountInfo()` or `initializationResult()`, whose
   `AccountInfo` carries `apiKeySource`, `tokenSource` and `subscriptionType`
   (`sdk.d.ts:23`). The `system`/`init` event is too late: the CLI builds it
   while processing the first user message. In streaming-input mode the prompt
   iterable yields only after the handshake check passes. That this holds on the
   production start and resume paths is for #253's test to show, not assumed
   here.

   The handshake is not enough on its own either. The binary reports an
   `apiKeyHelper` source only once the helper has produced a value; a helper
   that has not run yet leaves `apiKeySource` absent while the request path
   still switches to the helper's key. That was read from the binary's source,
   not reproduced on the wire. So an `apiKeyHelper` in effect is itself grounds
   to refuse: the backend neutralises it or ends the turn before releasing the
   prompt, rather than trusting an absent source.

   The same rule covers the core CLI's Claude runners. Legitimate non-inference
   users of an Anthropic key, such as the core CLI's `anthropic-haiku`
   completions, have to keep working under a separately named key. The
   provider can already read one
   (`const apiKeyEnv`, `packages/core/src/providers/completions/anthropic.ts:59`),
   but nothing public reaches that option: the `completions` config schema
   admits only `provider` and `fallback`
   (`completions: z`, `packages/core/src/lib/config.ts:166-171`), and the registry
   builds the provider with no options
   (`"anthropic-haiku": () => anthropicCompletions()`, `packages/core/src/lib/registry.ts:40`).
   A supported route to name that key is part of the work. Tracked in #253.

   > **2026-09-30 — Implementation context (rule 1's completion-config gap).**
   > The [old schema](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/lib/config.ts#L166-L171)
   > and [provider registry](https://github.com/schlessera/brain-kit/blob/bcb16c73e68ed95f5453e88c6f38ffcb9bb97dca/packages/core/src/lib/registry.ts#L40)
   > had no public key-name route. [#253](https://github.com/schlessera/brain-kit/commit/af2affb2e939cc39446abeaccc704b617d9e6fd7)
   > added `completions.apiKeyEnv` and `fallbackApiKeyEnv` and passes them through
   > the [current registry](../../packages/core/src/lib/registry.ts). That
   > implements rule 1; the missing-route claim is historical.

2. **The billing mode in effect is observed per turn, and checked against the
   profile's policy.** The run records `init.apiKeySource` and the
   `accountInfo()` fields (`tokenSource`, `subscriptionType`, `apiProvider`).
   These show which credential the CLI selected. They do not prove the server
   billed it that way, or that it authenticated. The derivation:
   - `apiKeySource: "none"` with `tokenSource: "CLAUDE_CODE_OAUTH_TOKEN"` (or
     its file-descriptor variant) is a subscription token.
   - `apiKeySource: "none"` with a `subscriptionType` of `Claude Pro`,
     `Claude Max`, `Claude Team` or `Claude Enterprise` is a stored subscription
     login. The binary omits `tokenSource` for that case, and its subscription
     label falls back to `Claude API` when the tier is unknown. Both were read
     from its account-info functions, not measured end to end, so any other
     label counts as unknown.
   - `ANTHROPIC_API_KEY`, `apiKeyHelper` or `/login managed key` is API.
   - `apiKeySource: "none"` with `tokenSource: "ANTHROPIC_AUTH_TOKEN"` is a
     bearer token, i.e. a declared `authTokenEnv` profile. It is API billing
     through a declared route, and the profile's policy allows it.
   - Anything else is **unknown**.

   On the handshake's `AccountInfo`, `apiKeySource` is omitted rather than
   `none` when no key has been produced. The derivation treats the two the same
   for observation, but not as authorisation (rule 1).
   `apiKeySource` alone is not enough, because it also reads `none` when nothing
   is logged in. The check that matters compares the observation with what the
   profile requires — subscription for a credential-free profile — not with
   `classifyBilling`, since both can regress together. A mismatch flags the run
   and logs a warning. Tracked in #211.
3. **An auth failure is its own outcome.** `authentication_failed` (and the
   other account classes the SDK names — `oauth_org_not_allowed`,
   `account_on_hold`, `billing_error`; `sdk.d.ts:3484`) ends a turn as a
   distinct error class carrying a re-login instruction, never as success and
   never as a generic error. The terminal-frame work is #191. The
   per-turn record is #211. A 401 from model discovery is logged as an auth
   failure rather than becoming an empty roster.
4. **A keyless test proves which credential is sent.** The loopback-server
   probe above needs no key and no network, so it can be a test. It spawns the
   real binary the lockfile installs and asserts the header, and it runs in CI
   (#253 for the rule, #213 for the binary switch).
5. **There is a login and re-login procedure that has been run on a headless
   host.** Which mechanism was a maintainer decision with three live options,
   filed as #254. The ruling (2026-09-23) is the off-host token: `setup-token`
   on a machine with a browser, the token in the host's secret store, a
   redeploy, and a yearly rotation. A server-driven login through Settings and
   `claude auth login` credentials in `CLAUDE_CONFIG_DIR` were not taken. The
   procedure is `docs/hosting/README.md`, "Claude subscription login". The
   server's part: the operator records the mint date
   (`BRAIN_UI_CLAUDE_TOKEN_MINTED_AT`), the server warns from 30 days before
   the measured one-year expiry, and `/api/status` shows when the token last
   worked. Every auth failure also becomes an instruction: `relogin` for a
   rejected token, `check_account` for an account the token cannot fix, and
   `check_config` for a turn the backend refused before sending it. A keyless
   test rehearses the rotation on a headless host.

The follow-up issues from the first half of this record gained acceptance
criteria so none of them can regress this: #209's probe covers the precedence
rows, #211 records the billing source, #213 proves the bundled binary sends
the OAuth token and not an API key, and brain-hosting-template#1 fixes the
environment contract and checks a built image's first turn reports
subscription.

## 2026-09-23 — The re-check runs without credentials (#209)

**Correction to "Re-checking a measured behaviour when the version moves".**
That section planned a probe "run by hand with credentials" and ruled it out of
CI under the keyless rule. The probe as built needs neither. Every behaviour
it measures is the CLI's own permission precedence — which hook, rule or
callback admits a tool call the model asked for — and none of it depends on
what a real model would choose to ask. So `scripts/measure-claude-runtime.ts`
runs the real CLI the lockfile installs against a scripted Messages API on
loopback, which plays one planned tool call per turn, with bogus
credentials. Nothing leaves the machine.

What that changes and what it does not:

- **The sites table stands, with one row resolved.** Each live site cites
  `MEASURED_RUNTIME` (`@schlessera/brain-backend-claude`). Every row has a case
  in the probe, including the composition case and the credential-precedence
  rows from the section above. D44's CLI half is now a keyless case
  (`d44-always-load-reaches-the-model`). Its latency and rate halves still
  need a live model, through `scripts/measure-show-block.ts --both-arms`,
  which now records the runtime per turn. The table's description of that
  harness is the state before #209.
- **The measured pair moved.** The probe passed on Claude Code 2.1.278 /
  `@anthropic-ai/claude-agent-sdk` 0.3.278, the pair the lockfile ships. The
  earlier measurements named 2.1.280 / 0.3.278, a pair the SDK never ships
  together.
- **What a scripted model cannot show.** Model choice, latency and call rates.
  It also cannot show any behaviour the CLI gates on a first-party base URL.
  Tool search is one — the probe turns it on explicitly for its cases — and the
  auto-mode classifier's headers are another. None of the measured cases uses
  auto mode.
- **CI runs it (#284).** The `claude-runtime-probe` job in
  `.depot/workflows/ci.yml` (mirrored in `.github/workflows/ci.yml`) runs the probe on every PR and on `main`, inside
  a network namespace that holds nothing but loopback: nothing but loopback is
  reachable, so every case passing there shows the probe needs no network. It
  does not audit connection attempts, so a background request that fails
  quietly would not fail a case. A failed or inconclusive case fails
  the job, and the job prints the JSON report.

## 2026-09-30 — CI returns to GitHub Actions (#618)

The `claude-runtime-probe` job now runs only from
`.github/workflows/ci.yml`. The Depot workflow was removed when CI returned to
GitHub Actions so agents can inspect failed checks through GitHub's log
surfaces. This supersedes the workflow location above; the keyless probe and
its network namespace remain the same. The migration findings and verification
are recorded in #618.

## 2026-10-04 — CI moves to Depot with CLI observability (#983)

The maintainer requested Depot CI again, with `depot` instructions for agents
to monitor runs and inspect failures. The current CI workflow is migrated from
the latest main, including its newer runtime and packaging gates, rather than
restoring the historical Depot copy. `.depot/workflows/ci.yml` becomes the
authoritative workflow for the unchanged keyless runtime probe. AGENTS.md
documents status, diagnosis, attempt logs and artifact downloads. Project sync
retains GitHub Actions because Depot CI does not support issue events and Depot
Actions runners cannot serve a personal-account repository. This supersedes
the provider choice in #618; it does not alter the probe or its isolation.

## 2026-10-05 — Fork pull requests fall back to GitHub Actions (#988)

Depot CI does not run pull request workflows triggered from forks; its
compatibility page lists that support as planned. The maintainer chose
(2026-10-04) to run the complete CI and contract gates for fork PRs on GitHub
Actions, from the contributor's own PR. Depot keeps same-repository PRs and
pushes to main, and project sync keeps its separate exception above.

- **One definition.** `.depot/workflows/` stays the only place a gate is
  written. `scripts/fork-ci-adapters.ts` generates
  `.github/workflows/fork-ci.yml` and `fork-contract.yml` from it, keeping its
  comments and layout. The adaptations are enumerated in that script's header
  and nowhere else: a `pull_request` trigger only, fork-only job routes,
  `fork / <job>` check names, GitHub-hosted runner labels and
  `persist-credentials: false` on every checkout. A source shape without a
  rule (another trigger, runner, job permission or a `secrets.` reference)
  refuses generation. `tests/fork-ci-adapters.test.ts` parses both files and
  requires every job, step, command, matrix, container, environment, timeout
  and artifact to match once those adaptations are undone. `bun run lint`
  fails on a stale adapter.
- **Routing.** Each Depot job runs only for a push, a local `api` run or a PR
  whose head repository is this one (`DEPOT_ROUTE`). Each adapter job runs only
  for a PR from another repository (`FORK_ROUTE`). The test evaluates both
  routes against fork, same-repository, deleted-fork, push and `api` events
  and requires exactly one provider per job, so Depot stays off fork PRs even
  once it starts receiving them. On a same-repository PR the adapter's jobs
  are skipped. Their `fork / ` names cannot satisfy a requirement written for
  Depot's `CI / <job>` checks.
- **Fork context.** The adapters run under ordinary `pull_request` with
  `contents: read`, on GitHub-hosted runners, with no secret, write token or
  persisted checkout credential, and never through `pull_request_target` or
  `workflow_run`. Artifacts are diagnostics for a human, never input to a
  privileged follow-up. The contract gate still checks the PR's head against
  its base, and reads the title and labels only from environment values. The
  test runs the emitted contract step with a hostile title and labels.
- **Approval.** GitHub may hold a first-time contributor's run until a
  maintainer approves it. A held run has not passed.

Retiring the fallback needs verified native Depot fork behaviour and a new
entry here. A provider roadmap claim alone does not change the routing.

## 2026-09-30 — What a sync ran is observed per run, not probed (#290)

"The server knows the version" left open whether the per-run record reaches a
documented `--json` envelope. For chat it is the root span; for `brain sync`
it now is both. Chat's version never said what a sync ran: the core CLI
resolves its own `claude` (`claudeCommand`), and a host can hold two
installations.

- **Observed from the session that ran.** The core Claude runner reads the
  Claude Code session's `system`/`init` event and passes `claude_code_version`
  to the runner's `onRuntime` callback the moment it arrives
  (`if (!sawInit`, `packages/core/src/providers/agents/cli-runners.ts:188-195`).
  A run that fails after `init` has already reported it. A refused run never
  reaches `init` and reports nothing. The other built-in runners do not
  report, and neither does anything else: no boot probe, no lockfile, no
  ambient binary fills a gap.
- **Unknown stays unknown.** `brain sync --json` says `runtime: null` when the
  agent reported nothing and `version: null` when it named itself without one
  (see [deterministic-sync.md](deterministic-sync.md), "Bare `brain sync
  --json` prints one result").
- **Recorded on the run it belongs to, in chat's representation.** Both
  scheduling paths write `brain.runtime.name`/`version` on the sync run's own
  root span, plus `brain.sync.agent` (`not-invoked`, `invoked`, or `unknown`
  for a result that could not be read), from that run's result only
  (`syncActivityAttrs`, `packages/ui-server/src/brain/sync-result.ts:99-116`).
  A run that invoked no agent, or whose agent reported no version, writes no
  version, so it cannot appear to carry an older run's.
- **Status shows the latest run apart from the last observation.**
  `/api/status` reads the activity store, because the cron wrapper is another
  process (`readSyncRuntime`,
  `packages/ui-server/src/activity/sync-runtime.ts:83-123`).
  `runtime.sync.latest` is the latest sync run and only what it recorded.
  `runtime.sync.lastObserved` is the last run that recorded a version, with its
  run id and times and whether it is the latest run. Chat's
  `runtime.lastObserved` stays beside it, and the two may differ.

Billing is not inferred from any of this: a runtime name or an absent agent
says nothing about what a sync cost. That policy is #293's.

## 2026-09-30 — Keep the range; compose package and host requirements (#210)

The maintainer's 2026-09-28 ruling retains the SDK range. This supersedes the
unresolved exact-pin question in "What this costs", "The server knows the
version" and "Where the work goes" above. A host can require stricter SDK or
runtime minimums, but cannot weaken a package requirement or escape its upper
bound. The host need not have a semantic version: dependencies still point
host → public packages → dependencies/runtimes.

[runtime-requirements.md](runtime-requirements.md) specifies the declarations,
composition, actual loaded/executed identities, overrides, unknown versions,
diagnostics and evidence for initial requirements. Compatibility and measured
pair status remain separate. The lockfile/rebuild update model, immutable
executables, permission checks, keyless measurement guard and per-turn
provenance remain binding. This specification changes no runtime behavior.

## 2026-09-30 — Boot probes and app initialization are asynchronous (#286)

The maintainer chose asynchronous startup over a shipped supervisor executable
or a synchronous compatibility path. A synchronous subprocess wait prevented
calling the configured group killer at its five-second deadline when a wrapper
dropped uid. The brain CLI probe also waited on a TERM-ignoring command and
could accept the version it printed before timing out.

`createApp` now returns a promise and awaits required backend probes and the
brain CLI check before opening SQLite or starting application services.
`BackendModule.probeRuntime` and both built-in probes return promises too.
External consumers await the factory before wiring a server and handle
startup refusals as promise rejections; descriptors migrate directly to an
asynchronous implementation. Configuration validation order, injected-registry
behavior, subscription checks and version compatibility policy remain intact.

The shared version-command lifecycle has a five-second deadline and a separate
250 ms cleanup budget. Deadline cancellation invokes `killWrapped` with
`SIGKILL` while the child is running, including the configured group helper.
For these calls only, helper execution has a 200 ms limit and falls back to
the ordinary signal route on failure or expiration. Existing turn cancellation
uses its original unbounded helper handling. Readers and timers are cancelled,
and abandoned subprocesses are unreferenced, so inherited pipes or an
unsignalable command cannot keep probe settlement or host exit waiting.
Unconfirmed cleanup is reported explicitly; neither a successful signal nor
a helper exit code proves every descendant stopped.

Real local subprocess tests show cancellation reaches the correct group while
the child is alive, preserve timeout despite a printed version, and exercise
missing, failing, hung and ineffective helpers plus inherited output pipes.
A standalone host exits after giving up on an ineffective killer. Startup
integration tests observe the pending probe before any database exists and
serve a real health request only after successful startup. Tests allow a
1.5-second scheduling margin beyond the five-second deadline; production
cleanup adds at most 250 ms, subject to event-loop scheduling.

### Candidate 2.1.287 comparison (2026-10-03)

The [bounded compatibility measurement](claude-2.1.287-compatibility.md)
reproduces three raw-probe failures on SDK 0.3.287 / CLI 2.1.287, traces the
changed omitted-mode semantics, and records passing production enforcement
controls on both the retained and candidate pair. It leaves measured constants,
declared requirements and permission policy unchanged. A selected explicit-mode
control is diagnostic evidence, not permission to skip the full upgrade probe.

## 2026-10-05 — Mid-turn follow-ups ride the turn's open input (#1003)

The Claude backend used to declare `followUp: false`, on the belief that the
Agent SDK had no mid-turn injection, so the host queued every message sent
during a turn as the next turn. Measured keylessly on SDK 0.3.283 / CLI 2.1.283
(the real bundled CLI against a scripted loopback Messages API), that belief
was wrong:

- With `query()` fed a stream that stays open, a user message written while a
  tool call is still running is not delivered at once and does not interrupt
  the call. The CLI holds it and sends it in the next main-loop request,
  beside that tool's successful result, inside the same turn. It says so to
  the model in a system message ("The user sent a new message while you were
  working"). `priority: "next"` and no priority behave the same. `now` was not
  used, because its name says it interrupts.
- A message written after the model's last step, while the final answer is
  being generated, is not folded in. The CLI ends the turn on its `result` and
  then runs the message as a continuation turn of the same process: a second
  `system/init`, then a second `result`. This happens even when the input is
  closed after the first result, because the CLI drains what it has already
  read before it exits.
- A message stamped with a `uuid` is reported back in `command_lifecycle`
  frames: `queued` when the CLI reads it, `started` when a turn takes it in,
  and `completed` when that turn ends, before the turn's `result`.
- `total_cost_usd` and `modelUsage` on a later result are cumulative over the
  process. `num_turns` and `duration_ms` count that run only.

So the backend now keeps every turn's input open until the turn's last result
(`createTurnInput`, `packages/ui-backend-claude/src/turn-input.ts`) and declares
`followUp: true`. A `result` that arrives while a follow-up is pushed but not
`started` is held. The terminal frame is built from the last result, with the
earlier runs' turns and duration added. If no continuation comes, the held
result is emitted when the stream ends. A follow-up the CLI has not
acknowledged at a result also closes the input. That covers a runtime that
never reports lifecycle frames, which would otherwise wait for input forever.

This changes neither the measured runtime nor the SDK requirement nor the
enforcement policy. The behaviour is re-checked on every CI run, not by the
hand-run probe: `packages/ui-backend-claude/tests/follow-up-delivery.test.ts`
drives the production backend through the real CLI and asserts what the CLI
sent the model, with a control whose CLI never receives the follow-up. A
version bump that moves any of the behaviours above fails that test.
