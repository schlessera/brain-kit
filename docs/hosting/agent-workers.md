# Agent worker host boundary

The [all-writer decision](../decisions/policy-write-boundary.md) requires a
read-only authoritative brain and isolated writable scratch before an agent
writer initializes. The shared TypeScript launcher and per-turn host probe are
the host-side implementation of that decision (#1035).

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
the restricted mode while autonomous work is enabled. A failure is logged once
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

Bubblewrap establishes user, PID, IPC, UTS and mount namespaces, drops all
capabilities, mounts `/` and the canonical brain read-only, and replaces `/proc`
and `/dev`. When the server runs as root, the worker's whole `/proc` is
read-only as well (#1629, see [running as root](#running-the-server-as-root)).
`/tmp` is private tmpfs; the per-turn scratch location is a fresh
tmpfs and cannot overlap the brain or its ancestors. The brain's own scratch
area and its workspace directory are writable binds inside the read-only
brain, and `$HOME` gets a per-turn overlay where the host supports one; see
[what a turn can write](#what-a-turn-can-write-and-where-outputs-go). The
worker receives only explicit environment entries and `BRAIN_WORKER_SCRATCH`.
The overlay is optional; bubblewrap 0.9 is eligible.
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

Each ordinary Claude turn copies settings, credentials and the account file
into a private runtime-state tmpfs directory under `/dev/shm`. Transcript state
is session-scoped: a resume copies only that session's JSONL and companion
folder; a new conversation copies no transcripts. After teardown, only changed
JSONL files for the resumed or newly created sessions are persisted. Other
saved sessions are untouched.

The host's `/dev/shm` must fit the settings plus the largest resumed session,
with room for concurrent workers and transcript growth. Docker's default is
64 MiB; increase it with `--shm-size` when needed. The backend checks free space
before copying, reserving the larger of 16 MiB or 25% of the resumed transcript
for turn growth and CLI files. Settings plus the 16 MiB minimum reserve that cannot fit refuse with `worker_host_unsupported`;
a session that exceeds available space or the 128 MiB state bound refuses with
`session_too_large`. Its error card offers **Continue in a new conversation**
through the existing reviewed handoff flow.

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
[writable-areas decision](../decisions/worker-writable-areas.md) records why
and how each is checked; a separate "governed writable" epic will revise this
default, and these areas will remain what its strict profile gets.

| Place | Paths | Lifetime | Link it for the reader? |
| --- | --- | --- | --- |
| Turn temp | `$BRAIN_WORKER_SCRATCH`, `/tmp`, writes under `$HOME` | Deleted when the turn ends | Never: the reader cannot open it. A file the answer links there anyway is copied into `.brain/scratch/turns/<turnId>/` and the saved link rewritten. |
| Persistent scratch | `.brain/scratch/`, and `workspaces/` for repository clones | Kept across turns; scratch is pruned after 7 days, oldest first past 1 GB | Yes: the only non-brain place to link |
| The brain | Everything else | Canonical | Yes, as documents |

- **The brain** stays read-only. Markdown changes go through the server's
  validated write and edit tools; a direct write, `git commit` or index
  command in the brain fails with `Read-only file system`.
- **`.brain/scratch/`** is created when missing and bound writable when every
  segment is a real directory (no symlink), no mount point sits at or below
  it, and, in a git repository, git ignores it (`brain doctor --fix` adds the
  line). A scratch name whose file also has a name outside scratch is
  unlinked before the turn. `brain render --scratch`, `brain image --scratch`
  and `brain scratch prune` work inside a turn, and the reader opens the path
  the command prints. The server never follows a symlink under `.brain/` when
  it serves, previews or lists a scratch path.
- **`workspaces/`** is bound writable only when it already exists as a real
  directory in the brain root. Core always excludes it from the index.
  Creating it outside a hosted turn is the opt-in; the name is fixed. It
  stays read-only for a turn when it holds a file hard-linked to something
  outside it, sits on or contains a mount point, holds more than 200 000
  entries, or holds a directory the server cannot read (scratch too); the
  agent's note and the server log name the reason. Links wholly
  inside it, such as local clones between workspace repositories, are fine.
- **`$HOME`** gets `bwrap --tmp-overlay` when the host can mount it:
  bubblewrap 0.11.0 or later, not installed setuid, and a kernel that allows
  overlayfs in an unprivileged user namespace. Each turn probes this with
  the real launcher. Existing configuration such as `.gitconfig` still
  reads; every write is discarded at turn end. Otherwise the fallback keeps
  `$HOME` read-only and points `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
  `XDG_DATA_HOME` at per-turn directories under `/tmp/brain-worker-home`,
  which is what headless Chromium needs to start. Ubuntu 24.04's bubblewrap
  0.9.0 takes the fallback.
- **Turn temp** is a private directory the server creates for each worker on
  a tmpfs that is not the brain's device: its own temporary directory when
  that is a tmpfs, otherwise `/dev/shm`. Its capacity is that tmpfs's free
  space, shared with every running worker and, on `/dev/shm`, with Claude's
  runtime state; in Docker, size `/dev/shm` with `--shm-size` accordingly.
  When the worker exits, files its answer linked there are copied into
  `.brain/scratch/turns/<turnId>/` (128 MiB per file, 256 MiB and 64 files per
  turn), the saved answer links the copies, and the directory is removed. A
  symlink, a hard-linked file, a directory or anything over the bounds is not
  copied, and its link stays as written. Each copy or refusal is a governance
  event (`GET /api/governance/events`). A host without a usable tmpfs keeps
  turn temp inside the worker's namespace, logs that, and copies nothing.
- **Restricted (autonomous) turns** are unchanged: no area is bound, there is
  no host home, and `$BRAIN_WORKER_SCRATCH` and `/tmp` are the only writable
  places.

Every turn's agent reads a note generated from the same resolved layout that
builds the mounts, so it is told exactly which of these it has this turn,
and to put anything it links into `.brain/scratch/`, never into turn temp.
When a `brain` CLI write hits the read-only brain, the error names the rule
and the route: `brain render` and `brain image` say to use `--scratch`.

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

## Running the server in a Docker container

Docker's defaults stop the worker at three separate launcher steps. Each needs
its own option, and the probe refuses at the first step that fails, quoting
bubblewrap. The measurements, the alternatives to a fresh `/proc` and why
each was rejected are in the
[container fresh-/proc decision](../decisions/container-fresh-proc.md).

| Launcher step | Refusal without the option | What the container needs |
| --- | --- | --- |
| bubblewrap is installed | `bubblewrap is missing` | bubblewrap in the image. 0.9 is eligible. |
| Create the user and PID namespaces | `bwrap: No permissions to create new namespace…` | A seccomp profile that allows `clone`, `unshare`, `mount` and `umount2` without `CAP_SYS_ADMIN`. Docker's default profile allows them only with that capability. |
| Switch to the worker's root | `bwrap: pivot_root: Operation not permitted` | The same profile also allows `pivot_root`, which Docker's default profile never allows. |
| Mount the worker's fresh `/proc` | "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths; in Docker, run the container with --security-opt systempaths=unconfined" | `--security-opt systempaths=unconfined`. Inside a user namespace the kernel mounts a new procfs only when the parent `/proc` has no covered paths, and Docker covers several by default. No other option fixes this step. |
| (AppArmor hosts) mounts inside the namespace | Not measured. Docker's `docker-default` profile contains `deny mount`. | `--security-opt apparmor=unconfined`, or an AppArmor profile that allows the worker's mounts. |

Derive the seccomp profile from Docker's default profile for your Docker
version, adding one rule:

```sh
jq '.syscalls += [{"names":["clone","mount","umount2","unshare","pivot_root"],"action":"SCMP_ACT_ALLOW"}]' \
  default.json > worker-seccomp.json
docker run --user 1000:1000 \
  --security-opt seccomp=worker-seccomp.json \
  --security-opt systempaths=unconfined …
```

`--security-opt seccomp=unconfined` also passes, but it disables every
syscall filter rather than five. Do not add `--cap-add SYS_ADMIN` or
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
| `file_size` | `RLIMIT_FSIZE` | 16 GiB per file | `File too large` (`EFBIG`) |
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
