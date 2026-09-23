# Decision — the container's privilege model

How the server and the agent are meant to be separated inside the deployment
container, and the two measurements that decided it.

Nothing here ships in this repository: the container lives in the private
`brain-ui` deployment shell, and the work is tracked there. What *is* here is
the reason the design looks like this, and the part that reaches into these
packages — the pi backend's in-process `initContext` call, and the exec wrapper
the backends need.

**Investigated against:** brain-kit `e8b8d9ea4985`, the shell at
`99c1e98139df`, installed `@earendil-works/pi-coding-agent` 0.84.4 and
`@anthropic-ai/claude-agent-sdk` 0.3.265. **No container was built or run for
this record** — the measurements below that were taken live are marked as such,
and the C helper's source is unbuilt.

**Read the proof-plan corrections at the end before using any sequence here as
an acceptance criterion.** Four of them were found to be defective by review,
and each would have passed against a broken implementation.

## Decision

0.35.0 should use two fixed numeric users and an exec-in-place setuid helper:

- `brain` is uid/gid 10001/10001 and runs the server, the cron recorder and
  trusted application code.
- `agent` is uid/gid 10002/10002 and has supplementary group `brain`. It runs
  the Claude CLI and every command that can load or execute content from the
  brain repository.
- `/data/brain` is the only group-shared mutable tree. `/data/db` is
  `brain:brain 0700`, so supplementary group membership does not let `agent`
  traverse it.
- pi does **not** stay in the server process. Its curated brain tools call
  `initContext` in-process, which imports the repo's executable
  `brain.config.ts` as `brain` — with project trust off and no extension
  loaded. Either the pi runtime moves under `agent`, or `createBrainAccess`
  goes through the owned CLI like ui-server does; disabling extension trust
  alone would ship a false isolation claim. If neither lands in time, 0.35.0
  ships with the pi backend off rather than with a claim it does not meet.
  See "The path that decides it" in section 4.
- Cancellation needs its own setuid helper. After the uid drop the server
  cannot signal the turn at all — `kill(2)` requires a matching uid, so
  `process.kill(-pid, …)` returns `EPERM` and the turn keeps running. Measured;
  see "Cancellation" in section 2.

The critical refinement to the earlier plan is that an owned `brain`
executable is not enough. The CLI imports `brain.config.ts` directly
(`loadUserConfig`, `packages/core/src/lib/config.ts:349-364`) and imports both
repo-local and repo-resolved modules
(`importManifest`, `packages/core/src/lib/module-loader.ts:130-162`). Those
are agent-writable executable inputs. Consequently, the server, cron and root
entrypoint invoke the owned CLI **through the uid helper**, so the CLI itself
runs as `agent`. Root must likewise perform clone, pull and `bun install`
through the helper. The `brain` uid may consume validated output and write the
server DB, but it must not import the repository's TypeScript.

## 1. Directory ownership map

Modes below are the required steady state after the one-time migration. Fixed
numeric ids are part of the on-disk format: names are only presentation, while
volumes store numbers. “Volume” includes a named volume or a deployment bind
mount. Both preserve inode ownership across an image replacement; changing
`RUN chown` in a Dockerfile changes only a new volume's seed, not an existing
volume. The current compose mounts the brain, DB, logs, Claude and pi trees as
volumes (`[brain-ui] docker-compose.yml:32-41`), and the Coolify example uses
persistent binds (`[brain-ui] docs/examples/docker-compose.coolify.yml:40-45`).

