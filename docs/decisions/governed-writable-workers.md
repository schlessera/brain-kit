# Decision — governed writable workers

The maintainer's [2026-10-11 statement and rulings](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6112643600)
on [#1636](https://github.com/schlessera/brain-kit/issues/1636) restore direct
writes for ordinary turns. Every turn stays inside the isolated worker. This
record settles how that works.

> It's important for me that the flexibility of the previous way of working with
> the brain stays as intact as possible. We want additional controls so that we
> might want to block more or monitor the cost for more things. But the general
> approach of being able to make modifications to the systems as you go is
> wanted. It should be governed and you should have policies that you can
> enforce, but it should not be completely locked down by default without any
> meaningful way of productively working like we did before.

**The product principle (maintainer, 2026-10-11).** The ordinary flow is: the
user asks, and it happens — usually on the first attempt, and as efficiently
as possible. The agent may hit a roadblock and try something else until it
gets a proper result. That is fine, but every roadblock is tracked, so it can
be removed over time. A roadblock is removed in one of two ways: better agent
guidance, or a capability change that makes the first attempt work.

Every control below is judged against that principle. A control that turns
ordinary requests into roadblocks costs more than the risk it removes.

**The governing rule (maintainer, 2026-10-11, verbatim):**

> This should generally work that way and should guide the design of the
> flows, the permissions, policies, and so on. The only thing we want to ensure
> is that this all happens within secure boundaries so that the agent cannot do
> something completely absurd that would break the system or leak data, and
> also that it doesn't go completely off the rails in terms of budget and scope.

The default is productive. The maintainer
[approved seven guardrail classes](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6112825672)
on 2026-10-11. A hard boundary or added friction exists only where one of them
applies. Everything else is allowed, observed and revertible, and is tracked as
a roadblock when it fails.

| Class | What it prevents | How this record enforces it |
| --- | --- | --- |
| **G1 — system integrity, including resource exhaustion** | Breaking the host, the server, the policy, git internals or the kernel interface. Starving the host of CPU, memory, disk or processes. | Worker namespaces and the read-only host, with `/proc/sys` covered read-only in #1629. [The host execution boundary](#the-host-execution-boundary): no host process runs repository code, git or the `brain` CLI against a governed brain. Tier A protected paths with self-bound ancestors. Durable quarantine of unexpected protected files. [Per-worker resource limits](#resource-limits-g1). |
| **G2 — data exfiltration** | Secrets or brain content leaving the host unseen, or reaching an inference provider the user did not allow | `.env*` is masked, not only read-only. The host `$HOME` is replaced by #1626's per-turn overlay. Egress is recorded, then allow-listed and byte-capped by the policy. Host Unix sockets are masked. Inference and paid providers go through server relays, so a `governed` worker holds no provider credential. [Data-to-provider routing](#data-to-provider-routing-g2). Where the host provides an identity helper, [the worker runs under its own uid](#worker-identity-g2), so the server's own state is denied by ownership. |
| **G3 — budget runaway** | Cost growing without a stop | Turn, session and day limits that **block**, not only warn. Refusal at admission, an abort mid-turn, and Claude's `maxBudgetUsd` as a backstop. CLI provider spend is counted through metered relays. |
| **G4 — scope runaway** | A turn that goes on and on: too many files changed, too much time, too many tool calls | Per-turn caps on all three. Reaching a cap **escalates to the user** rather than failing silently. |
| **G5 — outward actions as the user** | An effect outside the brain in the user's name: git push, GitHub posts, email or messages, bookings, payments | [Approval, or a policy allow-list](#outward-actions-g5). Everything inside the brain stays free. |
| **G6 — untrusted input and persistence** | Content from the web, email, shared documents or cloned repositories steering the turn | [Taint](#untrusted-input-g6) makes egress and outward-action rules tighter for the rest of the session, and flags the turn's writes to steering artifacts. |
| **G7 — self-modification of steering artifacts** | Skills, instructions, memory, hooks and scheduled tasks changing unnoticed | Changes are allowed, but [journaled as their own class](#steering-artifacts-g7) with easy review and revert. The policy itself stays unwritable to agents (R35). |

Two principles cut across the classes:

- **Reversibility determines friction.** A reversible, journaled edit is free.
  An irreversible effect needs approval: an outward action, an unjournaled
  delete, a history rewrite or a force-push. This keeps approvals rare.
- **Every change is attributed.** The journal, governance events and outward
  actions record the actor: the user, an interactive, voice or autonomous turn,
  a server route, or a change made outside any turn. They also record the turn
  id, the session, the model and the profile.

Every sub-issue of #1636 names the class it serves. Work that serves no class
may not add a block or a confirmation. It may add observation, revert or
roadblock tracking.

| Ruling | What it selects | What it replaces |
| --- | --- | --- |
| 1 | `governed` is the default for interactive and voice turns. The brain is writable in the worker, except policy-protected paths, which are mounted read-only. Each turn's changes are journaled and revertible. | The read-only brain for interactive and voice turns. That view becomes the opt-in `strict` profile. |
| 2 | Policy lives in the brain repository, mounted read-only in every worker. It is changed outside a turn or through an explicit approved action. | R33's v1 rule that the host reads no policy. R35 stays: no agent runtime writes policy. |
| 3 | Autonomous turns keep the restricted envelope. | Nothing. A later ruling may widen them. |
| 4 | Four monitors: a change journal, cost budgets, a tool and command audit, and egress recording and limits. | Interactive turns had no budget and no egress record. |
| 5 | A turn's limits are stated to the agent and in the UI before it starts, generated from the inputs that enforce them. | Limits discovered only through failures. |
| 6–7 | Three write areas, each with a lifecycle. A linked turn-temp file is promoted automatically. Every intervention leaves a machine-readable record and no user-facing noise. | The 7-day and 1 GiB scratch prune deleting linked files. |

Production showed what the read-only default broke. Scratch, workspaces,
renders and CLI writes failed ([#1626](https://github.com/schlessera/brain-kit/issues/1626)).
Runtime state overflowed its tmpfs ([#1621](https://github.com/schlessera/brain-kit/issues/1621),
[#1625](https://github.com/schlessera/brain-kit/issues/1625)). Docker hosts
needed options that nothing documented ([#1622](https://github.com/schlessera/brain-kit/issues/1622)).
Large documents could not be edited through the hosted route
([#1624](https://github.com/schlessera/brain-kit/issues/1624)).

## What this supersedes, and what still binds

Each passage in [the all-writer decision](policy-write-boundary.md) that this
record reverses carries a dated note pointing here. They are:

- **"Each worker receives a read-only authoritative brain view."** It now
  holds for `strict` and `restricted` workers only. A `governed` worker binds
  the brain read-write.
- **"Ordinary shell and custom-extension writes therefore no longer directly
  change authoritative brain files."** Reversed for `governed`. Shell,
  extension and CLI writes reach the brain directly, and the journal records
  them.
- **R33's no-policy-read rule.** The server now reads the governance policy
  file. The file grants nothing to autonomous turns, and R34's grant files are
  still deferred.
- **"CLI writes through a read-only worker fail visibly"** and **"Claude uses
  the structured server write/edit tools rather than translating native
  built-in callbacks."** Under `governed`, the CLI writes and Claude's native
  `Write`, `Edit` and `NotebookEdit` tools are available again. Under
  `strict`, both rules still hold.

Everything else in that record still binds:

- Every writer enters a worker before it initializes.
- The per-turn host probe refuses visibly, and there is no unsandboxed
  fallback.
- R35 holds: no agent runtime writes policy.
- R31 and the restricted envelope for autonomous turns are unchanged.
- The validated application route, its approvals and the PNG mask operation
  are unchanged.
- Writable overlays and copied scratch brains stay declined. The approved
  read-only startup execution view below is a separate exception.

The [voice decision](voice-permission.md) still binds: speech may refuse a tool
but never grant one.

## Profiles

A profile is the worker's filesystem and network view. Tool membership is a
separate axis: it is the existing allowlist mechanism and does not change here.
What a turn can do is the intersection of the two.

| | `governed` (default for interactive and voice) | `strict` (opt-in) | `restricted` (autonomous, fixed) |
| --- | --- | --- | --- |
| Brain | Read-write bind, with protected paths read-only | Read-only (the 0.41 view) | Read-only, `.git` masked |
| Writable areas | The brain, plus #1626's named areas | #1626's named areas only (scratch, workspaces, turn temp, `$HOME` overlay) | Turn temp only |
| Host root | Read-only, with runtime and home directories masked | Same as `governed` | An explicit read envelope |
| Network | Host namespace until the egress monitor lands, then a private namespace with the egress proxy | Same as `governed` | Loopback plus the inference relay |
| Claude native `Write`/`Edit`/`NotebookEdit` | Auto-allowed on typed turns; voice calls refuse | Registered but refused at call time. The server tools are used instead. | Not in the roster |
| Server application tools | Available | Available | Proposal route only |
| Journal | Yes | Yes. It only ever sees named-area and server-route changes. | No authoritative changes are possible |

**How a profile is selected:**

- **Interactive and voice.** The policy file's `profiles.interactive` and
  `profiles.voice` choose `governed` or `strict`. Without a valid policy, the
  default is `governed`.
- **One session.** A user may tighten one session to `strict` through an
  authenticated session setting. Nothing loosens a profile below the policy.
- **Autonomous.** The profile is always `restricted`, and the policy cannot
  change it.

**Delivered session tightening (#1663).** The existing model picker's This chat
section saves authenticated next-turn preferences in the operational session
catalog. An unbound composer saves only its preference under its existing
draft identity; validated first-send correlation binds it to the actual
named session. There is no draft text requirement or session reservation.
Admission still uses the same last-valid policy reader and may only tighten
interactive work. Voice shows its policy read-only; dictation is interactive.
The current worker never changes profile because a later save succeeded.
Unknown enforcement facts remain unknown, and requested preference is separate
from the actual admitted worker, including fallback
(`createSessionProfiles`, `packages/ui-server/src/ws/session-profiles.ts:12-89`;
`begin`, `packages/ui-server/src/brain/governed-turn.ts:53-115`).

**Where a turn falls back to `strict`.** The launcher refuses to start
`governed` when a protected path is a symlink, a hardlinked file
(`nlink > 1`), or another mount, using #1626's guard. In that case the turn
runs under `strict` and its capabilities note says why. Falling back to
`strict` gives a stronger boundary, not a weaker one, so "no weaker fallback"
still holds.

**Voice.** Ruling 1 makes voice `governed` too. Voice keeps its narrower
membership (`VOICE_ALLOWED_TOOLS`, `packages/ui-backend-claude/src/tool-policy.ts:120`):
no Bash, no raw `Write`/`Edit`, no archive, and approval returns false
(`const apply = createBrainApplication`, `packages/ui-server/src/ws/bridge.ts:577-581`).
A voice turn therefore writes only through curated capture and update, now
with a journal behind it. The writable mount gives voice no tool it lacked.
Pi still refuses voice turns.

**2026-10-16 native-tool registration amendment (#2022, #2048 A).**
Hosted interactive Claude keeps native file-tool definitions registered across
`governed`, `strict` and voice turns to preserve provider prompt caching.
Governed typed `Write`/`Edit` (and configured `NotebookEdit`) retain their
SDK auto-allow, alongside existing server writers. Strict and voice natives
refuse in the mandatory PreToolUse hook and permission callback before any
handler, approval card or lock acquisition; settings and remembered grants
cannot override that refusal. Native stale-read checks, write locks, journals
and protected mounts still apply to governed typed execution. The autonomous
roster and authority do not change. This amends native availability language
above; #2048 owns the broader bridge-roster amendment.

## The policy file

**Location.** `context/policies/governance.md` in the brain. It is Markdown,
and its YAML frontmatter is the policy. The body is free prose for the reader,
and nothing enforces it. The file is versioned with the brain like any other
document.

**Parsing.** The server parses it with `parseFrontmatter` and validates it
with a zod schema at the start of every turn. The schema lives in core, so the
server and a read-only `brain policy check --json` command share it.

**Why that location:**

- `context/policies/` is already denied to the application route
  (`if (folded[0] === "context"`, `packages/ui-server/src/brain/application.ts:39`).
- R34 already placed policy there.
- Scheduled-task definitions set the precedent of host-parsed Markdown under
  `context/`.

The `governance` slug is reserved, so a future R34 grant file can never shadow
it. `context/policies` joins `DEFAULT_EXCLUDE.dirs`, as `context/scheduled-tasks`
did: the file is host input, not an index document.

```yaml
schema_version: 1
profiles:            # governed | strict
  interactive: governed
  voice: governed
protect:             # added to the built-in protected set
  - me/identity.md
release:             # may name only built-in tier B paths
  - .claude/settings.json
budgets:             # USD at list price and/or tokens; warn and block are separate
  turn:    { warn_usd: 2, block_usd: 10 }
  session: { warn_usd: 10 }
  day:     { warn_usd: 25, block_usd: 60, block_tokens: 40000000 }
scope:               # per turn; reaching one escalates to the user
  max_files_changed: 200
  max_minutes: 30
  max_tool_calls: 300
commands:            # anchored regexes matched against Bash input
  deny:    [{ pattern: "^git push (-f|--force)", reason: "No force pushes." }]
  confirm: [{ pattern: "^git push", reason: "Pushing leaves the host." }]
egress:
  mode: record       # record | allowlist
  allow: ["github.com", "*.githubusercontent.com"]
  deny: []
  max_bytes_per_turn: 500000000
outward:             # G5; see "Outward actions"
  allow: []
  hosts: [api.github.com, uploads.github.com]   # extends the built-in list
taint:               # G6; see "Untrusted input"
  egress: { allow: [] }
providers: []        # G2; see "Data-to-provider routing"
```

**Validation rules:**

- Unknown keys are refused.
- Patterns compile under the [confirmation-pattern rules](confirm-patterns.md):
  a nonempty list with no valid regex is an error.
- `release` can never name a tier A path.
- `profiles` cannot name `restricted`, and no key reaches autonomous turns.

**When the policy is invalid.** The server enforces the last valid policy it
loaded during the process's life. When there is none, it enforces the
built-in defaults. A notice names the validation error.

**Where it is recorded.** The policy's hash is recorded on every turn's journal
entry, so a reader can always tell which policy governed a turn.

**How it changes.** Ruling 2 allows two routes:

- **An edit outside a turn.** An editor, a terminal or a pulled commit.
- **An approved action.** An agent may call a server tool that proposes a
  complete new policy. The server shows the user the diff on an approval card,
  and only after approval does a server-owned route write the file. The route
  takes `BRAIN_LOCK_KEY` and re-validates the schema. The tool cannot be
  auto-allowed. It is absent from voice and autonomous membership, and a voice
  answer can only refuse it.

Neither route lets an agent runtime write the file, so R35 holds.

**No hash activation.** R36's hash-activation design is not adopted for this
file. Inside a turn the file cannot change: the mounts below prevent it, and
the measurements prove it. Outside a turn, ruling 2 makes an edit legitimate.
An activation click would add friction and no protection.

**Reader and admission identity (#1650).** The schema and data-only reader live
in the shared internal common helper, consumed by core and the server
(`GovernancePolicySchema`, `packages/common/src/governance-policy.ts:35-50`;
`parseGovernancePolicy`, `packages/common/src/governance-policy.ts:91-124`).
This preserves the server's optional core peer (#1744).
The hash identifies the complete UTF-8 file bytes, including prose and
line endings; the body still has no policy semantics. This preserves a simple
version identity without a second YAML canonicalization algorithm. The strict
input format, defaults and read-only command are in
[supported inputs](../supported-inputs.md#governance-policy) and the
[CLI contract](../integration-contract/cli.md#governance-policy-check-additive-1650).
Mixed command lists retain their valid entries and report skipped sources;
nonempty entirely invalid lists refuse under the existing confirmation ruling.

Admission captures and freezes one effective policy/hash after acquiring the
writer gate (`createGovernedTurns`, `packages/ui-server/src/brain/governed-turn.ts:28-115`),
records it for strict and governed turns in host operational state,
and passes its protection list to the existing launcher/manifest. The journal
consumes that captured identity rather than rereading the file. Invalid edits
retain the process's last valid file/hash, or defaults with a null hash before
any valid file; known absence selects defaults. True voice uses the voice profile,
dictation uses interactive, and autonomous authority remains separate. Existing
host strict overrides and stronger fallback remain effective. This reader does
not enforce the budget, scope, egress, outward, taint or provider fields.
Their parsed values are inputs for their owning guardrails.

**Command deny and confirm (#1661).** Admission also captures the command lists
and their original source positions, including invalid entries skipped before a
valid rule. Claude checks denies before its PreToolUse shortcuts and callback;
pi checks them at the host permission RPC and its in-process tool gate. Both
recheck approved edits before execution. Policy confirmations join the existing
case-insensitive operator patterns and use per-use command cards; a remembered
tool grant does not answer them. The capability note lists the captured active
patterns. The existing governance writer retains each refusal or confirmation
with its hash and rule provenance, independent of span-detail retention.

**Authoritative agent applications (#1743).** Worker mounts and the privileged
application route consume the same admitted protection. The application bridge
is constructed after admission and captures that turn's list. It does not
reparse the policy on each tool call. Every proposed/planned document output
and submitted PNG destination is checked under the existing write lock and
again before publication. Protection is read-only, so permitted reads remain
available. Scratch cleanup performed by a permitted mask retains protected
files, directory descendants and ancestors too. Refusals use the existing
`policy_denied` result with no partial mutation; membership, live principal
authority, exact browser submissions, voice exclusions and static alias checks
remain independent requirements.

## The host execution boundary

The independent review of this record showed that read-only mounts cannot, on
their own, keep repository-controlled code off the host
([review findings](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6112823126)).
Each case below was reproduced on a disposable fixture:

- **The config's dependencies.** The host imports `brain.config.ts`
  (`export async function loadUserConfig`, `packages/core/src/lib/config.ts:590`).
  The config can import local helpers and local module entries, and those
  files are not on any fixed list.
- **Bun startup.** A newly created `bunfig.toml` preload runs before any
  application code, in every host-side Bun process started with the brain as
  its working directory. The same goes for a new `.env`.
- **Git includes and filters.** A protected `.git/config` that includes a
  writable file still lets that file define filters, and `git add` runs them.
- **Writable git metadata.** A worker that replaces `.git/refs/heads` with a
  symlink makes a later host commit create a file outside the brain.

So `governed` adds one rule, which binds before the profile can be the default:

> **No host process evaluates repository-supplied code, or runs git or the
> `brain` CLI against the brain, once a `governed` turn may have changed it.**
> That work runs in a maintenance worker.

**What a maintenance worker is.** It uses the same launcher. The brain is
writable, the host is read-only, and nothing has a credential except what that
one command needs. It covers:

- the application route's planning and indexing (`initContext`,
  `prepareIngest`, `indexAll`);
- every server-spawned `brain` command (`execBrain`), including scratch prune
  and hygiene;
- cron's `brain sync` and `brain index`;
- every git invocation.

Declared writer admission also applies to asynchronous host fallback before
the first governed turn. Both complete and streaming commands acquire their
existing shared/exclusive gate before selecting host or worker execution;
required missing admission refuses before process creation. A streaming host
command retains admission through process exit and both output EOFs, including
inherited descendant output. Credential exclusion follows writer admission.
Optional missing gates and trusted `gate: none` readers retain their existing
behavior. A host holder records its planned folders, without claiming physical
folder pins; an earlier holder missing a newly required folder causes governed
admission to refuse. No existing writer is killed or made exclusive by that
refusal.

**Operational state lives outside the brain.** The fourth
[maintainer ruling on #1649](https://github.com/schlessera/brain-kit/issues/1649#issuecomment-6125423103)
requires the operational database and other private server state outside the
brain for every hosted profile. Boot refuses as `OperationalStateInBrainError`
before opening state or executing brain code when the database or private state
resolves inside the brain, including through symlinks or a new path's existing
parents. Database, WAL/SHM, and private-state inode aliases through hardlinks or bind mounts
inside the brain refuse too, including new database paths beneath a mounted state
parent. Aliases wholly outside remain valid. Worker masks cover configured state
directories and resolved database/token/quarantine targets. The refusal gives migration steps: stop the server, move the complete
state directory outside the brain, point the configuration at it, and restart.
The same diagnostic is reflected in host boundary status and the boot error/log.
No strict private-state exclusions are introduced and no mask is weakened.
**Maintenance temporary storage (2026-10-12).** Each command receives a
256 MiB temporary allowance, reserved in full against a separate 256 MiB
cross-process maintenance budget before repository code runs. Trusted
configuration can raise either limit; the budget must cover one allowance.
Server and cron share admission through their existing canonical UI-state
identity and access authority, independently of launcher uid or private
temporary directory. Standalone SDK callers retain a private per-uid domain.
Crashed ownership is recovered only when its process identity is positively
dead; unknown foreign PID-namespace ownership remains held. These limits do
not consume or derive
from agent-state capacity.

All maintenance temporary paths share one sized tmpfs. Maintenance workers
and their separate host-owned Git transport require bubblewrap's paired
`--disable-userns` and `--assert-userns-disabled` flags; startup refuses hosts
that cannot enforce
this maintenance-only restriction. The outer worker isolation and agent
capabilities stay as previously decided. Credentialed Git transport remains
separate and never evaluates repository code. This exception to general
capability preservation was explicitly approved in
[the #1708 decision](https://github.com/schlessera/brain-kit/issues/1708#issuecomment-6128047037).

The journal and revert run no git and import no repository code at all (see
below). The server itself must not run with the brain as its working
directory. Boot refuses `governed` when it does.

A malicious config, preload, filter or symlinked ref therefore runs only in a
sandbox with a read-only host.

**Credentials never reach a process that evaluates repository inputs.** A
read-only host does not stop sandboxed code from stealing a credential it was
handed: a config that imports a writable helper, or a git config that includes
a writable filter definition, would run beside the push key. Credentials stay
in host-owned transports instead:

- **Git transport.** It goes through a host-private bare mirror with a host-owned
  configuration and no hooks. An uncredentialed maintenance worker moves refs
  and objects between the brain and the mirror over the local file transport.
  A separate transport worker fetches and pushes between the mirror and the
  remote with the credential. It never reads the brain's configuration or
  working tree. Objects that cross the boundary are data.
- **Paid providers.** Calls go through metered relays (see "Cost and budgets"),
  so no worker holds a provider key.

**Interim exposure.** Until the mirror and the relays land, a maintenance
worker that needs a credential receives it directly. Code the agent can write,
such as a helper the config imports, could then read it. That is the same
exposure as before 0.41, it is listed in the capabilities status, and closing
it is a p1 sub-issue of #1636.

The protected list below keeps the policy intact, keeps secrets out of workers,
and stops a turn from steering later turns' permissions or start-up code.

## Protected paths

Protected paths are what governance and later workers rely on. A write to one
of them would let a turn change its own rules, or run start-up code or grant
permissions in another turn.

| Tier | Paths | Can the policy release it? |
| --- | --- | --- |
| A — governance, secrets and start-up code | `context/policies/`, `.git/config`, `.git/config.worktree`, `.git/hooks/`, `.git/info/`, `.git/modules/`, `.env*`, `bunfig.toml` | No |
| B — runtime permission and configuration surfaces | `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `brain.config.ts`, `brain.config.json`, `package.json`, `bun.lock`, `node_modules/` | Yes |
| Added by the policy | Anything listed under `protect` | Yes, by deleting the entry |

**Why the tier A paths are there:**

- `context/policies/` is the policy itself.
- Git hooks and config run in every later git invocation, including the user's
  own clones of the brain.
- `.env*` holds secrets.
- `bunfig.toml` preloads code into every later Bun process started in the brain.

**Why the tier B configuration files are protected by default.** The config and
its dependencies decide what the maintenance workers do. Since the host no
longer imports them, protecting them is a default, not a containment
requirement. A user who wants agents to edit configuration as they go may
release them.

**`.env*` is masked, not only read-only (G2).** A present `.env*` file is
replaced inside the worker by a read-only bind of `/dev/null`. The agent cannot
read the brain's API keys. A CLI provider that needs a key reaches it through a
metered relay (see "Cost and budgets"), never through the worker environment.

Before the mask ships, the G2 sub-issue establishes which in-worker paths read
`.env` and which providers they call. A provider without a relay yet is refused
in turn workers with a named roadblock, and the key is not handed to the
worker. Where core can degrade, as hybrid search falls back to keyword search,
it does. The relay sub-issue is p1, because each refused provider is a
roadblock.

**Why tier B is protected by default.** Allow rules in project settings would
skip the server's approval prompts. Releasing one is a policy choice the user
makes in the brain.

**Deliberately not protected:**

- **`brain.db`.** It is disposable, and the CLI needs it to capture and index.
  SQLite coordinates writers across processes
  (`PRAGMA busy_timeout`, `packages/core/src/lib/db.ts:50`). The host never
  takes authority from it.
- **`CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `.agents/`.** Changing them as
  you go is exactly the flexibility ruling 1 restores. The journal records
  those changes and can revert them.
- **`.brain-ui/`.** Agents file staged shares from it.

### How the mounts enforce it

After `--bind brain brain`, the launcher builds the mounts from the resolved
list:

- each **existing** protected path is `--ro-bind`-mounted onto itself;
- each ancestor of a protected path below the brain root (`context/`, `.git/`,
  `.claude/`) is self-bound **read-write**, which turns it into a mount point;
- protected directories that are missing (`context/policies/`, `.git/hooks/`,
  `.git/info/`, `node_modules/`) are created empty by the server before launch.
  An empty directory changes no behaviour, and module resolution continues past
  an empty `node_modules`.

The protected list is one more input to #1626's named-mount list, not a second
mechanism.

**Measured on 2026-10-11** with bubblewrap 0.12.0 on Linux 7.2 x86_64, using a
disposable fixture brain ([probe scripts](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6112682063)).

| Attempt inside the worker | Plain read-only sub-mounts | With self-bound ancestors |
| --- | --- | --- |
| Write a protected file | `EROFS` | `EROFS` |
| Hardlink a protected file into a writable path | `EXDEV` | `EXDEV` |
| Rename or unlink a protected file, or rename another file over it | `EBUSY` | `EBUSY` |
| Rename `context/` to `context2/`, then recreate `context/policies/governance.md` | **Succeeds. The host reads the attacker's policy.** | `EBUSY` |
| Rename `.git/`, then create `.git/hooks/post-commit` | **Succeeds** | `EBUSY` |
| `rename(2)` of an ordinary file across a self-bound ancestor | n/a | `EXDEV`. `mv` falls back to copy and delete. |
| Create an absent protected file such as `brain.config.ts` | Succeeds | Succeeds |

The first two columns show why ancestors must be mount points. Read-only
sub-mounts alone are defeated by renaming a parent. The cost is the `EXDEV` on
direct renames between `context/` or `.claude/` and the rest of the brain.
Ordinary tools fall back to copy and delete, and git writes new files rather
than renaming across directories.

**Absent protected files** cannot be mounted without creating them on the host,
because bubblewrap creates the mount point. A placeholder `brain.config.ts`
would break the brain.

With the host execution boundary in place, an absent name that a turn creates
can run only inside later workers, never on the host. The remaining risk is a
later credentialed or interactive worker picking it up, so it is closed with
durable quarantine:

1. **The manifest is durable.** Before launch, the server writes the turn's
   protected-path manifest (path, existence, type, device, inode, hash) to
   `brain-ui.db`.
2. **Quarantine at turn end.** Any tier A or tier B file that did not exist at
   turn start is moved into the turn's journal quarantine and removed from the
   brain. A diagnostic record is written, and the user can restore the file
   from history.
3. **Recovery after a crash.** At boot, every turn that has a manifest but no
   end record is reconciled the same way, before any maintenance worker or new
   turn launches.
4. **Startup execution views, and equal-authority peers.** The maintainer's
   [peer-visibility ruling](https://github.com/schlessera/brain-kit/issues/1649#issuecomment-6120164424)
   allows governed peers to consume configuration another governed turn creates
   while they overlap. These are G7 steering changes, journaled and revertible
   by the journal work. This replaces active-peer masking. Every other
   consumer freezes both bytes and absence at its own launch, as below.
5. **Credentialed maintenance is exclusive.** A maintenance worker that holds a
   credential (in the interim, see above) holds the writer gate exclusively
   from validation through execution and reconciliation (see "Revert").

A user who creates such a file from a terminal while a turn is running sees it
quarantined. That is the accepted cost.

**Symlinks.** A symlink an agent creates toward a protected file resolves to
the read-only mount (`EROFS`). A symlink toward the host root resolves to the
read-only host. Server routes that serve brain files keep their existing
no-escape resolution. Server code must not follow a brain symlink out of the
brain.

**The probe changes.** `probeWorkerHost` gains a `governed` mode. It proves
that a protected sentinel is unchanged and that an unprotected sentinel *was*
written, in addition to today's checks.

## Immutable startup configuration and explicit outputs

> **2026-10-14 — Storage mechanism superseded.** The complete immutable view
> requirement below still binds. [Native checkpoints](native-brain-storage.md)
> replace per-launch user-space full copies; governed peers still share the live
> brain and outputs still use authoritative validation.

The maintainer's [complete-view ruling on #1649](https://github.com/schlessera/brain-kit/issues/1649#issuecomment-6120567225)
approves complete read-only startup views for strict, restricted, maintenance
and host configuration consumers. A single frozen `brain.config.ts` is not
enough: its helpers, arbitrary transitive imports and configured resources must
be frozen too. Governed peers retain the live brain. A running snapshot
consumer sees neither new bytes nor a newly created configuration name; a new
consumer takes the then-current bytes at its own launch.

The view copies raw file bytes and link text through descriptor-anchored opens,
without evaluating repository code or sharing writable inodes. It is mounted
read-only at the original brain path. Concurrent changes during copying refuse
launch. Special nodes refuse copying; restricted views keep only an empty `.git`
mount point, since that profile masks Git and its daemon sockets anyway.
External runtime paths stay read-only under the existing explicit envelope;
the worker cannot reach the live brain through an alternate source path.

| Configuration consumer | Inputs in the complete startup view |
| --- | --- |
| Core config and modules | `brain.config.ts/json`, every imported helper and module, dependency manifests, locks, package resolution trees and data used by config |
| Bun child startup | `bunfig.toml`, preloads and their transitive inputs; `.env*` remains masked in credential-free workers |
| Git maintenance | Local config, worktree config, includes, hooks and configured hook paths, filters, fsmonitor, attributes, ignore files and programs/dependencies |
| Claude strict | Project settings, `.mcp.json`, instructions, skills, hooks, plugins and configured resources; restricted startup retains its existing exclusions |
| Pi strict | Project settings, package/extension/skill/prompt/theme resources, context files, `SYSTEM.md`/`APPEND_SYSTEM.md` and reload inputs |
| Host data configuration readers | Immutable parser inputs captured at operation startup; no host config imports, Git or CLI evaluation |

**Explicit writable outputs.** The execution view receives no write mount.
Strict persistent areas are mounted at `/tmp/brain-worker-areas/scratch` and
`/tmp/brain-worker-areas/workspaces`, outside it, from private startup copies whose writes are validated and
published after the worker exits, with their canonical link paths stated in the note. Restricted staging and inference remain outside the
brain. Maintenance receives `/tmp/brain-maintenance-output`, a private output
workspace; `BRAIN_ROOT` names that workspace and core configuration/module
resolution still uses the immutable execution view. Index files, skills sync,
module settings and sync state are validated and published by the server after
the whole worker exits. Worker output cannot change tier A inputs or escape
through a link, and a stale authoritative base refuses publication. Strict-area publication holds the server native-write path locks through commit, rechecks the base after copying, and installs absent output names atomically without clobbering a concurrent creator. Directory
versus file replacements are refused during preflight, before any deletion.
Publication also refuses deletion of a tier A ancestor directory, including an
empty `context` or `.git` whose protected descendants are currently absent.
This host-side check applies before any changed output is installed; worker
namespace mount points alone do not constrain the host publisher.
Within one server process, maintenance clients serialize preparation through
publication per canonical brain. Even readers produce SQLite projections or
Git attribute objects in their private outputs; concurrent copies of that
state cannot be published independently without stale-base conflicts. This
serialization does not replace the writer gate or peer revalidation. Deferred
turn refreshes drain before the server closes the writer-gate database; shutdown
admits no further refresh. Git preparation carries cancellation, and streaming
launch rechecks cancellation before starting the command.

Git's server-built adapter retains expanded startup config, immutable hooks
and an attributes tree while directing repository state to the output workspace.
No host Git evaluates the repository. Curated application writes retain their
existing authoritative server path and exact-base checks. Credentials and
writer-gate admission retain their interim rules. This is an execution-input
snapshot, not a second authoritative brain or a writable overlay.

### Bounded startup and output staging (maintainer, 2026-10-12)

The [output-staging ruling on #1649](https://github.com/schlessera/brain-kit/issues/1649#issuecomment-6123713987)
gives publication storage its own per-worker allowance: 256 MiB by default,
host-configurable and validated. Its aggregate budget defaults to allowance
multiplied by the concurrent-session cap, with an explicit override. Admission
extends the runtime-state/turn-temp ledger; refusal is `worker_state_busy` with
Retry. Writes over capacity fail with named `ENOSPC`, never by overflowing a
host-backed directory. The allowance bounds newly staged writable bytes, not
the complete immutable input tree. **2026-10-13 correction (#1778):** the shipped
0.42.0 implementation charged startup inputs and duplicate baselines too; that
stronger constraint was not in the linked maintainer ruling and refused
legitimate large brains before launch. Complete immutable inputs retain the
existing 4 GiB logical copy guard in separately owned private storage; only
new/copied-up output bytes and writable filesystem overhead occupy the
kernel-bounded output upper layer. An input-capacity refusal remains named
and leaves status available without host fallback.
The agent's limits list and the hosting guide state the enforcing value.
Secret links are resolved in worker-visible names while brain components are
inspected through the held startup copy. Relative links, absolute brain links
and link/parent traversal keep their masks after the startup bind. Secret
destinations are masked in every separately named maintenance output or strict
area copy too; a writable copy cannot expose the same bytes through an alias.

Zero-filled extents are copied as sparse holes, preserving every logical byte
without allocating a sparse artifact's logical length in the immutable input
snapshot. Copied-up outputs remain charged for their allocated bytes. The
output capacity bound applies to allocated writable storage; logical file bytes
still meet the existing copy and inventory bounds. Deleting a lower-only input
does not release upper-layer write capacity.

The implementation retains a trusted copy-on-write mount helper until
publication and starts the worker's bubblewrap inside that namespace using `nsenter`. Its
starting view is still read-only, its output view still separate, and its own
fresh namespaces/masks still apply. Fixed parser inputs such as `.gitignore`
are captured through anchored descriptor reads and parsed as data; they need
no execution tree because the parser imports or executes no repository code.

## The three write areas

Ruling 6 adopts the maintainer's model. Each area has a lifecycle contract, and
the capabilities note states all three and says which one to link:

| Area | Where | Lifetime | Linkable | Indexed or journaled |
| --- | --- | --- | --- | --- |
| Turn temp | `$BRAIN_WORKER_SCRATCH`, the per-turn `$HOME` overlay, `/tmp` | Deleted at turn end | Never | No |
| Persistent scratch | `.brain/scratch/`, which is gitignored and served by the file routes | Survives turns. Pruned by age and size, but never while a retained conversation links the file. | Yes | Not indexed. Listed in the journal by name and size only. |
| Canonical brain | Everything else that is not ignored | Versioned in git | Yes | Indexed and journaled with content |

`workspaces/` is a sibling of persistent scratch. It holds clones of external
repositories, and the journal covers each workspace through its own git
metadata (see below).

**Link check at turn end.** Before the turn is reported complete, the server
scans the final response for links into turn temp. Each linked file is promoted
into `.brain/scratch/turns/<turnId>/` and the link is rewritten. The response
gets **no visible marker**: the user does not need to care where a file
started (ruling 7).

**The copy is descriptor-safe.** The link target is controlled by the worker. A
fresh tmpfs inside bubblewrap exists only in the worker's mount namespace, so a
privileged copier that resolved the path on the host could follow a symlink to
host files.

Turn temp therefore becomes a host-created private directory on a separate
tmpfs device, never on the brain's device, bound into the worker. #1626 owns
that mount. To promote a file, the server:

- opens every component from its own directory descriptor with `O_NOFOLLOW`;
- requires a regular file with one link;
- enforces the byte bound while copying, not only before;
- writes through an anchored destination under `.brain/scratch/turns/`, in
  the same way as the application route's `openTarget`;
- does all of this before the turn-temp directory is removed.

**Diagnostic records.** Each promotion is recorded with the source path,
destination, bytes, turn id and both links. A promotion over the per-turn size
bound is refused, the link is left unchanged, and that is recorded the same
way.

**As built (#1655, bounded by #1703).** #1655 first bound a private `0700`
host directory, on the first tmpfs apart from the brain, at the worker's
`/tmp`. That directory had no size limit, so one worker could fill a tmpfs
every worker and the host shared. The maintainer's ruling on #1703 replaced
it: each worker's `/tmp` is now a private tmpfs of exactly its turn-temp
allowance, mounted by bubblewrap with `--size`. It holds
`$BRAIN_WORKER_SCRATCH` and the per-turn XDG directories, and the per-turn
`$HOME` overlay is gone, because bubblewrap keeps an overlay's upper
directory on the host, where no size-limited mount can hold it. Before the
worker's command starts, the server opens that tmpfs from outside through the
sandbox's `/proc/<pid>/root`. It waits until the path is a tmpfs of exactly
the allowance on another device than the server's own `/tmp`, and keeps the
descriptor
(`function openPrivateTurnTemp`, `packages/ui-sdk/src/server/worker-launcher.ts:988-1016`).
Every later read goes through that descriptor, after the worker's namespace
is gone as well, and never enters another mount, so runtime state below
`/tmp` is never read as turn temp. The allowance (256 MiB by default,
`BRAIN_UI_TURN_TEMP_BYTES`) is admitted in the same ledger as runtime state,
against its own budget, and a turn that cannot reserve it is refused as
`worker_state_busy` (docs/hosting/agent-workers.md). The `turn_temp` tool
reports usage and purges paths through the same descriptor
(`export function purgeTurnTemp`, `packages/ui-sdk/src/server/worker-turn-temp.ts:450-458`).
The restricted envelope gets the same sized `/tmp` and promotes nothing.
After the worker exits, the backend
rewrites the answer text the turn appended to its saved transcript, and only
that text. It looks at Markdown link and image destinations and reference
definitions outside code. A file is promoted once per turn however often it
is linked, up to 128 MiB per file, 256 MiB and 64 files per turn
(`export function createTurnTempPromoter`, `packages/ui-sdk/src/server/worker-turn-temp.ts:124-135`).
The copy goes to `.brain/scratch/turns/<turnId>/` under a name the reader's
file links accept, so the rewritten link is brain-relative and is pinned like
any other scratch link. Each result reaches the server as a `promotion` or
`promotion_refused` activity event, which it stores as the governance event of
the same name. `scratch_unavailable` is the refusal for a turn whose
`.brain/scratch/` was not usable. The stored answer is rewritten before the
turn's history boundary is read. A reader still watching the live stream
holds the text as it streamed, so the server also sends the turn's clients
a `message_links` frame for each promoted file, and the client rewrites the
same destinations with the function the backend used. The link changes in
place, without a reload or a marker (#1698).

Classified blocks follow the same destination edits in persisted history
(#1704). The host retains the turn's original text and destination map,
then saves blocks under the rewritten text's hash with rebased spans.
It does this when promotion arrives and when classification completes,
so either completion order replays the same blocks. The original hash
remains available to other identical, unpromoted parts in the session.
Live blocks still use streamed-text offsets; the client and server share
the span rebasing function and discard ambiguous overlaps as plain Markdown.

**Pinning.** A link into `.brain/scratch/` pins the target. Prune skips pinned
files (`export function pruneScratch`, `packages/core/src/lib/scratch.ts:626`).
A pin is released when every conversation that links the file is deleted or
falls out of retention. If the scratch area still exceeds its size limit
(`SCRATCH_MAX_BYTES`, `scratch.ts:58`) after unpinned files are pruned, the
overage is reported. Pinned files are never deleted. A writer that prunes
after writing into scratch also passes the paths it just produced, protected
for that one call (`pinnedPaths`), so retained pins over the cap cannot make it
delete the output it reports; the next ordinary prune treats that output like
any other unlinked file (#1691).

The server scans retained backend histories before pruning and records stored
assistant links at turn boundaries. Its session-keyed snapshot is
`.brain/scratch-pins/pins.json`, replaced atomically. Core reads this data without
opening the server database. The separate `.brain/scratch-pins-required` marker
keeps missing snapshot directories fail-safe. Missing, invalid or unfinished
managed snapshots suspend deletion for CLI maintenance and prune-on-write too.
A retained-session scan and direct history confirmation release pins for deleted/expired sessions;
failed or aborted scans never release pins. The server records remaining cap
overage as a `scratch_overage` governance event, with logging as the fallback
when the event store is unavailable.

**Expired links.** A link whose file is gone renders as "expired", not as a
404.

**Why automatic promotion.** The alternative was a visible flag on the link,
which keeps the agent honest without copying anything. It lost because the
agent can only see turn temp, and the user can only reach scratch. A flagged
link is still a broken link, and fixing it costs another turn. The bounded
copy and the diagnostic record keep promotion honest without showing anything
to the user.

## The change journal and reconciliation

> **2026-10-14 — Capture and temporary-storage scope superseded.**
> [Native checkpoints and delta history](native-brain-storage.md) replace the
> full baseline capture described below. Changed-only retained objects keep
> their 10 GiB object/metadata/reservation cap; temporary native checkpoints
> use the separately configured finite managed-volume bound. Observation,
> attribution, guarded revert and honest partial-history guarantees still bind.

**Delivered journal behavior (#1652).** The host records raw observations at
admission, tool completion, 15-second scope observations and turn completion
before quarantine/gate release. The journal and private content objects are
operational state beside `DB_PATH`, masked from workers; they do not make
`brain.db` authoritative. Descriptor walking, the pinned ignore matcher and
the stat cache were implemented by
[the historical `createJournalWalker`](https://github.com/schlessera/brain-kit/blob/79d54278f1b2f35e929f4c6f182089360ab7759f/packages/ui-server/src/brain/journal-snapshot.ts#L36-L40).

The approved aggregate cap is 10 GiB. Reservations include retained raw
objects, simultaneous temporary copies, journal-owned SQLite pages and bounded
WAL/GC headroom. Reader leases prevent collection during downloads. Completed
detail expires oldest-first when space is needed; compact summaries normally
remain through the 30-day retention window, and can expire when only summaries
remain and cannot fit. Active windows and referenced/shared objects are never
collected. An incomplete initial snapshot refuses the worker; missing mid-turn
observations stop it while retaining observed versions and partial work. No
automatic revert or claim of recovering writes between observations is made.

Every retained turn has one initially collapsed receipt. Known no-change is
zero; legacy/unknown detail and unknown cost/limits remain explicitly unknown.
The live receipt's polite accessibility status follows authoritative cost and
completion-state updates for its own session and turn. Repeated equal text and
unrelated updates do not mutate the live region; expired or inactive-session
receipts clear it. Known subscription zero remains distinct from unknown cost.
The existing reader dialog shows bounded raw text diffs (combined 256 KiB or
5,000 lines), with authenticated raw downloads for retained larger/binary
versions. The journal's policy-write seam requires a live original observation
window and records an approved server write as user/policy; approval and
principal authority remain the caller's responsibility. The policy publisher
creates, writes, fsyncs and removes its operation-owned staging name entirely
inside that synchronous callback, between the two serialized observations
(`await options.observeUserPolicy`,
`packages/ui-server/src/brain/policy-proposal.ts:183-210`). First publication
also removes the temporary hardlink before the final observation. No filename
prefix is ignored; a similarly named real agent change is still retained.
Failed staging preserves the original policy, while failed recording after
publication retains partial/unknown receipts rather than claiming completion.
Steering classification
and effective budget/scope enforcement belong to their own programme work.

**Delivered user revert (#1653).** The existing reader has a single-file history
action. Whole-turn revert opens one review dialog listing eligible and excluded
paths; its first focus reads the heading. Waiting, conflict, partial and unknown
outcomes remain in the original turn disclosure. Escape closes the reader;
it neither executes nor cancels an operation. Lost responses read the original
principal/session/source/selection-bound receipt and never blindly repeat a POST.
The exclusive gate queues new turns but permits shared maintenance an existing
turn needs to finish. Under the gate and existing brain/Git locks, descriptor
restoration compares existence, type, mode and raw bytes; later changes conflict.
Verified leased CAS streams avoid uncharged temporary brain copies. Effects are
journaled as a user revert for Undo through the same comparison, and incremental
index refresh is queued after releasing the gate. A write failure is partial,
not an atomic all-path guarantee. Explicit history restoration can recover
retained observed quarantine versions; private quarantine paths remain private.
Ignored, incomplete, Git metadata and unsupported entries are named exclusions;
missing or changed parents conflict. No unobserved empty-directory metadata is
invented.

**Snapshots.** At turn start and at turn end, the server snapshots the brain's
working tree itself. It runs no git and imports no repository code:

- **The walk is descriptor-anchored.** A worker can swap a directory for a
  symlink between an `lstat` and the next open, so pathname operations are not
  enough. Every directory is opened from its parent's descriptor with
  `O_DIRECTORY | O_NOFOLLOW`. Every file is opened with
  `O_NOFOLLOW | O_NONBLOCK`, so that a FIFO cannot block the host, as
  `readRegular` in the application route already does. Each descriptor is
  `fstat`-checked before it is read; only regular files are hashed. This is the
  `/proc/self/fd` technique the application route already uses. Raw ref reads
  follow the same rule.
- **What it covers.** It skips `.git/` and `workspaces/` (which are snapshotted
  separately). It also skips paths ignored by the `.gitignore` rules **as they
  stood at turn start**. A pure matcher reads them as data, with no git
  configuration or attributes involved. Every path in the turn-start manifest
  stays covered until the turn ends. Editing `.gitignore` during a turn can
  therefore never take a canonical file out of the journal or out of
  scope-cap counting. The edit applies from the next turn on, and it is
  highlighted in this turn's history.
- **The stat cache.** It is host-owned, keyed by device, inode, size, mtime
  and ctime in nanoseconds. A file whose key changed has its **raw bytes**
  hashed. Symlinks are recorded by their target text, and each entry records
  its mode.
- **The store.** Changed content is written to a host-private,
  content-addressed store beside `DB_PATH`. Every object a retained journal
  needs is held in that store. Nothing depends on the brain's `.git`, so
  deleting brain objects, git garbage collection or an agent editing index
  flags cannot erase or hide a journaled change.

The journal entry is the difference between the two manifests. Reading
`.git/HEAD`, the refs and `packed-refs` as raw text without following
symlinks adds `HEAD` and ref movement.

> **2026-10-14 — Historical measurement scope.** These walker timings do not
> qualify the released per-turn object-retention and on-disk accounting path.
> [#1790](https://github.com/schlessera/brain-kit/issues/1790) reproduced first
> and warm journal-admission health stalls; the following cost conclusion is
> superseded by the [native storage decision](native-brain-storage.md).

**Measured on 2026-10-11** on a tmpfs-backed workstation with Bun. The times are
a lower bound for disk-backed brains
([script](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6112823126)).

| Tree | Cold (first snapshot in a process) | Warm, no changes | Warm, 20 changed | Warm, mtime churn |
| --- | --- | --- | --- | --- |
| 5,000 files, 79 MB | 61 ms | 19 ms | 20 ms | 17 ms (100 files) |
| 20,000 files, 315 MB | 275 ms | 94 ms | 104 ms | 87 ms (400 files) |

That is cheap enough for two snapshots per turn, plus the intermediate
snapshots that the scope caps use.

**Why not git.** The first design used a private index copied from
`.git/index`, then `git add -A` and `write-tree`, with the brain's objects as
an alternate. It measured 18–68 ms. The review then showed four ways it fails:

- copied `skip-worktree` flags hide edits from the snapshot;
- filters and includes from writable files run, even with hooks and fsmonitor
  disabled;
- alternates make retained snapshots depend on brain objects that an agent can
  delete;
- clean and smudge normalization records bytes that differ from the working
  tree, so revert would compare and restore the wrong content.

The git-free walk avoids every one of them.

**Workspaces.** Each `workspaces/*` checkout is snapshotted by the same walk,
excluding its own `.git/`. Its `HEAD` and refs are read as raw text. No git
runs on the host in a workspace.

**What the journal does not snapshot:**

- **Ignored paths.** Scratch, `brain.db` and staged shares are listed by name
  and size, not stored.
- **Commits, pushes and other egress.** They are recorded but cannot be
  reverted.

A change to `.gitignore` is itself journaled and highlighted, because it can
hide later files from the snapshot.

**Concurrent turns.** Parallel sessions share one brain. A path that changed
while two writable turns overlapped is recorded in both journals, marked with
the overlapping turn ids. The journal states that the attribution is shared
rather than guessing.

The alternative was precise attribution: a snapshot around every mutating tool
call, under a brain-wide lock. That is what the lock design rejected
(`export function bashLockKey`, `packages/ui-sdk/src/server/lock-keys.ts:57`):
one session's long build would block every other session's tools.

**Revert.** The user reverts from the turn's history entry. Revert is a server
action: never an agent tool, never voice, never autonomous.

**Why the keyed locks are not enough.** Native writes take a per-path lock,
and arbitrary Bash writes take none, so `BRAIN_LOCK_KEY` cannot make
compare-and-restore atomic against a running turn.

**The writer gate.** Every writer of a journal target holds the brain's shared
**writer gate** from launch to exit:

- `governed` turns;
- `strict` turns, which can write workspaces and scratch;
- uncredentialed maintenance workers.

A credentialed maintenance worker holds it exclusively.

**No deadlock.** A turn never awaits a credentialed maintenance worker, because
the turn's own shared hold would block it forever. Maintenance that a running
turn waits for is credential-free; for example, the synchronous index after a
curated application. The automatic plain `brain index` command is keyword-only
and uses that same credential-free shared path. Flagged index operations,
including embedding and on-commit passes, retain the credentialed exclusive
path. Git transport and other credentialed work remain queued until no shared
holder remains.

Revert takes the gate exclusively too:

- it waits for running turns to finish;
- new turns queue behind it;
- the UI shows "waiting for running turns".

Revert also takes `BRAIN_LOCK_KEY` and `GIT_LOCK_KEY` against server routes.
Then:

- For each path, the server restores the pre-turn state, but only if the path
  still holds the turn's post-turn state. The comparison covers existence,
  type, mode and raw bytes. It uses descriptor-anchored opens without
  following symlinks, as the application route does.
- A path that has changed since is skipped and named as a conflict, like
  `stale_base` today. Revert never overwrites later work.
- A user may revert a single path.
- The revert is itself journaled, so it can be undone.
- Afterwards the server reindexes incrementally.

**Index refresh.** After every governed turn, the server runs an incremental
`brain index` under `BRAIN_LOCK_KEY`, off the turn's response path. Indexing
evaluates the brain config, so under the host execution boundary it runs in a
maintenance worker.

**Locking.** Native write tools and Bash go through the existing lock
classification:

- In Claude, the parent-side mutating hook takes `GIT_LOCK_KEY` or
  `BRAIN_LOCK_KEY` (`export function lockKeyForTool`,
  `packages/ui-backend-claude/src/tool-policy.ts:246`). The parent process is
  shared across sessions, so the lock is too.
- Pi takes its lock inside the worker (`brain: createBrainAccess(init.backend.brainPath), lock: init.sharedLock ?`,
  `packages/ui-backend-pi/src/worker-entry.ts:118`). Under `governed`, pi's tool
  lock must instead be the server's keyed lock, acquired over the worker RPC.
  Otherwise two pi sessions can interleave `git add` and `git commit`.

**Application tools coexist with direct writes:**

- **Server tools stay.** `brain_add`, `brain_update` and `brain_archive` keep
  their curated semantics, approvals, exact-base checks and synchronous
  indexing. `write_file` and `edit_file` remain the way to write under
  `strict`.
- **Native tools return under `governed`.** In Claude the
  `Write`/`Edit`/`NotebookEdit` disallow is lifted
  (`disallowedTools`, `packages/ui-backend-claude/src/sdk-options.ts:297`). In
  pi, the direct tools and a `bash` whose working directory is the brain root
  return (`const bash`, `packages/ui-backend-pi/src/tools.ts:541`).
- **Approvals do not change.** Confirmation patterns and destructive-operation
  approvals still run in the permission hooks. The journal adds the ability to
  undo; it removes no approval.

**Native stale writes.** Interactive sessions remember SHA-256 observations of
native file reads and writes. Before Claude `Write`, `Edit` or `NotebookEdit`,
and Pi `write_file` or `edit_file`, a different observed byte version refuses the
write with an ordinary native tool error. A path the session never read remains
writable. This is an optimistic check before writing, not a lock against an
external editor throughout a native tool's execution.

The parent observes the worker's resolved mount sources, including strict
startup copies and writable area aliases; it does not substitute newer
canonical bytes for a frozen view (`createWorkerFileObserver`,
`packages/ui-sdk/src/server/worker-file-observer.ts:13`). A failed or changing
read cannot establish a new version. Claude's native `file_unchanged` response
also preserves the previous observation: it supplied no new bytes
(`const finishNativeFile`,
`packages/ui-backend-claude/src/permission-hooks.ts:107`).

Claude keeps these observations in its backend-owned session map
(`const fileVersionsBySession`,
`packages/ui-backend-claude/src/turn-runner.ts:85`). Pi keeps them in its
backend-owned session runtime across fresh per-turn workers
(`const nativeFileVersions`,
`packages/ui-backend-pi/src/session-runtime.ts:19`); internal RPC reports
observation phases for the actual granted native operation, not a supplied hash
or authority. Both also retain observations in host-private records and restore them before
resumed native tools run. Claude keeps these records beside its transcript
archive; Pi keeps them under its host-owned session directory. Neither worker
receives them as writable state or serialized authority. The record is bound to
the canonical brain root and native session identity; filenames contain only a
SHA-256 identity. Atomic replacement, file and directory fsync, private modes,
regular-file validation and a 16 MiB per-session metadata bound protect the
record (`saveNativeObservations`,
`packages/ui-sdk/src/server/native-observation-storage.ts:56-69`).

Read and write admission first retain an unavailable observation. A crash after the
worker was shown or wrote bytes but before the completion callback therefore requires
a genuine reread; it cannot turn an observed path into a never-read path.
Successful stable reads and completed writes retain their versions at each
observation, rather than waiting for turn end. Corrupt, aliased or unreadable
records refuse resume before tools run; failed retention refuses subsequent
writes until storage recovers.

A retained session from before observation persistence, or one whose record
is missing, has incomplete read history. It requires a genuine read before a
native write to an unrecorded path. Rereading establishes that path's current
version. This conservative recovery cannot infer that an unrecorded path was
never read. Sessions with complete retained observations preserve the approved
never-read behavior across restarts. There is no reconstruction of authority
from worker transcripts, and no extension of the observed-shell guarantee.

## Monitoring

**Where it lives.** All monitoring is host operational state in `brain-ui.db`
and the host-private journal store. None of it goes in `brain.db`, which is
disposable, or in Markdown:

- These records describe what the host did, not knowledge the brain holds.
- Writing them into the brain would make every turn change the brain it is
  journaling.

The brain's git history stays the durable record of its content.

### Cost and budgets

**Source of truth:**

- **Per-response usage events.** Claude reports `CompletedResponseUsage`
  (`export class CompletedResponseUsage`, `packages/ui-backend-claude/src/usage.ts:11`)
  at `message_stop`. Pi reports usage at `message_end`.
- **General completed usage** is now reported for ordinary turns; autonomous
  Queue accounting keeps its separate sidechannel. The host stamps the
  additive `usage` wire receipt before presenting its shared below-turn facts.
- **The Activity recorder and its rollups** price those events under the
  [cost-tracking rules](cost-tracking.md). An unknown price is never counted as
  zero. The session total that counts unknown as zero
  (`msg.costUsd ?? 0`, `packages/ui-server/src/ws/session-catalog.ts:364`)
  must not feed any budget.

**Enforcement:**

- **At admission.** A turn is refused before launch, with the class
  `budget_exceeded`, when its session or day is already at a block limit. The
  check uses the same shape as the Queue's `admit`
  (`function admit`, `packages/ui-server/src/inbox/budget.ts:199`).
- **During the turn.** The server aborts the turn when a usage event crosses a
  block limit.
- **In Claude, as a backstop.** `maxBudgetUsd` is passed as well. The SDK maps
  it to `error_max_budget_usd` (`case "error_max_budget_usd"`,
  `stream-adapter.ts:464`).
- **Unpriced models.** The unknown portion has no invented USD price. A
  known priced lower bound may still reach a USD stop; otherwise token
  fallback is the enforceable alternative. Unknown is never treated as zero,
  and it never blocks by itself.

**Paid calls outside the agent's own stream.** A Bash call can run the `brain`
CLI's embedding, completion or image providers over and over. Those calls
produce no `CompletedResponseUsage` and are invisible to `maxBudgetUsd`. A
provider credential handed to a worker is therefore unmetered spend.

The design moves provider credentials out of workers. Paid provider calls from
a worker go through host-owned metered relays: the inference-relay pattern,
one route per provider. Each relay records usage on the turn and counts it
toward the same budgets.

Until a provider has a relay, the budget covers the agent's own inference only.
The capabilities note and the budget UI say so, rather than implying that G3
covers everything.

**Warnings.** Crossing a warn limit is recorded as a governance event. It
appears once, beside the existing cost display. It is also added to the
agent's next turn context.

**Default limits (G3), approved 2026-10-12.** The
[maintainer ruling](https://github.com/schlessera/brain-kit/issues/1669#issuecomment-6128541024)
approves turn warn $100/stop $200 and conversation/UTC-day warn $2,000/stop
$4,000. Unpriced token fallback stops are 512,000,000 per turn and
8,000,000,000 per conversation/day. Explicit policy values override defaults;
independent runtime/resource limits still apply.

The [public measured proposal](https://github.com/schlessera/brain-kit/issues/1669#issuecomment-6128436103)
uses four times the relevant observed p99, rounded upward: typed turn cost
$44.48 gives $177.92 → $200; recent complete tokens 116.52 million give
466.10 million → 512 million. Session/day known-cost lower-bound p99
$644.89/$813.45 give $2,579.55/$3,253.81 → $4,000; token lower bounds
1.5546/1.9834 billion give 6.2183/7.9336 billion → 8 billion. Warnings are
half the USD stops. The retained sample has 723 completed root session turns,
699 with known list prices. It excludes preparation, labels, cron and child
span cost; missing values and censored timeout tails limit this one workload's
measurement. Subscription effective zeros do not establish invoice percentiles
or a guarantee for every workload.

The host freezes the already admitted policy, uses the Activity calculator and
retained root rollups, and stores per-turn completed-response receipts outside
the brain. A measured new turn never takes a resumed SDK transcript's
cumulative terminal total: that can include earlier turns. Legacy Activity
rows remain historical inputs with explicit legacy attribution. Completed
responses contribute once to their server-observed UTC day; legacy history
uses its recorded start day. A terminal rollup never adds the live ledger a
second time. The concrete ledger is (`createTurnBudgets`,
`packages/ui-server/src/brain/turn-budgets.ts:43-193`).
Known priced lower bounds survive an unpriced model joining;
unknown usage alone never blocks. A token fallback remains enforceable.

The same receipt drives next-turn warning and single disclosure.

> **2026-10-16 — Implementation context.** The former routine
> [`inferenceBudgetNote`](https://github.com/schlessera/brain-kit/blob/53258a203d37ab32ae211c5f645cb32e2b3898d1/packages/ui-server/src/brain/turn-budgets.ts#L196-L198)
> appended running totals to every governed prompt. #2051 removes that suffix
> and strips its exact legacy shape only during UI replay, before local-command
> and message-metadata joins; saved provider transcripts remain unchanged.
> #2047 owns session-stable limits and actionable notices in new tail context.

Crossing keys retain once-only warning events by scope,
identity, unit and threshold. Conversation blocks offer the existing reviewed
handoff; a new conversation does not reset the day. Day stops display the
server's next UTC midnight. Neither stopped inference nor unavailable
accounting automatically retries. Warning arrivals do not steal focus and are
visual only in genuine voice; speech cannot grant a continuation. Autonomous
Queue budgets keep their existing admission and containment semantics.

### Scope caps (G4)

The policy's `scope` limits apply per turn to:

- distinct paths changed in the brain and workspaces;
- wall time;
- tool calls.

They have built-in defaults, chosen the same way as the budget defaults.

**Changed files need live observation.** A start and end snapshot only reports
the count afterwards; one Bash call can change thousands of paths and keep
running. So while a `governed` turn runs, the server takes warm snapshots at
each tool completion and every 15 seconds; each costs 20–104 ms at the
measured sizes.

When a cap is exceeded mid-call, the server freezes the worker's processes.
It uses the cgroup freezer when a cgroup is delegated, and otherwise stops the
process tree inside the worker's PID namespace. Then it escalates. The
permitted overshoot is what one observation interval allows, and the event
records it.

**When an interactive turn reaches a cap,** it pauses on the existing ask-user
card, which states what was reached and offers continue or stop:

- **Continue** raises that cap once for this turn and resumes the frozen
  processes.
- **Stop** ends the turn normally, with its journal intact.

**A voice turn cannot grant.** It stops at the cap and says so; the user
continues by asking again. **An autonomous turn** keeps its own limits from the
Queue.

Reaching a cap is recorded as a governance event and as a roadblock.

### Approved scope defaults and finite recovery — 2026-10-12 (#1670)

The [maintainer decision](https://github.com/schlessera/brain-kit/issues/1670#issuecomment-6128541457)
selects 500 calls (4 × observed p99 118, rounded upward) and 120 wall minutes
(4 × successful-turn p99 21.09 minutes, rounded upward). The call sample has
148 turns with complete retained detail; the successful duration population
has 699 turns. The all-outcome timeout tail was censored, not an uncapped
measurement. The 1,000 distinct-path and 4 GiB byte defaults are explicitly
provisional maintainer choices because historical distributions were absent.
Policy overrides remain supported; independent hard limits are unchanged.

Continue adds the original cap exactly once per dimension in the turn, with
the finite ceiling displayed first. A second hit for that dimension is Stop-only;
other dimensions retain independent grants. The existing max(5%, 2 GiB) free-space
floor is Stop-only. True voice stops, dictation is interactive, and Queue authority
is unchanged. Paused work remains paused with an authorized session client;
30 minutes with none connected stops it. Reconnect never resumes it. Restart
ends work and records interruption; event/turn/session-bound authenticated
replies are idempotent and expose answered-elsewhere/ended-before-answer receipts.

The monitor consumes the existing shared journal snapshots and the adapters'
parent lifecycle. It confirms cgroup freeze where delegated, otherwise STOP/CONT
of the verified worker namespace process tree. The trusted bubblewrap PID-1
reaper stays responsive to parent death while agent processes are stopped.
Periodic observation briefly freezes currently productive owned workers before
retaining changed versions. It resumes only those temporary holds whose turn
still has authority and has no cap pause; existing paused work never resumes.
Capture failure ends held work. This keeps cold retention cost from delaying
actual process freeze beyond the observation interval. The recorded observation
time follows capture and may be later than actual freeze; it is not relabelled
as the instant the writer stopped.
A frozen snapshot records observed overshoot. Bytes count captured changed
regular-file versions; snapshots do not capture overwritten intermediate writes,
and incomplete snapshots never imply zero or complete coverage.

The approved interaction reuses the in-turn ask-user card and the single
under-turn Disclosure. There is no free-text grant. Arrival never steals focus;
a local activated answer focuses its receipt only in the same active chat.
Disconnected/pending actions state their reason, and lost/failed receipts have
manual readback/recovery. Escape does nothing to the server operation. Exact
numbers wrap at the approved 320 CSS-pixel minimum and at 200% zoom in both
themes, with 44px targets and reduced motion. The picker exposes the actual
limits from the same policy inputs and states independent hard limits.

### Tool and command audit

**What exists.** The audit trail is the Activity span record: tool name, the
full input up to its cap, output and approval decisions
(`"tool_input"`, `packages/ui-server/src/activity/recorder.ts:287`).

**What changes:**

- **Retention.** Span detail is pruned after 7 days. Policy blocks and their
  inputs also become governance events, which follow the retention of the
  session.
- **Blocks.** The policy's `commands.deny` refuses a matching Bash input in the
  permission hook. `commands.confirm` adds to the existing confirmation
  patterns, using the same compiled-pattern mechanism. This introduces no new
  hook interface.

### Network egress

**Today.** Interactive and voice workers share the host's network namespace,
so nothing in them can be recorded or limited.

**The design.** A `governed` or `strict` worker gets `--unshare-net` and a
server-owned egress proxy, bind-mounted as a Unix socket in the same way as
the inference relay. The relay's `observe` hook already exists but is not
connected (`observe?(event`, `packages/ui-sdk/src/server/inference-relay.ts:34`).
Inside the worker, a small loopback listener forwards to the socket, and
`HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` point at it.

**What the proxy does:**

- **TLS.** It handles `CONNECT` only, with no interception, and records host,
  port, bytes and duration.
- **Plain HTTP.** It forwards the request and records the method, host and path.
- **Limits.** It applies the policy's allow and deny lists and the per-turn
  byte cap.
- **Defaults.** The default mode is `record` with every host allowed, which
  keeps today's reach.

**Measured facts and gaps:**

- **Claude CLI.** The bundled CLI (0.3.292) reads `HTTPS_PROXY`.
- **Bun.** The earlier source observation that fetch ignored proxy variables
  is historical. Offline 2026-10-16 qualification with installed Bun 1.4.2
  captures automatic HTTP_PROXY forwarding through the Unix transport in real
  governed and strict workers, alongside explicit-proxy and curl controls.
  This does not supply ordinary inference authentication, endpoint or billing
  qualification; those still require their native relay proof.
- **SSH remotes.** They need a `ProxyCommand` helper that tunnels through
  `CONNECT`.

**The gate.** The egress child must show that each first-party path works
through the proxy before the namespace is unshared by default:

- Claude and pi inference;
- `git` over HTTPS and SSH;
- `curl`;
- the `brain` CLI's providers;
- headless Chromium.

Until that measurement passes, the capabilities note says that egress is
unrecorded.

**Host Unix sockets.** A private network namespace does not stop `connect()` to
a filesystem socket that is visible through the read-only host root: a Docker
socket, a session bus, an SSH agent or a host proxy. Each of those is an
unrecorded way out, and some reach privileged host effects. The launcher
already masks `.git` in restricted workers for exactly this reason
(`function maskedGit`, `packages/ui-sdk/src/server/worker-launcher.ts:196`).
Interactive workers have the same exposure today.

`governed` and `strict` workers therefore mask the host's runtime and state
directories with empty read-only tmpfs mounts:

- `/run`, `/var/run`, `/var/lib`, `/tmp/.X11-unix`;
- every home directory except the brain's own path;
- `/root`, `/mnt`, `/media` and `/srv`.

After the masks, the launcher re-binds the runtime the worker needs, read-only
and file by file, with the same resolution the restricted envelope uses
(`export function restrictedReadPaths`, `packages/ui-sdk/src/server/worker-launcher.ts:1596`):

- the Bun executable;
- the backend entry and its `node_modules` chains;
- the bundled agent CLI.

This keeps a Bun or package install under a home directory or `/srv` working,
without exposing that whole directory again.

### Owned runtime placement beneath `/tmp` — 2026-10-14

The maintainer's ruling on #1844 selects support for a host-installed owned
runtime beneath `/tmp`. The launcher installs private turn temp first, then
retains only the existing concrete runtime closure read-only: the executable,
its owning package, dependency directories and resolved workspace packages.
Canonical locations and the installation aliases needed to execute them remain
available. Internal callers without a named profile use the same closure;
profiled, restricted, maintenance and mirror-transport callers keep their
existing authority and explicit read envelopes.

A runtime location cannot overlap reserved scratch, runtime state, writable
areas, XDG, maintenance HOME/state/output, relay/proxy, fresh procfs or device
mounts. Names, canonical targets and ancestors/descendants are checked before
dispatch, including unresolved final entries beneath an aliased parent. A
collision names the offending location and asks for a separate installation
directory. Runtime retention also reapplies explicitly masked private files
and subdirectories through retained aliases. It does not restore unrelated
host-temp siblings or make runtime bytes writable.

The concrete checks and mounts are in (`validateRuntimePlacement`,
`packages/ui-sdk/src/server/worker-launcher.ts:650-656`),
(`temporaryRuntimeMounts`, `packages/ui-sdk/src/server/worker-launcher.ts:657-696`)
and (`runtimeMaskOverlays`, `packages/ui-sdk/src/server/worker-launcher.ts:697-715`).
Alias restoration recognizes names already supplied by a read-only bind or an
explicit system-view symlink. It does not mount a canonical executable over an
existing alias such as `/bin/sh`; missing owned temporary paths still receive
only their narrow read-only binds.

Broad host-temp binding would reveal other workers and operator state; blanket
relocation would reject the selected supported placement. Neither is the
chosen correction. Private temp sizing, namespace/capability restrictions,
brain permissions, active host masks and cleanup retain their original rules.

The original report at `5dc2595ca07042f2e2024c95bbc361f31637559f`
recorded 285 passing experiment tests and two pre-request exit-127 failures;
moving the same bytes outside `/tmp` passed eight tests / 76 assertions. Those
historical controls identify the placement boundary, rather than qualifying
the eventual correction. The retained regression additionally executes equal
native bytes inside, outside and through an installation alias in every
applicable launcher mode, and captures actual installed Claude requests in a
loopback-only network namespace. No inference service or production store is
used. #1901 records this support amendment alongside #1844's implementation.

The mounts go on in a fixed order:

1. the masks;
2. the runtime rebinds above, all read-only;
3. the brain and the named writable areas, each with its profile's own
   permission (read-write for `governed`);
4. the protected-path and provider masks on top.

A brain under a masked home directory is therefore restored as writable, not
read-only.

The only sockets a worker keeps are the approved relay and proxy sockets. The
egress gate includes a probe that walks the worker's visible filesystem for
sockets and fails on any socket not on that list.

## The remaining guardrails

### Resource limits (G1)

Each `governed` or `strict` worker gets limits that always apply:

- **`rlimit`s**, set before the worker command's `execve`: private memory,
  number of processes, file size and open files. They need no privilege.
  `prlimit` sets them as the first program inside the worker's user
  namespace, where `RLIMIT_NPROC` counts only the worker's own tasks. The
  memory bound is `RLIMIT_DATA`, not `RLIMIT_AS`: Chromium reserves over a
  terabyte of address space and failed under every `RLIMIT_AS` that would
  bound anything (#1660,
  [measurements](../hosting/agent-workers.md#resource-limits)).
- **A cgroup v2 limit** on CPU, memory and pids, but only when the host
  delegates a cgroup to the server. Docker and rootless hosts may not. The boot
  probe (#1632) reports which limits are in force. Like the namespaces, a
  missing cgroup is stated, not silently assumed.
- **Sized tmpfs mounts** for turn temp and runtime state, owned by #1621 and
  #1625. They are the disk-side instance of the same class.
- **A free-space floor** for the persistent writable areas: the brain,
  persistent scratch and workspaces. `RLIMIT_FSIZE` bounds a single file, not
  the total, and project quotas need privilege the server does not have.

  So every scope observation also reads `statfs` for the brain's filesystem,
  and counts bytes written to scratch and workspaces since turn start. Below a
  free-space floor (default: 5% or 2 GiB, whichever is larger), or above the
  turn's byte allowance, the worker is frozen and the turn escalates, exactly
  as a scope cap does. The overshoot is bounded by one observation interval at
  the worker's write rate. That is an enforced bound, not a hard quota, and
  the record says so.

Defaults are generous. A worker that hits a limit fails that step, and the
failure is recorded as a roadblock.

### Data-to-provider routing (G2)

The policy may name which paths or document types may reach which inference
provider:

```yaml
providers:
  - paths: ["me/**", "finance/**"]
    allow: [anthropic]
```

**Whole-folder sequencing (maintainer, 2026-10-16).** Whole-folder exclusions
are qualified first, preserving the live brain and existing shared-writer
concurrency. Literal `folder/**` selectors need stable roots and ancestors in
every writer view: a private tmpfs attached to an old directory does not hide a
replacement directory created by a peer. Newly admitted governed workers retain
these directories with read-write self-binds; shared gate plans inherit active
peers' roots across policy removal. Host publication independently refuses root
or ancestor removal/replacement, since worker mount points cannot constrain host
syscalls. Contents and permitted siblings remain writable. Missing or aliased
folder topology is not invented through placeholder creation or overlays.
Resolver-owned folder qualification is private and tied to the exact brain
identity; public layout facts or copied layouts cannot mint folder mounts.
The governed live launcher verifies the actual retained mount points and inode
identities through its authenticated, still-gated worker view. A host-path check
before spawning does not prove what bubblewrap subsequently mounted. Unknown
views refuse before payload start; the existing separate-UID broker does not
attest these folder mounts, and its state/temp authority is not repurposed into
generic process inspection. This closes a launch-time check/mount gap without
claiming complete active-peer or protected-reader admission.

Known-unsafe active peers refuse new governed folder admission: legacy or
missing-root plans cannot retain the requested topology. A retained descendant
also pins its ancestors, while an ancestor alone does not pin arbitrary children.
Unknown checking capability refuses. Existing peers continue, nested shared
maintenance stays admissible, and strict consumers keep their existing path.
Successful plan checks remain nonattestation and cannot authorize a protected
reader; complete active-writer provenance remains required.

These are topology primitives, not complete privacy admission or recipient
proof. Gate root sets are plans rather than attested mounted identities; legacy
writers, races with unqualified peers, policy changes, copies in history/indexes
and server tools all need qualification before worker routing can activate.
Actual recipients cannot be inferred from cost routes or model/vendor labels.
Arbitrary type/glob exclusion criteria remain required; this sequencing does not
waive them or approve different writer concurrency or filtered content overlays.

**Agent turns.** Paths not allowed for the turn's provider are masked in its
worker. A directory is masked with an empty read-only tmpfs, and a single file
with a read-only bind of `/dev/null`. Permitted siblings stay visible. The
capabilities note lists what is masked.

**Copies of the same content are filtered too.** The working tree is not the
only copy:

- **The index.** `brain.db` holds document bodies. A turn with masked paths
  gets the real `brain.db` masked, and a turn-private, **writable** filtered
  copy without those documents in its place. The CLI's capture and index
  commands open the database for writing, so a read-only copy would break
  them. The copy is disposable. After the turn the server reindexes the real
  index from Markdown, in a maintenance worker, so captures made in the turn
  reach it.
- **Git history.** The `.git/` directory carries committed versions. Such a
  turn sees `.git/` masked, as restricted turns do, so history is unavailable
  to it.
- **Server tools.** Search, read and context tools refuse masked paths for
  that turn, with a named refusal.

Setting a provider restriction therefore costs the affected turns git history,
and the user is told so when the policy is checked.

**Indexing.** The same rule feeds [embedding eligibility](embedding-eligibility.md):
a path that may not reach the configured embeddings provider keeps keyword
search and gets no vectors.

### Worker identity (G2)

> **2026-10-15 — Architecture and recovery amendment.** The argv-only helper,
> direct mount access and maintenance-reader descriptions below are the earlier
> design, not delivered cross-uid behavior. The [external broker amendment](#external-worker-broker-and-best-effort-recovery--2026-10-15)
> records the selected October 14 architecture and October 15 E ruling. It
> supersedes those mechanisms and absolute recovery/reclamation implications,
> while retaining the identity controls, optional-host behavior and budgets.

The maintainer [ruled on #1638](https://github.com/schlessera/brain-kit/issues/1638)
on 2026-10-11 that a worker uid separate from the server's uid is the
`governed` profile's identity model, under G2.

**Why a separate uid.** Today a worker runs as the server's kernel uid
([agent workers](../hosting/agent-workers.md#running-the-server-as-root)).
Once the brain is writable, any code the agent runs has the server's file
authority over the read-only host root. That includes the server's database,
its Claude and pi credentials, and its environment files. The masks in this
record cover only the paths they name:

- #1626's `$HOME` overlay;
- the runtime and home-directory masks;
- the `.env*` mask.

A separate uid denies access by ownership, including paths nobody thought to
list.

**Where the switch happens.** Neither the worker nor the exec wrapper can make
it. The exec wrapper runs inside the worker
(`export function createWorkerSpawn`, `packages/ui-backend-claude/src/worker-spawn.ts:86`).
An unprivileged user namespace cannot change its outside uid, and bubblewrap
cannot either. The uid therefore changes *before* `bwrap` starts, through a
helper the host provides:

- a setuid helper in a container;
- or a uid launcher on a bare host.

**What the kit and the template each own.**

- **brain-kit owns the launcher seam** (#1677). An optional host-supplied
  identity helper sits in front of `bwrap`. It follows the exec wrapper's
  rules (`export const EXEC_WRAPPER_ENV`, `packages/ui-sdk/src/server/exec-wrapper.ts:39`):
  an absolute path in argv position 0, and the worker as its own process
  group. `kill(2)` across uids returns `EPERM`, so every signal goes through
  the kill helper. The helper's protocol
  (`<killer> <pgid> <TERM|KILL|INT>`, `packages/ui-sdk/src/server/exec-wrapper.ts:53`)
  gains `STOP` and `CONT`. A scope cap without a delegated cgroup stops and
  resumes the worker through them (see "Scope caps"). Signalling the process
  group is not enough. `bwrap --new-session` puts the payload in a session and
  group of its own. The pid the launcher holds is bubblewrap's outer
  supervisor, which stays in the server's PID namespace.

  So the launcher reads the sandbox child's pid from bubblewrap's
  `--json-status-fd`. It checks that this pid is a descendant of the
  supervisor, in a PID namespace other than the server's. For `STOP` and
  `CONT`, the helper gets that child pid and signals the whole process tree
  rooted at it. It walks parent links in `/proc`, so processes in nested PID
  namespaces are covered too. It repeats the walk until a pass finds no
  process it has not already stopped, which catches anything forked during
  the pass.
- **The hosting template owns the packaging.** That means the two fixed uids,
  the setuid identity helper, the kill helper with `STOP` and `CONT`, the
  ownership map, the volume migration and the container proof. Its `docs/decisions/container-privilege.md`
  already designs a `brain` server uid, an `agent` uid in group `brain`, and
  `/data/db` at `0700`. That record predates the bubblewrap worker and is being
  reassessed:
  - the helper now wraps the one `bwrap` launch, not each agent subprocess;
  - its rule that the CLI runs as `agent` is already met by this record's
    maintenance workers.

**Shared objects the kit creates.** The two uids share the brain, scratch,
workspaces, turn temp, runtime state and the relay sockets through a common
group, with setgid directories. Setgid sets only the group, though, and the kit
creates its per-turn objects with private modes today. Runtime state
(`export function createClaudeWorkerState`, `packages/ui-backend-claude/src/worker-state.ts:136`)
and the inference relay
(`export function startInferenceRelay`, `packages/ui-sdk/src/server/inference-relay.ts:61`)
both use `0700` directories and `0600` files or sockets. With a helper configured,
the kit therefore creates these with explicit group ownership and group modes:

- runtime state and turn temp: `0770` directories and `0660` files;
- the relay directory: `0750`;
- relay and proxy sockets: `0660`.

The launcher's FIFOs stay as they are: already-open, unlinked descriptors with
no path to share.

**Files the worker makes private.** The worker owns what it creates and can
`chmod` a file to `0600` or a directory to `0700`. Setgid and the umask cannot
prevent that. So when the server's descriptor-anchored read for the journal,
promotion or runtime-state persistence gets `EACCES`, it does not give up. It
reads those bytes through an uncredentialed maintenance worker that runs under
the worker uid and streams the raw bytes back. That worker evaluates nothing,
so the rule that the journal runs no git and imports no repository code still
holds.

A file that stays unreadable is journaled by name and size only and is not
revertible. It is recorded as a governance event and as a roadblock.

**Verification from inside a real worker.** The probe checks:

- the outside uid is not the server's and is not 0;
- **the negative control:** a sentinel the server creates at boot, `0600` in
  a `0700` directory beside its database and outside every mask, refuses to
  open. Opening a masked path proves nothing: a masked directory opens empty,
  and a hidden one is not proof of ownership;
- **the positive controls:** the worker can write scratch and turn temp, read
  and write its runtime state, and connect to the relay socket. The brain
  check depends on the profile: a write succeeds under `governed` and is
  refused under `strict`.

If any check fails, `governed` and `strict` are refused, with a named
host-status reason. The mutation proof makes both the sentinel's directory
(`0750`) and the file (`0640`) reachable by the group. The worker's open then
succeeds, and the probe must refuse. Nothing private to the server is
group-readable.

**Without a helper,** `governed` still runs. A laptop or a single-user server
keeps working, with the masks as the only protection. The launcher also masks
the configured database directory explicitly. The host status and the
capabilities note say that the worker shares the server's uid.

**Overlap with the other G2 controls.** The brain's `.env*` files sit in the
group-shared tree, so a separate uid does not hide them; the mask stays
(#1666). With a helper configured, a root-run server's worker is never uid 0,
which removes the root read and socket authority that #1638 describes for
those hosts.

### External worker broker and best-effort recovery — 2026-10-15

The maintainer selected this architecture in
[#1677](https://github.com/schlessera/brain-kit/issues/1677) on October 14 and
qualified its guarantees with **option E, practical safeguards with explicit
limits**, on October 15. [#1894](https://github.com/schlessera/brain-kit/issues/1894)
records these amendments. These are approved design requirements; recording
this decision does not implement the broker or establish integrated proof.

**Why an argv-only switch is insufficient.** The cross-uid control in #1677
used a non-root server uid, a different nonzero worker uid and a shared group.
An ordinary group-shared directory was accessible, but the worker's private
mount and namespace links through `/proc/<pid>` were denied. Changing the
private directory to `0770` did not remove that process-access barrier. The
current launcher opens mounts directly (`function openPrivateState`,
`packages/ui-sdk/src/server/worker-launcher.ts:955-983`;
`function openPrivateTurnTemp`,
`packages/ui-sdk/src/server/worker-launcher.ts:988-1014`) before population and
start-gate release (`export function launchAgentWorker`,
`packages/ui-sdk/src/server/worker-launcher.ts:1147-1206`). Group modes and a uid
switch alone therefore cannot implement the selected cross-uid lifecycle.

**Authority and launch.** One trusted external supervisor owns each worker
launch and stays outside the agent sandbox. It is long-lived and unprivileged;
short-lived privileged helpers perform only that launch's authorized uid
switch, private-mount acquisition, identity/ancestry/namespace verification and
worker-tree signalling. The server remains non-root and neither it nor the
supervisor retains broad process-inspection authority.

Each helper operation authenticates the original server-owned launch, protects
against PID reuse and uses trusted bootstrap/status evidence. Caller uid alone
is insufficient. Reject unrelated or reused pids, arbitrary host paths,
repository-selected helper executables, shell prefixes and general privileged
commands. Missing, malformed or spoofed status, wrong uid/namespace and
substituted mounts fail closed; no same-uid fallback is permitted when the
helper is configured.

Before the start gate opens, verify each required mount's identity, type and
exact allowance, retain only its authorized directory handles, and populate
bounded starting state. Setup failure terminates the unstarted worker and
cleans up partial handles and reservations. The server retains mount access
for space observation, post-exit persistence and promotion. Existing private
kernel-bounded tmpfs mounts, per-worker allowances and aggregate admission
budgets remain; this ruling approves neither a storage redesign nor new quota
modes or capacity. Native-stage authority and output validation remain binding
under [native brain storage](native-brain-storage.md).

Trusted control channels, transferred mount handles, launch authorization and
helper privileges never reach the agent payload or its descendants. Descriptor
transfer in the trusted broker must preserve the payload's existing descriptor
filter (`// Close every non-protocol descriptor explicitly.`,
`packages/ui-sdk/src/server/worker-entry.ts:38-40`). Shared brain/scratch/workspace
ownership and the specified group modes remain required, but do not substitute
for verified mount access or private-file recovery.

**Private files.** A retained mount handle does not bypass a worker-created
`0600` file or `0700` directory. A fixed trusted raw-byte reader runs under the
worker uid, without provider credentials, repository imports or evaluation.
The supervisor supplies only authorized retained handles, including after the
original worker exits. Reads remain descriptor-anchored, path/alias constrained,
regular-file checked and byte bounded. An unreadable file remains name/size-only,
not revertible, with the governance event and roadblock. Privileged helpers do
not open arbitrary individual private files or stream their bytes as root.

**Termination and recovery.** Supervisor death or loss of authenticated control
terminates the verified worker tree and reports a named supervision failure.
The termination mechanism must remain authorized and effective after the
supervisor has died. Cancellation and server death cover owned descendants,
including nested PID namespaces. Keep TERM/KILL/INT semantics and the verified
worker-tree STOP/CONT extension; incomplete signalling cannot yield a false
stopped, resumed or terminated receipt. No replacement supervisor, automatic
replay or continued unsupervised execution is selected.

Recovery begins only after verified owned-tree termination and completion of
the implemented owned-I/O cleanup. It is **best-effort recovery of observed
bytes**, not an atomic snapshot of mutable runtime state or temporary output.
Never persist or promote while a known owned-tree writer survives. Lost handles,
unreadable files, incomplete recovery and uncertain cleanup remain explicit;
recovery cannot turn supervision failure into a successful turn.

The #1677 counterexample transferred a writable private-tmpfs descriptor through
an abstract Unix socket to a cooperating process outside the origin tree. That
recipient could still write after origin exit and an empty origin cgroup. It
was a narrow disposable-kernel/bubblewrap experiment, not integrated broker
qualification or proof of a journal exploit. External handles, mappings or
outstanding operations can outlive the supervised tree, mutate a source or
delay physical reclamation. A stable completed copy need not represent an
atomic source capture; empty cgroups and closed server handles do not prove
global object quiescence or reclaimed memory.

Keep configured bounds and account for known retained/recovery resources until
owned handles and storage are released, exactly once on every exit. State the
remaining external-reference accounting limitation explicitly; do not claim
strict host-wide reclamation. Address the demonstrated handoff path and obvious
reachable defects with proportionate implementation review and targeted runtime
controls. Option E does not require universal capability confinement, full tenant
isolation, a new UID/IPC/LSM policy or exhaustive proof of every OS channel. It
does not waive a detected failure or an existing guard.

**Ownership and proof.** brain-kit owns protocol framing, launcher/status and
budget integration, the fixed reader integration and fixture-based qualification.
[brain-hosting-template #18](https://github.com/schlessera/brain-hosting-template/issues/18)
owns production helper binaries/build/install, supervisor packaging, fixed
users/groups, ownership, migration and container proof. No production setuid
binary is built or shipped in brain-kit. Template packaging is downstream of
#1677, not a reverse implementation prerequisite.

Integrated qualification must run actual launch/populate/space/persist/promote
with a genuinely non-root server and a different real nonzero worker uid.
Retain the unmasked private-server sentinel and original positive controls,
strict/governed brain behavior, no-helper database mask/disclosure and no-cgroup
nested-PID freeze/resume proof. Exercise post-exit private-file reads with byte
limits, malformed authorization/status/descriptor/mount controls, supervisor
kill/control disconnect, server death, cancellation during setup/copy-out and
cleanup/accounting. Keep focused failing-first/restored mutations for the uid,
sentinel, database mask, authorization, descriptor filtering, owned-writer
recovery and supervision-loss controls. Test each guard at the boundary it
protects, accounting for redundant defenses. Do not claim universal confinement
from those receipts or substitute predicate-only tests for the runtime.

**Why not the alternatives.** A host-wide privileged daemon would introduce
shared authority and lifetime beyond one launch. A privileged long-lived
supervisor or broad server ptrace/root access would retain authority that the
short-lived helpers are intended to contain. An in-sandbox keeper shares the
agent's attack surface and cannot supply independent supervision. Privileged
private-file recovery conflicts with the selected uncredentialed worker-uid
reader. Freeze-and-replacement recovery could continue a turn after its trusted
supervision was lost; the selected policy instead fails and terminates it.
Unbounded shared storage, Btrfs/qgroup redesign and universal cross-worker
confinement do not follow from this ruling. The existing optional no-helper,
same-uid mask-only mode remains available with truthful host-status disclosure.

### Outward actions (G5)

**Inside the brain, nothing is outward.** Journaled edits, commits to the
local repository and scratch output are free.

**What counts as outward.** The server classifies a tool call as outward with
deterministic rules, in the same way `bashLockKey` classifies git verbs:

- `git push` to any remote;
- `gh` and GitHub API write verbs;
- MCP tools whose descriptors declare an external effect, such as mail,
  calendar, booking or payment;
- non-GET HTTP requests that the egress proxy can see.

**What happens to it.** An outward action raises the existing approval card
unless the policy's `outward.allow` lists it:

```yaml
outward:
  allow:
    - { command: "^git push origin ", remotes: ["github.com/*"] }
```

- A force-push or other history rewrite of a remote always asks.
- Voice can refuse an outward action but never approve it.
- Autonomous turns have no outward actions.

Each outward action is recorded with its attribution. Because it cannot be
reverted, it is listed in the journal as irreversible.

**Delivered visible-command admission (#1664).** Both adapters share the
visible Git, GitHub CLI and explicit HTTP-write classifier and use the existing
per-use command cards. Named Git push destinations are read only by a
credential-free isolated maintenance command in the worker's actual startup
configuration view; the host-selected maintenance admission domain and masks
remain in force. Unknown or multiple push destinations cannot match an allow
rule. Force, deletion, mirror and prune writes ask even with a matching rule.
Approval edits are rechecked against their exact visible input; retries need
fresh per-use approval. Native Pi retains its existing refusal of voice turns;
the Claude voice gate and Pi's shared permission gate refuse outward calls.
Autonomous admission remains unchanged.

The shipped Claude and Pi tool inventories supply local brain tools and read
capabilities, but no built-in outward mail/calendar/booking/payment MCP
descriptors. The fixed outward descriptor inventory is consequently empty;
this implementation does not assign invented external effects to third-party
names. Capabilities explicitly disclose that opaque HTTPS scripts are outside
this visible-command coverage and that the egress proxy is not active.

Every visible outward admission is retained as `outward_action`, including
refusals. The existing expanded turn disclosure lists these as irreversible
external actions, names their approval decision, and does not claim that an
external action completed. Local-file restore is never offered for them.
Classification observations include the exact call identity, decision and
unknown-segment coverage; they confer no egress authority by themselves.

**Opaque network code.** A script making an HTTPS `POST` shows nothing in its
tool input, and a `CONNECT`-only proxy cannot see the method. Classification
cannot catch it, so enforcement moves to the destination. The policy names
**outward hosts**, the write APIs reachable from the user's credentials, with
defaults for the GitHub API and mail submission. A `CONNECT` to an outward
host waits on an approval card ("a command wants to connect to
api.github.com"), unless one of two things is true:

- the tool call in progress was classified and approved as that outward action;
- it was classified as a read, such as `gh issue view`.

What G5 promises is therefore:

- classified actions ask;
- unclassified connections to outward hosts ask;
- connections to other hosts are recorded, and are only limited in
  `allowlist` mode.

`egress.mode: allowlist` restricts destinations. It does not by itself approve
outward actions to an allowed host. A user who wants approval on every
destination lists the allowed write-capable hosts under `outward.hosts` as
well. An opaque `POST` to an allowed host outside `outward.hosts` is recorded,
not approved.

### Untrusted input (G6)

A session becomes **tainted** the first time a turn ingests content it did not
author:

- `WebFetch` and `WebSearch` results;
- staged shares in `.brain-ui/inbox`;
- reads under `workspaces/`;
- email or other MCP-sourced documents;
- files the user marks untrusted;
- **any connection from inside the worker other than the inference relay**,
  recorded by the egress proxy. This covers `curl`, CLI scrapers, headless
  Chromium and opaque scripts, whose provenance cannot be told apart.

Before the egress proxy lands, Bash commands classified as fetching (`curl`,
`wget`, `git clone` and `fetch`, the `brain` scrape and import commands, and
Chromium) taint the session. Any Bash call that the classifier cannot rule out
as network-free also taints it. Erring towards taint costs only tighter
outward rules.

Taint is sticky for the session, because that content stays in the context
window. A tainted session runs under tighter rules:

- egress switches to the policy's `taint.egress` allow-list, which by default
  is the hosts already used in the session plus the inference relay;
- every outward action asks, even if `outward.allow` would allow it;
- writes to steering artifacts are flagged in the journal (below).

Ingesting untrusted content never blocks the turn. Taint changes only what
the turn may send out and how its writes are labelled.

### Steering artifacts (G7)

Steering artifacts include `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Pi context
files, `.claude/`, `.agents/`, `.pi/`, `.mcp.json`, and
`context/scheduled-tasks/`. The finite configuration seed mapping is consumer-qualified:

- The core CLI loads `brain.config.ts` or `brain.config.json` at the canonical
  brain cwd (`loadUserConfig`, `packages/core/src/lib/config.ts:590-624`).
  Host commands bind that cwd to the selected brain (`function hostSpawn`,
  `packages/ui-server/src/brain/host-boundary.ts:410-421`).
- Bun startup uses root `bunfig.toml` and `package.json`; retained literal
  preload/module inputs can identify a nested module's nearest package scope.
  The inventory walks parent directories only within the originating journal
  scope and includes that `package.json` as module-resolution metadata, without
  activating its scripts. This follows Bun's
  [module resolution](https://bun.sh/docs/runtime/module-resolution) and
  [startup configuration](https://bun.sh/docs/runtime/bunfig) rules.
- Claude's project MCP location is root `.mcp.json`; its cwd is the selected
  brain (`const sdkOptions`, `packages/ui-backend-claude/src/sdk-options.ts:264-281`).
  Existing instruction, skills, `.claude/`, `.agents/`, `.pi/` and scheduled-task
  surfaces remain unchanged. Their retained module references can likewise
  identify package metadata within that same scope.

A manifest or lockfile in a dependency tree or cloned workspace does not itself
identify a consumer. Declared projects/scripts do not establish execution.
Root-only discovery was rejected because genuine nested module consumers need
package metadata; any-depth basename discovery was rejected because incidental
clones and dependencies became false seeds. No repository configuration is
executed during discovery. Conditional package maps, computed configuration,
unsupported commands and unobserved working directories remain coverage
limitations; this finite mapping never claims arbitrary shell/runtime coverage.
Ignored, oversized, unreadable and opaque genuine inputs remain named as
classification limitations (`nativeJournalSteeringInputs`,
`packages/ui-server/src/brain/journal-steering.ts:121-130`).

The journal follows only data-only references with a supported input role;
quoted strings and file extensions do not establish consumption. Seed selection
is now consumer-qualified independently of reference classification (#2028). The finite mapping is in
(`steeringReferences`, `packages/ui-server/src/brain/journal-reference-roles.ts:20-123`):

| Consumer | Followed input role | Resolution and limits |
| --- | --- | --- |
| Claude instruction imports | Standalone unquoted `@path` lines outside code, recursively to four hops | File-relative literal input, including extensionless text. Inline/escaped/ambiguous forms remain unknown. See the [consumer documentation](https://code.claude.com/docs/en/memory#import-additional-files). |
| Bun [`bunfig.toml`](https://bun.sh/docs/runtime/bunfig#preload) | Root and `[test]` `preload` arrays | Local module references relative to the config file; other properties such as install caches are not inputs. |
| `package.json` | `scripts` executable, known interpreter entry point and preload flags | A single literal command/argv relative to the manifest directory. Bun/Node entries and `--preload`, `--require`, `-r`, `--import` inputs are followed; ordinary arguments/output paths are not. Shell programs, aliases, substitutions, compound commands and unsupported flags stay unknown. |
| Claude settings | `hooks.<event>[].hooks[]` with `type: command`, `command` and optional `args` | Executable roles relative to the scope root; the installed SDK settings schema supplies these fields. Prompt-hook text and arbitrary properties are not file references. Plugins remain unknown. |
| `.mcp.json` | `mcpServers.<name>.command` and `args` | Same literal executable/interpreter roles; network server URLs and ordinary arguments are not local steering dependencies. |
| Pi settings | `extensions`, `skills`, `prompts`, `themes` arrays | Relative to the settings directory, matching the installed `DefaultPackageManager.resolve` consumer. Computed/glob/package/directory discovery stays unknown. |
| Core JSON config | Local `modules` keys | `<key>/module.ts`, then `module.js`, relative to the config, as the core loader selects. Package modules and TypeScript config evaluation stay unknown. |
| Local JS/TS inputs | Literal module imports/exports/requires identified by Bun's parser | File-relative bounded resolution, including genuine text/extensionless resources. Runtime resource reads, computed imports and package resolution remain unknown. |

This mapping was checked against core's (`loadModules`,
`packages/core/src/lib/module-loader.ts:95-103`), (`importManifest`,
`packages/core/src/lib/module-loader.ts:192-224`), Pi's (`build`,
`packages/ui-backend-pi/src/session-resources.ts:85-129`) and the installed
Pi 0.99.2 package-manager/settings consumers and Claude SDK 0.3.293 settings
schema. Nothing imports or evaluates repository configuration on the host.
Followed JSON resources do not acquire configuration-consumer semantics merely
from a basename; configuration roles belong to known seeds. Both retained-object
and sealed-root readers share classification and the
1 MiB input bound (`nativeJournalSteeringInputs`,
`packages/ui-server/src/brain/journal-steering.ts:121-130`). Ignored, unreadable,
oversized, unsupported or ambiguous inputs are named as coverage limitations;
unknown never fabricates a consumed path or a claim of complete runtime coverage.

The resolved disposable index and its `-wal`, `-shm`, `-journal` sidecars are
excluded by exact journal-relative identity before reference lookup. Core's
current identity is `<root>/brain.db`, established by (`initContext`,
`packages/core/src/lib/context.ts:36-52`); core has no configurable index-location
field. Internal callers may supply an already resolved identity without
executing configuration. This excludes no unrelated same-basename resource.
The inventory preserves scope boundaries, policy exclusions and bounded
readers (`steeringInventory`,
`packages/ui-server/src/brain/journal-steering.ts:20-107`).

The maintainer selected role classification over an index-only exception,
script-extension whitelist or their combination (#2026): none of those
alternatives distinguishes a genuine extensionless instruction input from an
ordinary output or data argument. This changes classification only; operational
file presentation and observed-path accounting remain separate.

Changes are allowed and journaled with class `steering`. The single initially
collapsed turn disclosure includes the steering count; expanded steering comes
first. Review uses the existing raw diff reader and user per-file/whole-turn
revert controls. No extra collapsed banner or steering-group action is added.
Policy is separate, class `policy`, excluded from the steering count, and only
the approved user route writes it.

The [approved review hierarchy](https://github.com/schlessera/brain-kit/issues/1846#issuecomment-6197338526)
keeps retained changes ahead of configuration-identification inventory. Stored
class, scope, ignored flags and kind group each change once; filenames never
suppress observations or infer a writer. Ignored paths retain their metadata
explanation separately from other nonregular entries, and genuine missing
versions retain their own reasons. The optional authoritative configuration
coverage summary supplies a compact incomplete glyph outside label truncation;
omitted and unknown evidence never claims completeness. Turn facts collapse
without hiding retention, shared-writer, partial or budget warnings. Every
configuration path remains in the filterable, bounded-height list; filtering
announces once 500 ms after the last input. Same-turn reads retain the prior
details, filter, scroll, focus and open disclosures until replacement, including
read errors. Session/turn changes and unavailable retained states cannot reuse
another window's details. This changes review hierarchy, not capture, changed
path counts, retention, budgets, attribution or recovery authority.

Each steering observation retains a governance event and shared-window
attribution. If an existing same-session/turn taint event precedes an agent
observation, the journal retains its source ID with that change. Replay never
infers taint from a later event, and absence of evidence does not assert complete
untrusted-input detection. User history operations are not tainted agent writes
(`async function observe`, `packages/ui-server/src/brain/turn-journal.ts:185-253`).

Claude auto-memory persists outside the authoritative brain. Its validated
native copy-out wraps each changed direct `.md` note in host journal retention:
exact before/after objects and the private destination are staged and pinned
before saving; only a successful save publishes the attributed steering change.
The logical `claude-memory://<note.md>` path and `claude_memory` scope cannot
collide with a canonical brain-relative path. Host directories, credentials,
transcripts and settings never become journal change entries. Taint is captured
from existing session/turn evidence at save time, not inferred on replay.

The existing reader and authenticated per-file/whole-turn recovery use the
private saved destination. Current bytes and saved-directory identity must match
before restoration, preserving later memory. Revert is user-attributed and
journaled for Undo; voice/agent/autonomous actors gain no recovery authority.
Ordinary persistence never deletes notes. Refused or interrupted saves retain
truthful partial/unconfirmed history, including the window between file commit
and receipt finalization. Staged raw versions remain under the same aggregate
cap, active pins and completed-turn retention/collection. This is the external
memory completion of the earlier 0.42.0 steering slice, not a widening of memory
providers or a claim of capturing intervening external writes. The copy-out
boundary is `const write`, `packages/ui-backend-claude/src/worker-state.ts:201-215`;
retention/finalization is `persistClaudeMemory`,
`packages/ui-server/src/brain/turn-journal.ts:352-387`; destination-bound recovery
is `const target`, `packages/ui-server/src/brain/turn-revert.ts:106-116`.

### Concurrent edits

Parallel sessions, autonomous proposals, server routes and the user can all
edit the same file. None of them may silently overwrite another; there is no
last-write-wins.

**Server routes already refuse.** They refuse a stale base (`stale_base` in
the application route). Revert does the same.

**Native write tools refuse as well:**

- A `PostToolUse` hook records the hash each session last read for each path.
- A `PreToolUse` hook on `Write`/`Edit` (and pi's direct tools) compares the
  current hash with that record.
- If another actor changed the file in between, the tool is denied with "changed
  since you read it; read it again". That is recorded as a roadblock.

**Shell writes are detected after the fact, at observation granularity.** They
cannot be checked before they happen. Each observation point records a
version: the turn start, every tool completion, the 15-second scope snapshots
and the turn end. The journal compares each changed path with other actors'
entries that overlap this turn's window. When both changed a path, every
version an observation captured is kept, and the entry is marked as a
conflict. The user resolves it from history by keeping one version or keeping
both, as `brain sync` does.

The history reader names explicit retained observations rather than inferring
exclusive "mine" or "theirs" ownership. A conflict requires two distinct
observed after-versions sharing an overlapping turn; one version remains shared
attribution. User choices use the existing authenticated history operation,
comparing current raw state with the reviewed latest observation before effects
(`resolveSelection`, `packages/ui-server/src/brain/turn-revert.ts:49-72`).
Keep both creates the other version beside the selected file with sync's
numbered `-remote` convention, using exclusive descriptor-rooted creation,
existing CAS leases and explicit coverage for its final generated name
(`createJournalSibling`, `packages/ui-server/src/brain/revert-files.ts:74-102`).
The same user journal records both effects and enables stale-safe Undo; index
refresh follows. Nothing here promises atomic merging or recovers an
unobserved overwritten version.

**The guarantee is narrower than "nothing is lost".** A version that one shell
write created and another overwrote between two observations was never
captured, and it cannot be recovered. The guarantee is:

- no **observed** version is lost;
- every overlap that shows up as an observed change on a path is reported.

Two writers that change a path and restore its original bytes between
observations leave no trace, and none is promised.

Closing the gap completely would need a capture on every write, which means
either file watching (rejected below) or serializing writers (rejected with
precise attribution).

## What each profile tells the agent

The capabilities note from #1626 is the only generator of this statement. It
renders from the resolved mount list, the resolved policy, the worker-state
budget from #1621 and #1625, and the host status from #1632, so the statement
and the enforcement cannot drift.

| Profile | The note states |
| --- | --- |
| `governed` | The brain is writable, and changes are journaled and revertible by the user. The read-only paths are listed, along with the reason each is protected. The three write areas, and that links must point into the brain or `.brain/scratch/`. The active budgets and how much remains. The blocked and confirmed command patterns. Egress mode, or that egress is unrecorded. The policy hash, and that the policy can be read but not written, with changes proposed through the approval tool. |
| `strict` | The brain is read-only. Edits go through `write_file`, `edit_file` and the curated tools, and a direct write fails with `EROFS`. The named writable areas. Budgets, commands and egress as above. |
| `restricted` | Unchanged: the autonomous system prompt and its roster. |

The delivered host note (#1654) receives history availability through the
existing resolved sandbox. The shared renderer is
(`workerSandboxNote`, `packages/ui-sdk/src/server/worker-sandbox.ts:477-527`).
Journaling is stated as active only after this
turn's real observation window is admitted; user restoration additionally
requires the concrete mounted history service and a non-voice turn. Missing
host facts stay unrecorded, and hosts missing a service do not promise it.
Both adapters inject the shared generator's exact protected paths/reasons and
history statement. Only the authenticated user can restore retained observed
paths through history; the agent gains no revert or Undo tool. The statement
preserves overwritten-between-observations and stale-conflict limitations,
with no automatic revert and no new budget or egress authority.

An `EROFS` or a refused write under any profile names the rule that refused it
and the allowed alternative. It is also recorded as a governance event.

## Roadblocks and governance events: tracked, not noise

The product principle and ruling 7 together require one record of everything
that got in a turn's way. Each record is machine-readable, kept on the host and
quiet by default.

### Governance events

Every sandbox or governance intervention writes one versioned JSON record:

- auto-promotions and refused promotions;
- policy blocks and confirmations;
- read-only refusals;
- tier A and tier B quarantines;
- budget warnings and blocks;
- egress denials;
- `strict` fallbacks;
- revert conflicts.

Each record carries `kind`, `schema_version`, the turn, the session, the time
and fields specific to its kind. Records go in a governance-event table in
`brain-ui.db`, kept with the session rather than with the 7-day span detail.

#1651 built the table, its one validating writer and the read endpoint. The
[HTTP specification](../http-api.md#governance-events-additive-1651) lists
every kind's payload. Each event also carries the attribution: the actor, the
model and the profile. An event whose turn never named a session, such as a
new conversation refused at admission, has no catalog row to live with and is
kept for 90 days.

### Main-model attribution timing

The maintainer's 2026-10-16 ruling (#2037) chooses additive runtime main-model
identity propagation and guarded active-turn journal binding. Admission remains
before worker execution: explicitly configured identity is usable immediately;
runtime defaults remain unknown until the backend reports its executing main
model. Helper/subagent usage and mixed-model totals cannot choose that identity.
Runtime reports are scoped to the current turn and session; cancellation,
completion and a reused bridge cannot revive or change a finished turn.

Governance records are snapshots of identity known at emission. Earlier nulls
remain null in stored, live, replayed and exported evidence. Only the correlated
active journal summary gains the reported identity; there is no backfill,
amendment stream or read-time enrichment. This deliberately accepts incomplete
early attribution rather than rewriting emitted evidence or introducing an
unselected provenance representation. An admission refusal cannot acquire an
invented runtime identity. See the [interface contract](../integration-contract/package-api.md#interactive-main-model-identity-additive-2037).

### Roadblocks

A roadblock is a failed step inside a turn. The kinds are:

- a tool error;
- a nonzero shell exit;
- `EROFS` or `EACCES`;
- a permission or policy denial;
- a budget block;
- a network refusal;
- a repeated attempt at the same intent.

**How roadblocks are classified.** The server classifies them from the Activity
frames it already relays, and from the governance events, with deterministic
rules and no model call:

- An **episode** opens at a failed step and resolves at the next successful
  step of the same tool family. Without that path it remains unresolved.
- The episode records the failing calls, the **resolving path** if there was
  one, and the **waste**: the tokens, cost and time spent between failure and
  resolution.
- **The remedy class.** A resolving capability the turn already had means
  **guidance**; a turn-temp workaround means **capability**. An unresolved
  episode with exactly one failure, no retry and a later eligible success is
  **abandoned**. Repeated unresolved failures remain **capability**.
- **Unresolved waste has an accounting boundary.** After the last failure is
  known, the first successful call of any family that starts strictly later
  bounds waste at its start. A success already in flight does not qualify.
  Without one, waste runs through turn end. Usage is sampled at the boundary;
  final turn usage is used only for a turn-end bound. Unknown evidence stays
  unknown. Actual same-family resolution retains its original bound/remedy.

**Superseding the original rule (#2034, maintainer decision 2026-10-16).**
Originally every unresolved episode meant capability and waste through turn
end. This exaggerated isolated missing-path probes even after successful work
on another path. The selected boundary and abandoned inference are deterministic
accounting/diagnostics: an unrelated success can underestimate causal waste,
and neither proves the missing capability became available or intent was
satisfied. Semantic `resolution` remains null without a same-family resolving
path. Keeping the old upper bound preserves noisy rankings; bounding alone
still labels isolated probes capability; direct-only attribution misses recovery
effort; cross-family intent inference would require unselected heuristics or a
model. Historical stored events are retained without reclassification.

**How #1671 built it.** The turn recorder already sees every relayed frame for
both backends. It keeps each call's tool, input, result and denial, and at
turn end it classifies them together with the turn's other governance events
(`export function classifyRoadblocks`,
`packages/ui-server/src/governance/roadblocks.ts:462`). Each episode is stored
as one `roadblock` event; the
[HTTP specification](../http-api.md#governance-event-kinds) gives its fields.
The choices that shape the report:

- **Families are narrow enough to mean "the same intent".** A shell call's
  family is its program, plus the subcommand for multi-command programs such
  as `git push`. Compound-command headers and reserved words are structure:
  `for …; do git push …; done` shares the plain `git push` family. Conditions,
  iteration lists and case patterns do not become the body program. This
  remains a segment-based heuristic rather than a full shell parser.
  Otherwise any later `ls` would resolve a failed `git push`.
  File tools from both backends share `file_write` and `file_read`, so Claude's
  `Write` and pi's `write_file` group together.
- **Failure causes are read from what each backend reports.** Claude Code
  marks a failed command as an error and appends `Exit code N`. It treats exit 1
  of `grep`, `rg` and `diff` as an answer. The classifier does the same for
  both backends, but only when one of those programs ends a single pipeline,
  because in a command list the status could have come from another member.
  pi's `bash` output ends in `[exit N]` without an error flag. The pi tool now
  writes that line after its output clip, so a long failing output still ends
  with it. `EROFS`, `EACCES` and `EPERM` text makes a failure `fs_denied`, and
  resolver or connection errors make it `network_refused`.
- **Governance events outrank the text.** A `policy_block`,
  `read_only_refusal`, declined `policy_confirm` or `outward_action`, or
  `egress_denial` written while a failed call ran sets that call's category
  and is cited in `eventIds`. `budget_block` and `scope_cap` stand on their
  own, as does a backend's own `max_budget` or `max_turns` ending.
- **The signature is a grouping key, not a log line.** It keeps the family,
  the program or a structural target directory and the cause. It drops file
  names, arguments, hosts, directory names the user chose and absolute roots,
  so the report can rank one roadblock across sessions without storing what
  the agent wrote.
- **Order follows what the agent could know.** A failure sits on the timeline
  when its result arrived, so a parallel call that started earlier never
  counts as the way around it.
- **Waste is measured, never estimated.** Tokens and cost come from cumulative
  usage reported during the turn, including source-qualified completed inference
  from interactive, voice and autonomous turns. Missing token or cost samples
  remain `null`; a final result total cannot fill an earlier boundary. Time is
  always recorded.

**The report.** Session history and Activity live only in the host's
`brain-ui.db`. The `brain` CLI never opens that database, and workers cannot
reach it. So the report is an authenticated server endpoint that returns
JSON, and the agent reads it through the existing `query_activity` bridge
tool. It is not a `brain` subcommand.

The endpoint ranks roadblock signatures across sessions by frequency and by
waste, each with its suggested remedy class and example turns. #1672 implements
four separate rankings (count, measured tokens, measured cost, time) through
one retained-event aggregation (`export function queryRoadblockReport`,
`packages/ui-server/src/governance/roadblock-report.ts:24-79`). Mixed remedies are
reported as guidance/capability/abandoned counts. The default actionable view
excludes abandoned episodes before grouping, ranking, totals and example turns;
`remedy=all` includes them and a named remedy selects only that class. This
filter is identical over HTTP and `query_activity`; retained event reads still
expose the original evidence. Unknown-cost
and unknown-token counts accompany sums of known values, which remain null
when no measurement exists. [The tool contract](../integration-contract/mcp.md#chat-ui-in-process-tools-mcp__brain-ui__)
specifies limits and deterministic ties. Everything stays
on the host, and nothing is sent anywhere.

### What reaches the user

Only two things are user-facing: the journal with its revert, and a budget
warning, block or refusal. Ruling 4 asked for both to be visible. Everything
else here is read through the report.

## Alternatives rejected

- **Keep the read-only default and add more server routes.** Ruling 1 rejects
  it. Every unrouted tool, from Chromium to `git fetch`, would need its own
  route. Production showed that the gap is the way the maintainer works, not
  an edge case.
- **Writable overlays or copied authoritative brains.** They were declined on 2026-10-05,
  and they would also hide one session's writes from parallel sessions until
  commit. The complete read-only startup execution view is the explicit
  2026-10-12 exception, with separate server-validated output publication.
- **File watching.** inotify misses changes under load and has watch limits.
  fanotify needs capabilities that the unprivileged worker host lacks.
- **Landlock to deny protected paths.** Landlock only grants rights on
  hierarchies. It cannot deny a name inside a writable one.
- **A read-only root with each top-level entry bound separately.** It would
  stop absent root-level names. But renaming over a bind-mounted file returns
  `EBUSY` (measured above), which breaks atomic saves and `git checkout` of
  root files such as `CLAUDE.md`.
- **Hash-activated policy (R36).** It adds friction without protection, given
  the mounts. See [The policy file](#the-policy-file).
- **Policy inside `brain.config.ts`.** That file is executable code that the
  host imports. Policy must be data.
- **Audit or journal in `brain.db`, or in Markdown.** The first is disposable.
  The second makes every turn write the brain it is journaling.
- **A TLS-intercepting proxy.** It would put a host CA and decrypted
  credentials inside the record path. Host-level records are enough for
  per-turn limits.
- **A pluggable policy engine or monitor interface.** Excluded by the
  no-new-seams rule. One concrete schema and one set of monitors.

## Questions left open

- **SSH egress.** Whether SSH goes through `CONNECT` with a `ProxyCommand`
  helper or keeps host networking under an explicit policy flag is settled by
  the egress measurement. The recommendation is the helper, so that the
  namespace is uniform.
- **Policy grants for autonomous turns.** Ruling 3 defers them. This schema has
  no key that reaches autonomous turns, so adding one is a later, separate
  ruling.
## Settled release defaults

The [maintainer’s later ruling on #1636](https://github.com/schlessera/brain-kit/issues/1636#issuecomment-6114233107)
settles both calls on 2026-10-11: `governed` is the default in 0.42.0 despite
interim maintenance-worker credential exposure, which host status states until
the relays and mirror land. `strict` remains opt-in. `governed` also remains
available without a separate-uid helper, with mask-only protection stated in
host status; the hosting template always ships the helper.

## Host-owned web-search direction — 2026-10-15

The [maintainer's C ruling on #1863](https://github.com/schlessera/brain-kit/issues/1863#issuecomment-6187551558)
settles provider configuration, credentials and authenticated web-search execution
on the host. Ordinary Pi workers request the capability through a constrained,
authenticated bridge. This supersedes the earlier worker configuration-snapshot
direction; it does not authorize provider credentials in worker files or
environment, host HOME exposure, repository code in a credentialed executor,
cross-session result sharing or expanded restricted autonomous authority.

This is policy for the pending integration, **not a statement that the relay is
shipped**. Existing egress, credential and spend-coverage limitations above
remain true until their implementation is qualified. The bridge must preserve
per-turn permission, data-routing, taint, attribution and budget admission,
including extraction fallbacks and nested model calls. Unknown external spend
remains unknown; host-owned execution alone does not measure every paid call.

[#1969's comparison](../plans/host-owned-web-search.md) examines pinned upstream
MCP and a real full-extension executor, their feature/auth losses, trusted
adapters and bounded offline worker evidence. The
[maintainer's timing ruling](https://github.com/schlessera/brain-kit/issues/1863#issuecomment-6188083290)
reserves the executor choice until that comparison is reviewed. Neither this
amendment nor a successful plain-search prototype selects an executor or grants
additional host model, UI, browser, shell or credential-command authority.


#### Approved host OAuth refresh placement (2026-10-16)

The #1665/#1666 maintainer ruling moves stored-login Claude OAuth refresh to
the host, replacing the earlier native-worker ownership of that operation.
The [runtime amendment](claude-code-runtime.md#host-owned-stored-login-refresh-2026-10-16-amendment)
binds the bounded protocol, credential-maintenance serialization, offline
qualification and activation gate. Native login acquisition, Pi's supported
native auth runtime, per-request provider identity and billing, and the ban on
provider credentials in governed worker files/environment remain binding.
Delivering the internal resolver does not activate the ordinary worker relay or
qualify the remaining egress paths and socket isolation.
