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

The default is productive. A hard boundary exists only for one of four
guardrail classes. Everything outside them is allowed, observed, revertible and
tracked as a roadblock when it fails.

| Class | What it prevents | How this record enforces it |
| --- | --- | --- |
| **G1 — system integrity** | Breaking the host, the server, the policy, git internals or the kernel interface | Worker namespaces and the read-only host (with `/proc/sys` covered read-only in #1629). Tier A protected paths with self-bound ancestors. Quarantine of unexpected tier A files. Hardened host git. Workspace git runs inside a worker. |
| **G2 — data exfiltration** | Secrets or brain content leaving the host unseen | `.env*` is masked, not only read-only. The host `$HOME` is replaced by #1626's per-turn overlay. Egress is recorded, then allow-listed and byte-capped by the policy. The goal is inference through the server relay, so a `governed` worker holds no provider credential. |
| **G3 — budget runaway** | Cost growing without a stop | Turn, session and day limits that **block**, not only warn. Admission refusal, a mid-turn abort, and Claude's `maxBudgetUsd` as a backstop. |
| **G4 — scope runaway** | A turn that goes on and on: too many files, too much time, too many tool calls | Per-turn caps on files changed, wall time and tool calls. Reaching one **escalates to the user** rather than failing silently. |

Every sub-issue of #1636 names the class or classes it serves. Work that serves
none of them may not add a block. It may add observation, revert or roadblock
tracking.

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
- Writable overlays and copied scratch brains stay declined.

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
| Host root | Read-only | Read-only | An explicit read envelope |
| Network | Host namespace until the egress monitor lands, then a private namespace with the egress proxy | Same as `governed` | Loopback plus the inference relay |
| Claude native `Write`/`Edit`/`NotebookEdit` | Available | Disallowed. The server tools are used instead. | Not in the roster |
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

**Where a turn falls back to `strict`.** The launcher refuses to start
`governed` when a protected path is a symlink, a hardlinked file
(`nlink > 1`), or another mount, using #1626's guard. In that case the turn
runs under `strict` and its capabilities note says why. Falling back to
`strict` gives a stronger boundary, not a weaker one, so "no weaker fallback"
still holds.

**Voice.** Ruling 1 makes voice `governed` too. Voice keeps its narrower
membership (`VOICE_ALLOWED_TOOLS`, `packages/ui-backend-claude/src/tool-policy.ts:119`):
no Bash, no raw `Write`/`Edit`, no archive, and approval returns false
(`const apply = createBrainApplication`, `packages/ui-server/src/ws/bridge.ts:428-432`).
A voice turn therefore writes only through curated capture and update, now
with a journal behind it. The writable mount gives voice no tool it lacked.
Pi still refuses voice turns.

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
  (`if (folded[0] === "context"`, `packages/ui-server/src/brain/application.ts:36`).
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

## Protected paths

Protected paths are what the host executes or trusts. A write to one of them
would let a turn act outside its worker or change its own governance.

| Tier | Paths | Can the policy release it? |
| --- | --- | --- |
| A — host-executed or authority | `context/policies/`, `.git/config`, `.git/config.worktree`, `.git/hooks/`, `.git/info/`, `.git/modules/`, `brain.config.ts`, `brain.config.json`, `.env*`, `bunfig.toml`, `package.json`, `bun.lock`, `node_modules/` | No |
| B — runtime permission surfaces | `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` | Yes |
| Added by the policy | Anything listed under `protect` | Yes, by deleting the entry |

**Why each tier A path is there:**

- Host git runs hooks and config: fsmonitor, filters and `sshCommand`.
  `brain sync` and the journal run git on the host.
- The host imports `brain.config.ts` (`export async function loadUserConfig`,
  `packages/core/src/lib/config.ts:590`).
- Bun reads `.env` and `bunfig.toml` at process start, and module resolution
  walks into `node_modules`.

**`.env*` is masked, not only read-only (G2).** A present `.env*` file is
replaced inside the worker by a read-only bind of `/dev/null`. The agent cannot
read the brain's API keys. A CLI provider that needs a key must receive it
through the worker's filtered environment instead. Before the mask ships, the
G2 sub-issue establishes which in-worker paths read `.env`. Otherwise masking
would turn embeddings or search into a roadblock.

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
would break the brain. Two rules close the gap instead:

1. **The host never loads a tier A file it did not see at turn start.**
   - The launcher records the tier A manifest (path, existence, device, inode,
     hash) for the turn.
   - The server's config loader chooses which file to import from the
     manifests of running turns, not from a fresh `existsSync`. A file that
     appeared during a turn is never imported.
   - A present file is read-only, so its bytes cannot change.
   - This removes the check-then-import race in `loadUserConfig`.
2. **At turn end, unexpected files are quarantined.** Any tier A or tier B file
   that did not exist at turn start is moved into the turn's journal
   quarantine and removed from the brain. A diagnostic record is written, and
   the user can restore the file from history.

   A user who creates such a file from a terminal while a turn is running sees
   it quarantined. That is the accepted cost.

**Symlinks.** A symlink an agent creates toward a protected file resolves to
the read-only mount (`EROFS`). A symlink toward the host root resolves to the
read-only host. Server routes that serve brain files keep their existing
no-escape resolution. Server code must not follow a brain symlink out of the
brain.

**The probe changes.** `probeWorkerHost` gains a `governed` mode. It proves
that a protected sentinel is unchanged and that an unprotected sentinel *was*
written, in addition to today's checks.

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

**Diagnostic records.** Each promotion is recorded with the source path,
destination, bytes, turn id and both links. A promotion over the per-turn size
bound is refused, the link is left unchanged, and that is recorded the same
way.

**Pinning.** A link into `.brain/scratch/` pins the target. Prune skips pinned
files (`export function pruneScratch`, `packages/core/src/lib/scratch.ts:491`).
A pin is released when every conversation that links the file is deleted or
falls out of retention. If the scratch area still exceeds its size limit
(`SCRATCH_MAX_BYTES`, `scratch.ts:52`) after unpinned files are pruned, the
overage is reported. Pinned files are never deleted.

**Expired links.** A link whose file is gone renders as "expired", not as a
404.

**Why automatic promotion.** The alternative was a visible flag on the link,
which keeps the agent honest without copying anything. It lost because the
agent can only see turn temp, and the user can only reach scratch. A flagged
link is still a broken link, and fixing it costs another turn. The bounded
copy and the diagnostic record keep promotion honest without showing anything
to the user.

## The change journal and reconciliation

**Snapshots.** At turn start and at turn end, the server snapshots the brain's
working tree into a host-private git object store:

- a private index, seeded from a copy of `.git/index` so the stat cache stays
  warm;
- `git add -A`, then `git write-tree`;
- `GIT_OBJECT_DIRECTORY` pointing into the private store, with the brain's
  objects as an alternate.

The journal entry is `git diff-tree` between the two trees, plus `HEAD` and
ref movement.

**Where the journal lives:**

- Snapshot objects stay in the host-private store, beside `DB_PATH`.
- Journal rows go in `brain-ui.db`.
- Nothing goes in the brain's `.git`, so an agent cannot delete a turn's
  evidence, and journals do not bloat the brain repository.

**Measured on 2026-10-11** on a tmpfs-backed workstation with git 2.55. The
times are a lower bound for disk-backed brains.

| Tree | Clean snapshot | Snapshot after 21 changes | `diff-tree` | Snapshot after mtime churn |
| --- | --- | --- | --- | --- |
| 5,000 files, 79 MB | 18 ms | 20 ms | 6 ms | 27 ms (100 files) |
| 20,000 files, 315 MB | 28 ms | 53 ms | 9 ms | 68 ms (400 files) |

That is cheap enough to take two snapshots per turn on the turn path.

**Host git is hardened.** Every git invocation the host runs against the brain
sets:

- `-c core.hooksPath=/dev/null` and `-c core.fsmonitor=false`;
- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.

The brain's own `.git/config` is tier A.

**Workspaces.** A workspace's config and hooks are agent-writable, so the host
never runs git in a workspace directly. Workspace snapshots run git inside a
`strict` worker with no network. The workspace is read-only there, and only the
private object store is writable. Workspace `HEAD` and ref movement are
recorded too.

**What the journal does not snapshot:**

- **Ignored paths.** Scratch, `brain.db` and staged shares are listed by name
  and size (from `git ls-files -o -i` before and after), not stored.
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
action: never an agent tool, never voice, never autonomous. It runs under
`BRAIN_LOCK_KEY` and `GIT_LOCK_KEY`:

- For each path, the server restores the pre-turn bytes, absence or mode, but
  only if the path still holds the turn's post-turn bytes.
- A path that has changed since is skipped and named as a conflict, like
  `stale_base` today. Revert never overwrites later work.
- A user may revert a single path.
- The revert is itself journaled, so it can be undone.
- Afterwards the server reindexes incrementally.

**Index refresh.** After every governed turn, the server runs the incremental
index under `BRAIN_LOCK_KEY` (`indexAll` with `force: false`, as the
application route does), off the turn's response path.

**Locking.** Native write tools and Bash go through the existing lock
classification:

- In Claude, the parent-side mutating hook takes `GIT_LOCK_KEY` or
  `BRAIN_LOCK_KEY` (`export function lockKeyForTool`,
  `packages/ui-backend-claude/src/tool-policy.ts:242`). The parent process is
  shared across sessions, so the lock is too.
- Pi takes its lock inside the worker (`lock: toolLockFromKeyed(createKeyedLock())`,
  `packages/ui-backend-pi/src/worker-entry.ts:71`). Under `governed`, pi's tool
  lock must instead be the server's keyed lock, acquired over the worker RPC.
  Otherwise two pi sessions can interleave `git add` and `git commit`.

**Application tools coexist with direct writes:**

- **Server tools stay.** `brain_add`, `brain_update` and `brain_archive` keep
  their curated semantics, approvals, exact-base checks and synchronous
  indexing. `write_file` and `edit_file` remain the way to write under
  `strict`.
- **Native tools return under `governed`.** In Claude the
  `Write`/`Edit`/`NotebookEdit` disallow is lifted
  (`disallowedTools`, `packages/ui-backend-claude/src/sdk-options.ts:188`). In
  pi, the direct tools and a `bash` whose working directory is the brain root
  return (`const bash`, `packages/ui-backend-pi/src/tools.ts:514`).
- **Approvals do not change.** Confirmation patterns and destructive-operation
  approvals still run in the permission hooks. The journal adds the ability to
  undo; it removes no approval.

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
- **Today those events are sent only for autonomous turns**
  (`kind: "autonomous_usage"`, `packages/ui-backend-claude/src/stream-adapter.ts:72`).
  They become a general `usage` frame for every turn. Adding a new frame kind
  to the protocol is an additive contract change.
- **The Activity recorder and its rollups** price those events under the
  [cost-tracking rules](cost-tracking.md). An unknown price is never counted as
  zero. The session total that counts unknown as zero
  (`msg.costUsd ?? 0`, `packages/ui-server/src/ws/session-catalog.ts:248`)
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
  `stream-adapter.ts:422`).
