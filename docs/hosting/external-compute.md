# Hosted external compute

A hosted chat turn can start a command on an external compute provider through
the host, under the same governance as its other effects. This page is for the
operator of a self-hosted `@schlessera/brain-ui-server`. What external compute
is, and why it works this way, is in
[the compute decision](../decisions/external-compute.md); the brain-side
configuration is in [configuration](../configuration.md#boat).

Nothing runs remotely unless the brain configures an instance, the operator
binds its credential on the host, and the user approves each run.

## What the host needs

| Setting | Meaning |
| --- | --- |
| `@schlessera/brain` and `@schlessera/brain-compute-boat` | Installed beside the server. Without core, hosted compute is off; without the Boat package, a `boat` instance is `provider_unavailable`. |
| `BRAIN_UI_COMPUTE_KEYS` | The credentials the host may use, by built-in provider: semicolon-separated `provider=NAME[,NAME...]`, for example `boat=BOAT_CI_KEY,BOAT_HEAVY_KEY`. A listed provider's own default variable (`BRAIN_COMPUTE_BOAT_API_KEY`) is bound too; list the provider alone (`boat`) to bind only that. Unset, the host binds no credential at all, defaults included. Set the named variables in the server's own environment. |
| `BRAIN_UI_COMPUTE_STATE_DIR` | Job records, leases, reservations and collected artifacts. Default `<DB_PATH>.compute`. It must be outside the brain; the server refuses to boot otherwise and masks it from every worker. |

An ephemeral database (`DB_PATH` empty or `:memory:`) has no durable place for
job state, so hosted compute is off. `/api/status` reports the state under
`runtime.compute`: whether it is on and why not, the state directory and its
mask, each bound credential with whether it is set and whether it would reach a
worker, the built-in package and whether it has remote expiry, and the
instances the last turn read. No vendor is called to produce it.

## Credentials

A brain instance names its credential variable (`apiKeyEnv`); the brain never
holds the key. The host uses a variable only when the operator bound it, so an
agent that edits `brain.config.ts` cannot point a job at another credential the
server happens to hold: such an instance is `provider_unavailable`. Only
built-in providers run on the host; an instance whose provider is a value in
`brain.config.ts` is `provider_unavailable`, because the host never runs brain
code. The host reads the configuration as data, from a masked worker that sees
only the governance policy's protected paths, so keep `brain.config.ts`
protected (it is by default).

Each provider call carries only its own instance's bound credential, so a key
bound for one instance or provider never reaches another provider, health
checks included.

Keep bound credential variables out of `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. A bound
name that would be forwarded to a child process turns hosted compute off until
it is not; `/api/status` names it. Give each instance a scoped key with
run-only actions (Boat's `ci` preset); account administration is never needed.

Two residuals stay with the provider, not the host:

- **A Boat environment reaches the sandbox.** An instance's
  `options.environment` attaches that Boat environment to every sandbox it
  creates, with its variables and secrets. That is allowed on hosted runs: by
  configuring it, the brain owner and the operator accept that a command, and
  so the agent that wrote it, can read them. Without `environment`, sandboxes
  are created with none.
- **Boat's per-sandbox port token.** Boat documents a token in every sandbox,
  even without an environment, that can only host ports. A command can print
  it into its output, which the agent then reads.

## Approval, budgets and data

On an interactive typed turn, each run shows a card naming the instance, the
lease, the cost estimate or that it is unknown, the files it uploads with
their hash, the command, the environment variable names and the artifacts. An
answer is never remembered, and "always allow" has no effect on it. A voice
turn, or a turn with no client connected, is refused instead of asked.

A run reserves its estimate (hourly ceiling times lease) against the turn,
conversation and day budgets of the governance policy before it allocates. An
instance without `hourlyCeilingUsd` runs with its cost unknown, bounded by its
lease and `maxConcurrent`; set a ceiling to make budgets bind it. Only the
declared source files are uploaded, under the policy's `providers` rules with
the instance id as recipient; `.env*` files, Tier A protected paths and folders
the turn's provider masks hide are refused.

## Shared pools with the CLI

Slots and budgets are shared per compute state directory. The hosted default
is separate from what `brain compute` uses in a shell, so the two have separate
pools. To share one pool, set `BRAIN_COMPUTE_STATE_DIR` for the shell to the
host's `BRAIN_UI_COMPUTE_STATE_DIR`, as the same operating-system user; both
then serialise admission through the same locks.

## Lifecycle

A job outlives the turn that started it: the host drives it until it settles,
and a later turn of the same conversation can check or collect it, also after
the user signs in again; the change of principal is recorded on the job's
Activity run. A turn that is cancelled, times out, hits its budget or loses its
authority cancels the jobs it started, including one it was still starting;
deleting the conversation cancels its jobs. A job counts as settled only once
its reservation has settled too; if the budget ledger cannot record that, the
host keeps the job open and retries. On shutdown the
host cancels the jobs whose provider has no remote expiry; Boat stops its own
sandboxes at the lease plus the release allowance. On start, before any turn,
the host reattaches every unsettled job, and settles any reservation left
without a job (the server stopped between reserving and recording it) as
unknown, so it keeps counting at its reserved amount.

Each job is its own Activity run, `compute:<job id>` with origin `compute`,
linked to its turn and tool call. It ends `success`, `error`, `cancelled` or
`timeout` with the cleanup fact; a job whose outcome is `uncertain` stays open
and is flagged stuck until reconciliation resolves it; `brain compute
reconcile` from a shell on the same state directory visits it too.