| Path | Owner:group | Mode | Volume? | Purpose and rule |
| --- | --- | ---: | --- | --- |
| `/opt` | `root:root` | `0755` | no | Immutable executable prefix. Neither runtime uid may write it. |
| `/bin`, `/usr/bin`, `/usr/sbin` | `root:root` | dirs `0755`; packaged files unchanged | no | Immutable distro shell, Git, cron, syslog, supervisor and utility executables. Runtime code uses absolute paths for security-sensitive spawns; package-manager ownership is the image invariant. |
| `/opt/bun/bin/bun` | `root:root` | `0755` | no | Bun copied from the pinned build image. Replaces today's `/root/.bun/bin/bun` (`[brain-ui] Dockerfile:239-244`). |
| `/opt/claude/bin/claude` | `root:root` | `0755` | no | Real Claude CLI file, not a symlink into a home directory. Replaces the current `/root/.local/bin` install and symlink (`[brain-ui] Dockerfile:246-258`). |
| `/opt/rtk/bin/rtk` | `root:root` | `0755` | no | Trusted rewrite executable. Today's copy is `/usr/local/bin/rtk` (`[brain-ui] Dockerfile:217-231`); 0.35.0 moves all three non-distro tools under `/opt`. |
| `/opt/brain-toolchain` | `root:root` | dirs `0755`, files `0644` | no | Standalone, lockfile-pinned install containing `@schlessera/brain`; never resolved from `/data/brain`. |
| `/opt/brain-toolchain/node_modules/.bin/brain` | `root:root` | `0755` | no | The only core CLI entrypoint used by server, cron or entrypoint. The current server chooses the repo bin at `brainCliCommand`, `packages/ui-server/src/brain/client.ts:78-81`. |
| `/opt/brain-toolchain/hooks` | `root:root` | dir `0755`, hooks `0755` | no | Hooks copied from the same installed core package. The current setup instead copies them into agent-writable `.githooks` and sets a relative path (`join(root, ".githooks")`, `packages/core/src/cli/hooks-util.ts:49-66`). |
| `/opt/brain-ui` | `root:root` | dirs `0755`, files `0644`, bins `0755` | no | App source, dependencies, entrypoints and `brain-ui-cron`. The image already copies the app here (`[brain-ui] Dockerfile:269-287`); it must remain non-writable at runtime. |
| `/opt/brain-ui/bin/brain-agent-exec` | `root:brain` | `4750` | no | The helper in section 2. Only root or members of `brain` can enter it; it accepts callers root or uid `brain`, drops permanently to `agent`, then `exec`s. |
| `/opt/brain-ui/pi-extensions` | `root:root` | dirs `0755`, files `0644` | no | Exact image-installed pi extension set. Project and mutable global extension discovery are disabled. |
| `/home/brain` | `brain:brain` | `0700` | no | Server `HOME`; only ordinary caches/config which cannot grant agent capability belong here. |
| `/home/agent` | `agent:agent` | `0700` | no | Restricted subprocess `HOME`. The helper forces `HOME`, `USER` and `LOGNAME`; no tool falls back to `/root`. |
| `/data/brain` | `brain:brain` | `2775` | **yes: `brain`** | Markdown source, repo Git state, disposable `brain.db`, session-independent generated files, and repo dependencies. Both users write it. Setgid preserves group `brain`; wrappers use `umask 0002`, producing ordinary dirs `2775` and files `0664`. |
| `/data/brain/.git` | `brain:brain` | dirs `2775`, ordinary files `0664` | part of `brain` | Mixed-uid Git metadata. No root/`brain` process runs Git here; repo Git runs as `agent`. |
| `/data/brain/node_modules` | `agent:brain` after install | dirs `2775`, regular files `0664`, executable files `0775` | part of `brain` | Untrusted. `bun install` runs only as `agent`; no executable below it is selected by server, cron or entrypoint. |
| `/data/brain/brain.db` | creating user:`brain` | `0660` | part of `brain` | Disposable content index, not the server DB. Both users may rebuild it. |
| `/data/brain/logs` | creating user:`brain` | `2775` dir, `0664` files | part of `brain` | Content-job logs. The entrypoint currently creates it at `[brain-ui] scripts/entrypoint.sh:234-235`. |
| `/data/db` | `brain:brain` | `0700` | **yes: `db`** | Server authority boundary. `agent` is a different uid, so group membership does not grant traversal. This is the deliberate exception to group sharing. |
| `/data/db/brain-ui.db`, `-wal`, `-shm` | `brain:brain` | `0600` | part of `db` | Sessions, passkeys, settings and activity. Server and the `brain` cron recorder use it; agent children receive neither access nor a file descriptor. |
| `/data/db/pi` | `brain:brain` | `0700` | **yes: existing `pi`, remounted here; Coolify may use `db`** | pi auth/settings/state. Because the recommended design keeps pi in-process under `brain`, `PI_CODING_AGENT_DIR` points here and the restricted shell cannot traverse `/data/db`. This resolves the apparent conflict between pi persistence and DB denial. |
| `/data/db/logs` | `brain:brain` | dir `0750`, files `0640` | part of `db` fallback | Persistent fallback when `/var/log/brain-ui` is not independently mounted, preserving today's redirect behavior (`[brain-ui] scripts/entrypoint.sh:112-128`). |
| `/data/db/.uid-layout-v1` | `brain:brain` | `0600` | part of `db` | Idempotent migration marker, written only after every ownership/access assertion passes. |
| `/data/claude` (`CLAUDE_CONFIG_DIR`) | `agent:brain` | top/dirs `2770`, files `0660` | **yes: existing `claude`, new target** | Claude CLI writes transcripts as `agent`; server-side SDK history readers running as `brain` must read them. Set `CLAUDE_CONFIG_DIR` explicitly for parent and child. The current volume is `/root/.claude` (`[brain-ui] docker-compose.yml:36`). Whether the real CLI honors the required file mode remains a proof item in section 5. |
| `/var/log/brain-ui` | `brain:brain` | dir `2770`, files `0640` | **yes: `logs`**, or symlink to DB fallback | Persistent cron/syslog output. Root syslog may create files; `brain` may read them. |
| `/var/log/supervisor` | `root:root` | dir `0755`, files `0600`/`0640` | no | Ephemeral supervisor child logs. Current entrypoint creates it (`[brain-ui] scripts/entrypoint.sh:109-110`). |
| `/etc/cron.d/brain-ui` | `root:root` | `0644` | no; regenerated | Validated crontab. Lines run as `brain`, replacing current `CRONTAB_USER=root` (`[brain-ui] scripts/entrypoint.sh:194-210`). |
| `/etc/environment` | `root:root` | `0600` | no; regenerated | Cron's secret-bearing allowlist. Root cron reads it before dropping to the job user; neither runtime user may read it. Current generation is `[brain-ui] scripts/entrypoint.sh:212-232`. |
| `/run/supervisord.pid`, cron/syslog runtime files | `root:root` | service defaults | no | Supervisor, cron and syslog remain root control processes; only the app child changes uid. |
| `/tmp/brain-activity-sink-*` | `brain:brain` initially, child append access explicitly granted | `0660` | no | Cron recorder creates and later ingests the span sink (`const sinkPath`, `packages/ui-server/src/cron/run-job.ts:211-217`). Creation must be race-safe (`open(O_CREAT|O_EXCL|O_NOFOLLOW)`) before its path reaches an `agent` child. |
| `/usr/bin/google-chrome-stable` and `/opt/google/chrome/chrome-sandbox` | `root:root` | `0755` and `4755` | no | Chrome runs as `brain`; the distro's setuid sandbox helper must retain its bit. The renderer adds no sandbox-disabling args by default (`createRenderer`, `packages/ui-render-puppeteer/src/renderer.ts:130-165`). |

The app tree and toolchain are executable, never mutable, by either runtime
uid. The server program becomes `user=brain` with explicit
`HOME=/home/brain`, `USER=brain` and `umask=002`; current supervisord runs it
as root from `/root/.bun` (`[brain-ui] config/supervisord.conf:43-58`). Cron
remains a root daemon but its generated job user becomes `brain`. Each wrapper
that crosses into repository work sets `umask 0002` again; relying only on the
parent daemon's umask is too fragile.

### Git settings for the shared repository

At migration time, with the container stopped except for the entrypoint:

```sh
git -C /data/brain config core.sharedRepository group
git -C /data/brain config core.hooksPath /opt/brain-toolchain/hooks
find /data/brain -xdev -type d -exec chmod g+s {} +
su -s /bin/sh brain -c 'git config --global --add safe.directory /data/brain'
su -s /bin/sh agent -c 'git config --global --add safe.directory /data/brain'
```

`safe.directory` must be in each user's protected global config, not the
repository config. `core.sharedRepository=group`, setgid directories and
`umask 0002` solve different parts of mixed-uid operation: Git-created
objects/refs, inherited group, and non-Git files respectively.

The repository's `.git/config` is itself agent-writable. Therefore a one-time
`core.hooksPath` assignment is not a privilege boundary. Every automatic Git
invocation additionally carries command-scope configuration:

```sh
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=/opt/brain-toolchain/hooks
```

Git 2.51.0 on the investigation machine reports that value as `command line:`;
the 0.35.0 image must repeat the precedence test with its pinned Git. Root does
not run repo Git at all; root entrypoint actions invoke the uid helper. The
command-scope setting still prevents an agent-planted hook from running during
automatic agent-uid operations.

### The data step

The migration remounts the existing `claude` and `pi` volumes at their new
paths, converts the existing root-owned brain/DB/log/state trees without
following symlinks or crossing mount boundaries, sets the modes above, applies
the two protected `safe.directory` entries, and writes the marker last. It
must refuse startup if `/data/db` is traversable by `agent`, if either runtime
uid can write `/opt`, if either user cannot write `/data/brain`, or if `brain`
cannot open the server DB. This is why 0.35.0 needs a maintenance window and a
backup: old volume ownership survives the new image.

## 2. The uid switch: setuid helper, not sudo

Use a small setuid-root helper and the Agent SDK's custom spawn seam. The SDK
explicitly supplies command, args, cwd, env and a post-grace abort signal to
`spawnClaudeCodeProcess` (installed `sdk.d.ts:2259-2278` and
`sdk.d.ts:8441-8474`). The custom spawner starts a new process group as:

```text
/opt/brain-ui/bin/brain-agent-exec <absolute-command> <args...>
```

