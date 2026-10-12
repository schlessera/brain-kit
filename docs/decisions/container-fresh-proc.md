# A fresh /proc for agent workers in a container

The agent worker launcher gives every worker its own user and PID namespaces
and a fresh procfs (`workerCommand`, `packages/ui-sdk/src/server/worker-launcher.ts:439-539`).
Under Docker's default masked `/proc` paths the kernel refuses that procfs
mount, so every turn on such a host refuses with
`bwrap: Can't mount proc on /newroot/proc: Operation not permitted` (#1622,
reported in-app as #1620). This record says why the launcher keeps the fresh
procfs, what a container must allow for it, and what the probe now says when
it is refused. It extends the
[all-writer decision](policy-write-boundary.md), whose host-profile rule it
does not change.

## Decision

1. **The launcher keeps `--unshare-user --unshare-pid --proc /proc`.** None of
   the measured alternatives keeps the boundary under Docker's default masks.
   A container host must let the kernel mount a fresh procfs, which in Docker
   means `--security-opt systempaths=unconfined`.
2. **The probe names this refusal.** When bubblewrap reports that it could not
   mount proc, the requirement reads "the kernel refused the worker a fresh
   /proc because the parent /proc has masked or covered paths; in Docker, run
   the container with --security-opt systempaths=unconfined", followed by
   bubblewrap's own line. Every other launch failure keeps the generic list
   (`FRESH_PROC_REFUSED`, `packages/ui-sdk/src/server/worker-launcher.ts:1029`).
   The match is on bubblewrap's literal message, not a guess from the
   environment: a host that refuses for another reason is not told to change
   Docker options.
3. **No conditional `--proc`, no fallback.** Launching without a fresh procfs
   when the probe fails would be the weaker profile the all-writer decision
   rules out.
4. **A root-run server's worker gets its whole `/proc` read-only** (#1629,
   ruled 2026-10-11, see [what `systempaths=unconfined` costs](#what-systempathsunconfined-costs)).
   Root servers still qualify; running as non-root is recommended.
5. **What a root-run server's worker keeps is warned about, not covered**
   (#1638, ruled 2026-10-11). The read-only `/proc` stops its writes, not its
   reads or socket connections: it can still read root-only `/proc` files,
   root-owned files on the host root and connect to root-owned and abstract
   Unix sockets. No `/proc` covers, host-root masks or socket-directory masks
   are added, and the server is still not refused. Instead it warns once at
   boot and persistently on `/api/status` and in the app, and the
   [host boundary doc](../hosting/agent-workers.md#running-the-server-as-root)
   states that the full worker boundary needs a non-root server. A worker uid
   separate from the server's belongs to the governed-writable design (#1636).
6. **Container requirements are documented per probe step** in
   [the host boundary doc](../hosting/agent-workers.md#running-the-server-in-a-docker-container),
   with the measured tuple added to its matrix.

## Why the kernel refuses

Inside a user namespace, a new procfs or sysfs mount is allowed only when a
fully visible instance of the same filesystem already exists in the mount
namespace: one with no locked mounts covering any part of it
(`mount_too_revealing` in the kernel's `fs/namespace.c`). Docker bind-mounts
`/dev/null` or an empty read-only tmpfs over `/proc/kcore`, `/proc/keys`,
`/proc/timer_list` and others, and remounts `/proc/sys`, `/proc/bus`,
`/proc/fs`, `/proc/irq` and `/proc/sysrq-trigger` read-only. Those covers are
locked once bubblewrap enters its new user namespace, so the container's
`/proc` no longer counts as fully visible and the mount fails with `EPERM`.
`systempaths=unconfined` removes the covers; nothing else on the measured
tuple did.

## Measurements

Measured 2026-10-11 with Docker 29.7.2 on Linux x86_64 kernel
`7.2.5-3-omarchy`. The daemon's security options were the built-in seccomp
profile and cgroup namespaces; the host has no AppArmor. The image was
Ubuntu 24.04 with bubblewrap `0.9.0` and `python3` from its archive, the same
bubblewrap the reporting host used. "Default seccomp + userns" below is
Docker's default seccomp profile with one rule appended that allows `clone`,
`mount`, `umount2`, `unshare` and `pivot_root` regardless of capabilities;
the derivation is in the host doc.

### Which option each launcher step needs

`bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev
--tmpfs /tmp --cap-drop ALL true`, as container root and as a non-root user
(uid 1500), each tuple run separately:

| Container options | Result (root and uid 1500 alike, unless stated) |
| --- | --- |
| none | `No permissions to create new namespace` (seccomp refuses `unshare`/`clone` without `CAP_SYS_ADMIN`) |
| `--cap-add SYS_ADMIN` | `pivot_root: Operation not permitted` (the default profile never allows `pivot_root`) |
| `--cap-add SYS_ADMIN --security-opt systempaths=unconfined` | `pivot_root: Operation not permitted` |
| `--security-opt systempaths=unconfined` | `No permissions to create new namespace` |
| default seccomp + userns | `Can't mount proc on /newroot/proc: Operation not permitted` |
| default seccomp + userns, `--cap-add SYS_ADMIN` | `Can't mount proc on /newroot/proc: Operation not permitted` |
| `seccomp=unconfined`, `apparmor=unconfined`, with or without `SYS_ADMIN` | `Can't mount proc on /newroot/proc: Operation not permitted` |
| default seccomp + userns, `systempaths=unconfined` | passes |
| `seccomp=unconfined`, `systempaths=unconfined` | passes |

`CAP_SYS_ADMIN` on the container is not needed once seccomp allows the
namespace and mount calls, and it does not help with the procfs refusal.

### The real probe and the proofs in the passing tuple

With default seccomp + userns and `systempaths=unconfined`, run as uid 1000
with the repository and Bun `1.4.2` bind-mounted:

- `probeWorkerHost` returned `{ ok: true }` in both the ordinary and the
  restricted mode. Without `systempaths=unconfined` it returned the new
  fresh-/proc requirement in both modes, and with the default profile it
  returned the generic list carrying bubblewrap's namespace or `pivot_root`
  refusal.
- The component proof from the host doc (five files): 84 pass, 0 fail.
- `tests/policy-write-boundary.test.ts`: all 14 pass, both adapters.
- `tests/autonomous-containment.test.ts`: all 4 pass, and
  `packages/ui-sdk/tests/inference-relay.test.ts` passed. The pi containment
  case fails on any host when the repository path is long, independent of the
  container (#1630); this run mounted the checkout at a short path.

### Alternatives to a fresh procfs, measured under the default masks

Each case ran a "server" process with a marker in its environment, then a
worker under the stated flags, as uid 1500 in a container with default
masks and default seccomp + userns.

| Alternative | What the worker could do | Verdict |
| --- | --- | --- |
| **Bind the container's `/proc`** (keep user and PID namespaces, `--ro-bind /proc /proc` instead of `--proc`) | Mounts. `/proc/<pid>/environ`, `/proc/<pid>/root`, `/proc/<pid>/cwd` and `/proc/<pid>/fd` targets of outside processes were refused, and `pidfd_send_signal` on a `/proc/<pid>` descriptor returned `EINVAL`: the user and PID namespaces still hold. But every process in the container was listed, and **`/proc/<pid>/cmdline` was readable for all of them**, including a concurrent worker's `bwrap` whose `--setenv PEER_TOKEN …` value appeared in full. | Rejected. Workers receive their environment as `--setenv` arguments to bubblewrap, so a restricted autonomous worker could read the credentials an interactive worker was launched with, which is what the [restricted envelope](../hosting/agent-workers.md#the-restricted-envelope-for-autonomous-turns-676) exists to prevent. It also exposes the server's and every sibling's command line. |
| **Drop the PID namespace** (`--unshare-user`, no `--unshare-pid`) | bubblewrap's procfs request succeeded but shared the container's procfs instance. The worker listed every container process and **`kill -0` on the server succeeded**: it can signal the server. | Rejected. A worker could signal the server or its siblings, and the worker's descendants would no longer end with the namespace when a turn is cancelled. |
| **A `subset=pid` procfs** | The kernel allowed `mount -t proc -o subset=pid` in a fresh user and PID namespace under the default masks, where a full procfs was refused. It showed only the namespace's PIDs, `self` and `thread-self`; `/proc/self/fd` worked; `/proc/net/dev` and `/proc/meminfo` were absent. | Not available. bubblewrap `0.9.0` and `0.12.0` take no procfs mount options (`--proc DEST` only), and the restricted probe and runtimes read `/proc/net/dev` and system files. Adopting it would need bubblewrap support or a second launcher that sets up namespaces itself, and a fresh review of every runtime's `/proc` use. Worth revisiting if bubblewrap grows the option. |
| **`--proc` only when the probe succeeds, otherwise one of the above** | — | Rejected: a second, weaker profile chosen by the host, which the all-writer decision forbids. |

### What `systempaths=unconfined` costs

The masks protect the container's own processes from the host kernel's
`/proc` and `/sys` interfaces. Removing them does not weaken the worker
boundary itself, because the worker gets its own procfs either way; it
widens what the server and anything else in the container can reach.
Measured with access checks only (nothing was written) in the same image:

| Container user | Default masks | `systempaths=unconfined` |
| --- | --- | --- |
| root | `/proc/sys`, `/proc/sysrq-trigger` read-only; `kcore`, `keys`, `timer_list` covered | `/proc/sysrq-trigger` and `/proc/sys` pass the write check; `/proc/keys` and `/proc/timer_list` readable |
| uid 1500 | same | `/proc/keys` readable (it lists only the caller's own keys) |

Inside a worker of a **root-run** server the fresh procfs was just as
exposed. bubblewrap covered `sysrq-trigger`, `irq` and `bus` but not
`/proc/sys`, and writing `kernel.panic` with its current value succeeded. A
worker of a non-root server was refused. This is not Docker-specific: a
root-run server on bare metal maps the worker to the same kernel uid, and
most host-global `/proc` files check only the file mode, not a capability.

**Ruling on #1629 (2026-10-11): a root-run server's worker gets its whole
`/proc` read-only. Root servers still qualify.** `workerCommand` adds
`--remount-ro /proc` after `--proc /proc` when the server's uid or effective
uid is 0 (`rootProcCover`, `packages/ui-sdk/src/server/worker-launcher.ts:273-275`).
Measured as container root with `systempaths=unconfined` and the seccomp
profile above, with bubblewrap `0.9.0` from the image and the host's `0.12.0`,
each in the ordinary and the restricted mode:

| Cover after `--proc /proc` | Result for a uid-0 worker |
| --- | --- |
| none (the launcher before #1629) | `kernel.panic` same-value write accepted. 977 files outside the per-process directories passed the write check (836 in the restricted envelope), including `kernel.core_pattern`, `kernel.modprobe`, `/proc/acpi/wakeup`, `/proc/dynamic_debug/control`, `/proc/mtrr`, `/proc/pressure/*` and the sound card's `prealloc` and `eld` files. |
| `--remount-ro /proc/sys` | bubblewrap refuses: `Unable to find "/newroot/proc/sys" in mount table`. It is not a mount point in a fresh procfs. |
| `--ro-bind /proc/sys /proc/sys` | Sysctl writes fail with `EROFS`, but every non-sysctl file above still passed the write check. A root worker in the host network namespace could also still write that namespace's files under `/proc/<pid>/net`, which no fixed path covers. |
| `--remount-ro /proc` | Sysctl writes fail with `EROFS`, and no file under `/proc` passes the write check. Writes through `/proc/self/fd/<n>` and `/dev/stdout` still work, because those magic links resolve to the target's own mount. |

A uid-0 worker's other surfaces, audited in the same runs: `/sys` and the
cgroup tree arrive through the recursive read-only root bind (the restricted
envelope has neither). `/dev` holds bubblewrap's tmpfs with the `null`,
`zero`, `full`, `random`, `urandom` and `tty` nodes, a fresh `devpts` and a
private `/dev/shm`. Other processes' `/proc/<pid>` entries are outside the
worker's PID namespace. The worker cannot remount, because it has no
capabilities.

The cover is limited to uid 0. A non-root worker writes no host-global file
through its procfs either way, and a read-only `/proc` breaks nested user
namespaces: as uid 1500, `unshare -U -r` failed on `/proc/self/uid_map` with
`EROFS`, and Chromium aborted with "No usable sandbox!", while both work
without the cover.

The real Claude and pi runtimes run with a read-only `/proc`. In a local-only
mutation, the cover was forced on for every worker, and seven suites passed
as uid 1000 in the container: 96 tests across policy-write-boundary,
autonomous-containment, inference-relay, worker-host-gate, run-session,
autonomous-turn and ws-handoff. Those suites were not run with the runtimes
as a uid-0 worker. The test harness's own outer bubblewrap runs without a
user namespace, and as root it covers `/proc` paths, so the kernel refuses
every nested fresh procfs before the launcher's cover is reached. The uid-0
evidence is the launcher's own tests and the real probe.

What a root worker keeps is root's authority over everything it can reach
without a write. It can read root-only `/proc` files: `/proc/slabinfo`,
`/proc/timer_list`, `/proc/vmallocinfo`, `/proc/pagetypeinfo` and the TCP Fast
Open key. In interactive and voice turns, which see the host root read-only,
it passes the owner check on every root-owned file there. It can read `/etc/shadow`, host keys and
root's stored credentials, and it can connect to a root-owned daemon's Unix
socket. The host doc therefore still recommends running the server as a
non-root user. Whether to narrow this further is #1638.

### Not measured here

- **AppArmor.** This host has none. Docker's `docker-default` profile contains
  `deny mount,` and denies writes to `/proc/sysrq-trigger` and most of
  `/proc/sys`; the reporting Ubuntu host ran with `apparmor=unconfined`. Whether
  a narrower AppArmor profile suffices is open.
- **Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1`.** The report
  found it was not the cause on its host; it was not reproduced here.
- **Host variation.** The report's WSL2 host with the same options did not
  reproduce the refusal. The kernel rule is the same, so the difference is in
  what that runtime mounted over `/proc`. Qualify a container on its target
  host with the real probe, as the host doc says.

## Revisit when

- bubblewrap can mount procfs with `subset=pid` (or any option that the kernel
  exempts from the visibility check), and the runtimes are shown not to need
  the rest of `/proc`;
- workers stop receiving their environment on bubblewrap's command line, which
  would remove the credential leak but not the process-table exposure of a
  bound `/proc`;
- Docker offers a per-path unmask instead of the all-or-nothing
  `systempaths=unconfined`.
