# Decision — isolated agent writers and validated authoritative edits

The maintainer's three 2026-10-02 rulings on
[#674](https://github.com/schlessera/brain-kit/issues/674) select:

1. [Isolated workers and server-validated edits](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943637433).
2. [Existing approvals for permitted edits](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943943836).
3. [Linux-first hosting, with qualifying WSL2 profiles](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5944340342).

These choices bind implementation. They do not establish production containment,
enable autonomous execution or make a release commitment. The
[finite investigation](../plans/policy-write-boundary.md) remains evidence about
its measured fixture. The [async collaboration decision](async-collaboration.md)
and [voice decision](voice-permission.md#containment-shared-with-51-deliberately-not-identical)
continue to bind authority and tool membership.

## Every writer enters through the boundary

Both first-party runtimes run in isolated workers, confined **before** SDK,
extension, custom-tool or other agent writer initialization. This includes pi
extension factories and Claude runtime-owned executors, rather than only their
shell children. Each worker receives a read-only authoritative brain view and
separate writable scratch. The boundary covers ordinary interactive, voice and
autonomous turns, including indirect scripts and nested execution.

> **2026-10-11 — Superseded for interactive and voice turns ([governed writable workers](governed-writable-workers.md#what-this-supersedes-and-what-still-binds)).**
> The read-only brain view and "no longer directly change authoritative brain
> files" below now hold for `strict` and `restricted` workers only. A
> `governed` worker, the default for interactive and voice turns, binds the
> brain read-write. Policy-protected paths stay read-only, and every change is
> journaled. Pre-initialization isolation still binds.

Ordinary shell and custom-extension writes therefore no longer directly change
authoritative brain files. Their output stays in scratch or staging until an
explicit bounded application request names the files and exact proposed changes.
The privileged server never replays a worker's command. Workers receive neither
arbitrary privileged filesystem handles nor a generic privileged shell route.

Use the existing server lifecycle and AgentBackend interface for worker ownership,
communication and teardown. This choice adds no daemon or extension seam.
Cancellation and session history must remain accurate across worker execution,
application, refusal and recovery.

This is a change to the execution architecture. Current Claude assembly creates
SDK options and in-process bridge tools (`createClaudeSdkTurn`,
`packages/ui-backend-claude/src/sdk-options.ts:83-258`); pi builds its worker-local resource
loader and calls `reload()` (`createSessionResources`,
`packages/ui-backend-pi/src/session-resources.ts:28-103`). A child-only wrapper
cannot be treated as proof for those parent-side paths. The investigation records
the concrete unsandboxed extension-initialization escape.

## Application preserves existing authority

Otherwise permitted ordinary interactive document/file edits may complete during
the turn without an additional confirmation for every edit. Curated brain
operations retain their existing permissions. An explicit shell/extension
application request is a bounded proposal, not authority supplied by the worker.
The server validates every application against:

- The exact operation, input and target, and the principal's **current** authority.
- Policy-path, ancestor and alias denial; bounded payloads and explicitly supported
  operations and file kinds.
- Filesystem topology races and stale or conflicting content. Unsupported effects
  and conflicts visibly refuse, without overwriting concurrent edits or silently
  merging them.
- Existing locking, indexing, cancellation and accurate history, including which
  changes actually reached the authoritative Markdown.

Destructive effects retain their existing explicit permissions. A successful
scratch write, an allowed tool name or a prior application cannot authorize a
different effect. The server-owned validation/application path must be covered
by the boundary proof, including privileged bridge effects.

R35 denies policy writes to **every** agent runtime, including ordinary shells,
extensions and autonomous agents. R33's v1 no-policy-read rule remains binding:
policy content cannot supply authority; policy formation and activation stay
deferred. This record grants no new policy access or standing permission.

> **2026-10-11 — R33 superseded, R35 retained ([governed writable workers](governed-writable-workers.md#the-policy-file)).**
> The host now reads the governance policy file `context/policies/governance.md`,
> which is mounted read-only in every worker. It grants autonomous turns
> nothing, and R34 grant files stay deferred. No agent runtime writes policy.

Voice and unattended execution retain **one tool-enforcement mechanism with
different named memberships**. The filesystem boundary applies to both and to
ordinary turns. Voice keeps its narrower membership, including raw-write
exclusions; speech may refuse and can never grant. Authorized curated capture
and update operations remain possible under their existing rules.

R31 unattended share triage remains confined to scratch/staging. Authoritative
autonomous effects still require existing explicit bounded authorization for
the exact operation. Neither triage nor the isolated-worker choice authorizes
acting on arbitrary shared content.

## Supported-host matrix and visible refusal

Initial support is limited to **explicitly verified Linux profiles**, starting
with the namespace/bubblewrap candidate. WSL2 is eligible only when the required
capabilities actually work and the same integrated proof passes. Native macOS
and native Windows backend hosting are deferred to separate measured work.
The browser client's operating system is independent of backend-host support.

The matrix below states eligibility and proof obligations, not a list of proven
production profiles. Implementation must publish exact architecture, runtime
versions, backing filesystem and capability tuples and prove each supported row.
An OS label or successful version check alone is insufficient.

| Backend host | Architecture and runtime versions | Backing filesystem | Required capabilities and disposition |
| --- | --- | --- | --- |
| Linux | Exact architecture, kernel, Bun, sandbox launcher and installed Claude/pi adapter/runtime versions measured together | Exact authoritative and scratch filesystems, including alias and topology behavior | Establish the pre-initialization namespace/bubblewrap boundary, read-only brain, separate writable scratch and closed inherited authority; pass both adapters' integrated proof before declaring support. |
| WSL2 | Exact WSL2 kernel/architecture and the same runtime dimensions as Linux | Exact brain/scratch locations and filesystem behavior; WSL2 presence is insufficient | Meet the same actual capability and integrated-proof requirements as Linux; otherwise visibly refuse. |
| Native macOS / Windows | No supported tuple selected by this ruling | No backing filesystem qualified by this ruling | Backend hosting deferred; visibly refuse rather than use a weaker profile. |
| Any unlisted or failed profile | Unknown or unverified tuple | Unknown or unverified behavior | Refuse before writer initialization; do not infer support from a similar measured row. |

Before **each** interactive, voice or autonomous turn initializes any agent
writer, verify that the required boundary can actually be established. An
unsupported profile or failed capability/confinement check must visibly refuse,
name the missing requirement and give a supported-host route. There is no weaker
profile or automatic unsandboxed fallback. Version compatibility and historical
measurement do not substitute for this check.

The investigation's historical tuple was Linux x86_64 on WSL2 kernel
`6.18.33.2-microsoft-standard-WSL2`, Bun `1.3.14`, Python `3.12.3`, bubblewrap
`0.9.0`, Landlock ABI `7`, pi coding-agent `0.99.2` and Claude Agent SDK
`0.3.283`, measured on 2026-10-01. That finite fixture is **not** a supported
production matrix row: the Claude spawn adapter ran a fixture program rather
than a vendor model turn, and authoritative application was absent.

## Why these alternatives lost

The [architecture comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943238069)
considered retaining direct authoritative writes through a separately privileged
worker identity and protected inode/ancestor ownership. It would require a new
concrete privilege and filesystem layout with proof for aliases, rename,
descriptors and bridge effects. The finite investigation supplied no such
proof. The maintainer accepted the changed shell/extension behavior of read-only
workers with validated effects instead. Neither choice is proven by its approval.

The [editing comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943640675)
considered mandatory review for every staged edit. The maintainer selected
existing approval rules so otherwise authorized interactive edits can finish
in their turn without an extra confirmation. Exact validation, conflict refusal
and destructive permissions remain mandatory; the choice removes no guard.

The [host comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943978912)
considered broader initial platform support. Linux-first delivery avoids treating
unmeasured native macOS/Windows designs as equivalent containment. WSL2 must
qualify on capabilities and proof rather than its name.

## Evidence the implementation still owes

#674 owns production integration and the all-writer proof. Exercise both
installed adapters through their actual ordinary-turn entry points, using a
keyless fixture inference transport. Observe nonempty original policy bytes and
directory membership from outside the boundary, alongside successful unrelated
permitted authoritative edits through the selected application route.

Retain the investigation's weaker-profile escapes: writable hardlink aliases,
host scratch aliases, inherited writable descriptors, policy-backed stdio,
parent-side extension initialization and confinement applied after an open.
Add mappings, descriptor/socket transfer, `/proc`/parent access, topology races,
extension startup before tool events and privileged bridge effects. Mutate the
integrated enforcement, observe the intended write-safety assertion fail, then
restore it. Prove unsupported-profile refusal occurs before initialization.

### The integrated proof — #1039

`tests/policy-write-boundary.test.ts` is that proof. Its probe
(`tests/fixtures/policy-boundary-probe.ts`) runs each adapter through
`runSession`, a voice `HostWork` or `runAutonomousTurn` with loopback fixture
inference, inside a network namespace. An outer stage that is neither the server
nor the worker records the policy bytes, the policy directory membership and a
manifest of the whole brain tree before and after the turn. It also sets up the
attack surfaces: policy-backed server stdout, an inherited writable descriptor,
a writable descriptor and shared mapping opened before confinement, a donor
process that holds both, and hardlink, symlink, directory-symlink and outside-brain
aliases.

For both adapters the suite covers:

- **Interactive turns.** The six measured escapes, socket and `/proc`
  descriptor transfer, mappings, `/proc` access to the server and donor, case and
  NFKC aliases, every routed operation and the mask and ask-user bridge effects.
  The writers are Bash, indirect and nested scripts, a Claude subagent, the pi
  extension tool and the brain CLI. Each runs beside a permitted `edit_file`
  that reaches Markdown in the same turn.
- **Route races.** Directory, hardlink, symlink and policy-ancestor swaps between
  the route's validation and commit, made through its deterministic
  `beforeCommit` seam.
- **Voice.** Claude's narrower membership cannot grant, raw writes are outside
  it, and a capture still lands. pi refuses voice turns before any worker starts.
- **Autonomous turns.** Bash and the raw write tool are explicitly allowed, but
  their writes stay in scratch. The autonomous bridge has no application route,
  so R31 is held by the absence of any authoritative change, not by a paired
  edit. Since #676 these turns run in the restricted envelope and load no
  project hook, MCP server or extension, so the suite asserts that none of the
  pre-tool executors starts.
- **Refusal.** With a failing host probe, interactive, voice and autonomous turns
  are refused before any inference request, process spawn or pre-tool executor.

Its recorded mutations are a writable brain bind with a blind probe, which fails
the policy-bytes assertion for both adapters; a removed route topology recheck,
which fails the race case; and a skipped host gate, which fails the refusal cases.
It runs in the CI unit job and has passed on both rows of the
[measured matrix](../hosting/agent-workers.md#measured-host-component-matrix).
It proves the filesystem boundary only.

#676 separately owns complete R28/R29/R31 credentials, ambient-configuration and
egress containment for both runtimes. The filesystem experiment, these rulings,
the integrated proof and a green tool-membership test do not discharge that
obligation. Interactive and voice workers still share the host network
namespace, so a host process that hands out descriptors over a reachable Unix
socket is not a case this suite closes. The restricted envelope for autonomous
turns and its proof are recorded in
[the async collaboration decision](async-collaboration.md#autonomous-containment--2026-10-10).
Autonomous enablement still requires the complete system proof. #674 must
assess its implementation's machine-contract and version impact separately;
this decision changes documentation only.

## Curated operations use server-owned tools — 2026-10-05

The [maintainer ruling](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5999043045)
selects server-routed structured tools for hosted curated writes in both adapters.
Capture, update and archive complete in one validated step with existing approvals,
locking, indexing and current-principal authorization. Hosted Claude turns shadow
project `brain` MCP write tools. Terminal MCP clients keep their names and schemas.
Core skills name the hosted tools while retaining terminal CLI instructions.

CLI writes through a read-only worker fail visibly with a read-only diagnostic
and curated-tool guidance; no command is staged or replayed.

> **2026-10-11 — Superseded for `governed` turns ([governed writable workers](governed-writable-workers.md#the-change-journal-and-reconciliation)).**
> The CLI writes directly in a `governed` worker. The read-only diagnostic
> remains the `strict` behavior. New hosted tool names
and schemas are an additive contract change with a minor changeset. Bubblewrap
0.9 remains eligible; writable overlays and copied scratch brains are declined.
The three October 2 rulings, R31, R33, R35 and voice membership are unchanged.

The five implementation children of #51 separately own host setup, this application
route, each runtime worker, and integrated escape proof. The route does not claim
worker containment or enable unattended authoritative writes. Current principal
and exact operation membership are checked again at application time. Supported
applications are bounded UTF-8 Markdown effects plus the narrow PNG mask
operation below, never commands or file handles.

## PNG mask application — 2026-10-10

The [maintainer ruling on #1037](https://github.com/schlessera/brain-kit/issues/1037)
preserves hosted masking through one server-owned binary operation. It accepts
only a PNG mask for a submitted existing image, at the existing adapter filename,
selected by trusted server backend identity, with an 8 MiB byte cap and PNG signature check. Exact browser submission, current
turn authority/membership, cancellation, image/mask bases, policy/alias/path and
topology checks bound the effect. Scratch masks retain their existing prerequisites;
pruning runs under the same authority and records actual removals. The bridge tool
and browser/model result shape remain unchanged. This is an additive contract
change; it supplies no generic binary route or autonomous authority.

Claude uses the structured server write/edit tools rather than translating native
built-in callbacks.

(2026-10-11: under `governed`, native `Write`/`Edit`/`NotebookEdit` are
available again and journaled; this sentence binds `strict`. See
[governed writable workers](governed-writable-workers.md#the-change-journal-and-reconciliation).) This preserves exact-base validation and server-side permission
checks without performing a privileged effect inside a hook that the runtime can
later deny. Unsupported notebooks refuse. The CLI, tools, subagents and project
stdio MCP descendants enter the mandatory worker; only trusted bridge handlers and
bounded native transcript persistence remain in the parent. #1039 owns the wider
integrated escape matrix; #676's credential, configuration and egress proof is
[recorded separately](async-collaboration.md#autonomous-containment--2026-10-10).

## Writable areas inside the worker — 2026-10-11

The maintainer's rulings on [#1626](https://github.com/schlessera/brain-kit/issues/1626)
add designed writable areas to the read-only worker for interactive and voice
turns: the brain's `.brain/scratch/` and its existing `workspaces/` directory
as writable binds, and a per-turn overlay over `$HOME` with an XDG fallback.
Every refusal from inside those areas still meets the boundary: the integrated
proof above attacks from inside both and passes. The earlier sentence "writable
overlays and copied scratch brains are declined" still holds for the brain;
the home overlay never covers it and is optional, so bubblewrap 0.9 stays
eligible. Restricted autonomous turns are unchanged.
[The writable-areas decision](worker-writable-areas.md) records the rulings,
checks and measurements. A "governed writable" default for interactive and
voice turns is being designed separately and will revise this section and
parts of this record.

## Runtime state budget across concurrent turns: the shared ledger (option A) — 2026-10-11, superseded

**Superseded the same day by the private per-worker tmpfs below.** This
section is kept as the record of the earlier delegated ruling
([#1625 comment](https://github.com/schlessera/brain-kit/issues/1625#issuecomment-6113479512))
and of what draft #1678 measured for it at `c8ea98c7`. That code never merged;
its names below refer to that draft, not to the current tree.

#1621 made each Claude turn's runtime state session-scoped and admits one turn
against the tmpfs's free space. #1625 adds the concurrency dimension: every
turn's state directory sits on the host's one `/dev/shm`, so a free-space
reading is not admission. Two turns could both see room, then both copy and
both fail with `ENOSPC`, and a turn's transcript keeps growing after it is
admitted. The maintainer assigned option A from #1625's triage (a shared
reservation with bounded growth and named refusal) for the 0.42.0 batch.

- **One in-process ledger per state root.** Admission reserves settings,
  memory, resumed history and the growth reserve against the tmpfs's free
  space less what live reservations have not yet written (the draft's
  `admit` in `worker-state.ts` and `createStateLedger` in
  `worker-state-budget.ts`). Reserve,
  copy and release are synchronous in the server process, so check-then-copy
  cannot interleave between turns. Cleanup releases on every exit path,
  including a failed copy, a failed launch and a failed removal. What never
  fits the tmpfs or the 128 MiB bound stays `session_too_large`; what fits but
  is held by running turns is `worker_state_busy`, so a user is not sent to a
  new conversation for a capacity problem that clears by itself. Autonomous
  turns reserve the growth reserve too, because they write there while they
  run.
- **Growth is measured, then stopped by name.** The spawn measures the running
  state every 250 ms (the draft's
  `monitor` in `worker-spawn.ts`). Within 8 MiB of its
  reservation a turn extends it to 16 MiB beyond its usage into space no
  other turn holds. A turn that has outgrown its reservation with no unheld
  space left, passes 128 MiB, or makes its state unreadable to the server is
  killed and reported as `worker_state_exceeded`. What it saved still goes
  through the ordinary persist checks. An unmeasurable state counts as
  wholly unwritten in other turns' admission. Live usage is always measured
  before free space is read, so a concurrent write can only make a check
  stricter. A host cancellation outranks a state failure measured meanwhile;
  otherwise the turn reports the recorded class, not the runtime's own error
  for a killed process.
  **Residual:** this is polling, not a quota. A turn that writes more than its
  unheld headroom within one interval can still fill the tmpfs before it is
  stopped, and another turn's write in that window can see `ENOSPC`. A turn
  whose result already streamed stays completed; an overshoot found by the
  exit check is then only logged. A second server process or any other tmpfs
  user appears only as used space, never as a reservation, so the hosting doc
  says one server per `/dev/shm`.
- **Agent memory persists (#1626 finding 2, memory option M2).** Interactive
  turns copy the project's `memory/` folder in and write back new or changed
  `.md` notes directly in it (the draft's
  `persist()` in `worker-state.ts`; the same rule now runs in the copy-out
  below), with the
  transcripts' alias, redirect, byte-bound and concurrent-change checks. A
  note another turn changed meanwhile is refused alone and named, and nothing
  is deleted. Trust: memory is model-written text later sessions load as
  context, the same trust as the transcripts already persisted. It is never an
  authority for brain writes, which keep going through the server's validated
  routes. Autonomous turns still see and keep no memory.

**A per-worker tmpfs, considered and not adopted then (#1625 item 3, option B).**
The reasons as recorded at the time follow; the next section answers each with
a measurement. A
size-limited tmpfs per worker would give each turn a fixed budget independent
of the host's `/dev/shm`. It does not fit this boundary:

- The server cannot mount one itself. A parent-side tmpfs mount needs
  `CAP_SYS_ADMIN` in the host's mount namespace, which a hosted server does not
  hold.
- A tmpfs bubblewrap mounts inside the sandbox lives in the worker's mount
  namespace and disappears with it. Persisting would then have to copy out
  while the runtime is still alive, which gives up the property that no
  runtime writer can race the copy-out once the PID namespace is gone.
- A size option caps one mount and does not reserve memory. Per-worker caps do
  not bound their sum, so the host limit would only move from `/dev/shm` to
  memory exhaustion, with no named refusal; host admission would still be
  needed.

The shared tmpfs with an in-process ledger kept the copy-out after namespace
death and named every refusal; its hosting rule was
`per-turn budget x expected parallel sessions` of `/dev/shm`.

**Evidence for option A** (draft #1678, a real 64 MiB `/dev/shm` in a private
mount namespace, actual workers): on #1640's code the second of two 30 MiB
conversations was refused as `session_too_large` and a growing turn hit
`ENOSPC`; with the ledger, the second turn was refused as `worker_state_busy`
and ran once the first ended, two fitting turns both persisted, and a growing
turn was stopped by name before the tmpfs filled. Thirteen mutation receipts
covered its guards. These receipts prove option A's measured cases only.

## Runtime state: a private, size-limited tmpfs per worker (option B) — 2026-10-11

The maintainer then selected option B explicitly
([#1625](https://github.com/schlessera/brain-kit/issues/1625), decisions of
2026-10-11 from 21:11 UTC), superseding the shared ledger above, and settled
its policy:

- Each worker's runtime state is a **private, size-limited tmpfs** with a
  **fixed allowance**, the same for every worker: **64 MiB (67,108,864 bytes)
  by default**, set by trusted host configuration
  (`BRAIN_UI_WORKER_STATE_BYTES`, or the backend's `workerState` option),
  never by brain content. One resolved value drives the mount size, the
  reservation, the copy guards, the diagnostics and the agent's note. The
  hard-coded 128 MiB state bound and #1640's growth reserve are gone: a
  conversation is `session_too_large` exactly when its starting state does not
  fit the allowance.
- Before launch, the **whole allowance is reserved atomically** against an
  **aggregate budget**: by default the allowance times `MAX_CONCURRENT_SESSIONS`
  (192 MiB at the defaults), or an explicit `BRAIN_UI_WORKER_STATE_BUDGET_BYTES`
  that may admit fewer workers than the session cap. Both are validated
  (positive whole multiples of 4096 bytes, a budget of at least one allowance,
  a product that is a safe integer; `export function resolveWorkerStateLimits`,
  `packages/ui-sdk/src/server/worker-state-limits.ts:107-137`); an invalid value
  refuses the boot by name. The reservation is logical admission, not
  allocated RAM.
- When the budget cannot take another allowance, the turn is **refused
  immediately** as `worker_state_busy` with Retry: no queue, no wait, no
  automatic retry, nothing sent. A worker keeps its admitted allowance for
  its whole life; a configuration change cannot shrink it or erase its
  reservation.

**Admission.** One ledger per server process, shared by every Claude backend
instance through a process-global slot, so recreating a backend never forgets
a running worker (`export function createStateLedger`,
`packages/ui-sdk/src/server/worker-state-budget.ts:59-99`). Reserve and
release are synchronous; every exit path releases. The supported envelope is
one server process per budget: a second server process on the same host has
its own ledger, so the operator splits the host's headroom between them with
the budget override.

#1703 adds a separate private turn-temp tmpfs at `/tmp`, default 256 MiB,
including worker scratch and XDG directories. The shared ledger admits its
whole allowance alongside runtime state, both or neither, across Claude and
pi. Its aggregate budget defaults to allowance × maximum concurrent sessions;
`BRAIN_UI_TURN_TEMP_BYTES` and `BRAIN_UI_TURN_TEMP_BUDGET_BYTES` override it.
Real HOME remains read-only. The host retains a directory descriptor for
post-exit promotion; `turn_temp` reports usage and safely purges only that
mount, with a linked-file guard and a governance event. Nested runtime state
is excluded from promotion and purge by descriptor device checks.

**The mount.** bubblewrap mounts the tmpfs with `--size <allowance> --tmpfs`
at a fixed path inside the worker. `--size` exists since bubblewrap 0.7.0, so
the 0.9.0 measured on the Docker host profile has it. The Claude backend's
per-turn probe mounts the allowance and checks its size from inside, and
refuses older bubblewrap by name; while the Claude backend is active, the
server's recorded boot and "Check again" probes do the same, so the host
status reports it. The tmpfs exists only in the worker's mount namespace.
Inside it the filesystem limit is the enforcement: a write past the allowance
fails with `ENOSPC` in that worker and nowhere else. No `/dev/shm` space is
used any more, so Docker's 64 MiB `/dev/shm` no longer limits parallel
sessions.

**Copy-in and copy-out from the server side.** The server must fill the tmpfs
before the runtime starts and read it after the worker is gone, while the
tmpfs is reachable only inside the worker. The launcher does both from the
host (`export function launchAgentWorker`,
`packages/ui-sdk/src/server/worker-launcher.ts:663-704`):

1. It finds the sandbox's first process from the kernel's record of
   bubblewrap's only child, then opens the tmpfs root through
   `/proc/<pid>/root` and keeps that directory descriptor
   (`function openPrivateState`,
   `packages/ui-sdk/src/server/worker-launcher.ts:573-597`). bubblewrap's
   process exists before its mounts do, so the open is accepted only once the
   path is its own mount (a device other than its parent's), a tmpfs of
   exactly the allowance, and empty; until then it would name the host's
   directory or nothing. The wait is bounded at five seconds and fails fast if
   bubblewrap exits.
2. The worker's command is held behind a start gate that runs before any agent
   code: the absolute `/bin/sh` reads one line from the worker's stdin with
   its `read` builtin, which only the server writes, and then becomes the
   command; closed stdin or any other line ends the worker unstarted
   (`const STATE_GATE`, `packages/ui-sdk/src/server/worker-launcher.ts:36`).
   The gate runs no `PATH` lookup, so nothing in the worker's environment or
   the brain can stand in for it, and the shell reads a pipe a byte at a time,
   so the runtime's own input is untouched. The server copies the snapshot in
   through the held descriptor (`populate(root) {`,
   `packages/ui-backend-claude/src/worker-state.ts:190-211`), then opens the
   gate. A failed copy kills the worker unstarted and releases everything.
3. After the worker exits, its PID namespace is gone, and with it every process
   that could write the tmpfs. The held descriptor still reaches the detached
   mount, so the server walks it then (`persist(root, rewrite) {`,
   `packages/ui-backend-claude/src/worker-state.ts:216-255`) with the existing
   rules: only this brain's native transcripts and `memory/*.md` notes, every
   directory checked with `lstat` before it is entered, every file opened with
   `O_NOFOLLOW` and refused on the descriptor when it is not a regular file,
   has more than one link or passes the allowance, the total bounded by the
   allowance, and a saved file that changed meanwhile never overwritten.
   Because no writer survives, nothing can swap an entry between a check and
   its use. Closing the descriptor frees the tmpfs.
4. If the server dies, `--die-with-parent` ends the worker; its namespace and
   tmpfs go with it. Nothing is left on the host to sweep.

**Why not the alternatives** (measured 2026-10-11, Linux 7.2, bubblewrap 0.12.0
native and 0.9.0 in Docker, Bun 1.4.2):

- *A host-visible size-limited tmpfs per worker.* An unprivileged server cannot
  mount one: `mount -t tmpfs -o size=64m` fails with "must be superuser". A
  mount made inside a user namespace exists only in that namespace; the host
  sees the plain directory under it. So a private mount plus a server-side route
  into it is the only unprivileged form.
- *bubblewrap's own `--block-fd`/`--info-fd`.* The trusted bootstrap reaches
  bubblewrap through Bun's `process.execve`, which closes every descriptor above
  2, and Bun itself marks inherited descriptors from 4 up close-on-exec. No
  extra descriptor survives to bubblewrap without loosening the bootstrap's
  descriptor rule, so the gate uses stdin, which already exists.
- *A trusted keeper inside the sandbox streaming state through a pipe.* It
  would share the agent's uid and PID namespace: inside the sandbox a process
  killed a sibling with `kill -9` at once, so the agent could kill or trace the
  keeper. Its copy-out would also have to run while the agent's descendants are
  alive, giving up the no-writer property above.
- *A host-side private directory, bind-mounted.* It is disk or `/dev/shm`
  backed with no per-directory size limit for an unprivileged server, which is
  exactly the shared exhaustion this decision removes.

Cost: launching a worker with private state takes a median 32 ms (empty) to
70 ms (30 MiB copied in), against about 2 ms to spawn one without state.

**Exhaustion is named, not polled.** The native runtime does not fail when its
runtime state is full: measured with Claude Code 2.1.292, a turn whose tool
filled the tmpfs still streamed its answer and reported success, while the
answer was missing from its saved transcript, and it freed some space again
as it exited. So the state is checked when the result arrives, the terminal
result is held until the worker has exited and its state has been copied out,
and the state is checked again then. A `statfs` of the tmpfs with no whole page
free at either point, or a write error the worker reported, names the turn
`worker_state_exceeded` (`const unsaved`,
`packages/ui-backend-claude/src/turn-runner.ts:231-238`). A result, success or
error, becomes an error result with that class and keeps its usage, so the
client never presents unsaved output as saved; what was written before the
limit is persisted with the usual checks, and if that copy-out is refused the
message says so instead. A copy-out refusal without exhaustion is named
`worker_state_save_refused` (#1697), with a safe reason and an explicit
incomplete-save disclosure; retry does not recover unsaved state. A reported write error stays on record however much
the worker prints after it, and a refusal is recognized by its class from any
copy of the module. A host cancellation outranks it.
**Residual:** a turn that fills the tmpfs and frees space again between those
two checks is named only if the runtime printed the write error.

**Admission comes first.** The reservation is taken before an archived
session is restored and before any file is read, so a `worker_state_busy`
refusal changes nothing on disk; a later `session_too_large` or failed copy
releases it. The agent's note on its allowance is generated from the same
resolved value for interactive and restricted autonomous turns.

**Evidence for option B.** Real workers through the real launcher, native and
in the Docker host profile's container (bubblewrap 0.9.0, non-root, the derived
seccomp profile, `systempaths=unconfined`), with `/dev/shm` a 64 MiB tmpfs that
the workers must leave untouched: two parallel 30 MiB conversations each get a
64 MiB tmpfs, run and persist; a budget of one allowance refuses the second as
`worker_state_busy` before launch and Retry then runs it; a turn that outgrows
its allowance hits its own limit, is named `worker_state_exceeded`, and the
other turn is untouched; an 8 MiB override is the mounted limit and the size
refusal; links planted in the state (a symlink, a hardlink, a symlinked
directory, a symlink swapped in late) are refused at copy-out and nothing is
exported; a server killed mid-turn leaves no worker behind; and the actual
Claude runtime's full-state turn ends as `worker_state_exceeded` with its
unsaved answer absent from history. A root-run server's copy-in, limit and
copy-out were also measured in that container.
