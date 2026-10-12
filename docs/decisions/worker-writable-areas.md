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

1. **Scratch.** `<brain>/.brain/scratch` is bound read-write into the worker
   as its own mount. It is created when missing and must be a real
   directory inside the brain, never a symlink or redirect. Hard links into
   the rest of the brain fail across the mount, and the server never follows
   a symlink when it serves, previews or prunes scratch. The existing flow
   (`brain render --scratch`, `brain image --scratch`, `brain scratch prune`,
   a link for the reader) works unchanged. The per-turn
   `BRAIN_WORKER_SCRATCH` tmpfs stays as it is.
2. **Workspaces.** The index-excluded workspace directory is bound read-write
   only when it exists, and never the brain root, an ancestor of it or
   anything holding authoritative documents.
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
  `$HOME` writes) is deleted at turn end and must never be linked in a
  response. Persistent scratch (`.brain/scratch/`, plus `workspaces/` for
  clones) survives turns and is where every file the reader should open or
  download goes; it is the only non-brain place to link. The brain is
  canonical. The note says exactly this, adapted to the mounts present.

Memory persistence (the issue's second finding) is owned by #1621 and #1625
on the transcript persist path and is not part of this record.

## How it is built

**One resolution, two consumers.** `prepareWorkerSandbox` resolves the
areas and the home mode once per worker
(`export function prepareWorkerSandbox`, `packages/ui-sdk/src/server/worker-launcher.ts:633-672`).
The backend passes the result both to the launcher, which turns it into
bubblewrap arguments, and to `workerSandboxNote`, which renders the agent's
note (`export function workerSandboxNote`, `packages/ui-sdk/src/server/worker-sandbox.ts:471-504`).
The launcher re-checks the resolved layout against the actual launch: the
same brain and envelope, each writable area still a real directory at its
own path in the brain, and `$HOME` still the home the overlay was probed for.
A mismatch refuses the launch instead of binding something the note does not
describe (`function sandboxMounts`, `packages/ui-sdk/src/server/worker-launcher.ts:582-613`).
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
(`export function resolveScratchMount`, `packages/ui-sdk/src/server/worker-sandbox.ts:354-373`).

**Workspaces.** The directory is `workspaces/`, a fixed name. Core excludes
it from the index in every brain: `exclude.dirs` adds to the defaults and
cannot remove `workspaces`, so it never holds an indexed document. Its
existence is the opt-in: someone creates it outside a hosted turn, and every
later turn binds it (`export function resolveWorkspacesMount`, `packages/ui-sdk/src/server/worker-sandbox.ts:382-393`).
It needs no gitignore line, unlike scratch: the ruling's condition is the
index exclusion, and committing a clone or a work file from `workspaces/` is
the user's choice, as it was before 0.41, not something a turn's output
lands in by default.

**Hard links made before the turn.** A bind mount stops a worker from
creating a new hard link, rename or symlink write into the rest of the brain.
It does not stop a link that already exists on the host: `git clone --local`
of the brain into `workspaces/`, or a hand-made link, would make that brain
file writable through the mount. So each area is walked with `lstat` before
the launch, counting the names each regular file's inode has inside the area.
A file is offending only when its link count is higher than the names found
inside: links wholly within the area (local clones between workspace
repositories, package-manager stores) are harmless
(`export function scanForOutsideLinks`, `packages/ui-sdk/src/server/worker-sandbox.ts:208-218`).
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
its private, size-limited turn-temp tmpfs. Real HOME stays read-only: a tool
that writes it directly receives `EROFS`, recorded through the roadblock
path. `prepareWorkerSandbox` resolves this same XDG mode on every eligible
host (`export function prepareWorkerSandbox`,
`packages/ui-sdk/src/server/worker-launcher.ts:633-667`). Host-backed overlay
uppers cannot live on the worker's private tmpfs; keeping them would leave
an unbounded write area. Tools reading XDG config see the per-turn directory,
while direct reads of real HOME retain the read-only host view.

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
sent there (`export function writeTarget`, `packages/core/src/cli/read-only.ts:42-48`).
`brain render` and `brain image` into the read-only brain now say to write
with `--scratch` and link the printed path; when scratch is read-only too, the
message says nothing written now is kept. The `read_only_brain` code and its
`tool` field are unchanged.

**Serving.** The file routes refuse any symlink at or below `.brain` for a
scratch path, and a scratch listing omits links
(`const scratchRequest`, `packages/ui-server/src/files/walker.ts:115`).
Elsewhere in the brain an in-brain link resolves as before. Those checks
run before the open, so a file whose requested or resolved path lies in
`.brain/scratch/` or `workspaces/` is then read once, from its resolved
path, through descriptors that never follow a link (each directory from the brain root opened with
`O_NOFOLLOW | O_DIRECTORY` through the previous one, the file with
`O_NOFOLLOW`), and the route serves that snapshot; the size cap bounds it
(`export function readAnchoredSnapshot`, `packages/ui-server/src/files/walker.ts:157-193`).
Core's prune reads every entry with `lstat`, and on Linux removes each file
and emptied directory through its parent's descriptor in the same way
(`function anchored`, `packages/core/src/lib/scratch.ts:498-528`), because a
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
- **A plain tmpfs `$HOME`.** It loses the reads the overlay keeps, such as
  `.gitconfig` and tool configuration.
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