- **Unpriced models.** A USD limit cannot be evaluated when the price is
  unknown. The turn is recorded as unpriced and a token limit is the
  enforceable alternative. Unknown is never treated as zero, and it never
  blocks by itself.

**Warnings.** Crossing a warn limit is recorded as a governance event. It
appears once, beside the existing cost display. It is also added to the
agent's next turn context.

**Default limits (G3).** Blocking limits are on by default. A brain without a
`budgets` key still gets built-in turn and day limits. The budget sub-issue
derives them from the measured distribution of recorded turn cost in Activity
rollups, using a generous multiple of the observed high percentile, and records
the numbers. Ordinary turns never reach a default limit; a runaway turn does.

### Scope caps (G4)

The policy's `scope` limits apply per turn to:

- distinct paths changed in the brain and workspaces, counted from the turn's
  journal;
- wall time;
- tool calls.

They have built-in defaults, chosen the same way as the budget defaults.

**When an interactive turn reaches a cap,** it pauses on the existing ask-user
card, which states what was reached and offers continue or stop:

- **Continue** raises that cap once for this turn.
- **Stop** ends the turn normally, with its journal intact.

**A voice turn cannot grant.** It stops at the cap and says so; the user
continues by asking again. **An autonomous turn** keeps its own limits from the
Queue.

