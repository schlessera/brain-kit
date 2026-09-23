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
and offline by rule (`AGENTS.md:82-83`), so no test re-measures them, and
nothing in the tree knew which binary a deployment actually runs. If the binary
moved and a measured behaviour stopped holding, nothing would notice.

## How the binary is located, invoked and updated today

Every line below was read on `origin/main` at `fe5a225` or shown by the command
next to it.

- **Located.** `CLAUDE_CODE_PATH` is declared with default
  `/usr/local/bin/claude` (`packages/ui-server/src/config/env.ts:336-339`) and
  resolved with `env.CLAUDE_CODE_PATH || "/usr/local/bin/claude"`
  (`env.ts:753`). The whole `agent` block is copied into the backend's module
  config (`packages/ui-server/src/agent/backend.ts:369`), read back as a string
  (`packages/ui-backend-claude/src/module.ts:216-219`) and handed to the SDK
  (`packages/ui-backend-claude/src/sdk-options.ts:121-122`). Because of the
  `||` default the value is never empty, so **the server always overrides the
  SDK's own binary**. The variable is withheld from every subprocess
  (`packages/ui-sdk/src/server/subprocess-env.ts:122`).
- **Invoked.** The SDK spawns it. With an exec wrapper configured,
  `spawnClaudeCodeProcess` puts the wrapper in front
  (`packages/ui-backend-claude/src/spawn-wrapper.ts:1-18`); without one the SDK
  spawns it directly.
- **Updated.** Nothing in the tree installs, updates, pins or reads the version
  of this binary. The only version probe in the server is for the `brain` CLI
  (`packages/ui-server/src/brain/client.ts:115-180`, called at
  `packages/ui-server/src/app.ts:186`). `brain doctor` runs `claude mcp list`
  from `PATH` (`packages/core/src/cli/commands/doctor.ts:274-276`) — the user's
  own Claude Code on their own machine, to check the MCP registration, not the
  server's binary.
- **Two moving parts.** The SDK is a runtime dependency of
  `@schlessera/brain-backend-claude` at `^0.3.241`
  (`packages/ui-backend-claude/package.json:43`), resolved to 0.3.278 by this
  repo's lockfile (`bun.lock:346`). The binary at `CLAUDE_CODE_PATH` is whatever
  the host put there.

### What the SDK already ships

The part that decides this record, found by reading the installed SDK rather
than recalled:

