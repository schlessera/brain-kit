# Agent worker host boundary

The [all-writer decision](../decisions/policy-write-boundary.md) introduced
isolated workers before an agent writer initializes (#1035). The later
[governed-worker decision](../decisions/governed-writable-workers.md) makes
`governed` the 0.42.0 default for interactive and voice turns: ordinary brain
files are writable, while the resolved protected paths remain protected.
`strict` is opt-in and keeps an immutable read-only brain view; autonomous
turns retain their restricted envelope. The shared launcher and actual host
probe enforce the selected profile, with no host-execution fallback.

The server checks the actual configured brain before each interactive, voice,
queued, autonomous and handoff-summary turn. A failed check refuses before
`startTurn`, session/transcript writes or activity-runtime creation. Its visible
message names the missing requirement and the Linux/qualifying WSL2 route;
ordinary error frames carry `failure.errorClass = worker_host_unsupported`.
There is no flag, environment override, weaker profile or unsandboxed fallback.
Standalone autonomous callers default their brain path to the working directory;
hosts with another brain must supply `brainPath`.

The probe uses the real launcher, a disposable nonempty sentinel on the
configured brain filesystem and a nonempty scratch write/read control. It
observes the sentinel from the host, bounds launch execution to five seconds,
and removes its sentinel directory on either outcome. The host must be able to
create and remove that owned fixture. Checks are repeated, not cached from a
version string or an earlier turn.

The server also runs the probe at boot (#1632): the ordinary mode always, and
the restricted mode while autonomous work is enabled. While the Claude backend
is active, both also mount the Claude worker's runtime-state tmpfs at its
configured allowance (#1625). A failure is logged once
with its requirement and does not refuse the boot, because everything except
agent turns still works. `/api/status` reports the latest probe per mode as
`runtime.workerHost`, and each turn's own probe and each "Check again" update
it ([contract](../integration-contract/http.md#worker-host-status-additive-1632)).
While it says the host is unavailable, the app shows a notice above the
composer with the requirement and a link here. The status never admits or
refuses a turn; only that turn's own probe does.

## Process and filesystem coverage

`launchAgentWorker` (first-party internal SDK sharing) starts a trusted bootstrap
with three owned FIFO channels. Bun 1.4.2's `"pipe"` channels are Unix sockets,
so the launcher uses `mkfifo`, opens the two ends, and unlinks the private FIFO
paths before launch. The bootstrap validates actual pipe descriptors 0–2 and
refuses unexpected inheritable descriptors. It explicitly closes descriptors
above 2 before `process.execve`; runtime CLOEXEC descriptors are discarded at
exec too. Bun's read-only `/dev/urandom` descriptor is explicitly closed. A
refusal reports only on a validated pipe, so policy-backed stderr cannot be
modified even by the diagnostic itself.

Before bubblewrap executes, the bootstrap runs GNU coreutils `env` from
`/usr/bin/env` or `/bin/env` with `--default-signal`. It restores every
catchable signal disposition to its default, including Bun's inherited
SIGPIPE and SIGXFSZ ignores (#1690). SIGKILL and SIGSTOP cannot be reset.
This option changes dispositions only; it adds no signal-mask policy. The
requested runtime remains free to install its own handlers. A host needs
GNU `env` with this option; a missing or unsupported binary fails the real
worker probe and refuses agent turns.

Bubblewrap establishes user, PID, IPC, UTS and mount namespaces, drops all
capabilities, mounts the host root read-only, and replaces `/proc` and `/dev`.
The brain mount follows the resolved profile: governed permits direct writes
except to protected paths; strict executes from an immutable read-only startup
view. Restricted autonomous turns keep their existing read-only envelope.
When the server runs as root, the worker's whole `/proc` is read-only as well (#1629, see [running as root](#running-the-server-as-root)).
`/tmp` is a private tmpfs of a fixed size, the worker's
[turn temp](#turn-temp-allowance-and-the-turn_temp-tool), and holds the
per-turn scratch location, which cannot overlap the brain or its ancestors.
Governed turns use the verified scratch and workspace areas at their canonical
paths. Strict turns write private area copies through `/tmp/brain-worker-areas/`
aliases, with validated publication after exit. Host home remains read-only
and may be hidden by the resolved profile masks; per-turn XDG directories are
in turn temp. See
[what a turn can write](#what-a-turn-can-write-and-where-outputs-go). The
worker receives only explicit environment entries and `BRAIN_WORKER_SCRATCH`.
Turn temp is sized with bubblewrap's `--size`, so every worker needs
bubblewrap 0.7 or later; 0.9 is eligible.
A Claude worker's runtime state is a private tmpfs that bubblewrap sizes with
`--size`, so Claude needs bubblewrap 0.7 or later; the per-turn probe mounts it
and checks its size.
The worker and its descendants are inside the boundary. PID-namespace ownership,
`--die-with-parent` and the returned process handle support cancellation.
The caller owns the returned stdin/stdout/stderr streams and closes or destroys
them when cancelling a worker.

The privileged server, its validated application route and code loaded before
the bootstrap are outside this boundary. #1037 and #1038 moved Claude and pi
SDK/extension initialization into these workers. The integrated
adapter/application proof is `tests/policy-write-boundary.test.ts` (#1039);
the [decision record](../decisions/policy-write-boundary.md#the-integrated-proof--1039)
lists its cases. A passing host probe alone still does not establish that proof.
Interactive and voice workers share the host network namespace and see a
read-only host root. Autonomous turns use the restricted envelope below.

## Claude runtime state and transcript archival

Each Claude worker gets its own **private, size-limited tmpfs** for its runtime
state (#1625): the session files, settings, credentials, the account file and
the project's auto-memory notes (`memory/`). The worker sees it as
`CLAUDE_CONFIG_DIR`; no other worker and no host path can see it. Transcript
state is session-scoped: a resume copies only that session's JSONL and
companion folder; a new conversation copies no transcripts. The server copies
the snapshot in before the runtime starts and, after the worker and its whole
PID namespace are gone, copies back only changed JSONL files for the resumed or
newly created sessions, plus new or changed `memory/*.md` notes directly in the
memory folder. Other saved sessions are untouched. Copy-out refuses links,
hardlinks, special files and anything past the allowance; a memory note another
conversation changed during the turn is not overwritten and is named in the
error, the other notes still persist, and nothing is deleted. An autonomous
turn copies nothing in and writes nothing back. If the server process dies, its
workers and their tmpfs mounts go with it; nothing is left to clean up.

The allowance does not cover the worker's other writable places (`/tmp` and
`$BRAIN_WORKER_SCRATCH`, which have
[their own allowance](#turn-temp-allowance-and-the-turn_temp-tool), and
workspaces) or its process memory. It is
not a worker memory limit. Where the worker has a cgroup memory limit
([resource limits](#resource-limits)), the tmpfs pages the worker writes count
toward it like its other memory; the pages the server copies in before the
worker starts do not.

### Configuring the allowance and the budget

| Setting | Default | Meaning |
| --- | --- | --- |
| `BRAIN_UI_WORKER_STATE_BYTES` | `67108864` (64 MiB) | Each worker's runtime-state tmpfs, in bytes. |
| `BRAIN_UI_WORKER_STATE_BUDGET_BYTES` | allowance × `MAX_CONCURRENT_SESSIONS` (192 MiB at the defaults) | What all running workers' allowances may add up to. |

Both are whole numbers of bytes, digits only, multiples of 4096; the budget must
hold at least one allowance. An invalid value stops the server at boot with a
message naming the variable. They are host configuration: nothing in the brain
can change them, and a worker keeps the allowance it was admitted with until it
exits, whatever the configuration says later.

Before a worker launches, the server reserves its **whole allowance** against
the budget. Effective capacity is therefore
`floor(budget / allowance)` workers at once, and never more than
`MAX_CONCURRENT_SESSIONS` sessions. A lower budget deliberately admits fewer
workers than the session cap. Autonomous turns and handoff summaries run
workers too and reserve the same allowance, so size the budget for every kind
of turn you run at once (for example allowance × (`MAX_CONCURRENT_SESSIONS` +
`MAX_AUTONOMOUS_RUNS`)). The budget is admission accounting, not reserved RAM:
tmpfs pages are used only as they are written. Leave the host memory for the
server, the agent processes, browsers, other tmpfs mounts and caches beside
it. The budget is per server process; if you run several, split the headroom
between them.

Turns are refused or stopped with these classes, never with a raw `ENOSPC`:

| Class | When |
| --- | --- |
| `session_too_large` | The conversation's settings, memory and resumed history do not fit the allowance. Nothing is copied. The error card offers **Continue in a new conversation** through the existing reviewed handoff flow. |
| `worker_state_busy` | The budget cannot take another allowance while the running workers hold theirs. Refused before launch: nothing is copied or sent. The card offers **Retry**; nothing waits or retries by itself. |
| `worker_state_exceeded` | The running turn filled its allowance. Writes past it failed in that worker only. The runtime may still finish its answer, but the turn ends as this failure, because the part written after the limit was not saved. What was written before it is persisted with the usual checks. |
| `worker_host_unsupported` | Settings, credentials and memory alone exceed the allowance (raise `BRAIN_UI_WORKER_STATE_BYTES`), the host's bubblewrap is older than 0.7 (no `--size`), or the server cannot reach its worker's tmpfs through `/proc` (bubblewrap installed setuid, or `/proc` mounted with `hidepid`). |

The agent reads a note, generated from the same allowance, saying how large its
runtime state is and that it is not for files it makes.

A resumed ordinary conversation also reports one timestamped measurement of
the state actually admitted. At the existing 75% threshold, the agent context
and a dismissible composer notice show the same MiB and percentage. The notice
offers the [reviewed continuation](../decisions/session-handoff.md#measured-saved-state-warning-1679),
without starting work itself. Its age says `As of the last turn`; unknown state
invents no percentage. Dismissal persists for that session/allowance, and a
known allowance change waits for fresh measurement. A size refusal takes
precedence, and busy admission does not imply oversized history.

Pi's corresponding measurement is its existing UTF-8 session-initialization
payload plus growth reserve against the existing 16 MiB pipe bound. It is not
Claude's private-state capacity or the worker's separate turn-temp allowance.

Legacy `brain-claude-state-*` directories are retained. Released historical
writers did not record ownership, so neither a directory name nor a guessed
PID can prove that its owner is dead. The
[2026-10-12 acceptance ruling](https://github.com/schlessera/brain-kit/issues/1679#issuecomment-6129069373)
preserves those unknown leftovers. Current creation, failed-start cleanup and
normal cleanup use the descriptor-held private mount and create no new legacy
host directory; there is no new ownership-marker format or automatic deletion.

## Turn temp allowance and the `turn_temp` tool

Every agent worker, Claude and pi, interactive, voice and autonomous, gets a
**private, size-limited tmpfs at `/tmp`** (#1703). It holds
`$BRAIN_WORKER_SCRATCH`, the per-turn `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
`XDG_DATA_HOME` under `/tmp/brain-worker-home`, a pi worker's session state,
and whatever the turn writes to `/tmp`. bubblewrap mounts it with `--size`,
so one worker filling its turn temp gets `ENOSPC` in that worker only: no
other worker's turn temp, no host directory and no shared tmpfs such as
`/dev/shm` takes the bytes. Claude's runtime state is a separate tmpfs below
it with its own allowance, and is never turn temp.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BRAIN_UI_TURN_TEMP_BYTES` | `268435456` (256 MiB) | Each worker's `/tmp`, in bytes. |
| `BRAIN_UI_TURN_TEMP_BUDGET_BYTES` | allowance × `MAX_CONCURRENT_SESSIONS` (768 MiB at the defaults) | What all running workers' turn-temp allowances may add up to. |

The rules are those of the runtime-state settings above: digits only,
multiples of 4096, a budget of at least one allowance, a boot refusal naming
the variable, and an allowance fixed for each worker's lifetime. Before a
worker launches, the server reserves its whole turn-temp allowance against
this budget, in the same admission as runtime state: a worker gets both
reservations or neither. A turn that cannot reserve it is refused at once as
`worker_state_busy`, before anything is sent, and the card offers **Retry**.
Like the runtime-state budget, this is admission accounting, not reserved
RAM, and autonomous turns and handoff summaries reserve it too.

The server reaches each worker's `/tmp` through a directory descriptor it opens
from outside the sandbox before the worker's command starts, and keeps until
the turn's files are dealt with. Every read through it is descriptor-relative
and never follows a link or crosses into another mount, so a worker cannot
redirect it to a host file. This is how linked files are promoted after the
worker exits (below), and how the `turn_temp` tool works while it runs.

**The `turn_temp` tool** (`mcp__brain-ui__turn_temp` for Claude, `turn_temp`
for pi) lets the agent manage its own turn temp without an approval:

- `action: "usage"` returns the bytes used, the limit, the bytes free and the
  ten largest files and directories.
- `action: "purge"` removes the named `paths`, relative to `/tmp`, or
  everything with `all: true`. A path outside turn temp, a link on the way to
  it and runtime state are refused, and a named link is removed, never its
  target. Files the turn's answer already links are kept, because they are
  promoted at turn end; `force: true` removes them anyway, for named paths
  only. The directories the worker was given (`$BRAIN_WORKER_SCRATCH`, the XDG
  directories) are emptied, not removed.

Each purge is a `turn_temp_purge` governance event. After any step that takes
turn temp past 80% of its allowance, the agent is told once, and again
whenever it fills up, in a message that names the tool. The agent's note
states the allowance next to the tool. Autonomous turns have no `turn_temp`
tool: their note states the allowance alone.

After a non-autonomous turn, the Claude backend checks at most once per 24 hours
for sessions idle more than 30 days, using the newest modification time across
their JSONL and companion folder. Running sessions are excluded. It gzip-archives
old sessions under `<config>/transcript-archive/<project>/<id>/` and keeps their
SDK title and timestamps in `index.json`. Durable archive files and the atomic
index precede removal of live files; interrupted moves retain recoverable copies.
Archive failures are logged and never fail the turn.

Archived conversations remain in history. Reading or resuming one restores its
original bytes to the live project folder, refreshes its modification time,
and removes the archive entry. Autonomous state stays empty and nonpersistent.

Pi also bounds each session's serialized initialization and snapshots to 16 MiB,
reserving the larger of 1 MiB or 25% of initialization bytes before launch;
an oversized session or mid-turn snapshot fails with `session_too_large`.

## What a turn can write and where outputs go

An interactive or voice turn has three places a file can be. The
[writable-areas decision](../decisions/worker-writable-areas.md) records their
checks; the [governed-worker decision](../decisions/governed-writable-workers.md)
sets the shipped 0.42.0 profiles. Governed turns write canonical ordinary brain
paths directly. Strict turns keep the canonical execution view read-only and
write verified scratch/workspace copies through the aliases below.

| Place | Paths | Lifetime | Link it for the reader? |
| --- | --- | --- | --- |
| Turn temp | `$BRAIN_WORKER_SCRATCH`, `/tmp` and the XDG directories in it | Deleted when the turn ends | Never: the reader cannot open it. A file the answer links there anyway is copied into `.brain/scratch/turns/<turnId>/` and the saved link rewritten. |
| Persistent scratch/workspaces | Governed: `.brain/scratch/` and `workspaces/`; strict: `/tmp/brain-worker-areas/scratch` and `/tmp/brain-worker-areas/workspaces` | Governed writes persist directly; strict writes persist after validated publication. Scratch is pruned after 7 days, oldest first past 1 GB | Yes: link the canonical brain destinations, not the strict aliases |
| The brain | Everything else | Canonical | Yes, as documents |

- **The brain** is writable under `governed`, except the resolved protected
  paths. Native and shell writes are journaled at the documented observation
  points; the server refreshes the index after the turn. Under `strict`, the
  execution view stays read-only and ordinary Markdown changes use the server's
  validated write/edit tools. Direct writes outside its selected area aliases
  fail. Autonomous turns retain their restricted permissions.
- **`.brain/scratch/`** is created when missing and made writable when every
  segment is a real directory (no symlink), no mount point sits at or below
  it, and, in a git repository, git ignores it (`brain doctor --fix` adds the
  line). Governed exposes its canonical path; strict exposes a private copy at
  `/tmp/brain-worker-areas/scratch` and validates publication after exit.
  A scratch name whose file also has a name outside scratch is
  unlinked before the turn. `brain render --scratch`, `brain image --scratch`
  and `brain scratch prune` work inside a turn, and the reader opens the path
  the command prints. The server never follows a symlink under `.brain/` when
  it serves, previews or lists a scratch path.
- **`workspaces/`** is made writable only when it already exists as a real
  directory in the brain root. Core always excludes it from the index.
  Creating it outside a hosted turn is the opt-in; the name is fixed. Governed
  uses its canonical path; strict uses a private copy at
  `/tmp/brain-worker-areas/workspaces` with validated publication after exit. It
  stays read-only for a turn when it holds a file hard-linked to something
  outside it, sits on or contains a mount point, holds more than 200 000
  entries, or holds a directory the server cannot read (scratch too); the
  agent's note and the server log name the reason. Links wholly
  inside it, such as local clones between workspace repositories, are fine.
- **`$HOME`** is not a writable host escape. The resolved profile may mask its
  contents; only the selected runtime inputs restored by that layout are
  available. A write into a read-only home fails and is retained as a roadblock.
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
  `XDG_DATA_HOME` point at per-turn directories under
  `/tmp/brain-worker-home`, which is what headless Chromium needs to start,
  and the agent's note says to point a tool there. There is no per-turn home
  overlay: bubblewrap keeps an overlay's writes in a host directory, which no
  size-limited mount can hold.
- **Turn temp** is the worker's own size-limited `/tmp`
  ([above](#turn-temp-allowance-and-the-turn_temp-tool)). When the worker
  exits, files its answer linked there are copied into
  `.brain/scratch/turns/<turnId>/` (128 MiB per file, 256 MiB and 64 files per
  turn) through the server's held descriptor, the saved answer links the
  copies, and the tmpfs is released. A symlink anywhere on the path, a
  hard-linked file, a directory, runtime state or anything over the bounds is
  not copied, and its link stays as written. Each copy or refusal is a
  governance event (`GET /api/governance/events`).
- **Restricted (autonomous) turns** bind no area and have no host home:
  `$BRAIN_WORKER_SCRATCH` and `/tmp`, sized like every worker's turn temp, are
  the only writable places, and nothing in them is promoted.

Every turn's agent reads a note generated from the same resolved layout that
builds the mounts, so it is told exactly which of these it has this turn,
and to put anything it links into `.brain/scratch/`, never into turn temp.
When a `brain` CLI write hits the read-only brain, the error names the rule
and the route: `brain render` and `brain image` say to use `--scratch`.

## Maintenance workers: the server never runs the brain's code (#1648)

Maintenance commands have a separate **256 MiB** temporary-write allowance,
reserved in full against a separate **256 MiB** aggregate budget before any
repository code executes (#1708). `BRAIN_UI_MAINTENANCE_TEMP_BYTES` and
`BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES` override them with positive, safe,
4096-byte-aligned counts; the aggregate must cover one allowance. Raise the
aggregate explicitly for parallel maintenance. Neither value derives from
agent-session concurrency or uses agent turn temp, runtime state or the
separately bounded startup/publication storage.

Each command's sized private `/tmp` contains scratch and fresh XDG config,
cache, data and state directories. Credential-free HOME is also in that
filesystem. Credentialed HOME is readable but read-only; writes requiring a
writable HOME refuse honestly. Host masks and `/dev`, including `/dev/shm`,
are read-only. The transport worker's empty root and device mount are also
read-only, while its bounded `/tmp` and selected mirror mounts remain writable.
Authoritative brain/publication outputs, the host-owned Git
mirror and explicitly selected span sinks retain their existing ownership and
storage boundaries; they are not temporary overflow destinations.

The maintenance-only nested-usernamespace restriction was explicitly approved
on [#1708](https://github.com/schlessera/brain-kit/issues/1708#issuecomment-6128047037).
Both repository-evaluating maintenance and its separate host-owned Git
transport receive `--disable-userns` and `--assert-userns-disabled`;
an implementation unable to enforce them refuses at startup through the
existing worker-host requirement. A maintenance command needing another user
namespace is unsupported. Outer worker namespaces, credentials, egress,
command membership and agent-turn profiles are unchanged.

Server and cron select their admission ledger from the canonical configured
UI database identity, beside that existing host operational state. This
shares the budget across authorized server/cron users and different launcher
temporary directories. Ledger creation follows the state's existing owner,
group and access; it grants no new access and changes no UI-state permissions.
The ledger can admit the boot probe without prematurely creating the UI
database. Backend recreation and configuration changes retain live rows.

A host check that cannot reserve its allowance reports the actual busy reason
without claiming the uncompleted qualification passed. It retries once capacity
is released and keeps repository execution on the worker path. Independent
clients may reuse a completed successful qualification for the same brain,
state identity and resolved limits, so probing does not race their serialized
output lifecycle. Other commands still obtain their own full reservations.

Standalone SDK calls without persistent UI state keep a private per-uid
ledger under `/tmp/brain-maintenance-budget-<uid>/`. Separate private `/tmp`
views have independent standalone domains. An in-memory UI database provides
no shared persistent state identity and uses that standalone domain.

Both domains record full allowances, boot, PID-namespace and process-start
identities, and attach the bootstrap before exec. A live attached worker
remains counted if its launcher dies; positively dead ownership is recovered
on the next admission. Sharing state across different PID namespaces does
not establish globally recoverable process ownership: unverified foreign
ownership remains held. Actual shared-state admission, release and crash
recovery are qualified with distinct server/cron uids in the same PID
namespace. Reservations are released idempotently after worker exit. This is
logical capacity accounting, not reserved RAM. Busy admission refuses with
`worker_state_busy`; no code ran and no agent runtime state was lost. Temporary
filesystem exhaustion is `ENOSPC`; it does not authorize a host-backed fallback.

Once a turn can write the brain (the `governed` profile), every file the
brain supplies is agent-writable input: `brain.config.ts` and whatever it
imports, a `bunfig.toml` preload, an `.env`, git's includes, filters and
refs. A host process that evaluates any of them runs what an agent wrote. So
while the host execution boundary holds, the server evaluates none of them
itself. It runs that work in a **maintenance worker**: the same bubblewrap
launcher, with the brain bound read-write, the host root read-only, and
`/run`, `/var/run`, `/var/lib`, `/home`, `/root`, `/mnt`, `/media`, `/srv`
and the UI database's directory masked by empty private tmpfs mounts. No host
Unix socket below them is reachable. The server's Bun and its own
installation are bound back read-only, so a runtime installed under a home
keeps working; nothing the brain names is.

What runs there, and how it meets the brain's **writer gate**:

| Work | Credentials and network | Writer gate |
| --- | --- | --- |
| Application route planning (`brain_add`) and its index refresh | None | Shared |
| `brain hygiene`, `skills sync`, `scratch prune`, module settings, enable and disable | None | Shared |
| `brain briefing`, `stats`, `list`, `read`, `validate`, `module list`, `--version` | None | Shared |
| `brain search` | Yes (the query embedding) | Shared |
| Hosted `brain sync` (client, streamed route and generated sync cron job) | None in the brain; Git credentials only in the host mirror transport | Exclusive |
| `brain index`, `add`, module actions, `maintain`, module and hand-written cron jobs | Yes | Exclusive |
| `git check-ignore` and `rev-parse` against the brain | None | None |

Every maintenance worker binds the brain read-write and runs code the brain
supplies, so even a reader takes the gate shared: nothing runs beside an
exclusive holder. Search is the one credentialed command held shared, so a
search never waits for every running turn. Git's ignore checks run a fixed
git command with no gate; for a brain inside a parent repository the worker
sees that repository read-only, and where no worker can run the check
refuses rather than run git on the host.

- **Credential-free** means only plain settings (`PATH`, `TZ`, locale,
  `BRAIN_PATH`) reach the command, a private empty `$HOME`, no network
  beyond loopback, every `.env*` file at the brain root (or the file an
  `.env*` link leads to) replaced by one that cannot be opened, and
  `BUN_OPTIONS=--no-env-file`, so no Bun process in the worker loads an
  `.env` at all. The index refresh after an application is
  credential-free because the turn waits for it, so new chunks get their
  vectors from a keyed `brain index` the server queues to run once the gate
  is free.
- **Credentialed** work receives the credentials it was always given
  (the `brainCli` or `cron` audience), the host network, and the server's
  `$HOME` read-only, with temporary tool writes in private bounded XDG directories. That is the interim
  exposure the [decision record](../decisions/governed-writable-workers.md#the-host-execution-boundary)
  names until the metered relays land: code the agent can
  write, such as a helper the config imports, could read those credentials.
- **Hosted Git sync** keeps a private bare mirror beside `DB_PATH` (a private
  temporary directory for an in-memory database or standalone client).
  Commit, pull, merge, judgment and indexing run without credentials or host
  network access, using complete immutable startup inputs and a separate
  validated output workspace. Local outputs publish before the next credentialed
  transport phase. They fetch and push over the local file transport; only
  mirror objects and refs are writable, while its configuration, hooks and
  root remain read-only. After that worker and all its descendants have
  exited, the host rejects linked storage and object alternates and runs
  `git fsck --full --strict` before pushing. The transport has an explicit
  system/mirror mount list and never mounts the brain or its `.git`.
  It uses the literal protected `remote.origin.url`, without loading includes;
  writable Git includes cannot choose the credential's destination.
  GitHub HTTPS uses `BRAIN_UI_SYNC_GITHUB_TOKEN`, falling back to
  `GITHUB_TOKEN`; these tokens never enter brain maintenance workers. SSH
  transport sees only the host's `.ssh` directory and optional admitted
  `SSH_AUTH_SOCK`, with no complete home mount. The mirror stores no token or
  credential helper. A remote push race retries the existing deterministic
  re-pull flow up to three times. Terminal `brain sync --json` is unchanged.
- **The writer gate** lives in the UI database, because the cron runner is a
  separate process. Turns and credential-free maintenance hold it shared;
  credentialed work waits until no shared holder remains and then holds it
  exclusively. A holder whose process died is cleared by the next request.
- **The brain's CLI must be installed in the brain** (`bun install`, so
  `node_modules/.bin/brain` is a real package inside it). A CLI linked to a
  path below a masked directory is not visible in the worker.
- **Cron** lines now start with `cd /`, outside the brain: the runner is a Bun
  process and must not load the brain's `bunfig.toml` or `.env`. The runner
  starts each repository job in the brain itself, in a maintenance worker,
  and reconciles any governed turn a dead server left behind first.

**When the boundary holds.** `governed` is the default profile, so the
boundary holds wherever `governed` can run, and from then on for good: once
a governed turn has started on a brain (a fact kept in the UI database), or a
real probe has proven the worker boundary in this process, a later failure
never hands the brain's code back to the host. `governed` cannot run, turns
run under `strict`, and the brain's code stays on the host only when:

- the server's working directory is inside the brain (`server_cwd_in_brain`;
  start it from a directory outside the brain), or
- the host cannot run the worker boundary at all, or cannot start a
  credential-free maintenance worker with its private network namespace
  (`worker_host_unavailable`). The worker host probe starts outside the brain
  and loads no `.env`, so nothing the brain holds can fail it.

`GET /api/status` reports this as `runtime.workerHost.governed`, with
`hostExecution` `"worker"` or `"host"`, and the boot log says it once.

**Operational state must live outside the brain, in every hosted profile.**
Before opening SQLite, provisioning the private poke token, reconciling turns or
executing brain code, the server resolves `DB_PATH` and
`BRAIN_UI_INBOX_POKE_TOKEN_FILE` through symlinks, including existing parents of
new paths and the derived quarantine sibling. Database, WAL/SHM and private-state aliases through hardlinks or bind mounts inside
the brain refuse too, including new database paths beneath a mounted state parent.
Aliases wholly outside remain valid. Masks cover configured directories and
resolved database, token and quarantine targets. For an in-memory database, private quarantine storage under `TMPDIR`
(or the system temp directory) is checked too. A database or private state file or directory inside the brain refuses
boot as `OperationalStateInBrainError`. The same resolver reports
`database_in_brain` or `private_state_in_brain` with migration guidance on the
host boundary status surface. The thrown boot error carries that diagnostic as
`status`, and the boot log records it; a refused server opens no HTTP listener.

Stop the server, move its state directory outside the brain (keep the database,
WAL/SHM siblings and `brain-ui-quarantine/` together), set `DB_PATH` to the moved
database, and restart. Keep the poke token in a private directory outside the
brain, such as `/run`, and update `BRAIN_UI_INBOX_POKE_TOKEN_FILE` if necessary;
the server provisions a fresh token at boot. Choose a dedicated state directory
beside the brain, so masking it does not cover brain inputs. There are no strict
private-state exclusions; the worker masks retain their existing strength.

**Crash recovery.** Before a governed turn's worker launches, the server
records which protected paths exist (the decision's tier A and B, with
identity and bytes) in the UI database. At boot, and in the cron runner
before any job, every turn with a record and no end whose server is gone is
reconciled first: a protected file that appeared during it (a
`brain.config.ts`, a `bunfig.toml`, an `.mcp.json`, a new `.env*`) and any
protected ancestor swapped for a link are moved into `brain-ui-quarantine/`
beside the UI database, byte for byte, and logged. Nothing evaluates the
brain before that. A path that cannot be moved keeps the turn's record open,
and the server refuses to start (and cron jobs refuse to run), naming it,
until it is removed from the brain.

**Policy selection.** At each interactive/voice admission the host reads
`context/policies/governance.md` as data, never loading the brain's config.
Its [schema and defaults](../supported-inputs.md#governance-policy) select the
profile and add/release eligible protection. A known invalid edit records a
notice and retains the process's last valid effective policy/hash, or built-in
defaults before any valid input. A missing file selects defaults. An explicit
host `strict` override stays stronger. The exact captured policy/hash and
selected profile are immutable for the turn and retained in host operational
state for the journal; later edits apply to later turns. Actual voice uses the
voice profile; dictation remains interactive. Autonomous turns do not load this
policy. Check an edit with `brain policy check --json`; a valid check does not
imply budget, scope, network, outward or provider enforcement is active.

## Per-turn scope caps (#1670)

Hosted interactive turns use the frozen admitted policy's scope fields. Built-in
caps are 500 tool calls, 120 wall minutes, 1,000 distinct observed changed paths
and 4 GiB of captured changed regular-file versions. Calls/time derive from the
recorded distribution; file/byte defaults are provisional maintainer choices,
not measurements. Explicit policy values override them. The existing independent
host timeout, resource limits and bounded storage still apply, including paused
time; the picker and capabilities note state the actual enforced inputs.

The shared raw journal observes each tool completion and every 15 seconds,
including brain, scratch and workspaces, and the monitor reads `statfs` at each
observation. It freezes a running worker on a reached cap or below free space
max(5% of filesystem capacity, 2 GiB). A delegated cgroup confirms its freezer;
otherwise the parent verifies the worker PID namespace and stops its process
tree. The trusted namespace reaper remains alive to handle host death; agent
processes and descendants stop. No host execution fallback or unrelated signals
are used. A final frozen snapshot records the observed count and overshoot.
Snapshots cannot capture intermediate writes overwritten before observation;
missing data remains unknown and overlapping writers share attribution.

Interactive work waits on the existing in-turn Continue/Stop card. Continue
adds exactly the original cap once for that dimension in this turn; the exact
new ceiling is displayed first. A second hit for that dimension permits Stop
only. Other dimensions retain independent grants. The disk floor permits Stop
only, including when another writer crosses the floor during an existing pause.
The newest floor pause replaces the active Continue control without granting it.
True voice stops without granting; dictation remains interactive. Pi
continues to refuse true voice admission because it declares no voice posture.
Autonomous Queue limits are unchanged.

A paused worker stays paused while an authorized client that can answer for its
session is connected. After 30 minutes with none connected it stops; independent
hard limits can end it sooner. Reconnection never resumes it automatically.
Restart ends the worker and records an interrupted receipt, preserving partial
work and retained journal observations. Decisions/readback require current
approval authority and exact event/turn/session identities; retries have one
effect and another device's answer is reported. Scope facts use the same single
turn disclosure as changes and cost, without a new destination or control cache.

## The restricted envelope for autonomous turns (#676)

`runAutonomousTurn` sends every autonomous turn with
`autonomous.containment: "restricted"`, and dispatches only to a backend that
advertises `capabilities.restrictedAutonomous`; both first-party backends do.
A handoff summary is nonpersistent and toolless but not restricted, and is
unchanged. A restricted turn's worker is launched in the launcher's
`restricted` mode.
It adds a network namespace that holds only loopback, so no host interface,
host TCP/UDP listener, resolver or abstract Unix socket is reachable. The host
root is not mounted. The worker sees only `/usr` and the system library and
binary directories, a fixed list of dynamic-linker and name-service files from
`/etc`, the read-only brain, the installed runtime it runs, a fresh tmpfs
`/tmp`, scratch and runtime state. The installed runtime is the executable for
Claude, and for pi the Bun binary, each `node_modules` on the entry's path and
the linked workspace packages in them. The launcher refuses a read path that is
the host root, `/home`, `/etc`, `/run`, `/var`, `/tmp` or an ancestor of the
brain. No host home, stored login or `/run` socket is visible.

The worker's only route out is the server-owned inference relay
(`export function startInferenceRelay(`, `packages/ui-sdk/src/server/inference-relay.ts:60-132`).
It is a Unix socket in a private `0700` directory, bind-mounted read-only at
`/run/brain-inference`. It forwards only `POST` to the provider's inference
routes, such as `/v1/messages` and `/v1/messages/count_tokens` for Anthropic,
to the upstream the profile selects. It removes every inbound credential,
cookie, host and forwarding header, sets the server-held credential, and
refuses redirects and bodies over 32 MiB. The worker holds the placeholder
`brain-inference-relay-placeholder` where its credential would be.

- **Claude** reaches the relay through the CLI's `ANTHROPIC_UNIX_SOCKET`, with
  `ANTHROPIC_BASE_URL=http://localhost`. Flag settings pin both. The environment
  is `PATH`, `LANG`, the pinned route and placeholder, and the non-essential-traffic
  and auto-update switches. Runtime state is an empty tmpfs directory: no stored
  login, settings, account file or transcript enters or leaves it. The turn sets
  `settingSources: []` and `strictMcpConfig: true`. Tool membership stays the
  enforced roster, so an out-of-roster call escalates rather than disappears. A subscription turn needs `CLAUDE_CODE_OAUTH_TOKEN`; a stored
  `claude login` is never copied into the envelope, so such a turn refuses.
- **pi** runs its SDK in process, so its trusted worker entry binds a loopback
  port before pi initializes and forwards it to the relay socket. pi's provider
  points at that port with the placeholder key. No `auth.json`, `models.json` or
  settings file is copied in. The resource loader loads no extension, skill,
  prompt template, theme, context file, `SYSTEM.md` or project setting; the
  inline permission gate remains. The relay supports the `anthropic-messages`,
  `openai-completions` and `openai-responses` provider APIs with an API key from
  `auth.json`, the server environment or a `models.json` override. OAuth logins,
  command-sourced keys and other provider APIs refuse.

Before an autonomous turn, the per-turn probe launches this restricted mode
and checks that only loopback exists and the relay mount is present. A host that
cannot create the network namespace refuses before any worker or inference.

The brain's `.git` is masked in restricted mode: a directory becomes an empty
read-only tmpfs, a gitlink file cannot be opened, and a `.git` symlink refuses
the turn. That hides git's fsmonitor socket, hooks and configuration.

One residual is accepted under the maintainer's ruling 1A on #676: any other
Unix socket file inside the read envelope stays reachable, because a read-only
mount does not prevent `connect()`. The envelope contains only the brain,
system directories and installed packages, so this needs a host process that
listens inside one of them. Hostile content cannot create such a listener. Keep
host daemons' sockets out of the brain directory on a hosted install.

## Output-staging allowance

Strict, restricted and maintenance configuration consumers use immutable startup
inputs. Strict persistent areas and maintenance results use private copy-on-write outputs,
validated against the authoritative brain before publication. Each consumer
reserves a separate **256 MiB** allowance in the same admission ledger as runtime
state and turn temp. Newly created or copied-up output bytes, Git adapter data,
and writable filesystem overhead occupy that bounded tmpfs. Turn temp is separate.
Complete immutable input bytes retain their existing 4 GiB logical copy bound
in a private snapshot in host temporary storage under `/tmp`, outside the
output allowance. A trusted cleanup
keeper removes that snapshot even after abrupt server exit.

| Host setting | Default | Meaning |
| --- | --- | --- |
| `BRAIN_UI_OUTPUT_STAGING_BYTES` | `268435456` (256 MiB) | The private writable output capacity for one consumer; immutable input bytes are separate. |
| `BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES` | allowance × `MAX_CONCURRENT_SESSIONS` (768 MiB at defaults) | Aggregate admitted output-staging capacity. |

Both values must be positive multiples of 4096, with the budget at least one
allowance; invalid values refuse server startup. A consumer unable to reserve
its whole allowance refuses immediately with `worker_state_busy` and Retry.
Complete starting inputs must fit their own 4 GiB logical copy bound and the
host's free snapshot storage before repository code runs. A named
`worker_state_exceeded` refusal reports input capacity separately from output
staging; boot and status remain available without host execution fallback.
New output writes that fill the upper filesystem fail with `ENOSPC` (`No space
left on device`). Copying up a modified existing file consumes its full copied
bytes. Deleting a lower-only baseline file does not free writable capacity.
No host-backed output overflow fallback exists. The agent's limits note states
the same resolved output allowance.

A fixed trusted helper uses util-linux `unshare` and `mount` to create a
copy-on-write overlay with immutable input as its lower layer and upper/work
on the size-limited tmpfs. This is the separate private publication workspace,
not a writable mount over the brain's configuration execution path. The
launcher uses `nsenter --user --mount --preserve-credentials` to start
bubblewrap inside that completed helper namespace; bubblewrap still creates
the worker's own namespaces, fresh `/proc`, masks and private turn temp, and
drops its capabilities. No added host/container capabilities are needed.

The host needs kernel support for overlayfs in an unprivileged user namespace
with `userxattr`, util-linux `unshare`, `mount` and `nsenter`, and `python3`
for the isolated literal input-cleanup helper (`-I -S`, no brain imports).
The maintenance qualification performs a real private output write before
claiming availability. Missing tools or unsupported mounts produce the existing
host-requirement refusal; no live-input or host-execution fallback is selected.
Keep `setns`, namespace creation and mount calls allowed in the namespace
seccomp profile. Both the private output namespace and immutable input copy
are released after abrupt server exit.

## Running the server in a Docker container

Docker's defaults stop the worker at three separate launcher steps. Each needs
its own option, and the probe refuses at the first step that fails, quoting
bubblewrap. The measurements, the alternatives to a fresh `/proc` and why
each was rejected are in the
[container fresh-/proc decision](../decisions/container-fresh-proc.md).

| Launcher step | Refusal without the option | What the container needs |
| --- | --- | --- |
| util-linux namespace entry is installed | `nsenter` is missing or namespace entry fails | util-linux `nsenter` in the image and `setns` allowed in the namespace seccomp profile for bounded staging. |
| bubblewrap is installed | `bubblewrap is missing` | bubblewrap in the image. 0.9 is eligible. |
| Create the user and PID namespaces | `bwrap: No permissions to create new namespace…` | A seccomp profile that allows `clone`, `unshare`, `mount` and `umount2` without `CAP_SYS_ADMIN`. Docker's default profile allows them only with that capability. |
| Switch to the worker's root | `bwrap: pivot_root: Operation not permitted` | The same profile also allows `pivot_root`, which Docker's default profile never allows. |
| Mount the worker's fresh `/proc` | "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths; in Docker, run the container with --security-opt systempaths=unconfined" | `--security-opt systempaths=unconfined`. Inside a user namespace the kernel mounts a new procfs only when the parent `/proc` has no covered paths, and Docker covers several by default. No other option fixes this step. |
| (AppArmor hosts) namespace setup | Docker's default profile denies mounts and the quota write used by maintenance's `--disable-userns`. | `--security-opt apparmor=unconfined`, or a derived profile that permits the worker's mounts, `pivot_root` and namespace-local quota setup at `/proc/sys/user/max_user_namespaces`. |

Derive the seccomp profile from Docker's default profile for your Docker
version, adding one rule:

```sh
jq '.syscalls += [{"names":["clone","mount","umount2","unshare","setns","pivot_root"],"action":"SCMP_ACT_ALLOW"}]' \
  default.json > worker-seccomp.json
docker run --user 1000:1000 \
  --security-opt seccomp=worker-seccomp.json \
  --security-opt systempaths=unconfined …
```

`--security-opt seccomp=unconfined` also passes, but it disables every
syscall filter rather than the listed namespace calls. Do not add `--cap-add SYS_ADMIN` or
`--privileged`: neither is needed once seccomp allows these calls, and adding
`SYS_ADMIN` did not fix the `/proc` step in any measured combination.

**What these options cost.** The seccomp rule lets processes in the container
create user namespaces and mount inside them. That is the kernel surface any
bare-metal host that allows unprivileged user namespaces already exposes, and
the boundary requires it. `systempaths=unconfined` costs more. It removes
Docker's covers over `/proc/kcore`, `/proc/keys`, `/proc/timer_list`,
`/proc/sched_debug`, `/proc/acpi`, `/proc/scsi`, `/sys/firmware` and others.
It also removes the read-only remounts of `/proc/sys`, `/proc/sysrq-trigger`,
`/proc/irq`, `/proc/bus` and `/proc/fs`. The worker gets its own procfs
either way, so its boundary does not change. What widens is what the server and anything else in the
container can reach. As container root, `/proc/sysrq-trigger` and `/proc/sys`
pass the write check once unmasked. A worker of a root-run server can no
longer write them (#1629), but the server itself and anything else running as
container root still can. **Run the server as a non-root user.** A non-root
container user could read only its own `/proc/keys` entries and could write
none of these files.

Qualify the container on the host that will run it, with the real probe.
Kernels and container runtimes differ in what they mount over `/proc`. The
report behind #1622 failed on one Docker host and passed with the same options
on a WSL2 host.

## Running the server as root

The worker runs as the server's kernel uid with no capabilities. For uid 0
that is not enough on its own: most host-global `/proc` files check only the
file mode, so a root worker could write sysctls such as `kernel.core_pattern`,
`/proc/acpi/wakeup` or `/proc/dynamic_debug/control` through its fresh procfs.
A root-run server's worker therefore gets its whole `/proc` read-only
(`--remount-ro /proc`). Its sysctl writes fail with `EROFS`, and no file under
its `/proc` passes a write check. Workers of any other uid keep a writable
`/proc`. They reach no host-global file through it, and nested user
namespaces, such as Chromium's sandbox, need `/proc/self/uid_map`. A root
worker cannot use them. Chromium refuses to run as root without
`--no-sandbox` either way.

Running the server as root still qualifies, but it is not recommended. The
worker keeps root's authority over everything it can reach without writing.
It can read root-only `/proc` files, such as `/proc/slabinfo` and
`/proc/timer_list`. Interactive and voice turns see the host root read-only
and share its network namespace. There the worker can also read every
root-owned file on that root, such as `/etc/shadow`, SSH host keys and
root's stored credentials. It can also connect to the Unix sockets a
root-owned daemon listens on, because connecting is not a write the read-only
mount refuses. Abstract Unix sockets have no file to check at all: the
worker reaches them through the shared network namespace, and their peers
see it as uid 0. The measurements are in
[the container fresh-/proc decision](../decisions/container-fresh-proc.md#what-systempathsunconfined-costs).

**The full worker boundary needs a non-root server.** The read-only `/proc`
above is a second layer, not a substitute: it stops a root worker's writes,
not its reads or its socket connections. Run the server as a dedicated
non-root user. The hosting template's
[container privilege model](https://github.com/schlessera/brain-hosting-template/blob/main/docs/decisions/container-privilege.md)
is one way to do it: a `brain` uid for the server and a separate `agent` uid.

A root-run server still boots and serves turns, but it says so (#1638). It
logs a warning once at boot, `/api/status` keeps it as
`runtime.workerHost.rootServer`
([contract](../integration-contract/http.md#root-server-warning-additive-1638)),
and the app shows a standing notice above the composer that links this
section. The warning names what a root-run worker keeps: it can read
root-owned files and connect to root-owned and abstract Unix sockets.

Native storage accepts the server's fixed UID/GID, including UID 0 under this
same warning (`validateNativeBrainManagerConfig`,
`packages/ui-sdk/src/server/native-brain-manager.ts:60-81`). This does not give
the worker capabilities or remove its masks, filesystem filter or read-only
root `/proc`. The host still has to qualify for user namespaces. Since Linux
5.12, mapping a child namespace to parent UID 0 requires `CAP_SETFCAP` at the
namespace setup boundary; see the
[Linux user-namespace mapping rules](https://man7.org/linux/man-pages/man7/user_namespaces.7.html).
An unqualified root context remains a named worker-host refusal.

## Resource limits

Every agent worker runs under resource limits (#1660), so one runaway turn
cannot exhaust the host. The defaults are far above what normal work uses.
The design is in the
[governed-workers decision](../decisions/governed-writable-workers.md#resource-limits-g1).

**rlimits, always.** `prlimit` from util-linux is the first program inside the
worker's namespaces. It sets each limit, soft and hard, and then execs the
worker command. No agent process can raise a hard limit, because that needs
`CAP_SYS_RESOURCE` in the initial namespace. A host without `prlimit` refuses
agent turns with the named requirement, the same way it refuses a missing
bubblewrap.

| Limit | rlimit | Default | What a step that hits it sees |
| --- | --- | --- | --- |
| `processes` | `RLIMIT_NPROC` | 4096 tasks, threads included | `fork: Resource temporarily unavailable` (`EAGAIN`) |
| `data` | `RLIMIT_DATA` | half the server's memory, per process (below) | `Out of memory` / `Cannot allocate memory` |
| `file_size` | `RLIMIT_FSIZE` | 16 GiB per file | SIGXFSZ terminates the writer (`File size limit exceeded` when the shell reports it); `File too large` (`EFBIG`) if the runtime handles or ignores the signal |
| `open_files` | `RLIMIT_NOFILE` | 65536 per process | `Too many open files` |

`RLIMIT_NPROC` is set inside the user namespace on purpose. The kernel counts
it per user and namespace. Set outside, it would count every process of the
server's uid and refuse the namespace itself. Set inside, it counts only the
worker's own tasks, so two workers do not share one budget. The kernel never
applies `RLIMIT_NPROC` to uid 0, so a root-run server's workers are bounded
only by a cgroup `pids.max`, and the status reports `processes` as absent with
that reason ([running as root](#running-the-server-as-root)).

"The server's memory" is physical memory, or less when a cgroup above the
server caps it: a systemd `MemoryMax=`, or a container started with
`--memory`. The memory defaults are half of it. On a small host they keep at
least 1 GiB, but never more than three quarters of it, so the server always
keeps headroom.

The per-process memory bound is `RLIMIT_DATA` rather than the address-space
limit `RLIMIT_AS`. Chromium reserves more than a terabyte of address space at
start. Measured on 2026-10-12 in the worker's namespaces, Chromium 152 crashed
under `RLIMIT_AS` at 8, 16 and 32 GiB, hung at 64 GiB, and started only from
1 TiB, where the limit bounds nothing. `RLIMIT_DATA` counts private writable
memory, not reservations. Chromium, Bun and Claude Code all started under
1 GiB, and an allocation past the limit failed inside the allocating process.

Any rlimit is lowered to the server's own hard limit when that is lower: an
unprivileged process cannot raise it.

**A cgroup per worker, when the host delegates one.** When the server runs
alone in a cgroup v2 subtree it can write, it creates one child cgroup per
worker. That is the case for a systemd service with `Delegate=yes`, or a
`systemd-run --user --scope -p Delegate=yes` scope.

| Limit | cgroup file | Default |
| --- | --- | --- |
| `memory` | `memory.max`, with `memory.swap.max` 0 | half the server's memory, for the whole worker |
| `pids` | `pids.max` | 4096 tasks for the whole worker |
| `cpu` | `cpu.max` | all CPUs but one |

The server moves itself into a `brain-server` leaf of its cgroup and creates
the workers under `brain-workers/`. This is the layout systemd expects of a
delegated unit. The trusted bootstrap joins the worker's cgroup before it
execs anything, so no worker process runs outside it. The worker sees `/sys`
read-only and cannot leave its cgroup or change its limits. A worker can mount
cgroup2 afresh from a nested user and cgroup namespace, but there its own
cgroup is the namespace root. The cgroup2 mount option `nsdelegate`, which
systemd sets by default, keeps a namespace root's limits out of reach from
inside it. A host whose cgroup2 lacks `nsdelegate` gets no per-worker cgroup,
and the status says why. A worker's cgroup has `cgroup.max.descendants` 0, so
a worker cannot leave child cgroups behind it either.

Swap is off inside a worker's cgroup, because a worker swapping past its limit
would fill the host's swap instead of stopping. A memory overrun kills the
largest process, usually the runaway command, and the agent keeps running.

The server takes over its cgroup only when it is the only process in it, as
a systemd unit's command is when the unit starts. A cgroup holding anything
else, even a process the server started, is never restructured. A terminal's
desktop scope is one example. Docker mounts the cgroup filesystem read-only, so
a container gets the rlimits only. If a worker's cgroup cannot be created
later, that launch is refused, and from then on the cgroup limits are reported
absent. The cgroup limits a host cannot apply are stated as absent, with the
reason, never silently assumed.

**Configuration.** `BRAIN_UI_WORKER_LIMITS` overrides single limits as
comma-separated `name=value` pairs, for example
`BRAIN_UI_WORKER_LIMITS=memory=8GiB,pids=2048,cpu=2`. Sizes take `KiB`, `MiB`,
`GiB` or `TiB`. `unlimited` turns one limit off, and `cgroup=off` skips the
per-worker cgroup. A malformed entry refuses agent turns with the entry named,
and the status lists every limit as absent for that reason: a limit the
operator asked for is never dropped silently.

**Where the limits are stated.** `GET /api/status` reports
`runtime.workerHost.limits`, with each limit enforced (with its value) or
absent (with why)
([contract](../integration-contract/http.md#worker-resource-limits-additive-1660)).
The boot log says the same once and warns for each limit the host cannot
enforce. The agent reads the same values before it starts, in the "Limits in
this turn" list of its sandbox note: each limit, how hitting it looks, and
those this host cannot enforce.

**When a worker hits one.** With a cgroup, each new hit is recorded in the
run's Activity as a `worker_resource_limit` event, and as a `resource_limit`
governance event kept with the session (#1651), next to the tool step that
caused it, naming the limit, its value and the kernel's count: the times the
worker reached its own `memory.max` (an OOM kill by the host or an ancestor
cgroup is not counted), refused a fork at `pids.max`, or was throttled at
`cpu.max`. A worker killed (exit 137) within a second of its own memory limit
firing and an OOM kill counts as ended by that limit. A command the limit
killed earlier, which the worker survived, does not. A limit that
ends the worker itself fails the turn with `failure.errorClass =
worker_resource_limit` and the limit named. An rlimit fails the step inside the
worker with the error in the table above and leaves no record the server can
read, so the server cannot attribute it. The agent's note names those errors
so the agent can recognise them.

**Measured headroom.** `tests/worker-limits-workloads.test.ts` runs the four
first-party workloads through the real launcher under the host's defaults,
behind an offline network namespace with loopback fixture inference. It
records each one's peak resident memory in `tmp/worker-limit-workloads.json`.
On 2026-10-12, on the Linux x86_64 row below and in its Docker container, the
peaks were:

| Workload | Peak resident memory (largest process) |
| --- | --- |
| A Claude Code turn with one shell tool | 232 MiB |
| A pi turn with one shell tool | 207–219 MiB |
| `brain index` of the fixture corpus | 114 MiB |
| A Chromium render through `brain render` | 189–203 MiB |

All four also passed with `data=1GiB,processes=256,open_files=1024`, far below
the defaults. `packages/ui-sdk/tests/worker-limits.test.ts` proves the bounds.
A fixture that forks without bound stops at `RLIMIT_NPROC` while the host still
starts processes. An allocation past `RLIMIT_DATA` fails inside the worker.
Inside a delegated scope, `pids.max` stops a fork bomb, `memory.max`
OOM-kills inside the worker only, `cpu.max` throttles, and all three are
reported. A worker's own cgroup2 mount cannot raise its limits. The cgroup half
runs only where a systemd user manager can delegate a scope, and says so when
it cannot.

## Measured host-component matrix

These rows qualify the launcher/probe component. Where a row says so, the
integrated two-adapter proof (#1039) and the autonomous containment proof (#676)
have also passed on that tuple; both drive the installed adapters with loopback
fixture inference. Each automatic proof retains its exact tuple in
`tmp/worker-host-probe.json`, `tmp/policy-boundary-probe.json` or
`tmp/autonomous-containment-probe.json` and the unit-job logs/artifacts. Changing a tuple still requires the actual
per-turn capability check; an OS name alone never admits a turn.

| Host / architecture | Kernel / Bun / bubblewrap | Installed adapters and runtimes | Brain / scratch backing filesystems | Required capabilities and proof |
| --- | --- | --- | --- | --- |
| Linux x86_64, measured 2026-10-10 | `7.2.5-3-omarchy` / `1.4.2` / `0.12.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain Btrfs (`0x9123683e`); isolated scratch tmpfs (`0x01021994`) | Runnable bubblewrap; permitted unprivileged user/mount/PID/IPC/UTS namespaces; fresh proc/dev; `mkfifo`; Linux proc descriptor metadata and Bun execve. Actual probe, hardlink/scratch-alias bytes and membership checks, scratch readback, stdio/descriptor refusals, and active-gate turn regressions passed. The integrated proof `tests/policy-write-boundary.test.ts` (all 14 tests, both adapters) passed on this tuple on 2026-10-10. |
| Ubuntu 24.04 CI x86_64, measured 2026-10-10 | `6.17.0-1022-azure` / `1.4.2` / `0.9.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain ext4 (`0xef53`, confirmed with findmnt); isolated scratch tmpfs (`0x01021994`) | Same capabilities as the Linux row above. All seven real launcher/probe tests and all six refusal/authority gate tests passed in [the automatic unit job](https://github.com/schlessera/brain-kit/actions/runs/38014138934/job/114100926349). The exact tuple is retained in its logs/artifact; this component receipt is distinct from the full PR verdict. The integrated proof `tests/policy-write-boundary.test.ts` (all 14 tests, both adapters) passed on this tuple in [its automatic unit job](https://github.com/schlessera/brain-kit/actions/runs/38053535597/job/114217419653) on 2026-10-10; `tmp/policy-boundary-probe.json` in that job's artifact records the tuple. |
| Docker 29.7.2 container, Ubuntu 24.04 image, on Linux x86_64, measured 2026-10-11 | `7.2.5-3-omarchy` / `1.4.2` / `0.9.0` | Claude adapter `0.41.0`, Agent SDK `0.3.293`, native Claude Code `2.1.292`; pi adapter `0.41.0`, coding-agent `0.99.2` | Launcher tests: brain Btrfs bind mount (`0x9123683e`). Integrated proof: brain on the container's overlayfs (`0x794c7630`). Scratch tmpfs (`0x01021994`) | Same capabilities as the Linux row, with the [container options above](#running-the-server-in-a-docker-container): the derived seccomp profile and `systempaths=unconfined`, run as a non-root user, no added capabilities, on a host without AppArmor. The actual probe passed in both modes. The component proof passed (84 tests across the five files), as did `tests/policy-write-boundary.test.ts` (all 14 tests, both adapters) and `tests/autonomous-containment.test.ts` (all 4) with `packages/ui-sdk/tests/inference-relay.test.ts`. Without `systempaths=unconfined` the probe refused at the `/proc` step. With Docker's default seccomp profile it refused at namespace creation, or at `pivot_root` with `SYS_ADMIN` added. |
| Native macOS / Windows | No qualified tuple | No qualified runtime pair | No qualified backing filesystems | Refused before writer initialization: required Linux namespaces unavailable. |

No new WSL2 tuple has passed this implementation's checks. WSL2 may qualify
only through the same actual launcher/probe and integrated adapter proof; the
investigation's historical WSL2 measurement is not a supported row.

The browser client's operating system is independent of this backend-host rule.

## Reproducing the component proof

After the frozen dependency install, run:

```sh
bun run test packages/ui-sdk/tests/worker-launcher.test.ts \
  packages/ui-sdk/tests/worker-sandbox.test.ts \
  packages/core/tests/cli-read-only.test.ts \
  packages/ui-server/tests/worker-host-gate.test.ts \
  packages/ui-server/tests/run-session.test.ts \
  packages/ui-server/tests/autonomous-turn.test.ts \
  packages/ui-server/tests/ws-handoff.test.ts
```

For the integrated two-adapter proof, run `bun run test tests/policy-write-boundary.test.ts`.
It needs bubblewrap, unprivileged namespaces and `python3`, and makes no request
beyond the loopback fixture inside its own network namespace.

For the autonomous containment proof, run `bun run test tests/autonomous-containment.test.ts
packages/ui-sdk/tests/inference-relay.test.ts`. It also needs `/usr/bin/python3`,
which the attack runs inside the restricted envelope. Listeners outside the
worker and the server count every connection and datagram, and the fixture
upstream records the credential the relay injected.

The component fixture programs perform only filesystem/stdio operations and make no
network or provider requests. The probe's clear environment and exec boundary
do not propagate a JavaScript test preload into arbitrary future worker code;
the tests prove the named component operations, not runtime or egress containment.
The test harness keeps workspace output ownership with the existing ancestor
instead of transferring its writable lock descriptor into the worker bootstrap.

## Governed and strict hosted turns (0.42.0)

Interactive and voice turns default to `governed`: ordinary brain files are
writable inside the isolated worker. Policy, Git config/hooks, startup code,
installed dependencies and permission configuration remain protected. Existing
protected names are read-only, with self-bound ancestors; `.env*` is masked.
Unsafe linked or mounted protected paths select `strict`, with the cause in the
agent's note. Autonomous turns keep their restricted envelope.

`createApp({ workerProfile: "strict" })` opts ordinary hosted turns into strict.
Strict and restricted workers execute configuration from complete immutable
startup views, including imported helpers and absent names. Strict persistent
writes use `/tmp/brain-worker-areas/scratch` and
`/tmp/brain-worker-areas/workspaces`; link their canonical brain destinations.
Strict persistent writes are staged privately and validated after worker exit.
Maintenance writes use a separate server-validated output workspace. New
directory permissions are finalized after child publication. Finalization checks
the held and visible directory identity and temporary mode (using kernel
dentry paths if a peer removes ancestor search access), preserves a newer
peer mode, and processes every pending directory even if one final chmod fails;
the check and chmod are separate syscalls. The inaccessible-ancestor check
relies on workers having a separate mount namespace from the host. Worker-controlled unreadable private
copies are cleaned without following links, and cleanup failure cannot retain
the writer gate or staging reservation. Curated
writes retain their authoritative route. A governed turn triggers an incremental
index refresh after its workers exit, serialized on the server lock.

`runtime.workerHost.governed` states the selected default, resolved protected
paths, configuration view and shared-uid protection. Per-turn capabilities name
the actual mounts, fallback cause and limits. Without an identity helper,
protection is mask-only. Maintenance credentials and egress retain the interim
limits stated in the capabilities note. The journal keeps observed canonical
brain/workspace versions, not every write between observations; external
persisted Claude auto-memory remains outside that review/revert coverage.
Native read observations survive ordinary turns on the running backend but
not a host restart. Those remaining scopes do not change the shipped profiles.
Governed peers may see one another's configuration immediately; snapshot
consumers retain their startup inputs until the next launch. See the
[governed-worker decision](../decisions/governed-writable-workers.md).