and implements `SpawnedProcess.kill(signal)` through the companion kill helper
below — **not** `process.kill(-child.pid, signal)`, which cannot work across
this boundary (see "Cancellation" after the helper source). The exec helper
becomes the target with `execv`, so the pid/process-group leader observed by
the SDK is the actual CLI, not a relay. The same helper prefixes the two pi tool spawns and all automatic
repo CLI/Git/install invocations. Use absolute commands (`/bin/bash`,
`/usr/bin/grep`, `/opt/brain-toolchain/node_modules/.bin/brain`) so `PATH`
cannot select agent-writable code.

This is the exact helper source:

```c
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *what) {
  int saved = errno;
  if (saved != 0) {
    fprintf(stderr, "brain-agent-exec: %s: %s\n", what, strerror(saved));
  } else {
    fprintf(stderr, "brain-agent-exec: %s\n", what);
  }
  _exit(126);
}

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') {
    errno = 0;
    fail("usage: brain-agent-exec /absolute/command [args...]");
  }

  struct passwd *brain = getpwnam("brain");
  if (brain == NULL) fail("getpwnam(brain)");
  uid_t brain_uid = brain->pw_uid;

  struct passwd *agent = getpwnam("agent");
  if (agent == NULL) fail("getpwnam(agent)");
  uid_t agent_uid = agent->pw_uid;
  gid_t agent_gid = agent->pw_gid;
  if (brain_uid == 0 || agent_uid == 0 || brain_uid == agent_uid) {
    errno = 0;
    fail("invalid uid layout");
  }

  uid_t caller = getuid();
  if (caller != 0 && caller != brain_uid) {
    errno = 0;
    fail("caller is neither root nor brain");
  }

  if (initgroups("agent", agent_gid) != 0) fail("initgroups(agent)");
  if (setresgid(agent_gid, agent_gid, agent_gid) != 0) fail("setresgid(agent)");
  if (setresuid(agent_uid, agent_uid, agent_uid) != 0) fail("setresuid(agent)");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("PR_SET_NO_NEW_PRIVS");

  umask(0002);
  if (setenv("HOME", "/home/agent", 1) != 0) fail("setenv(HOME)");
  if (setenv("USER", "agent", 1) != 0) fail("setenv(USER)");
  if (setenv("LOGNAME", "agent", 1) != 0) fail("setenv(LOGNAME)");
  if (setenv("PATH", "/opt/bun/bin:/opt/claude/bin:/opt/rtk/bin:/usr/local/bin:/usr/bin:/bin", 1) != 0) {
    fail("setenv(PATH)");
  }
  unsetenv("SUDO_COMMAND");
  unsetenv("SUDO_USER");
  unsetenv("SUDO_UID");
  unsetenv("SUDO_GID");

  sigset_t empty;
  if (sigemptyset(&empty) != 0 || sigprocmask(SIG_SETMASK, &empty, NULL) != 0) {
    fail("unblock signals");
  }
  signal(SIGTERM, SIG_DFL);
  signal(SIGINT, SIG_DFL);
  signal(SIGHUP, SIG_DFL);
  signal(SIGQUIT, SIG_DFL);
  signal(SIGPIPE, SIG_DFL);

  execv(argv[1], &argv[1]);
  fail("execv");
}
```

### Cancellation: a second, narrowly authorized helper

`setresuid(agent, agent, agent)` leaves the CLI with no uid the server shares,
and `kill(2)` requires the sender's real or effective uid to match the target's
real or saved set-uid — parenthood and process-group membership grant no
exception. So `process.kill(-child.pid, …)` from the `brain` server fails with
`EPERM` and **the turn keeps running**.

Measured, in a throwaway container (Ubuntu 24.04, uid 2000 `brain` /
uid 2001 `agent`), 2026-09-09:

```text
$ # as brain, having launched the child through the uid switch
     86      78 root     sudo -u agent /opt/toolchain/agent-exec bash -c exec sleep 400
     88      86 agent    sleep 400
leaf agent pid=88
kill exit=1
kill: (88) - Operation not permitted
--- after ---
     86 root     sudo ...
     88 agent    sleep 400
```

Signalling the intermediary instead is no better: `sudo` runs as root, so an
unprivileged `brain` cannot signal it either — the `TERM` is dropped silently
and nothing dies. That is the same failure with a worse diagnostic, and it is
the concrete reason this document does not recommend sudo.

The fix is a second setuid-root helper, `/opt/brain-ui/bin/brain-agent-kill`,
owned `root:brain`, mode `4750`, so only `brain` can invoke it:

```c
/* brain-agent-kill <pgid> <TERM|KILL|INT>
 *
 * Signals ONE process group, after dropping to `agent`. Dropping first is the
 * containment: even a pgid-confusion bug on the caller's side can then only
 * reach processes the agent already owns, never root's or brain's.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *what) {
  int saved = errno;
  if (saved != 0) fprintf(stderr, "brain-agent-kill: %s: %s\n", what, strerror(saved));
  else fprintf(stderr, "brain-agent-kill: %s\n", what);
  _exit(126);
}

int main(int argc, char **argv) {
  if (argc != 3) { errno = 0; fail("usage: brain-agent-kill <pgid> <TERM|KILL|INT>"); }

  char *end = NULL;
  errno = 0;
  long pgid = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || pgid < 2) {
    errno = 0;
    fail("pgid must be an integer >= 2");
  }

  int sig;
  if (strcmp(argv[2], "TERM") == 0) sig = SIGTERM;
  else if (strcmp(argv[2], "KILL") == 0) sig = SIGKILL;
  else if (strcmp(argv[2], "INT") == 0) sig = SIGINT;
  else { errno = 0; fail("signal must be TERM, KILL or INT"); }

  struct passwd *brain = getpwnam("brain");
  struct passwd *agent = getpwnam("agent");
  if (brain == NULL || agent == NULL) fail("getpwnam");
  uid_t caller = getuid();
  if (caller != 0 && caller != brain->pw_uid) { errno = 0; fail("caller is neither root nor brain"); }

  if (setresgid(agent->pw_gid, agent->pw_gid, agent->pw_gid) != 0) fail("setresgid(agent)");
  if (setresuid(agent->pw_uid, agent->pw_uid, agent->pw_uid) != 0) fail("setresuid(agent)");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("PR_SET_NO_NEW_PRIVS");

  if (kill((pid_t)-pgid, sig) != 0) fail("kill");
  return 0;
}
```

`SpawnedProcess.kill(signal)` therefore becomes: read the child's process group
once at spawn (`/proc/<pid>/stat` field 5, or have the exec helper report it),
then run `brain-agent-kill <pgid> <SIG>`. The pgid is read, never assumed equal
to the pid: `setsid` execs in place only when the caller is not already a
process-group leader, and that is not a property the server can guarantee.

The same shape was measured working end to end in the throwaway container,
using a `sudo`-authorized stand-in for the helper while the setuid binary was
not yet built:

```text
agent leaf pid=23 pgid=23
--- abort via the kill helper ---
helper exit=0
clean: the turn died
--- helper refuses a non-numeric argument ---
usage: agent-kill <pgid> [signal]
exit=2
```