- `pathToClaudeCodeExecutable` is documented as "Uses the built-in executable
  if not specified"
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1887-1889`).
- The built-in executable is a real Claude Code release, shipped as
  per-platform optional dependencies pinned to the SDK's exact version
  (`bun.lock:346`, eight `claude-agent-sdk-<os>-<arch>[-musl]@0.3.278`
  entries), each with an integrity hash in the lockfile (`bun.lock:356`). The
  SDK carries a manifest naming the release and a checksum per platform
  (`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`:
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
  (`packages/ui-backend-claude/src/stream-adapter.ts:202-207`).

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

This does not contradict [container-privilege.md](container-privilege.md). Its
row for the CLI (`container-privilege.md:73`) asks for a real, root-owned,
non-writable file, not a symlink into a home directory. The built-in binary
lives under the application's own install, which that record already requires
to be root-owned and non-writable at runtime (`container-privilege.md:78`). The
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
  are immutable, so rolling back is reverting the lockfile and rebuilding.
- **No new updater.** Nothing runs at boot or on a timer, and nothing needs
  network access at runtime.

### The alternatives, and why each lost

| Mechanism | Failure mode | Why it lost |
| --- | --- | --- |
| **Keep a host-installed binary, pinned** (`claude install <version>` in the image build, bumped by hand) | The pin and the SDK lockfile drift apart in either direction, and nothing checks that they agree. | The runner-up, and what the `CLAUDE_CODE_PATH` override still allows. Lost because it adds a second pin to coordinate, in a file this repo's tests cannot read. |
| **Rebuild on release, installing `latest`** | The version is whatever was newest at build time. Two builds of one commit can differ; a rollback cannot rebuild the old binary. | Not reproducible. |
| **Entrypoint updates before serving** (`claude update`) | Boot needs the network and fails or stalls when the download does; the version changes on a restart with no code change; a partial download at boot. | The executable prefix is immutable at runtime (`container-privilege.md:70`), so the entrypoint would have to write it; and a version that moves on restart is exactly the invisibility this spike is about. |
| **Sidecar or scheduled updater** | The binary changes under a running server, possibly between two turns of one conversation, with no deploy event to attach a re-check to. | Same immutability conflict, and the worst observability of the set. |
| **`npx`/`bunx` resolution at spawn** | Unless run with `--no-install` against a preinstalled package, a spawn can download, and the resolved version can change between turns; the package cache is a writable place the spawned executable comes from. | Without `--no-install` it makes the registry a runtime dependency. With it, over a preinstalled Claude Code package, it is the pinned host install above plus a resolution step on every turn — still a second pin, and no longer the SDK's binary. |
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
  refuses to boot (`packages/ui-server/src/app.ts:176-181`).
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
  `brain` CLI probe (`packages/ui-server/src/brain/client.ts:115`). The SDK's
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
  reports the source commit (`packages/ui-server/src/routes/health.ts:43-58`),
  and the run record. Not `/api/health`: it is public and deliberately carries
  no version (`health.ts:8-10`). Not `brain doctor`: it runs on the user's
  machine against a different binary.

Why warn rather than refuse an unmeasured pair, given that what was measured is
a permission boundary:

- **A refusal would not buy what it appears to.** The measured version is not
  known-safe either: the list of mechanisms that skip `canUseTool` is what has
  been measured, not a closed set (`permission-hooks.ts:72-74`). A version gate
  would separate "probed" from "not probed", not "safe" from "unsafe", and it
  would say the second thing to whoever reads it.
- **It would block the path a CLI fix takes.** Under this decision the version
  moves only when somebody changes a lockfile or sets `CLAUDE_CODE_PATH` — both
  deliberate. One reason to do either ahead of a brain-kit release is a CLI
  security fix, and a refusal would stop exactly that deployment.
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
  not the one the constant names. It locates that SDK by resolving the
  backend's own import, then reads `package.json` and `manifest.json` from the
  directory beside the resolved entry. It cannot import them: the SDK's
  `exports` map names neither file
  (`node_modules/@anthropic-ai/claude-agent-sdk/package.json:6-29`), and a path
  hard-coded to the root `node_modules` could read a different copy from the one
  the backend loads. CI installs with `--frozen-lockfile`
  (`.github/workflows/ci.yml:52`), so bumping the SDK in this repo fails CI until
  somebody re-measures. It needs no key and no network, so it is allowed
  (`AGENTS.md:82-83`). It is the only automatic check this has.
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
  another hook's `updatedInput` intact (`permission-hooks.ts:97-99`,
  `allowlist-enforcement.test.ts:16-19`). That is its own case: a rewrite, an
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
runtime pair on `fe5a225` — six naming it, one restating it without a number —
plus historical anchors that are deliberately left alone.

| Site | What it asserts | Re-checked by |
| --- | --- | --- |
| `packages/ui-backend-claude/src/permission-hooks.ts:70-101` | Three things admit a tool before `canUseTool` — the safe-command classifier (`echo hi` with an empty allowlist), a built-in tool's own check (`ToolSearch`), a project-settings `PreToolUse` hook returning `allow` — and an explicit `ask` beats all three. `permissions.allow` rules and `defaultMode: "bypassPermissions"` do not bypass. | Probe cases for each of the three, each with and without the `ask`, plus the two negative controls. |
| `packages/ui-backend-claude/src/input-rewrite-hooks.ts:7-14` | A hook's `updatedInput` applies with no decision, and the permission path sees the rewritten input. | Probe case: rewrite with no decision; assert the executed input and the `canUseTool` input. |
| `packages/ui-backend-claude/tests/allowlist-enforcement.test.ts:10-19` | The precedence `runToolCall` models, (a)–(e). The test cannot re-measure it. | The cases above plus the composition case. A changed result changes the model in the test in the same PR. |
| `packages/ui-backend-claude/tests/no-grant-surface.test.ts:12-17` | The same three opinions, and that `ask` is what forces the decision. | Same probe cases. |
| `docs/decisions/voice-permission.md:584-594` | An in-process `deny` beats a project-settings `allow`. | Probe case: settings `allow` against in-process `deny`, with the positive control of the settings hook alone running the tool. |
| `docs/extending/agent-backends.md:164-179` | The same three mechanisms and the `ask`, restated for backend authors with no version attached. | Updated in the same PR as the constant whenever a probe result changes. |
| `docs/decisions/design-kit.md:2576-2600` (D44) | Two different kinds of claim. That `createSdkMcpServer({ alwaysLoad })` stamps `_meta["anthropic/alwaysLoad"]` is SDK behaviour, asserted keylessly by `packages/ui-backend-claude/tests/sdk-options-mcp.test.ts:74` and `tests/bridge-tools.test.ts:707,725`. That the CLI honours the stamp, and that first-frame latency did not move, is CLI behaviour. | The SDK half by the existing tests. The CLI half needs a live run of both arms — stamp set and unset — on the new pair, recording the pair from `init` and observing whether the bridge tools reached the model undeferred. `scripts/measure-show-block.ts` can run either arm (with and without `--always-load`, `scripts/measure-show-block.ts:304,369`), but it records no version and nothing in it compares the two arms or checks deferral, so it does not re-check this as it stands. Extending it is part of #209. `--tokens` prices schemas through the API and never runs the CLI, so it re-checks nothing here. |

Historical anchors, **not** re-checked because they describe what was true when
a record was written, not what the code relies on now:
`docs/decisions/container-privilege.md:12-14` (investigated against SDK 0.3.265),
`container-privilege.md:984` (a question about CLI 2.1.236),
`docs/decisions/agent-observability.md:118` (SDK 0.3.241 typings), and
`.agents/notes/skills-catalog-audit.md:86` (an inventory listing CLI 2.1.233).

None of the live sites is accepted as unverifiable. What stays unverifiable is
the absence of a *fourth* mechanism — `permission-hooks.ts:72-74` already says
three is what has been measured, not a closed set — and no probe can close
that.

## Where the work goes

| Repository | What |
| --- | --- |
| brain-kit | #209: the measured-runtime constant, the guard test and the probe. #211: the per-turn version record and the boot probe. #213: `CLAUDE_CODE_PATH` unset runs the built-in binary, after both. #210: whether to pin the SDK exactly — a question, not yet a task. |
| brain-hosting-template | [brain-hosting-template#1](https://github.com/schlessera/brain-hosting-template/issues/1): the image installs no separate Claude Code, commits its lockfile, installs optional dependencies for the image's libc, and rebuilds when the lockfile moves. That rebuild is the update mechanism. |
| The private deployment repo | Applying the release there, and removing any deployment-specific Claude Code install or `CLAUDE_CODE_PATH` setting. Tracked there; not restated here. |