Reaching a cap is recorded as a governance event and as a roadblock.

### Tool and command audit

**What exists.** The audit trail is the Activity span record: tool name, the
full input up to its cap, output and approval decisions
(`"tool_input"`, `packages/ui-server/src/activity/recorder.ts:225`).

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
connected (`observe?(event`, `packages/ui-sdk/src/server/inference-relay.ts:33`).
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
- **Bun.** Bun's `fetch` ignores proxy variables, as an existing comment in the
  scrape package records. Pi's inference must therefore use the relay socket,
  as restricted turns already do.
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

- An **episode** opens at a failed step and closes at the next successful
  step of the same tool family, or at turn end.
- The episode records the failing calls, the **resolving path** if there was
  one, and the **waste**: the tokens, cost and time spent between failure and
  resolution.
- **The remedy class.** An episode that was resolved with a capability the
  turn already had is classed as **guidance**. An episode that was never
  resolved, or was resolved only through a workaround such as writing to turn
  temp, is classed as **capability**.

**The report.** Session history and Activity live only in the host's
`brain-ui.db`. The `brain` CLI never opens that database, and workers cannot
reach it. So the report is an authenticated server endpoint that returns
JSON, and the agent reads it through the existing `query_activity` bridge
tool. It is not a `brain` subcommand.

The endpoint ranks roadblock signatures across sessions by frequency and by
waste, each with its suggested remedy class and example turns. Everything stays
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
- **Writable overlays or copied brains.** They were declined on 2026-10-05,
  and they would also hide one session's writes from parallel sessions until
  commit.
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
