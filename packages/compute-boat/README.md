# @schlessera/brain-compute-boat

The `boat` external compute provider: it runs a brain-kit compute job in a
disposable [Boat](https://docs.boat.dev/api/v1) sandbox. It maps Boat's public
HTTP API onto the vendor-independent `ComputeProvider` contract with plain
`fetch`, and ships no vendor SDK. The contract, its terminology and the
rulings behind it are in
[docs/decisions/external-compute.md](../../docs/decisions/external-compute.md);
how a job runs is in [the provider guide](../../docs/extending/compute-providers.md).

Installing this package enables nothing. Core imports it only when a
`compute.providers` instance names `provider: "boat"`, and the package makes
no request until the host calls one of its methods for such an instance.

## Install and configure

```sh
bun add @schlessera/brain-compute-boat
```

It is an optional peer of `@schlessera/brain`; install the same version.

```ts
export default defineConfig({
  compute: {
    providers: {
      "boat-small": {
        provider: "boat",
        apiKeyEnv: "BOAT_CI_KEY",          // omitted: BRAIN_COMPUTE_BOAT_API_KEY
        options: { machine: "small", from: "odysseus-ci" },
        lease: { maxSeconds: 3600 },
        maxConcurrent: 2,
      },
    },
  },
});
```

Without `apiKeyEnv` an instance reads `BRAIN_COMPUTE_BOAT_API_KEY`. That is
deliberately not the variable Boat's own CLI reads, so a broad key exported for
the CLI is never used by a job without the operator naming it.

### Options

`options` is validated strictly: an unknown key leaves the instance
`provider_unavailable`.

| Option | Boat field | Meaning |
| --- | --- | --- |
| `machine` | `type` | `small`, `default`, `large` or `xlarge`. Omitted: Boat's default, or the size a `from` snapshot was saved from. |
| `from` | `from` | A saved snapshot name or share code to start from. The key then also needs `snapshot.read`. A missing or expired snapshot refuses the job with `provider_unavailable`. |
| `environment` | `environment` | A Boat environment to attach. Omitted, the sandbox is created with `noEnv` (below). Name one only if it passes nothing you would not hand the job. |
| `org` | `org` | The organization wallet to bill. |

There is deliberately no option for a setup script, files written at create,
sandbox `env`, hosted ports or the API base URL. Commands receive only the
allowlisted variables the host passes with each job.

## The key

The key is read on the trusted host and travels only in the `Authorization`
header of requests to `https://boat.dev/api/v1`. It is never put in a URL, a
request body, a command, the sandbox environment, a job record, an outcome or a
log line. Signed file URLs Boat issues for staging are treated as secrets as
well and are never logged.

Create a [scoped key](https://docs.boat.dev/api-keys/scopes) with a short
expiry. The adapter needs these actions and no others:

| Action | Used for |
| --- | --- |
| `sandbox.create` | Allocation |
| `sandbox.read` | Readiness, lookup by allocation key, usage |
| `sandbox.stop` | `release("retain")` |
| `sandbox.delete-own` | `release("discard")` of the sandboxes this key created |
| `exec` | Commands |
| `file.read`, `file.write` | Collecting artifacts, staging the source |
| `snapshot.read` | Only with `from` |

Boat's `ci` preset covers them. `account.admin` is never needed. Without
`account.read`, health falls back from `GET /limits` to listing one sandbox.

## Credential-free sandboxes

Unless an instance names `environment`, every sandbox is created with
`noEnv: true`, also when it starts `from` a snapshot. Boat then gives it none
of the account's environment variables, secret files, model or GitHub logins,
and removes the in-sandbox Boat API key. Boat documents one per-sandbox token
that always stays, `ASCII_TOKEN`; it can only host ports of its own sandbox.
A job therefore never receives account administration authority.

## How the contract maps

| Contract | Boat |
| --- | --- |
| `allocate` | Looks for a sandbox labelled with the allocation key first, then `POST /sandboxes` with that key as `Idempotency-Key`, the key and instance as labels, `ttlSeconds` and `noEnv`. Answers as soon as Boat accepts it. |
| readiness | Before staging or a command, `GET /sandboxes/{id}` until the state is `ready`, `idle` or `running`. `setupStatus` and `hydrated` are not readiness and are not waited for. |
| `find` | `GET /sandboxes?label=…`; two matches are `uncertain`, never a guess. |
| `stage` | A tar of the declared files with a checksum manifest, uploaded to a signed URL and extracted by a command that verifies every checksum in a fresh directory before copying the files into `~/work`. The command is never resent on an unknown outcome, which is `uncertain`; it keeps the archive, so the host may stage again safely. |
| `exec` | A detached command (`detached: true`) in `~/work`, with only the allowlisted variables added. Boat gives it no time limit; the host lease bounds it. |
| `poll` | `GET /sandboxes/{id}/commands/{processId}` with the last 1 MiB of each log. |
| `kill` | `DELETE /sandboxes/{id}/commands/{processId}`. |
| `collect` | `GET /sandboxes/{id}/files/info` for the size, then `GET /sandboxes/{id}/artifacts` (at most 50 MiB per file). |
| `release("discard")` | `DELETE /sandboxes/{id}`, then the deletion operation until `completed`. |
| `release("retain")` | `POST /sandboxes/{id}/stop` without `force`, then the stop until `completed`. |
| `usage` | `GET /sandboxes/{id}/usage`. |
| `remoteExpiry` | `ttlSeconds`: the host deadline plus its release allowance, at most 30 days, never disabled. |

A job that does not ask to retain data is created with `snapshots: false`, so a
stop erases its disk instead of keeping it.

### Stop is not pause

A Boat stop archives the disk and ends every process; nothing keeps running and
nothing is resumed. This adapter never resumes a sandbox. A command whose
sandbox stopped (a retained release, Boat's own auto-stop, a plan limit) reads
as ended with the reason `provider_error`, never as still running.

### Retention

A retained release reports a deadline 14 days after the stop, Boat's documented
retention for stopped data. An account data-retention policy can shorten it;
once Boat has deleted the data, a further release reports `released`. Retained
data may be charged by Boat; that is a reported limitation, not part of a job's
cost.

### Command history

Boat keeps every command sent through its commands endpoint, with its output,
for 90 days in the sandbox's command history, readable while the sandbox is
stopped and until it is deleted. That includes the command line, and with it
the values of the allowlisted variables. They are non-secret by the contract;
never allowlist anything you would not keep there.

### Cost

Actual cost is the `dollars` Boat's usage report gives for the sandbox, at its
list price, whatever plan, trial or gift paid for it. Coverage is `partial`
while the meter runs and `complete` once it stopped. A discarded sandbox
reports the reading taken just before its deletion, as `partial`; that reading
lives in the memory of the process that deleted it, so another process reports
unknown. Core settles either as unknown. Without a report the cost is unknown
(`null`), never zero. The adapter contains no rate:
an estimate comes only from an instance's `hourlyCeilingUsd`.

## Errors and retries

Each call sends at most three requests, waits what Boat's answer asks
(`retryAfterSeconds`, `retryAfter` or `Retry-After`) capped at 30 seconds and
never past the call deadline, and only repeats a request whose repetition is
harmless. A detached command is sent again only when Boat says it did not run.

| Boat answer | Allocation | Other calls |
| --- | --- | --- |
| `401`; `402`; `403` (`api_key_expired`, `api_key_action_forbidden`, `api_key_sandbox_forbidden`, `environment_forbidden`, `machine_class_plan_required`, `trial_machine_class_not_allowed`, `org_suspended`) | refused `provider_unavailable` | `failed`; the host retries a release |
| `404 snapshot_not_found`, `409 snapshot_data_expired`, `400 unknown_environment` | refused `provider_unavailable` | — |
| `429 limit_reached`, `member_limit_reached` | refused `concurrency_exhausted` | — |
| `429 rate_limited` | one retry in the `minute` window, then refused `provider_unavailable` | — |
| `429 IP_RATE_LIMIT_EXCEEDED`, `503 no_ready_machine`, `503 out_of_capacity` | retried, then refused `provider_unavailable` | retried when repeatable |
| `409 idempotency_in_progress` | retried under the same key, then `uncertain` | — |
| `409 idempotency_key_reused` | `uncertain` (the host reconciles through `find`) | — |
| `409 sandbox_starting` / `boat_starting`, `502` with `sandbox_restoring` | — | retried: the command did not run |
| `502 sandbox_direct_failed` / `boat_direct_failed` otherwise | — | a command is `uncertain`; a file transfer is retried |
| a lost answer, a timeout or another `5xx` | retried under the same key, then `uncertain` | `uncertain` for an effect; retried when repeatable |
| aborted before sending | `failed`, nothing sent | `failed`, nothing sent |

A refusal after an attempt that may have created a sandbox is `uncertain`, not
refused.

## Testing

`bun run test packages/compute-boat/tests` runs the shared provider and
lifecycle conformance suites from `@schlessera/brain/testing` and the
adapter's own tests against an in-process fake of Boat's API, injected through
`ComputeContext.fetch`. No socket is opened, no vendor is called and no real
key is used. A live run against Boat is a separately authorized operator
exercise.

The vendor facts here come from Boat's public documentation and OpenAPI
description as read on 2026-11-02, not from measured behaviour.
