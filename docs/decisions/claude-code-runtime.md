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
never ships together. It exists only because the server overrode the SDK's
binary with a separately installed one.

### The live probe

Run on 2026-09-23 on a Linux x64 workstation, from a worktree of `fe5a225`
after `bun install`:

| Command | Reported |
| --- | --- |
| `claude --version` (standalone native install on `PATH`) | `2.1.280 (Claude Code)` |
| `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version` | `2.1.278 (Claude Code)` |
| `ls ~/.local/share/claude/versions` (the standalone install's own store) | `2.1.270` (2026-09-12), `2.1.271` (09-15), `2.1.278` (09-21), `2.1.280` (09-22) |
| a `query()` under Bun with no `pathToClaudeCodeExecutable`, an empty `HOME` and no credentials, stopped at the first `system`/`init` message | `claude_code_version: "2.1.278"` |
| the same `query()` with `pathToClaudeCodeExecutable` set to the standalone binary | `claude_code_version: "2.1.280"` |
| `time claude --version` | 0.009 s |

The versions directory is what "the binary floats on the host" looks like: a
self-updating install moved four times in ten days with nobody deciding to. The
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
- **The version is knowable before deploy.** It is in the lockfile, so a test in
  this repo can read it. Under every host-installed option the version is known
  only on the host, after the fact.
- **Reproducible and reversible.** The lockfile hash pins the bytes; npm versions
  are immutable, so rolling back is reverting the lockfile and rebuilding.
- **No new updater.** Nothing runs at boot or on a timer, and nothing needs
  network access at runtime.

### The alternatives, and why each lost

| Mechanism | Failure mode | Why it lost |
| --- | --- | --- |
| **Keep a host-installed binary, pinned** (`claude install <version>` in the image build, bumped by hand) | The pin and the SDK lockfile drift apart in either direction; this repo cannot see a version that lives in another repo's build file. | The runner-up, and what the `CLAUDE_CODE_PATH` override still allows. Lost because it keeps two version numbers that must agree and gives this repo no way to notice when they do not. |
| **Rebuild on release, installing `latest`** | The version is whatever was newest at build time. Two builds of one commit can differ; a rollback cannot rebuild the old binary. | Not reproducible. |
| **Entrypoint updates before serving** (`claude update`) | Boot needs the network and fails or stalls when the download does; the version changes on a restart with no code change; a partial download at boot. | The executable prefix is immutable at runtime (`container-privilege.md:70`), so the entrypoint would have to write it; and a version that moves on restart is exactly the invisibility this spike is about. |
| **Sidecar or scheduled updater** | The binary changes under a running server, possibly between two turns of one conversation, with no deploy event to attach a re-check to. | Same immutability conflict, and the worst observability of the set. |
| **`npx`/`bunx` resolution at spawn** | Network and registry on every turn; a cache the agent's uid can write becomes an executable the server spawns. | Makes the registry a runtime dependency and breaks the rule that no agent-writable executable is selected by the server. |
| **Do nothing** | Today's state: the host binary floats on its own updater. | The problem this record exists to fix. |

### What this costs

- **Claude Code fixes arrive at brain-kit's cadence.** A CLI fix reaches a
  deployment when this repo bumps the SDK, releases, and the host rebuilds. The
  two series publish in lockstep, so the delay is ours, not upstream's. A host
  that needs a fix sooner sets `CLAUDE_CODE_PATH` and accepts the unmeasured
  warning.
- **Optional dependencies must be installed.** An install with
  `--omit=optional`, or a lockfile from a different libc, leaves no built-in
  binary. The SDK then fails the first turn with "Claude Code executable not
  found" or, for a libc mismatch, "exists but failed to launch" (both strings in
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`). The boot probe below
  turns that into a refusal to start, for the same reason a missing backend
  refuses to boot (`packages/ui-server/src/app.ts:176-181`).
- **The published range is still a caret.** A host that installs without a
  lockfile gets the newest 0.3.x and so the newest binary. The hosting template
  must commit its lockfile. Whether the published package should pin the SDK
  exactly is its own question, filed separately rather than decided here.
- **Not measured: the CLI's self-updater under the SDK.** Whether a spawned CLI
  tries to update itself was not tested. It cannot change which file the SDK
  spawns — that is an absolute path under a root-owned install — and whatever it
  does, the per-turn version below records what ran.
- **Adopting it moves the version.** The built-in pair at the current lockfile
  is 2.1.278 / 0.3.278, which nobody has measured. The re-check below runs
  before the default changes, not after.

## The server knows the version

**Yes, from two sources, and it warns rather than refuses on a mismatch.**

- **Per turn, from `init`.** `claude_code_version` is recorded on the run the
  turn belongs to. It is the binary that actually ran, costs nothing, and needs
  no second copy of the SDK's resolution logic.
- **At boot, from the resolved binary.** The same shape as the `brain` CLI probe
  (`packages/ui-server/src/brain/client.ts:115`): run `--version` (9 ms above),
  log it, and **refuse to start if the binary is missing or will not launch**.
  A version other than the measured one is a warning naming both versions, not
  a refusal. "Unmeasured" is not "broken": the enforcement hook's `ask` defends
  every mechanism measured so far, and refusing to boot on every CLI release
  would turn each upstream release into an outage.
- **Where it shows.** `/api/status`, which is behind the auth guard and already
  reports the source commit (`packages/ui-server/src/routes/health.ts:43-58`),
  and the run record. Not `/api/health`: it is public and deliberately carries
  no version (`health.ts:8-10`). Not `brain doctor`: it runs on the user's
  machine against a different binary.

Whether the run-record field reaches a documented `--json` or `/api/activity`
envelope is for the follow-up to settle, and if it does it is a `CONTRACT:`
change there.

## Re-checking a measured behaviour when the version moves

The measured pair moves into one exported constant in
`@schlessera/brain-backend-claude`. Every site below cites the constant by name
instead of repeating the numbers. Two mechanisms hang off it:

- **A keyless guard test** reads the installed SDK's version and its
  `manifest.json` version from `node_modules` and fails when either differs from
  the constant. Under the decision above that is the version a deployment built
  from this lockfile will run, so bumping the SDK in this repo fails CI until
  somebody re-measures. It needs no key and no network, so it is allowed
  (`AGENTS.md:82-83`). It is the only automatic check this has.
- **A committed probe**, run by hand with credentials, replays the measurements
  with real `query()` calls and writes the version, the date and each result as
  JSON. It is not in CI, by the keyless rule. The PR that bumps the constant
  carries its output. The precedent for a committed, hand-run measurement is
  `scripts/measure-show-block-server.ts`. Until now these probes were run ad hoc
  and described in PR bodies (#141, #154).

The issue named four sites. There are six carrying the pair on `fe5a225`:

| Site | What it asserts | Re-checked by |
| --- | --- | --- |
| `packages/ui-backend-claude/src/permission-hooks.ts:70-101` | Three things admit a tool before `canUseTool` — the safe-command classifier (`echo hi` with an empty allowlist), a built-in tool's own check (`ToolSearch`), a project-settings `PreToolUse` hook returning `allow` — and an explicit `ask` beats all three. `permissions.allow` rules and `defaultMode: "bypassPermissions"` do not bypass. | Probe cases for each of the three, each with and without the `ask`, plus the two negative controls. |
| `packages/ui-backend-claude/src/input-rewrite-hooks.ts:7-14` | A hook's `updatedInput` applies with no decision, and the permission path sees the rewritten input. | Probe case: rewrite with no decision; assert the executed and the `canUseTool` input. |
| `packages/ui-backend-claude/tests/allowlist-enforcement.test.ts:10-19` | The precedence `runToolCall` models, (a)–(e). The test cannot re-measure it. | The probe cases above. A changed result changes the model in the test in the same PR. |
| `packages/ui-backend-claude/tests/no-grant-surface.test.ts:12-17` | The same three opinions, and that `ask` is what forces the decision. | Same probe cases. |
| `docs/decisions/voice-permission.md:584-594` | An in-process `deny` beats a project-settings `allow`. | Probe case: settings `allow` against in-process `deny`; the tool must not run. |
| `docs/decisions/design-kit.md:2576` | The SDK's `alwaysLoad` API shape. | Not a runtime measurement. It is an SDK type, and `tsc --noEmit` checks it. Excluded from the probe. |

None of the six is accepted as unverifiable. What stays unverifiable is the
absence of a *fourth* mechanism — `permission-hooks.ts:72-74` already says three
is what has been measured, not a closed set — and no probe can close that.

## Where the work goes

| Repository | What |
| --- | --- |
| brain-kit | The measured-runtime constant, the guard test and the probe; then the server's version record and boot probe, and `CLAUDE_CODE_PATH` defaulting to the built-in binary. |
| brain-hosting-template | The image installs no separate Claude Code, commits its lockfile, installs optional dependencies for the image's libc, and rebuilds when the lockfile moves. That rebuild is the update mechanism. |
| The private deployment repo | Moving that one installation off its separately installed binary once the brain-kit change ships. Tracked there; not restated here. |