That measurement validates the *mechanism* (a helper running as `agent` can
signal the turn's process group, and the group dies). It does **not** validate
the C helper above, which is unbuilt: the built-image test below owns that.

Build both helpers with the image toolchain, then `chown root:brain` and
`chmod 4750`.
The image test must assert the hash of the source/build input, ownership, mode,
that the saved uid is gone after the drop, an `agent` caller is rejected, and
an absolute target runs with uid 10002/gid 10002 plus supplementary group
10001.

I do not recommend sudo here. Sudo's monitor/command split adds another pid
whose signal-forwarding semantics must be trusted and tested. The helper still
needs a real cancellation test—`exec` does not stop the Claude CLI itself from
forking—but it removes the avoidable relay. Evidence that could reverse the
choice is a built-image test showing `sudo` preserves the required explicit
environment, forwards TERM and KILL to the CLI's whole process group, and
leaves no process after every abort case, together with a reason to prefer the
larger sudo package/policy surface. A predicate or unit mock is not enough.

## 3. `SUBPROCESS_ENV` audience assignment

The source of truth is
`SUBPROCESS_ENV`, `packages/ui-sdk/src/server/subprocess-env.ts:36-135`.
The current 0.32 filter is only a denylist: variables absent from the map still
pass through (`subprocess-env.ts:119-135`). U21 must land its per-audience
allowlist before the uid boundary is relied on.

“Keep” below means the declared audience remains appropriate after U21, not
that every process with that label runs at the same uid. The actual core CLI
runs as `agent`; the `brainCli` audience describes its needs. Cron has two
layers: the `brain` recorder may read `DB_PATH` and pricing settings, while the
command it launches is stripped again before the helper drops to `agent`.

| Variable | Current audiences | 0.35.0 assignment |
| --- | --- | --- |
| `PATH` | cron, agent, brainCli | Keep, but synthesize the fixed owned-only path from section 2. Never copy an ambient path. |
| `BRAIN_PATH` | cron, agent, brainCli | Keep; non-secret and required as cwd/root. |
| `NODE_ENV` | cron, agent, brainCli | Keep in the descriptor; retain the existing explicit cron exclusion until 0.33.1 decides its `.env.production` behavior (`CRON_ENV_EXCLUSIONS`, `packages/ui-server/src/cron/emit.ts:185`). |
| `TZ` | cron, agent, brainCli | Keep. |
| `HOME` | agent, brainCli | Keep; helper overwrites it with `/home/agent`. |
| `PI_CODING_AGENT_DIR` | agent | **Change to none/server-only.** With pi retained in-process it points inside `/data/db/pi`; the restricted shell neither needs nor may traverse that state. This is currently exposed to agent children and should not be. |
| `XDG_CONFIG_HOME` | agent | Keep only as `/home/agent/.config`; pi state must use the explicit variable above, not this fallback. |
| `DB_PATH` | cron | Keep for the `brain` cron recorder, then remove from its `agent` child environment. Filesystem mode is the final boundary. |
| `NO_COLOR` | agent, brainCli | Keep. |
| `CLAUDE_CODE_OAUTH_TOKEN` | agent, cron | Keep. It authenticates the CLI and is one `env` away from the agent by construction. Cron needs it for agent-driven sync. |
| `ANTHROPIC_API_KEY` | agent | Keep; an enabled API-billed Claude profile necessarily exposes its credential to that CLI/shell. |
| `ANTHROPIC_AUTH_TOKEN` | agent | Keep; same reasoning for compatible endpoints. |
| `OPENROUTER_API_KEY` | agent | Keep; profile credential. |
| `GITHUB_TOKEN` | cron, agent, brainCli | Keep. It is one `env` away from the agent by construction because agent-run Git needs it. Prefer the narrower sync token. |
| `BRAIN_UI_SYNC_GITHUB_TOKEN` | cron, agent, brainCli | Keep. It is likewise one `env` away; this is the preferred repo-scoped token. |
| `GEMINI_API_KEY` | cron, agent, brainCli | Keep; agent tools and core CLI features use it. |
| `OPENAI_API_KEY` | cron, agent, brainCli | Keep; agent tools and core CLI features use it. |
| `EXA_API_KEY` | agent | Keep; enabled web-search provider. |
| `BRAVE_API_KEY` | agent | Keep; enabled web-search provider. |
| `JINA_API_KEY` | agent | Keep; enabled web-search provider. |
| `PERPLEXITY_API_KEY` | agent | Keep; enabled web-search provider. |
| `TAVILY_API_KEY` | agent | Keep; enabled web-search provider. |
| `FIRECRAWL_API_KEY` | agent | Keep; enabled web-search provider. |
| `KAGI_API_KEY` | agent | Keep; enabled web-search provider. |
| `ANTHROPIC_BASE_URL` | agent | Keep; CLI profile override. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | agent | Keep; CLI profile override. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | agent | Keep; CLI profile override. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | agent | Keep; CLI profile override. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | agent | Keep; CLI profile override. |
| `BRAIN_UI_PRICING_DISCOVERY` | cron | Keep for the `brain` recorder; strip before its restricted child. It is not secret. |
| `BRAIN_UI_PRICING_TTL_HOURS` | cron | Keep for the `brain` recorder; strip before its restricted child. It is not secret. |
| `BRAIN_UI_SKILLS_GITHUB_TOKEN` | none | Keep server-only; skill archive fetching is host code. |
| `HOST` | none | Keep server-only. |
| `BRAIN_UI_CONFIRM_BASH` | none | Keep server-only; the backend turns it into policy, not child configuration. |
| `BRAIN_UI_WS_MAX_CONNECTIONS` | none | Keep server-only. |
| `BRAIN_UI_WS_RATE` | none | Keep server-only. |
| `BRAIN_UI_WS_BURST` | none | Keep server-only. |
| `BRAIN_UI_LOG_LEVEL` | none | Keep server-only. |
| `SOURCE_COMMIT` | none | Keep server-only. |
| `ALLOWED_ORIGINS` | none | Keep server-only. |
| `MAX_CONCURRENT_SESSIONS` | none | Keep server-only. |
| `BRAIN_UI_TURN_TIMEOUT_MS` | none | Keep server-only. |
| `AUTH_MODE` | none | Keep server-only. |
| `BRAIN_UI_PASSWORD_HASH` | none | Keep server-only secret. |
| `COOKIE_SECRET` | none | Keep server-only secret. |
| `TRUST_PROXY` | none | Keep server-only. |
| `TRUST_PROXY_HOPS` | none | Keep server-only. |
| `PROXY_AUTH_HEADER` | none | Keep server-only. |
| `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH` | none | Keep server-only. |
| `BRAIN_UI_ALLOW_PASSWORD` | none | Keep server-only. |
| `WEBAUTHN_RP_NAME` | none | Keep server-only. |
| `WEBAUTHN_USER_NAME` | none | Keep server-only. |
| `WEBAUTHN_USER_ID` | none | Keep server-only. |
| `WEBAUTHN_RP_ID` | none | Keep server-only. |
| `WEBAUTHN_ORIGINS` | none | Keep server-only. |
| `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN` | none | Keep server-only. |
| `AGENT_BACKEND` | none | Keep server-only. |
| `CLAUDE_CODE_PATH` | none | Keep server-only; the host passes its resolved absolute target to the custom spawner. |
| `BRAIN_UI_CLAUDE_DEFAULT_MODEL` | none | Keep server-only; the selected model is passed deliberately. |
| `BRAIN_UI_CLAUDE_PROFILES` | none | Keep server-only; only the selected profile's child settings/credential are passed. |
| `BRAIN_UI_PI_PROFILES` | none | Keep server-only. |
| `BRAIN_UI_MODEL_DISCOVERY` | none | Keep server-only. |
| `BRAIN_UI_MODEL_TTL_HOURS` | none | Keep server-only. |
| `DEEPGRAM_API_KEY` | none | Keep server-only secret; the host mints voice sessions. |
| `VOICE_PROVIDER` | none | Keep server-only. |
| `VOICE_KEYTERM_LIMIT` | none | Keep server-only. |
| `VOICE_CACHE_DIR` | none | Keep server-only. |
| `BRAIN_UI_REVERSE_GEOCODE` | none | Keep server-only; bridge tool executes in host code. |
| `NOMINATIM_URL` | none | Keep server-only. |
| `NOMINATIM_USER_AGENT` | none | Keep server-only. |

Three additions are required when the allowlist lands:

- `CLAUDE_CONFIG_DIR: ["agent"]`, set to `/data/claude`. It is absent today,
  so it passes only because unknown variables are allowed; after U21 omission
  would silently move state back under `HOME`.
- `BRAIN_UI_TOOL_EXEC_WRAPPER: []` and
  `BRAIN_UI_SUBPROCESS_ENV_EXTRA: []`: the server reads these control values,
  but children must not receive the controls themselves.
- The custom profile credential names and explicitly enabled web-search key
  names remain deliberate dynamic additions to the `agent` audience, never a
  restoration of the whole parent environment.

The plan already records the unavoidable limit: `CLAUDE_CODE_OAUTH_TOKEN`,
`GITHUB_TOKEN` and `BRAIN_UI_SYNC_GITHUB_TOKEN` authenticate programs whose
shells are their children, so each remains one `env` command away from the
agent. A uid boundary protects server-only material; it does not conceal the
agent's own capabilities.

## 4. Isolation prerequisite

### Owned entrypoints and restricted execution

Today the server resolves `<brainPath>/node_modules/.bin/brain` on every call
and falls back to repo `scripts/brain-cli.ts`
(`brainCliCommand`, `packages/ui-server/src/brain/client.ts:78-82`), then
spawns that selection (`Bun.spawn(wrapCommand`, `brain/client.ts:199-212`).
The root entrypoint runs `bun install` in the repo
(`[brain-ui] scripts/entrypoint.sh:59-85`), installs a dispatcher which again
executes repo code (`[brain-ui] scripts/brain-dispatch.sh:17-38`), and asks
`brain-ui-cron` to run `brain module list` during crontab generation
(`readModuleList`,
`packages/ui-server/src/bin/brain-ui-cron.ts:97-130,155-158`). A shared repo
therefore lets `agent` replace what root or `brain` executes next.

0.35.0 closes every named route as follows:

1. The image contains a separate, lockfile-pinned core install at
   `/opt/brain-toolchain`. Server `brainCliCommand`, cron's trusted PATH and
   entrypoint's module-list call all name its absolute bin. The repo dispatcher
   and legacy `scripts/brain-cli.ts` fallback are removed from automatic paths.
2. Every invocation of that owned bin is nevertheless prefixed by
   `brain-agent-exec`, because core imports agent-writable config and modules.
   This applies to API calls, cron content jobs and entrypoint module discovery.
3. Root performs clone, pull and dependency installation through the same
   helper. `bun install` remains possible because repo-local modules may need
   dependencies, but it runs only as `agent`; its lifecycle scripts can gain no
   uid they did not already have. No `brain` or root process imports anything
   below `/data/brain/node_modules`.
4. `brain-ui-cron` remains root-owned and runs as `brain` so it can record into
   `/data/db`. Before it spawns a content job, it removes `DB_PATH` and recorder
   settings, prefixes the helper, and gives the child no inherited DB handle.
   Its trusted `digest` subcommand is the exception: it contains no repo code
   and runs as `brain` to read the DB.
5. Automatic repo Git runs as `agent`, with command-scope
   `core.hooksPath=/opt/brain-toolchain/hooks`. The owned hooks resolve the
   owned wrapper first. A mutable repo-local override cannot affect automatic
   Git, and root never triggers a repo hook.

This also handles the extra sink discovered during the spike:
`brain.config.ts` is executable, not merely configuration. Converting a brain
to `brain.config.json` would not be a general fix because repo-local module
paths are still imported. Running all repo-aware CLI work at the restricted uid
is the durable boundary.

### pi extension loading

The installed package is 0.84.4. The hardening plan's cited offsets have **not**
drifted:

- `settings-manager.js:169` says `options.projectTrusted ?? true`; the default
  is trusted. The current backend calls `SettingsManager.create(brainPath,
  agentDir)` without options (`SettingsManager.create`,
  `packages/ui-backend-pi/src/session-resources.ts:74-95`).
- `package-manager.js:1988-1993` conditionally auto-discovers project
  extensions and skills under `.pi` when trusted. In particular line 1990
  calls `collectAutoExtensionEntries(projectDirs.extensions)`.
- `loader.js:473-482` resolves and imports each discovered extension, then runs
  its factory. This is in-process code execution under the server uid.
- `loader.js:320-323` implements extension `exec()` as
  `execCommand(command, args, ...)`; `core/exec.js:10-16` calls Node
  `child_process.spawn` directly. It does not pass through the backend's bash
  tool wrapper or permission gate.

These are the relevant installed statements, quoted from
`node_modules/@earendil-works/pi-coding-agent/dist/core/`:

```text
settings-manager.js:169  const projectTrusted = options.projectTrusted ?? true;
package-manager.js:1990 addResources("extensions", collectAutoExtensionEntries(projectDirs.extensions), ...);
extensions/loader.js:320-323
  exec(command, args, options) {
    assertActive();
    return execCommand(command, args, options?.cwd ?? cwd, options);
  }
extensions/loader.js:473 const factory = await loadExtensionModule(resolvedPath, cacheToken);
exec.js:12             const proc = spawn(command, args, {
exec.js:14               shell: false,
```

Therefore pi **does load** repo-local `.pi/extensions` under project trust, and
an extension can bypass the tool wrapper. The existing comment that the
`tool_call` gate makes extensions safe (`tool_call permission gate`,
`packages/ui-backend-pi/src/backend-options.ts:98-103`) does not cover extension initialization or `exec()`.

The two viable options are:

1. Disable project trust and mutable discovery, then load only exact extension
   paths from `/opt/brain-ui/pi-extensions`. Construct `SettingsManager` with
   `{ projectTrusted: false }`; configure the resource loader so repo `.pi`,
   project package entries and mutable global extension directories are never
   imported. Installed web/MCP/subagent extensions move from runtime install
   (`[brain-ui] scripts/entrypoint.sh:147-187`) into the root-owned image.
2. Move the entire pi runtime to an out-of-process worker under uid `agent`.
   Then even a loaded extension and its `exec()` child have only agent
   privileges, but session streaming, bridge callbacks, auth/state access and
   cancellation all cross a new RPC/process boundary.

### Measured: both named vectors, and both fixes

Throwaway container, 2026-09-09, `brain` uid 2000 in group `agent`, repo
group-shared at mode 2775:

```text
=== agent plants a payload in the repo-local bin ===
=== today: the server resolves the REPO-LOCAL bin (brainCliCommand) ===
PWNED: running as brain
=== 0.35.0: the server resolves an OWNED tree instead ===
REAL-BRAIN-CLI running as brain
=== can agent tamper with the owned tree? ===
cannot create /opt/brain-cli/node_modules/.bin/brain: Permission denied
```

```text
=== brain commits with the repo's own hooks (today) ===
HOOK-RAN as brain
=== brain commits with core.hooksPath pointed at an owned dir (0.35.0) ===
(no hook output = contained)
```

So the two vectors are real as described, and the two named fixes — an owned
CLI tree and a command-scope `core.hooksPath` — do close them. Note what this
does *not* show: it says nothing about the in-process import path below, which
no amount of executable ownership can reach.

### The path that decides it: pi imports repo code in-process

Extension trust is not the only way agent-writable code reaches the `brain`
process, and closing it is not sufficient. pi's curated brain tools go through
`createBrainAccess`, whose `ensureContext()` calls core's `initContext`
**inside the server process** (`initContext({ root: brainPath })`,
`packages/ui-backend-pi/src/brain-access.ts:146`).
`initContext` loads the user config and the modules
(`resolveRoot(opts.root)`, `packages/core/src/lib/context.ts:36-38`), and
`loadUserConfig` does a direct `await import(tsPath)` of the repo's
`brain.config.ts` (`existsSync(tsPath)`, `packages/core/src/lib/config.ts:357-359`).
`brain.config.ts` is executable code in an agent-writable tree, so a single pi
brain tool call runs it as `brain` — with project trust off, with no extension loaded, and with every
CLI-side mitigation in section 4 fully in place, because none of them apply to
an in-process import.

This is the only in-process caller: a grep over `ui-server`, `ui-backend-claude`
and `ui-backend-pi` finds `initContext` / `loadUserConfig` at exactly that one
site. Everything else reaches the brain through the CLI subprocess, which the
helper prefix covers.

Two further execution sites the inventory above missed, both spawns rather than
imports, and both therefore fixable by the helper prefix:

- `Bun.spawn`, `packages/ui-server/src/routes/brain.ts:126` spawns a **repo-local**
  `private/whatsup.ts` or `scripts/whatsup.ts` directly, not through
  `brainCliCommand`. Changing `brainCliCommand` does not protect this route; it
  needs the helper prefix of its own, and its own proof.
- The pi backend's two tool spawns, already listed, are the same shape.

Recommendation, revised: **option 2**. Option 1 leaves the
`brain.config.ts` import live and would ship a container whose isolation claim
is false on the first pi brain-tool call. The choices are to move the pi runtime
under `agent` (option 2), or to convert `createBrainAccess` to reach the brain
through the owned CLI the way ui-server already does — which is a backend
change of comparable size and is worth costing against option 2 before 0.34.0
freezes the seam. Option 1's extension-trust hardening is still worth doing, but
as defence in depth, not as the boundary.

If neither lands in time, 0.35.0 must ship with the pi backend disabled rather
than with an isolation claim it does not meet. That is a smaller loss than a
false claim, and it is reversible.

## 5. Proof plan for 0.35.0

These are runtime acceptance tests, not unit predicates. They assume a built
image named by `IMAGE`, the fixed paths above, and an env file containing real
agent credentials where the test says it is required. They intentionally use
throwaway volumes.

### Corrections this plan needs before it is run

The sequences below were written without a container to run them against, and
an adversarial pass found four that would pass without proving anything. Fix
each before 0.35.0 treats them as acceptance criteria:

1. **The abort test matches its own shell.** `pgrep -f u24-fake-claude` also
   matches the enclosing `sh -ceu …` whose command line contains that literal,
   so the negative assertion can never hold. Record the spawned pid and process
   group explicitly at launch and assert on those, and assert the
   helper-pid/CLI-pid equality the exec-in-place design claims.
2. **The API hook test never triggers the hook.** `/api/brain/stats` runs
   `brain stats`, which merges nothing, so a `post-merge` hook not firing proves
   only that the route does not merge. Advance the remote first and drive an API
   workflow that actually merges, then assert both the merged content and the
   hook's non-effect. Keep the API and restart cases on separate remote
   advances.
3. **The Chrome check reads the wrong thing.** `Seccomp: 2` on the browser
   process can be the container's own inherited filter — seccomp survives fork
   and exec. Inspect a *renderer* process and assert Chrome-specific sandbox
   evidence (its sandbox status, and namespace/filter differences from the
   browser process).
4. **The fixture blocks its own restart and sync proofs.** The seed has no
   ignore rules, so planting `.githooks` and `node_modules` leaves the tree
   dirty and the entrypoint deliberately skips its pull on a dirty tree
   (`[brain-ui] scripts/entrypoint.sh:47-55`). Seed ignore rules, assert a clean
   tree immediately before the restart, and give `agent` write access to the
   throwaway remote plus a git identity, or the push in the sync proof cannot
   run.

Two harnesses these sequences call — `load-production-pi-resources.ts` and
`ws-turn.ts` — plus the fake Claude executable do not exist yet. They are part
of the 0.35.0 work, not prerequisites assumed to be lying around; their source
belongs in this document or beside the tests before the sequences are run.

### Common fixture

```sh
export IMAGE=brain-ui:0.35.0-uid-proof
export U24_NAME=u24-uid-proof

docker volume create u24-brain
docker volume create u24-db
docker volume create u24-logs
docker volume create u24-claude
docker volume create u24-pi
docker volume create u24-remote

docker run --rm --entrypoint /bin/bash \
  -v u24-brain:/data/brain -v u24-remote:/remote "$IMAGE" -ceu '
    git init --bare /remote/origin.git
    git init -b main /tmp/seed
    git -C /tmp/seed config user.name "Alex Example"
    git -C /tmp/seed config user.email "alex@example.test"
    printf "{}\n" > /tmp/seed/brain.config.json
    mkdir -p /tmp/seed/notes
    printf "%s\n" "# UID proof" > /tmp/seed/notes/proof.md
    git -C /tmp/seed add -A
    git -C /tmp/seed commit -m init
    git -C /tmp/seed remote add origin /remote/origin.git
    git -C /tmp/seed push -u origin main
    git --git-dir=/remote/origin.git symbolic-ref HEAD refs/heads/main
    git clone /remote/origin.git /data/brain
  '

docker run -d --name "$U24_NAME" \
  --env-file ./u24-proof.env \
  -e AUTH_MODE=none -e BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1 \
  -e HOST=0.0.0.0 -p 127.0.0.1:33024:3000 \
  -v u24-brain:/data/brain -v u24-db:/data/db \
  -v u24-logs:/var/log/brain-ui -v u24-claude:/data/claude \
  -v u24-pi:/data/db/pi -v u24-remote:/remote "$IMAGE"

until curl -fsS http://127.0.0.1:33024/api/health >/dev/null; do sleep 1; done
docker exec "$U24_NAME" sh -ceu '
  test "$(id -u brain)" = 10001
  test "$(id -u agent)" = 10002
  test "$(stat -c %U:%G /opt/brain-ui)" = root:root
  test "$(stat -c %a /opt/brain-ui/bin/brain-agent-exec)" = 4750
  test "$(stat -c %U:%G /data/db) $(stat -c %a /data/db)" = "brain:brain 700"
  ! setpriv --reuid=agent --regid=agent --init-groups test -r /data/db/brain-ui.db
  setpriv --reuid=brain --regid=brain --init-groups test -w /data/brain
  setpriv --reuid=agent --regid=agent --init-groups test -w /data/brain
  ! setpriv --reuid=brain --regid=brain --init-groups test -w /opt
  ! setpriv --reuid=agent --regid=agent --init-groups test -w /opt
  su -s /bin/sh brain -c "git config --global --get-all safe.directory" | grep -Fx /data/brain
  su -s /bin/sh agent -c "git config --global --get-all safe.directory" | grep -Fx /data/brain
  test "$(git -C /data/brain config core.sharedRepository)" = group
  test "$(git -C /data/brain config core.hooksPath)" = /opt/brain-toolchain/hooks
  test -g /data/brain
  test -x /opt/brain-toolchain/node_modules/.bin/brain
  test ! -x /data/brain/node_modules/.bin/brain
  '
```

The fixture env file is deliberately outside the repository and must contain
only test credentials. `setpriv` is used only by the root test shell to assert
access; the application does not use it for the uid transition.

### Substituted CLI and planted hook: API and restart

```sh
docker exec -u agent "$U24_NAME" sh -ceu '
  mkdir -p /data/brain/node_modules/.bin /data/brain/.git/hooks /data/brain/.githooks
  printf "%s\n" "#!/bin/sh" "id -u > /data/brain/u24-bad-brain-api" \
    > /data/brain/node_modules/.bin/brain
  chmod 755 /data/brain/node_modules/.bin/brain
  printf "%s\n" "#!/bin/sh" "id -u > /data/brain/u24-bad-hook" \
    > /data/brain/.githooks/post-merge
  cp /data/brain/.githooks/post-merge /data/brain/.git/hooks/post-merge
  chmod 755 /data/brain/.githooks/post-merge /data/brain/.git/hooks/post-merge
  git -C /data/brain config core.hooksPath .githooks
  '

curl -fsS http://127.0.0.1:33024/api/brain/stats >/tmp/u24-stats.json
docker exec "$U24_NAME" test ! -e /data/brain/u24-bad-brain-api

docker run --rm --entrypoint /bin/bash -v u24-remote:/remote "$IMAGE" -ceu '
  git clone /remote/origin.git /tmp/update
  git -C /tmp/update config user.name "Alex Example"
  git -C /tmp/update config user.email "alex@example.test"
  printf "%s\n" "restart pull" > /tmp/update/notes/restart.md
  git -C /tmp/update add notes/restart.md
  git -C /tmp/update commit -m restart-proof
  git -C /tmp/update push origin main
  '

docker restart "$U24_NAME"
until curl -fsS http://127.0.0.1:33024/api/health >/dev/null; do sleep 1; done
docker exec "$U24_NAME" sh -ceu '
  test -f /data/brain/notes/restart.md
  test ! -e /data/brain/u24-bad-hook
  test ! -e /data/brain/u24-bad-brain-api
  '
```

The new remote file proves the restart actually ran the pull path. Absence of
both marker files proves neither the API nor root entrypoint selected the
substituted bin, and the pull did not execute either planted hook. A companion
test replaces `brain.config.json` with a `brain.config.ts` that records
`process.getuid()`; the owned CLI may load it, but the recorded uid must be
10002, never 10001 or 0.

### Repo-local pi extension and its child

Plant an async extension whose import and `exec()` child record their uids:

```sh
docker exec -u agent "$U24_NAME" sh -ceu '
  mkdir -p /data/brain/.pi/extensions
  printf "%s\n" \
    "import { writeFileSync } from \"node:fs\";" \
    "writeFileSync(\"/data/brain/u24-pi-import\", String(process.getuid()));" \
    "export default async function (pi) {" \
    "  await pi.exec(\"/bin/sh\", [\"-c\", \"id -u > /data/brain/u24-pi-child\"]);" \
    "}" > /data/brain/.pi/extensions/u24-proof.ts
  '

docker exec -u brain "$U24_NAME" \
  /opt/bun/bin/bun --no-env-file /opt/brain-ui/tests/runtime/load-production-pi-resources.ts

docker exec "$U24_NAME" sh -ceu '
  test ! -e /data/brain/u24-pi-import
  test ! -e /data/brain/u24-pi-child
  '
```

`load-production-pi-resources.ts` is a container-test entrypoint over the same
resource-builder used by `createPiBackend`; it calls `reload()`, asserts
`isProjectTrusted() === false`, asserts the malicious path is absent, and
asserts the expected root-owned extension paths are present. It must not be a
second reimplementation of the loader options. The two absent markers prove
the repo extension and its bypass child never ran as `brain` (in fact, never
ran). Unit tests additionally fail if the production backend stops using this
shared builder.

### Abort kills the actual Claude CLI

Build the runtime-test image with a root-owned fake Claude target that writes
its pid and uid, ignores stdin EOF, traps TERM, and waits. Point
`CLAUDE_CODE_PATH` at it; the production custom spawner still inserts the uid
helper. Then:

```sh
docker exec "$U24_NAME" sh -ceu 'rm -f /tmp/u24-cli.pid /tmp/u24-cli.uid /tmp/u24-cli.term'

docker exec "$U24_NAME" /opt/bun/bin/bun --no-env-file -e '
  const ws = new WebSocket("ws://127.0.0.1:3000/ws");
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  ws.send(JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: {} }));
  ws.send(JSON.stringify({ type: "chat_message", text: "uid abort proof" }));
  for (let i = 0; i < 100 && !(await Bun.file("/tmp/u24-cli.pid").exists()); i++) {
    await Bun.sleep(50);
  }
  if (!(await Bun.file("/tmp/u24-cli.pid").exists())) throw new Error("CLI did not start");
  ws.send(JSON.stringify({ type: "cancel" }));
  await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error("no cancelled result")), 10000);
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.type === "result" && m.outcome === "cancelled") {
        clearTimeout(timer); ws.close(); ok();
      }
    };
  });
  '

docker exec "$U24_NAME" sh -ceu '
  pid=$(cat /tmp/u24-cli.pid)
  test "$(cat /tmp/u24-cli.uid)" = 10002
  test -e /tmp/u24-cli.term
  test ! -e "/proc/$pid"
  ! pgrep -f u24-fake-claude
  '
```

The fake target's pid is the pid initially returned for the helper. Equality is
the `exec` proof; `/proc/$pid` absence and `pgrep` prove the actual CLI and its
process group are gone, not merely a wrapper. Repeat with a fake CLI that
ignores TERM, so the SDK's KILL escalation is also covered.

### Claude state write and resume across uids

With a real Claude test credential in `u24-proof.env`, run one turn, retain the
`session_info.sessionId`, fetch history through the server, then send a second
turn with that id:

```sh
docker exec "$U24_NAME" /opt/bun/bin/bun --no-env-file \
  /opt/brain-ui/tests/runtime/ws-turn.ts \
  --prompt 'Reply exactly U24-FIRST' --session-out /tmp/u24-session

session_id=$(docker exec "$U24_NAME" cat /tmp/u24-session)
test -n "$session_id"
curl -fsS "http://127.0.0.1:33024/api/sessions/$session_id" \
  | grep -F U24-FIRST

docker exec "$U24_NAME" /opt/bun/bin/bun --no-env-file \
  /opt/brain-ui/tests/runtime/ws-turn.ts \
  --session "$session_id" --prompt 'Reply exactly U24-RESUMED'

docker exec "$U24_NAME" sh -ceu '
  test "$(stat -c %U:%G /data/claude)" = agent:brain
  find /data/claude -xdev -type f -user agent | grep -q .
  '
curl -fsS "http://127.0.0.1:33024/api/sessions/$session_id" \
  | grep -F U24-RESUMED
```

`ws-turn.ts` is a test client, not an app seam: it waits for hello, sends the
typed `chat_message`, captures `session_info`, and refuses success without a
terminal non-error `result`. The first `find` proves the restricted uid wrote
the shared config tree; the HTTP history read and second turn prove the
`brain` server can read and resume it.

### Alternating writers and `brain sync`

```sh
docker exec -u brain "$U24_NAME" sh -ceu '
  umask 0002
  printf "%s\n" "brain writer" > /data/brain/notes/brain-writer.md
  '

docker exec -u agent "$U24_NAME" sh -ceu '
  umask 0002
  printf "%s\n" "agent writer" > /data/brain/notes/agent-writer.md
  test "$(cat /data/brain/notes/brain-writer.md)" = "brain writer"
  test "$(stat -c %G /data/brain/notes/brain-writer.md)" = brain
  test "$(stat -c %G /data/brain/notes/agent-writer.md)" = brain
  git -C /data/brain add notes/brain-writer.md notes/agent-writer.md
  git -C /data/brain commit -m alternating-writers
  '

curl -fsS -X POST http://127.0.0.1:33024/api/brain/sync \
  -H 'Content-Type: application/json' -o /tmp/u24-sync.sse
grep -F '"success":true' /tmp/u24-sync.sse
docker run --rm --entrypoint git -v u24-remote:/remote "$IMAGE" \
  --git-dir=/remote/origin.git log --format=%s --all \
  | grep -F alternating-writers
```

The direct `brain` file write is intentional boundary pressure. Only `agent`
runs Git, which preserves the rule that no higher-privilege process may load a
repo hook. This test proves group-sharing and the full sync workflow still
function. It **does not prove isolation**; the substitution, hook, pi and
DB-denial tests do that.

### Chrome sandbox enabled

```sh
test -z "$(docker exec "$U24_NAME" printenv BRAIN_UI_CHROME_NO_SANDBOX || true)"
docker exec "$U24_NAME" sh -ceu '
  test "$(stat -c %U:%G /opt/google/chrome/chrome-sandbox)" = root:root
  test "$(stat -c %a /opt/google/chrome/chrome-sandbox)" = 4755
  '

curl -fsS -X POST http://127.0.0.1:33024/api/render \
  -H 'Content-Type: application/json' \
  --data '{"content":"# sandbox proof","contentType":"markdown","format":"png"}' \
  -o /tmp/u24-sandbox.png
test "$(od -An -tx1 -N8 /tmp/u24-sandbox.png | tr -d ' \n')" = 89504e470d0a1a0a

docker exec "$U24_NAME" sh -ceu '
  pid=$(pgrep -o -f "/opt/google/chrome/chrome")
  test -n "$pid"
  test "$(ps -o user= -p "$pid" | tr -d " ")" = brain
  tr "\0" " " < "/proc/$pid/cmdline" | grep -Fv -- --no-sandbox
  tr "\0" " " < "/proc/$pid/cmdline" | grep -Fv -- --disable-setuid-sandbox
  grep -Eq "^Seccomp:[[:space:]]+2$" "/proc/$pid/status"
  '
```

A successful real render, no disabling flags, a valid setuid helper and active
seccomp together are the acceptance evidence. Merely asserting the launch
argument builder is not.

## 6. Questions not verified by this investigation

- **Does the target deployment permit the setuid helper and Chrome sandbox?**
  Source cannot answer daemon `no-new-privileges`, seccomp, LSM or host-kernel
  policy. The helper uid assertion and Chrome sequence above on the actual
  deployment host settle it. If only Chrome fails, the documented fallback is
  renderer-only `--no-sandbox`; do not weaken the agent uid boundary with it.
- **What modes does Claude CLI 2.1.236 create for every state file?** The image
  pins that CLI, but its installed program is not inspectable as ordinary
  TypeScript here, and no container was run. The cross-uid history/resume test
  plus a recursive `stat` report settles whether `umask 0002` is sufficient or
  the backend needs a narrower shared-state adapter. Do not add a chmod daemon.
- **Does process-group cancellation cover every real Claude descendant?** The
  SDK documents the forwarded signal and grace interval, but the actual CLI
  can change its child topology. The TERM and KILL fake tests establish the
  spawner contract; one real aborted tool-running turn, followed by a process
  and cgroup emptiness check, settles the pinned CLI.
- **Does the pinned Git version honor command-scope `core.hooksPath` ahead of
  an agent-written local config?** Git 2.51.0 on this machine reports the env
  value as command-line scope, but the image's Git version was not checked in a
  container. The planted-hook restart proof settles precedence end to end.
- **Can all recommended pi extensions be installed reproducibly in the image?**
  Their current runtime install is visible in the entrypoint, but their exact
  tarball integrity/pinning and transitive native requirements were not
  verified. A frozen image build plus the production resource-loader probe must
  show the expected extension paths and no network install at boot. If that
  cannot be pinned, ship without the optional extension rather than restoring
  mutable discovery under `brain`.
- **Will every deployment's existing volume layout migrate cleanly?** The two
  checked compose shapes differ: named `pi`/`claude` volumes versus Coolify
  state folded into bind-mounted paths. The coordinator's throwaway copies of
  both layouts must run upgrade, second boot and rollback. The runbook must
  back up first and reverse ownership, mount targets, `CLAUDE_CONFIG_DIR` and
  Git configuration before starting an image older than 0.35.0.
