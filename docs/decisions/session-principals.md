# Decision — a session carries a principal

Why a session has a named, revocable, expiring identity instead of one global
cookie epoch. Shipped in 0.35.0; this is the design record, not a status file.

Before this, `bumpSessionsEpoch()` was the only instrument of revocation, so
cutting off one agent signed out every device — and nothing was attributable.
The migration that advanced the legacy epoch once, and what that means for a
rollback, is the part most worth reading before touching auth.
## Summary

> **2026-09-30 — Implementation context (Summary and Problem frame).** The
> identity-free cookie and global revocation below describe the baseline before
> principals shipped, not the current session model. The
> [epoch mint and verifier](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/auth.ts#L253-L330)
> and [actor-free request log](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/app.ts#L267-L281)
> preserve that evidence. The [key decisions below](#key-technical-decisions)
> govern the replacement; the
> [principal-cookie implementation](https://github.com/schlessera/brain-kit/commit/5300960db88d36399f76ee20ab5d66a714c298f2)
> and [request attribution](https://github.com/schlessera/brain-kit/commit/0acd22d3fd27b4ce3c2fc41d22ef4ec4538ebf2f)
> implement it. This is historical context, not a reversal of those decisions.

A brain-ui session carries no identity. The signed cookie is
`<issuedAt>.<epoch>` (`middleware/auth.ts:253`), validity is "the signature is
ours, it is younger than 30 days, and its epoch equals the one global integer in
`settings`" (`auth.ts:265-296`), and every passkey belongs to one logical user by
construction (`migrations/005_passkey_credentials.sql`: *"single-user app: no
user_id column"*).

Two consequences, both felt the moment a second actor — a phone, a second
laptop, an agent — holds a session:

1. **Revocation is all-or-nothing.** `bumpSessionsEpoch()` (`auth.ts:321`) is the
   only instrument. Cutting off one agent signs out every device. The only finer
   tool is rotating `COOKIE_SECRET`, which is a deploy.
2. **Nothing is attributable.** The request log records method, path, status and
   duration (`app.ts:268-282`); the activity record stamps sessions, jobs, models
   and cost (`activity_spans`, `migrations/007_activity.sql:12-35`) — but no
   actor. Every action an agent takes reads exactly like the owner taking it.

This plan replaces the epoch with a **principals table**: a named, individually
revocable, expiring row per login, with the cookie carrying nothing but its
signed id. No second credential type, no new header, no change to how the
WebSocket upgrade authenticates.

**It is not a containment boundary.** A principal that has run a turn has had
code execution in the container and could have read `COOKIE_SECRET` or written
`brain-ui.db`. Revocation is the control for a lost credential or a
well-behaved agent; the control for a hostile one is rotating the secret and
auditing. Every document this ships with must say so.

## Problem frame

Single-owner, private, auth in front. The threat model is not "many users with
different rights"; it is "several clients hold a credential to one powerful
surface, and the owner needs to cut one off and know which one did what".

The immediate driver is agent access. Today the only options are handing an
agent the owner's cookie — indistinguishable from the owner, revocable only by
logging the owner out — or re-opening password login as break-glass, which adds
a public credential path for everyone. Both were used during the 2026-09-09
incident; neither should be the standing answer.

## Non-goals

- **Scopes / least privilege per route.** The one exception is R9's kind check on
  the principal-management routes — a single check on a single route family, the
  same shape as the existing password-disabled guard (`deps.passwordDisabled`,
  `packages/ui-server/src/middleware/auth.ts:698`), not a scope system.
- **Multi-user.** One owner, several principals.
- **Bearer tokens.** Additive later and cheap (see Q5); not in this plan.
- **Containment of a compromised principal.** See the Summary.

## Context: what exists today

Both reviewers verified every row below against the source.

> **2026-09-30 — Implementation context (the table's pre-principal shapes).**
> The epoch-cookie rows, boolean WS guard, identity-free upgrade/admission and
> turn recorder, global passkey revocation and wrapper-keyed subscriptions are
> historical. The original
> [WS guard](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/auth.ts#L221-L237),
> [WS admission and upgrade](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/connection.ts#L74-L253),
> [recorder](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/run-session.ts#L133-L141),
> [turn shape](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/turns.ts#L53-L77)
> and [passkey delete](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/middleware/passkeys.ts#L578-L586)
> show the old shapes; some original citation numbers had already drifted in
> this snapshot. The [login change](https://github.com/schlessera/brain-kit/commit/ca6b0b276b38b57bbd2b8e2416c7327530990a8a)
> and [revocation change](https://github.com/schlessera/brain-kit/commit/48348dfc2eba315f548788f7debaa590290892bf)
> replace them under the key decisions below. Other anchored rows remain
> maintained citations, not a claim that this whole table is current.

| Thing | Where | Shape |
| --- | --- | --- |
| Cookie mint | `middleware/auth.ts:253` | `setSignedCookie(..., \`${Date.now()}.${epoch}\`, secret, { httpOnly, sameSite: "Strict", secure: true, path: "/", maxAge: 30d })` |
| Cookie verify | `auth.ts:265-296` | strict `^(\d+)\.(\d+)$`, safe integers, future/expired rejection, `cookieEpoch === sessionsEpoch(db)` |
| Global epoch | `auth.ts:302-318` | `settings` row; missing = 0; non-integer **throws** |
| Global revoke | `auth.ts:321-330` | `setSetting` (overflow-guarded) + `clients.closeAll(1008, …)` |
| Auth routes | `authRoutes`, `app.ts:527` | mounted **before** the guard at `authGuard(authMode`, `app.ts:541`; logout guards itself (`resolveCookiePrincipal(c, auth, deps.db)`, `auth.ts:799`) |
| Passkey management | `passkeyManagementRoutes`, `app.ts:551` | mounted **after** the guard ("Mount AFTER the auth guard") |
| WS guard | `"/ws"`, `app.ts:648-665` | origin → `isWsAuthorized` (returns a boolean, `auth.ts:221-237`) → capacity → upgrade |
| WS upgrade | `ws/connection.ts:262-264` | `createWsUpgrade` ignores the request context |
| WS admission | `ws/connection.ts:84` | `clients.add(ws)` — the socket's identity is unknown |
| Turn record | `ws/run-session.ts:133-141` | recorder built from `{turnId, sessionId, billing}`; `RunningTurn` (`ws/turns.ts:55-77`) has no actor |
| Follow-up queue | `QueuedFollowUp`, `ws/turns.ts:61-103`; `slot.queue.push(entry)`, `run-session.ts:688` | queued entries re-mint `turnId` in the same slot and may come from another socket |
| Password login | `acquirePasswordVerification(key)`, `auth.ts:740` | argon2id verify, failure counting, in-flight reservation, then `issueSessionCookie` |
| Passkey login | `issueLoginSession`, `packages/ui-server/src/middleware/passkeys.ts:442` | assertion verified, then `issueSessionCookie`; `row.id` is in scope |
| Passkey **registration** | `INSERT INTO passkey_credentials`, `passkeys.ts:540` | inserts a credential; calls **neither** helper |
| Passkey delete | `passkeys.ts:578-586` | deletes the credential, then a **global** bump |
| Sockets | `ClientSet`, `ws/clients.ts:41` | `ClientSet` keyed on `ws.raw` — hono mints a fresh `WSContext` per callback |
| Activity subscriptions | `activity/stream.ts:153` | a **separate** registry keyed on the wrapper, not `ws.raw` |
| Rollups | `migrations/007_activity.sql`; `upsertRollup`, `activity/sql.ts:19-24` | `activity_run_rollups` survives span pruning and carries its own origin/session/job |
| Client logout | `logout: () =>`, `ui-react/src/lib/api-client.ts:663`; `Sign out everywhere`, `passkey-list.tsx:103-105` | "Sign out everywhere" POSTs `/auth/logout` with no arguments |
| Unauthorized in the UI | `res.status === 401`, `ui-react/src/hooks/use-vpn-status.ts:36` | reached by `/api/vpn-check` returning 401, not by a close code |

Two findings that are true today, independent of this plan:

> **2026-09-30 — Implementation context (the first finding).** The subscription
> leak below is the pre-U5 behaviour: the
> [wrapper-keyed registry](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/activity/stream.ts#L153)
> was [written and deleted through different wrappers](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/activity/stream.ts#L326-L354).
> [U5](https://github.com/schlessera/brain-kit/commit/48348dfc2eba315f548788f7debaa590290892bf)
> fixed the keying and principal cleanup; the
> [current stream implementation](../../packages/ui-server/src/activity/stream.ts)
> uses the raw socket. The second finding remains a contract requirement.

- **The activity subscription registry leaks.** `subscribe` stores by the
  message-callback wrapper (`stream.ts:326`), `dropConnection` deletes by the
  close-callback wrapper (`stream.ts:354`) — different objects, which is why
  `ClientSet` keys on `ws.raw`. Entries outlive the socket and keep the poller
  awake. U5 fixes the keying; worth a standalone fix if this plan slips.
- **`docs/integration-contract.md` covers the WebSocket and activity surfaces**
  (`Revision negotiation`, `docs/integration-contract.md:2012-2026`;
  `Activity stream`, `:2259-2273`), so how attribution reaches a client is a
  contract decision (Key decision 7), not an implementation detail.

## Key technical decisions

**1. One authority: the `principals` table. The epoch goes.** Revision 2 kept
the global epoch alongside per-row state; review killed that. With a row per
login, a principal never has a second live cookie, so a per-principal epoch is
dead weight — and a global epoch bumped *without* setting `revoked_at` produces
rows the verifier treats as dead while the UI lists them as live and pruning
never collects them. Two mechanisms for one concept is how that divergence
ships. Validity becomes: **signature valid ∧ row exists ∧ `revoked_at IS NULL` ∧
`now < expires_at`**.

This reverses the hardening plan's decision 3, *"Sessions epoch, not a session
table"* (decision 3 in [hardening.md](hardening.md)) — said
out loud, because that decision was correct for what it solved. The epoch bought
global invalidation with no schema; it cannot buy per-actor revocation or
attribution, which is what this plan is for.

**2. The cookie carries the signed id and nothing else.** `issuedAt` is
redundant with `created_at`/`expires_at`, which are server state and therefore
authoritative for an agent that holds the value verbatim and ignores `maxAge`.
A v1 payload (`\d+\.\d+`) cannot match `^[A-Za-z0-9_-]{22}$` and would find no
row, so the old format is rejected structurally. Hono signs the whole payload
and splits on the last dot (`hono/utils/cookie.js:79-89`), so the id cannot be
edited without breaking the signature.

**3. Verify the signature first, then read the row.** Unauthenticated traffic
must not be able to drive database reads with arbitrary ids. The corrupt-row
throw sits after signature verification and outside the cookie-parser catch,
exactly as today's code does (`Deliberately after signature`,
`auth.ts:426-428`) — so a corrupt row 500s only that principal's requests
instead of everyone's.

**4. Principals carry their lineage, and passkey deletion uses it.**
`credential_id` (passkey logins; NULL for password), `created_by` (delegation),
`auth_method`. Deleting a passkey revokes `WHERE credential_id = ?` instead of
bumping a global epoch — the narrower kill the 0.32.0 behaviour was standing in
for. The credential must also be re-checked **after** the asynchronous assertion
verification and before the principal is created: today's lookup precedes
verification (`credentialById(ctx.db, response.id)`, `passkeys.ts:356`), so a
ceremony in flight can mint a session for a credential deleted meanwhile.

**5. Revocation is a boundary that outlives admission.** Closing a socket is not
revocation: `onMessage` dispatches without re-checking (`ws/connection.ts:173`),
turn startup awaits routing and billing before `startTurn`
(`resolveTurnTarget`, `ws/run-session.ts:179`; `const billing = host.activity`,
`:339`), and queued follow-ups execute later. Each connection holds a
server-resolved authorization context; revocation marks it invalid
synchronously, refuses later frames, drops that principal's queued unstarted
follow-ups, and leaves running work running (cancelling a slot would take other
principals' queued work with it — `drop its queued follow-ups`,
`ws/turns.ts:665`). The revocation itself is recorded in the activity record.

> **2026-09-30 — Implementation context (decision 5's missing re-check).** The
> [old dispatch](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/ws/connection.ts#L162-L220)
> did not re-check authorization. [U5](https://github.com/schlessera/brain-kit/commit/48348dfc2eba315f548788f7debaa590290892bf)
> implemented this decision; [current WS handlers](../../packages/ui-server/src/ws/connection.ts)
> enforce it. The boundary remains binding.

**6. Only an owner mints or revokes.** Without R9, an agent can mint itself a
replacement labelled "Safari on iPhone" before it is revoked, or revoke the
owner's devices — a revocation that leaves a door open. `kind` is derived from
the authentication method, never from a User-Agent string, and any authenticated
session can register a passkey today, so the UI describes principals as
credentials, not people.

**7. Attribution rides on explicit optional fields and survives retention.**
`activity_spans.principal_id`, plus `principal_id` on `activity_run_rollups`
(`upsertRollup`, `activity/sql.ts:19-24`) — the rollup is what survives span
pruning, so cost-by-actor dies at prune time without it. The precedent is
profile/billing: a root-span attr that the rollup reads (`spanId: rootSpanId`,
`activity/recorder.ts:138-153`). Nullable for cron (`origin: "cron"`,
`activity/span-sink.ts:102`, `cron/run-job.ts:113`) and for pre-migration rows;
nothing is backfilled.

> **2026-09-30 — Implementation context (decision 7's cron example).** The
> [old cron root span](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/cron/run-job.ts#L108-L118)
> had no principal. [Current cron attribution](../../packages/ui-server/src/cron/activity.ts)
> gives the root span the explicit scheduled-jobs system principal, as decision
> 8 requires. Nullable historical rows remain part of decision 7; the old cron
> example does not describe the current root span.

**8. Ambient modes keep the identity they already have.** `proxy` mode reads an
upstream user header (`auth.proxyAuthHeader`, `auth.ts:485`) — that becomes the
ambient principal's label, bounded like `sanitizeLabel`, `passkeys.ts:268-270`.
`tailscale` carries the client IP; `none` is fixed. Minting and revocation are
disabled in these modes. Cron is attributed to an explicit system principal, never to the owner.

## High-level design

```
login (password | passkey)
   └─ INSERT principals { id, kind: 'owner', auth_method, credential_id?,
                          label (UA, ≤64 chars), expires_at, created_at }
   └─ Set-Cookie: brain_ui_session = signed(id), maxAge derived from expires_at

mint (owner only, router mounted AFTER the guard)
   └─ INSERT principals { kind: 'agent', created_by, expires_at = now + ttl }
   └─ value returned in the BODY via hono's generateSignedCookie —
      no Set-Cookie (it would replace the owner's own session), no-store

/api/*  ──► authGuard ──► verify signature ──► load row ──► revoked? expired?
                       └─ 401 on any failure; c.set("principal"); touch
                          last_seen_at only when >60s stale
                       └─ request log: auth.principal.id / .label

/ws     ──► route resolves the principal, c.set()s it
        ──► upgradeWebSocket((c) => createWsHandlers(host, c.get("principal")))
              (hono passes the context to createEvents:
               hono/helper/websocket/index.js:34)
        ──► ConnectionState.principal (ws/dispatch.ts:14-17)
        ──► clients.add(ws, principalId)
        ──► QueuedFollowUp.principalId / RunningTurn.principalId
              (reset per queued follow-up, like lastResult)
        ──► createTurnRecorder(..., { principalId }) ──► root span ──► rollup

revoke  ──► revoked_at = now
        ──► invalidate connection contexts, ClientSet.closeFor(id, 1008, …)
        ──► drop that principal's queued follow-ups
        ──► drop its activity subscriptions, unbind its push subscriptions
```

`POST /api/auth/logout` keeps meaning **everywhere** (`UPDATE principals SET
revoked_at = now WHERE revoked_at IS NULL`); the caller-only operation is a new
endpoint, so the shipped button (`Sign out everywhere`,
`passkey-list.tsx:103-105`) does not silently become "sign out this device".

## System-wide impact

> **2026-09-30 — Implementation context (export and migration impact).** The
> API bullet records the change from the
> [old root exports](https://github.com/schlessera/brain-kit/blob/ea2c3d840920a4e73adc650566a6cfc110e9646e/packages/ui-server/src/index.ts#L44-L45).
> [Current exports](../../packages/ui-server/src/index.ts) reflect the principal
> implementation, not a pending epoch API change. The DB bullet's cron example
> is likewise the old writer; current root-span attribution is described beside
> decision 7 above. The compatibility and migration reasoning is preserved.

- **Sessions:** one forced re-login on upgrade.
- **Wire protocol:** no new frames; additive attribution fields on activity
  payloads, documented in `docs/integration-contract.md`.
- **HTTP surface:** `/api/auth/principals` (GET, POST), `/api/auth/principals/:id`
  (DELETE), a caller-only revoke; `/api/auth/logout` unchanged in meaning.
- **Exported API:** `bumpSessionsEpoch` disappears and `isWsAuthorized` changes
  shape; both are exported from the package root (`src/index.ts:44-45`). No
  consumers in this repo — check known consumers before landing, and name the
  change in the changeset.
- **DB:** two additive migrations (011, 012), nullable for old writers including
  cron.
- **Per-request cost:** one primary-key read on local WAL SQLite, plus a
  `last_seen_at` write only when >60s stale.

## Scheduled creator and approval identity — 2026-10-04

The selected [scheduled-work authority](scheduled-tasks.md#approval-is-an-immutable-recurring-envelope)
uses server-resolved creator and verified operator-approval identities. A model,
frontmatter principal or ordinary authenticated proposal cannot mint approval.
Occurrence admission and effectful execution recheck usable creator/approver
authority; renewal never transfers a grant implicitly. Autonomous revocation/
expiry denies or aborts/drains that work under the existing autonomous boundary,
without changing the ordinary interactive queued/running distinction above.
Attribution and principal checks remain separate from actual credential,
filesystem and egress containment. Cron's system identity cannot stand in for
the schedule's creator or approver.
