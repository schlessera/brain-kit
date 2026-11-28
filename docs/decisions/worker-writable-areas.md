# Decision — writable areas inside the agent worker

Since 0.41.0 every interactive and voice turn runs in a worker that sees the
brain read-only ([the all-writer decision](policy-write-boundary.md)). The
only writable places were a per-turn tmpfs, `/tmp` and the runtime state, so
nothing the product itself documents could be produced in a hosted turn:
`brain render --scratch` and `brain image --scratch` failed, `brain scratch
prune` failed, repository clones could not be refreshed, and headless
Chromium could not start under a read-only `$HOME`
([#1626](https://github.com/schlessera/brain-kit/issues/1626)).

The maintainer ruled on 2026-10-11, recorded on the issue under "Decision
(maintainer, 2026-10-11)". This record carries those rulings, how they were
built and measured, and the alternatives they replaced.

> **Not the final default.** On the same day the maintainer opened a separate
> epic for a "governed writable" default for interactive and voice turns: the
> brain writable inside the worker again, with policy-protected paths
> read-only, per-turn change journals with revert, and command, cost and
> egress auditing. The 0.41 read-only brain becomes an opt-in strict profile,
> and autonomous turns stay restricted. That epic will revise the defaults
> below and parts of [the all-writer decision](policy-write-boundary.md).
> The areas, the overlay and the note recorded here remain what the strict
> profile gets; the launcher takes the list of areas as an input so a
> profile can choose it.

## The rulings

> **2026-10-18 — Reference inspection amendment (#2390).** The
> [reference-worktree decision](reference-worktrees.md) selects shared read-only
> source outside brain content for ordinary inspection and centrally managed
> isolated worktrees for edits or stable reads. It supersedes using an ordinary
> workspace clone as the supported disposable-reference workflow; the existing
> workspace mount and its journal/scope obligations remain. Managed worktree
> cleanup does not extend to arbitrary user-owned repositories. The historical
> mount measurements below do not qualify the new workflow.

1. **Scratch.** `<brain>/.brain/scratch` is bound read-write into the worker
   as its own mount. It is created when missing and must be a real
   directory inside the brain, never a symlink or redirect. Hard links into
   the rest of the brain fail across the mount, and the server never follows
   a symlink when it serves, previews or prunes scratch. The existing flow
   (`brain render --scratch`, `brain image --scratch`, `brain scratch prune`,
   a link for the reader) works unchanged. The per-turn
   `BRAIN_WORKER_SCRATCH` tmpfs stays as it is.
2. **Workspaces.** **Amended 2026-11-20 (#4295):** the index-excluded
   workspace directory is read-only in default governed and strict turns.
   A durable per-session code-changes switch, frozen at admission, opts in to
   the previous writable mount and its alias scan. The directory must already
   exist and cannot be the brain root, an ancestor or an authoritative area.
3. **A writable `$HOME` for the turn.** A per-turn `bwrap --tmp-overlay` over
   `$HOME`: existing configuration such as `.gitconfig` still reads, and every
   write is discarded when the turn ends. Where the overlay is unavailable,
   the fallback is `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` on
   the turn's private `/tmp`. Not for the restricted (autonomous) envelope,
   which has no host home.
4. **Promote from scratch** (a validated server tool copying a scratch file
   to a named brain path) was ruled, then **stopped** the same day: it only
   matters for the strict profile, so it waits for the governed-writable epic.
   Nothing of it was built.
5. **Clear errors.** An `EROFS` on a known read-only path names the sandbox
   rule and the allowed alternative wherever the product can intercept it:
   the `brain` CLI's scratch-capable commands and the agent's instructions.
   Arbitrary tools are not wrapped.

Two clarifications followed during implementation:

- **The agent knows the limits up front.** A note generated from the same
  resolved layout that builds the mounts is injected into every turn's
  agent context, for both backends, so the agent does not keep hitting
  `EROFS` and improvising with `/tmp` clones.
- **Three places a file can be.** Turn temp (`$BRAIN_WORKER_SCRATCH`, `/tmp`,
  per-turn XDG writes) is deleted at turn end and must never be linked in a
  response. Persistent scratch (`.brain/scratch/`, plus `workspaces/` for
  clones) survives turns and is where every file the reader should open or
  download goes; it is the only non-brain place to link. The brain is
  canonical. The note says exactly this, adapted to the mounts present.

Memory persistence (the issue's second finding) is owned by #1621 and #1625
on the transcript persist path and is not part of this record.

## How it is built

**One resolution, two consumers.** `prepareWorkerSandbox` resolves the
areas and per-turn XDG layout once per worker
(`export function prepareWorkerSandbox`, `packages/ui-sdk/src/server/worker-launcher.ts:1015-1082`).
The backend passes the result both to the launcher, which turns it into
bubblewrap arguments, and to `workerSandboxNote`, which renders the agent's
note (`export function workerSandboxNote`, `packages/ui-sdk/src/server/worker-sandbox.ts:625-690`).
The launcher re-checks the resolved layout against the actual launch: the
same brain and envelope, each writable area still a real directory at its
own path in the brain. The backend selects runtime HOME separately.
A mismatch refuses the launch instead of binding something the note does not
describe (`function sandboxMounts`, `packages/ui-sdk/src/server/worker-launcher.ts:916-957`).
A launch without a resolved layout keeps the 0.41 view: only the per-turn
scratch is writable.

**Scratch.** Every segment of `.brain/scratch` is checked with `lstat` and
created one real directory at a time; a symlink anywhere, a mount point at or
below it, or a walk past the entry limit leaves it read-only for the turn,
named in the note. In a git repository (its own, or a parent one around the
brain, as core's `isGitRepo` counts it) it is bound only while git ignores
it, as core's own scratch writes already require; otherwise a file written
there by any tool could be committed. Git runs with the server's `HOME`, so
the operator's `safe.directory` applies
(`export function resolveScratchMount`, `packages/ui-sdk/src/server/worker-sandbox.ts:468-487`).

**Workspaces.** The directory is `workspaces/`, a fixed name. Core excludes
it from the index in every brain: `exclude.dirs` adds to the defaults and
cannot remove `workspaces`, so it never holds an indexed document. Its
existence permits a mount; since the 2026-11-20 ruling, only a session
whose code-changes switch is on binds it writable at its next admission (`export function resolveWorkspacesMount`, `packages/ui-sdk/src/server/worker-sandbox.ts:502-513`).
It needs no gitignore line, unlike scratch: the ruling's condition is the
index exclusion, and committing a clone or a work file from `workspaces/` is
the user's choice, as it was before 0.41, not something a turn's output
lands in by default.

**Hard links made before the turn.** A bind mount stops a worker from
creating a new hard link, rename or symlink write into the rest of the brain.
It does not stop a link that already exists on the host: `git clone --local`
of the brain into `workspaces/`, or a hand-made link, would make that brain
file writable through the mount. Since the 2026-11-20 ruling (#4295), a
qualified read-only workspace mount needs no writable-alias walk: reads cannot
change either name. Root, symlink and mount-topology checks remain. Scratch
and opted-in writable workspaces still run the existing `lstat` walk before
the launch, counting the names each regular file's inode has inside the area.
A file is offending only when its link count is higher than the names found
inside: links wholly within the area (local clones between workspace
repositories, package-manager stores) are harmless
(`export function scanForOutsideLinks`, `packages/ui-sdk/src/server/worker-sandbox.ts:295-305`).
An offending scratch name is unlinked, because scratch is disposable and the
other name keeps the data. An offending workspace file, or a walk over 200 000
entries, leaves `workspaces/` read-only for that turn, named in the note and
logged by the server.

The walk and the unlink are anchored on directory descriptors. Each directory
is opened with `O_NOFOLLOW | O_DIRECTORY` through its parent's descriptor
(`/proc/self/fd/<fd>/<name>`) and must be the inode `lstat` reported, and an
alias is unlinked through its parent's descriptor only while it is still the
inode the walk counted. A concurrent worker owns scratch and could swap a
directory for a symlink into the brain mid-walk; it cannot redirect either
step. A directory or entry the walk cannot read (an execute-only directory
hides its names, so a link could sit behind it) leaves that area read-only
for the turn, scratch included. Names are read as raw bytes, so a name that
is not UTF-8 cannot hide a directory. Every directory's change and
modification times are taken before it is listed and compared after the
walk: a rename that moved a name between directories, which could make an
inode count twice or not at all, shows there. Such a walk is repeated, and
after three tries the area is unverified for the turn. An unexpected error
while resolving an area also leaves it read-only rather than failing the
turn.

**`$HOME`.** #1703 supersedes the optional home overlay. Every interactive
worker now uses the XDG directories under `/tmp/brain-worker-home`, inside
its private, size-limited turn-temp tmpfs. The original host home remains
read-only at its original path: a worker's direct write receives `EROFS`, recorded
through the roadblock path. This is a worker write boundary, not an immutable
view: host-side changes to that directory remain visible. A backend may select a different runtime HOME
as described below; it does not make the host home writable. `prepareWorkerSandbox` resolves this same XDG mode on every eligible
host (`export function prepareWorkerSandbox`,
`packages/ui-sdk/src/server/worker-launcher.ts:1015-1082`). Host-backed overlay
uppers cannot live on the worker's private tmpfs; keeping them would leave
an unbounded write area. Tools reading XDG config see the per-turn directory,
while direct reads of real HOME retain the read-only host view.

> **2026-10-26 — Claude shell startup amendment (#2984, Option A).** The
> maintainer selected suppression of operator shell startup configuration,
> including the native CLI's login-shell fallback when a shell snapshot fails.
> The measured CLI still sources rc files in a successful snapshot when
> `CLAUDE_CODE_SHELL` names a `--noprofile --norc` wrapper. A shell prefix does
> not prevent startup, and the launcher-script setting has no effect on Linux.
> Non-envelope Claude workers use a fresh, empty, **read-only** HOME, mounted
> separately from the writable runtime state named by `CLAUDE_CONFIG_DIR`.
> Credentials/config are resolved from the original environment before the
> override and retain their existing preparation and persistence. No operator
> rc/profile is present in HOME. Writes to `~`, including tool and geo caches,
> fail with `EROFS`; they cannot consume transcript/credential storage or be
> misreported as runtime-state exhaustion. The original host-home path retains
> its read-only view and profile masks. Bounded per-turn XDG storage is unchanged.
> This deliberately removes implicit `~` reads of operator configuration,
> including `~/.gitconfig`, `~/.npmrc` and `~/.netrc`; use an explicit path for
> those reads where the profile exposes it. Core's default `~/.local/bin` and geo's
> default cache/admission paths resolve under the empty read-only HOME. Geo
> cannot create private per-worker admission state and refuses a cache miss
> before sending a request. This is the accepted tradeoff for suppressing
> startup imports, not the rejected writable tmpfs home or a restored overlay.
> Non-envelope launches also discard `BASH_ENV`, `ENV`, `ZDOTDIR`, `SHELLOPTS`,
> `BASHOPTS` and exported `BASH_FUNC_*%%` functions; RTK still
> excludes the original host home. The note describes both runtime HOME and the
> original host home. Restricted workers keep their existing private-state HOME.

<a id="home-startup-masking"></a>

**2026-10-26 — Rc-file masking first, then the approved fallback (#2984).**
The maintainer asked to retain the real read-only HOME using startup-file masks
first, with the empty read-only HOME permitted only if masking cannot close
both branches. The real SDK-selected native CLI was measured under the
production launcher with an experimental bind plan, fictional files and
loopback-only fake inference. No CLI byte or subprocess allowlist changed.
The [runtime measurements on #2984](https://github.com/schlessera/brain-kit/issues/2984#issuecomment-6419188928)
record the successful fixed-file controls and the failures below.

The candidate binds `/dev/null` read-only over existing `.bashrc`,
`.bash_profile`, `.bash_login`, `.profile`, `.bash_logout`, `.zshenv`,
`.zprofile`, `.zshrc`, `.zlogin` and `.zlogout`. The installed snapshot selects
`.bashrc`, `.zshrc` or `.profile`; the other names cover Bash's login alternatives
and the zsh home startup sequence. Fixed regular-file fixtures import no planted
values and retain Git's implicit `~/.gitconfig` lookup in both snapshot and
fallback branches, with actual Bash and zsh commands. Bash emits permission
diagnostics for the null-bound rc/profile paths in this fixture.

The candidate fails the complete boundary. After the bind plan is enumerated,
the host side creates a previously absent `.bash_profile`. The worker's HOME
still reports read-only and its own file creations fail with `EROFS`, but the
new host file is visible. The successful snapshot imports its planted function;
the login fallback imports its function, export, PATH and output. Masking every
name, including that absent path, instead refuses before payload start because
bubblewrap cannot create the mount point on the read-only filesystem. A
read-only bind does not freeze directory entries, so enumerating existing files
once cannot establish that no startup file can appear during the turn.

**Symlinks and masked parents.** The bind destination follows a startup
symlink: `.bashrc -> .gitconfig` hides the resolved `.gitconfig` as well, and
the implicit Git lookup returns no value. The candidate does not restore a
home below an existing opaque profile mask to apply file masks; that home and
its config remain unavailable as before. No per-file masking policy is shipped:
the approved empty-HOME fallback avoids enumerating or following original-home
startup links, and leaves the original host-home path and masks unchanged.
The loss of implicit real-HOME config/cache reads is the explicit cost of this
fallback. Reconstructing a separate view of the whole home is not introduced.

**System startup stays with the image.** Bash's `-l` path still reads
`/etc/profile`. `/etc/bash.bashrc` can also run through image startup configuration
or the CLI's shell probes. A fixture image profile explicitly sources it, and
both system markers remain observable in both branches despite the home-file
masks. These image-owned files remain out of scope, including for the retained
empty-HOME fallback.

**Restricted turns are unchanged.** The autonomous envelope gets no area, no
home handling and the same argv as before; its note says so.

**The note.** Claude appends it to the preset system prompt, and for a
restricted turn adds it as its own block after the package-owned autonomous
instructions. pi receives it from the server in the worker's `init` message
and appends it to the resource loader's system prompt in both modes.

Since #1654 the interactive note opens with the profile line (`strict`: the
brain is read-only, change it through `write_file`, `edit_file` and the
curated tools), names each area by the path in the resolved list, and ends
with the link rule. Limits are stated in a closing list that their owners
fill from the values they enforce (`WorkerNoteFacts`); the governed profile
adds its own line with its protected paths. The rule sentences live in
`@schlessera/brain-common/internal/worker-areas`, which core's CLI refusals
render too, so a refusal repeats the note's rule word for word.

**Errors.** The CLI's read-only pre-check asks about the directory a command
actually writes: the scratch area for `brain scratch` and for `brain render`
sent there, and `.brain-index/` for an index pass without `--embeddings`, which
a provider-restricted turn's private index makes writable (#1668)
(`export function writeTarget`, `packages/core/src/cli/read-only.ts:45-54`).
`brain render` and `brain image` into the read-only brain now say to write
with `--scratch` and link the printed path; when scratch is read-only too, the
message states that condition and points to the sandbox note for the reason,
without guessing why the host left scratch read-only; nothing written now is
kept (`export function readOnlyBrainError`, `packages/core/src/cli/read-only.ts:18-34`).
Render source validation precedes the read-only refusal (#2038): outside
and missing input paths remain usage errors, while a valid input retains the
same refusal and scratch advice
(`export function validateRenderInput`, `packages/core/src/cli/commands/render.ts:195-204`).
The `read_only_brain` code and its
`tool` field are unchanged.

**Serving.** The file routes refuse any symlink at or below `.brain` for a
scratch path, and a scratch listing omits links
(`const policy: ContainmentPolicy = isScratchPath(rel)`, `packages/ui-server/src/files/walker.ts:96-98`).
Elsewhere in the brain an in-brain link resolves as before. Those checks
run before the open, so a file whose requested or resolved path lies in
`.brain/scratch/` or `workspaces/` is then read once, from its resolved
path, through descriptors that never follow a link (each directory from the brain root opened with
`O_NOFOLLOW | O_DIRECTORY` through the previous one, the file with
`O_NOFOLLOW`), and the route serves that snapshot; the size cap bounds it
(`export function readAnchoredSnapshot`, `packages/ui-server/src/files/walker.ts:115-151`).
Core's prune reads every entry with `lstat`, and on Linux removes each file
and emptied directory through its parent's descriptor in the same way
(`function anchored`, `packages/core/src/lib/scratch.ts:517-547`), because a
hosted agent can swap a scratch directory for a link while the host prunes.

## Measurements

Measured 2026-10-11.

- **Overlay support.** `--overlay`, `--tmp-overlay`, `--ro-overlay` and
  `--overlay-src` arrived in bubblewrap 0.11.0, and are unavailable when
  bubblewrap is installed setuid. On Linux x86_64 kernel `7.2.5-3-omarchy`
  with bubblewrap 0.12.0 and a Btrfs home, the real probe passed: an
  unprivileged user namespace mounted the overlay, a write inside succeeded
  and the host home was unchanged. Ubuntu 24.04 ships 0.9.0, so CI and the
  reporting Docker host take the XDG fallback; the tests assert whichever
  the host's bubblewrap version predicts.
- **What the kernel returns** from inside a writable area, the brain mounted
  read-only around it: `rename` into the brain `EXDEV`; `link` of a brain
  file into the area `EXDEV`; `link` of an area file into the brain `EROFS`;
  a symlink to a brain file or directory, written through, `EROFS`;
  renaming the area's own mount point `EROFS`.
- **The integrated proof** (`tests/policy-write-boundary.test.ts`, all 14
  cases, both adapters) passes with `.brain/scratch/` and `workspaces/` bound
  writable. Its pre-tool executors now also attack from inside both areas (a
  symlink written through, a hard link and a rename into the area) and
  assert the areas were really writable, so each refusal is the boundary's.
- **Mutation receipts.** Each guard was broken and its named assertion
  failed, then restored: counting no outside links (`OUTSIDE_LINK`); counting
  every multiply linked file (`CONTAINED_LINK`); not unlinking a scratch alias
  (the alias test); following a symlinked segment (three symlink tests);
  skipping the gitignore check (`SCRATCH_IGNORED`); skipping the launch
  re-check (`RELAUNCH_RECHECK`); a writable home bind instead of the overlay
  (`HOME_DISCARDED`, and the probe itself fell back, `HOME_MODE`); a note line
  that ignores its mount (`NOTE_SCRATCH`); the server following a scratch
  link (`SCRATCH_LINK`); the CLI asking about the brain root for a scratch
  write, and the old render message (the CLI mount test, `RENDER_REFUSAL`);
  and an area bind replaced by the whole brain, which failed
  `POLICY_BYTES_UNCHANGED` for both adapters in the integrated proof.

## Why the alternatives lost

- **A brain-config key for the workspace directory.** The brain
  configuration is writable by an agent in a terminal session, so an agent
  could widen its own future writable mount. Rejected.
- **An operator-owned environment variable naming the workspace directory.**
  Possible and safe, since the agent cannot change it, but a new documented
  input. The fixed name already matches the only convention core knows; an
  override is a possible later addition if a deployment needs another
  directory.
- **Treating every multiply linked file as offending.** Git's local clones
  and package stores link within the area all the time, and would leave most
  real workspaces read-only.
- **A writable plain tmpfs `$HOME`.** It adds writable tool/cache storage
  and loses implicit reads such as `.gitconfig`. It remains rejected. The
  #2984 amendment above deliberately accepts lost implicit reads for Claude
  with an empty **read-only** HOME; the original host-home path remains
  available subject to its profile masks, and HOME writes still fail `EROFS`.
- **Binding scratch whether or not git ignores it.** Core never writes into an
  unignored scratch area; a writable mount would let any other tool do so and
  have the file committed later.
- **Wrapping arbitrary tools to translate `EROFS`.** Ruled out: only the
  product's own commands and instructions are changed.

## Residuals

- **Between the walk and the launch** a host process could create a new
  outside hard link. Only an unsandboxed actor can; the walk covers links
  that exist when the turn starts.
- **A mount point inside an area** (a Docker volume at `workspaces/`, say)
  leaves that area read-only, because a nested mount keeps its own flags
  and could expose anything.
- **Overlay and sub-mounts.** An overlay shows only the home directory's
  own filesystem; a separate mount under `$HOME` appears empty in the worker.
- **An agent can make its own scratch read-only** for later turns, with an
  unreadable directory, deep nesting or more than 200 000 entries in it. The
  note names the reason; the operator clears the directory. Nothing outside
  scratch is affected.
- **A busy scratch** that another turn keeps changing during the pre-turn
  walk can come out unverified after three tries, leaving scratch read-only
  for that one turn.
- **Timestamp granularity.** The walk's change check compares directory
  change and modification times. On kernels before 6.13, and on filesystems
  such as NFS or ZFS, those move once per clock tick, so a rename in the
  same tick as the listing can go unseen. It still needs an outside link
  made on the host first.
- **The pre-turn resolution is synchronous** on the server: a walk of up to
  200 000 entries per area, one `git` call and one overlay probe per turn.
- **Overlay size.** The overlay's upper layer is an unbounded tmpfs, like
  `/tmp`. Per-turn tmpfs budgets are #1625's.

## Owned runtimes beneath private temp — 2026-10-14

The #1844/#1901 support amendment permits a noncolliding host-installed owned
runtime below `/tmp`. Its narrowly resolved package/dependency closure is
retained read-only after the private temp mount. This supports the original
installation location while unrelated host temp remains absent; it does not
bind all of `/tmp` or provide writable runtime storage.

Reserved scratch, state, writable-area aliases, XDG, maintenance HOME/state and
output, relays/proxies, procfs and devices cannot be replaced by runtime
retention. The check covers canonical and aliased names, including their
ancestors and descendants, and refuses with the path and an actionable
installation explanation before dispatch. Explicit private masks remain
effective through runtime aliases. Existing private-temp allowances, writable
area/profile boundaries, dropped capabilities and cleanup are unchanged. See
the [binding runtime amendment](governed-writable-workers.md#owned-runtime-placement-beneath-tmp--2026-10-14)
for the selected policy and separately attributed original controls.

## Private output published from a strict area — 2026-10-22

A strict worker may make its own scratch output private: a `0700` directory
with `0600` files. Native publication keeps those modes and installs the nodes
under the server's identity, so a later separate-UID maintenance worker cannot
search them. Ordinary maintenance still works over that output
([#2364](https://github.com/schlessera/brain-kit/issues/2364), option A). The
published modes and ownership are not rewritten, and the maintenance worker
gains no server authority: the worker's Git input collector withholds the
directory it cannot search, and the server reads only the nested
`.gitattributes` of directories it owns, from the retained checkpoint. Aliases,
foreign owners and changed identities refuse. The bounds and the rationale are
in the [governed-writable-workers record](governed-writable-workers.md), under "Server-owned strict output".

## Workspace inspection amendment, 2026-11-20 (#4295, #4298)

Default governed and strict turns inspect an existing `workspaces/` read-only. They exclude
its paths from journal content capture, retained rows, ignore-policy reads and
observed-byte charges. The exclusion belongs to each turn, so a concurrent
session with code changes enabled keeps its own workspace retention and byte
accounting. Captured versions remain per turn through storage: an overlapping
writer cannot replace another turn’s ignored metadata with retained bytes.
Previously retained workspace history remains readable. Checkpoint-release
accounting is independent of journal coverage: excluded checkout predecessors
still count while a superseded checkpoint remains retained.

**Absent optional area (clarified during #4295 review):** if `workspaces/`
is absent at launch, keep the ordinary governed writable brain. Create no
live mountpoint and install no workspace overlay. Exclusion is not in force
for that turn: anything it creates beneath `workspaces/` is ordinary brain
content, using root scope, ordinary Git-internal exclusions and the brain's
frozen root ignore rules, and journaled with retained
versions and charged bytes and paths. The
next default turn sees the directory and binds it read-only. The switch alone
permits a writable existing workspace. Journal exclusion keys the qualified
read-only workspace mount, never the path name or the saved preference alone.
The existing-directory qualification precedes protected-parent preparation,
including with the switch enabled: preparation cannot mint its own writable
workspace prerequisite. If absence changes before launch, retry admission rather than using a stale
mount/coverage plan. An explicitly protected missing ancestor still needs the
strict view when its protection cannot be enforced without creating content.

Inspection metadata readers omit the mounted checkout from initial inventory
and subtree expansion. Delta paths receive bounded single-path inode probes
before exclusion, so an update reported through a workspace hard link cannot
hide a change to its ordinary note alias. These probes never inventory the
checkout. Shared observations include the
checkout only while a participant covers it; a new writer inventories its
baseline from the current sealed root with the admission cancellation signal.
Only a transition from writer coverage removes indexed checkout entries;
unchanged inspection commits never scan the whole brain index. A failed writer-only inventory leaves
an inspection turn usable.

The authenticated code-changes preference survives resume and applies at the
next admission. Changing it cannot change a running worker's mounts. Enabling
it retains the existing alias scan. Ordinary workspace files keep per-file
journaling; covered Git checkouts retain one endpoint receipt per checkout
under the [history contract](../integration-contract/http.md#checkout-change-receipts-4297). The worker's sandbox note names the mode and both
ways to obtain writable checkout access: the session's code-changes switch or
a managed worktree. Arbitrary tools still return the kernel's read-only error;
failed tool results carrying `EROFS` or a read-only diagnostic receive the
fixed conditional sentence below whenever the turn has an inspected workspace.
There is no path, operand or shell-directory attribution; the sentence may also
appear for a failure outside the checkout.

> If this write was under workspaces/, the checkout is read-only in this turn: switch on code changes for this session (applies from the next message) or use a managed worktree.

Pi bash failures use the tool's actual nonzero exit-code details.
No package command is refused pre-emptively: verification and dry runs may
succeed without writes. The kernel enforces the mount. Inspecting source never writes,
including dependency installation and builds. This information travels once
in new-turn context when it first applies or changes, using the existing
append-only prompt context; tools, fixed system append and earlier messages
are never rewritten. Nonpersistent read-only handoffs retain legacy prompt
rendering from separately qualified historical facts, including a refused
alias or bounded-scan qualification, without preparing the sandbox twice or
granting writes. Async preparation resolves those legacy facts off the host
event loop. Writable qualification follows scratch alias cleanup. Strict data
trees omit checkout copies, qualify the actual sealed source and overlay it
at the repo-relative read path. Every read alias repeats secret targets and
provider masks; a second mount cannot restore anything excluded from the copy.
Strict staged writable area aliases repeat every overlapping provider folder
mask as well, including a provider mask covering the entire area. Explicit
owner protections keep both their configured names and symlink destinations;
the implicit inspection guard covers only its namespace. Status inspection
never prepares or creates paths on the live brain. It includes required literal
provider roots and leaves its optional profile/view fields unknown while type
folder qualification requires checkpoint taxonomy. Image markup may read an
inspected checkout source while publishing its layer under scratch; image mask
and markup restrictions apply to write destinations independently of source reads.

## State boundaries and root dependencies — 2026-11-20

A filesystem boundary may replace an alias walk only when current evidence
proves what the final worker namespace can reach. Different filesystem or
subvolume identities alone are insufficient: a mount can expose private bytes
under another name. The existing operational-state guard remains in force;
there is no filesystem-identity fast path or module-store activation.

A future boundary proof must read current filesystem/subvolume identities and
mount topology once per worker admission. A mount at the state root is not a
descendant mount. Descendant and stacked mounts must be resolved against the
visible backing tree, including aliases outside the brain. The proof must
account for the launcher's final binds, restored credentialed HOME and private
`/tmp`, rather than treating a host mask list as a namespace description.
Unreadable topology is unknown; a brain-only inode walk cannot discharge an
unknown external exposure. The full guard must cover that exposure before
any boundary can qualify. Path, ownership and symlink checks remain required.

Every worker launch needs the same proof, including delayed compute helpers,
autonomous inbox helpers and credentialed maintenance. Live database handles
keep their original files private after a configured symlink changes; validating
only the new target is insufficient. Mask updates must validate placement
before publication so a refused temporary path cannot poison later workers.
An unsafe-state refusal must not become ordinary governed unavailability that
selects strict execution. Recoverable topology failures restrict execution,
allow authenticated diagnostics, record their cause through the hosted writer
and clear mechanically after fresh safe evidence. Owner status must reflect
the current cause without a synchronous SQLite commit on admission.

A passed verdict on a shared filesystem is never a substitute for this proof,
whether cached by elapsed time or another token. A bare Btrfs subvolume
transaction generation is also rejected: without sync it missed 16 of 16
writes, and after sync it advanced on 16 of 16 plain reads. Banning new links
cannot repair an alias that already exists. These shortcuts must not return.
Native qualification must use sibling Btrfs subvolumes on the same filesystem,
keep private state out of artifact aliases, and retain the measured receipts.
A comparison with an unrelated `/tmp` filesystem cannot establish that claim.

“Ignored files get no protection” applies inside a checkout: dependencies and
build output there can be regenerated. The brain's own root dependencies are
code executed by later turns and maintenance, so their read-only protection
continues even when git ignores them. The root dependency tree keeps its
existing admission walk. A host-owned module store must not replace it until
bounded installation, provider masks, worker ownership and crash recovery are
proven together. A broken store must fall back to in-brain dependencies and
remain repairable by scheduled maintenance.

## Launch qualification — 2026-11-28 (#4301 PR A, path O5)

Every launch with a caller-supplied command is qualified against host private
state while its start gate is still closed, with one recorded exception. The
host reads the sandbox's own mount table and refuses that launch with
`private_state_exposed` when a state root is live there at a name the
sandbox's UIDs can open.

| Launch | Qualified |
| --- | --- |
| L1 agent workers (`launchAgentWorkerSteps`), every envelope | yes, unconditionally |
| L2 asynchronous maintenance and transport (`launchMaintenanceWorker`, `runMaintenanceWorker`) | yes, at the direct start gate |
| L3 synchronous maintenance (`runMaintenanceWorkerSync`) | **no; it walks.** It stays on `spawnSync` with main's argv (no seal), runs the brain's registered walk itself before it spawns (a refusal is the walk's typed error), and every launch for a brain with a layout, or that masks, is recorded as unqualified (`runtime.unqualifiedLaunches`, site `synchronous-maintenance`). Its qualification is a follow-up. |
| L4–L6 fixed probes, the probe keeper and the output-staging keeper | no: constant host programs |
| L7 the web executor | no: built outside the launcher, with no state masks (a separate follow-up) |

L3 cannot simply probe and then spawn: the mount table is not a function of
the argv (a symlinked bind source can change the row between a probe and the
spawn), and L3 runs commands an agent influences (`resolveOutwardGitRemote`'s
git options, `brainGitSteps` under the brain's configuration, the boundary's
`runSync`).

What qualification does not cover:
- a host mount made, or a root created at an unmasked name, after a worker
  was qualified, for the rest of that worker's life;
- an overlay layer the server cannot resolve in its own namespace, and FUSE,
  network, 9p or other stacking filesystems outside the brain backed by state;
- a hard link from a state file to a worker-visible place outside the brain;
- a copy of state, as opposed to an alias;
- the launches marked "no" above.

Two shortcuts were refuted and are not used: a filesystem-identity fast path
(a mount can expose private bytes under another name), and a mask list
predicted from the host's table (the launcher's real argv disagreed with it).
An unreadable, incomplete or ambiguous table refuses nothing by itself: the
walk runs at the launch, and its own verdict stands.

