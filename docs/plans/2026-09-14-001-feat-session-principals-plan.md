# Give the session a principal

Status: draft (revision 3, review-complete) · Owner: maintainer · Target: `@schlessera/brain-ui-server`, `@schlessera/brain-ui-react`

## Summary

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
   duration (`app.ts:267-281`); the activity record stamps sessions, jobs, models
   and cost (`migrations/007_activity.sql:12-35`) — but no actor. Every action an
   agent takes reads exactly like the owner taking it.

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

## Requirements

R1. Every authenticated path resolves a principal: HTTP, the WebSocket upgrade,
and every consequential frame on an open socket.
R2. Revoking one principal stops it — cookie fails, sockets close, queued
unstarted work is discarded, later frames refused — and touches no other.
R3. "Sign out everywhere" still exists and stays the meaning of the existing
`POST /api/auth/logout` that shipped clients already call.
R4. The request log and activity record attribute work to a principal, including
who answered an approval and who sent a follow-up — not only who started a turn.
R5. The owner can mint a principal for an agent, see it listed with last use and
expiry, and revoke it, from the UI.
R6. No new credential type, no new header requirement, no change to the WS
upgrade's authentication.
R7. Fail closed: unknown, revoked, expired or malformed cookies rejected; a
corrupt row refuses rather than degrading to valid.
R8. Nothing is attributed to the owner by default; unattributable work is
recorded as unattributed.
R9. Only an **owner** principal can mint or revoke principals.

## Non-goals

- **Scopes / least privilege per route.** The one exception is R9's kind check on
  the principal-management routes — a single check on a single route family, the
  same shape as the existing password-disabled guard (`auth.ts:552`), not a
  scope system.
- **Multi-user.** One owner, several principals.
- **Bearer tokens.** Additive later and cheap (see Q5); not in this plan.
- **Containment of a compromised principal.** See the Summary.

## Context: what exists today

Both reviewers verified every row below against the source.

| Thing | Where | Shape |
| --- | --- | --- |
| Cookie mint | `middleware/auth.ts:253` | `setSignedCookie(..., \`${Date.now()}.${epoch}\`, secret, { httpOnly, sameSite: "Strict", secure: true, path: "/", maxAge: 30d })` |
| Cookie verify | `auth.ts:265-296` | strict `^(\d+)\.(\d+)$`, safe integers, future/expired rejection, `cookieEpoch === sessionsEpoch(db)` |
| Global epoch | `auth.ts:302-318` | `settings` row; missing = 0; non-integer **throws** |
| Global revoke | `auth.ts:321-330` | `setSetting` (overflow-guarded) + `clients.closeAll(1008, …)` |
| Auth routes | `app.ts:334` | mounted **before** the guard at `app.ts:349`; logout guards itself (`auth.ts:646`) |
| Passkey management | `app.ts:353` | mounted **after** the guard ("Mount AFTER the auth guard") |
| WS guard | `app.ts:413-428` | origin → `isWsAuthorized` (returns a boolean, `auth.ts:221-237`) → capacity → upgrade |
| WS upgrade | `ws/connection.ts:251-253` | `createWsUpgrade` ignores the request context |
| WS admission | `ws/connection.ts:74` | `clients.add(ws)` — the socket's identity is unknown |
| Turn record | `ws/run-session.ts:133-141` | recorder built from `{turnId, sessionId, billing}`; `RunningTurn` (`ws/turns.ts:53-75`) has no actor |
| Follow-up queue | `ws/turns.ts:15-20`, `run-session.ts:305` | queued entries re-mint `turnId` in the same slot and may come from another socket |
| Password login | `auth.ts:591` | argon2id verify, failure counting, in-flight reservation, then `issueSessionCookie` |
| Passkey login | `passkeys.ts:436` | assertion verified, then `issueSessionCookie`; `row.id` is in scope |
| Passkey **registration** | `passkeys.ts:505` | inserts a credential; calls **neither** helper |
| Passkey delete | `passkeys.ts:578-586` | deletes the credential, then a **global** bump |
| Sockets | `ws/clients.ts:33` | `ClientSet` keyed on `ws.raw` — hono mints a fresh `WSContext` per callback |
| Activity subscriptions | `activity/stream.ts:153` | a **separate** registry keyed on the wrapper, not `ws.raw` |
| Rollups | `migrations/007_activity.sql`, `activity/sql.ts:19-24` | `activity_run_rollups` survives span pruning and carries its own origin/session/job |
| Client logout | `ui-react/src/lib/api-client.ts:449`, `passkey-tab.tsx:166-175` | "Sign out everywhere" POSTs `/auth/logout` with no arguments |
| Unauthorized in the UI | `ui-react/src/hooks/use-vpn-status.ts:23` | reached by `/api/vpn-check` returning 401, not by a close code |

Two findings that are true today, independent of this plan:

- **The activity subscription registry leaks.** `subscribe` stores by the
  message-callback wrapper (`stream.ts:326`), `dropConnection` deletes by the
  close-callback wrapper (`stream.ts:354`) — different objects, which is why
  `ClientSet` keys on `ws.raw`. Entries outlive the socket and keep the poller
  awake. U5 fixes the keying; worth a standalone fix if this plan slips.
- **`docs/integration-contract.md` covers the WebSocket and activity surfaces**
  (`:122`, `:158`), so how attribution reaches a client is a contract decision
  (Key decision 7), not an implementation detail.

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
table"* (`docs/plans/2026-09-07-001-chore-hardening-roadmap-plan.md:359`) — said
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
exactly as `auth.ts:293-295` does today — so a corrupt row 500s only that
principal's requests instead of everyone's.

**4. Principals carry their lineage, and passkey deletion uses it.**
`credential_id` (passkey logins; NULL for password), `created_by` (delegation),
`auth_method`. Deleting a passkey revokes `WHERE credential_id = ?` instead of
bumping a global epoch — the narrower kill the 0.32.0 behaviour was standing in
for. The credential must also be re-checked **after** the asynchronous assertion
verification and before the principal is created: today's lookup precedes
verification (`passkeys.ts:352`), so a ceremony in flight can mint a session for
a credential deleted meanwhile.

**5. Revocation is a boundary that outlives admission.** Closing a socket is not
revocation: `onMessage` dispatches without re-checking (`ws/connection.ts:162`),
turn startup awaits routing and billing before `startTurn`
(`ws/run-session.ts:43,129`), and queued follow-ups execute later. Each
connection holds a server-resolved authorization context; revocation marks it
invalid synchronously, refuses later frames, drops that principal's queued
unstarted follow-ups, and leaves running work running (cancelling a slot would
take other principals' queued work with it — `ws/turns.ts:164`). The revocation
itself is recorded in the activity record.

**6. Only an owner mints or revokes.** Without R9, an agent can mint itself a
replacement labelled "Safari on iPhone" before it is revoked, or revoke the
owner's devices — a revocation that leaves a door open. `kind` is derived from
the authentication method, never from a User-Agent string, and any authenticated
session can register a passkey today, so the UI describes principals as
credentials, not people.

**7. Attribution rides on explicit optional fields and survives retention.**
`activity_spans.principal_id`, plus `principal_id` on `activity_run_rollups`
(`activity/sql.ts:19-24`) — the rollup is what survives span pruning, so
cost-by-actor dies at prune time without it. The precedent is profile/billing:
a root-span attr that the rollup reads (`activity/recorder.ts:96-107`). Nullable
for cron (`activity/span-sink.ts:102`, `cron/run-job.ts:113`) and for
pre-migration rows; nothing is backfilled.

**8. Ambient modes keep the identity they already have.** `proxy` mode reads an
upstream user header (`auth.ts:340`) — that becomes the ambient principal's
label, bounded like `sanitizeLabel` (`passkeys.ts:265-267`). `tailscale` carries
the client IP; `none` is fixed. Minting and revocation are disabled in these
modes. Cron is attributed to an explicit system principal, never to the owner.

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
        ──► ConnectionState.principal (ws/dispatch.ts:11-14)
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
endpoint, so the shipped button (`passkey-tab.tsx:166-175`) does not silently
become "sign out this device".

## Implementation units

| # | Unit | Package(s) | Size |
| --- | --- | --- | --- |
| U1 | Migration 011 `principals` + store (create, resolve, touch, revoke, revoke-all, revoke-by-credential, prune, cap) | ui-server | S |
| U2 | Cookie = signed id: mint, verify (signature → row → revoked → expired), reject v1 | ui-server | S |
| U3 | `authGuard` / `isWsAuthorized` resolve and expose the principal; request-log attribution; throttled `last_seen_at` | ui-server | S |
| U4 | Login paths create principals with lineage and bounded UA labels; credential re-check after verification; pruning and cap | ui-server | M |
| U5 | Revocation boundary: the six-file plumbing chain above, `ClientSet.closeFor`, queued-follow-up discard, **activity-subscription re-keying on `ws.raw`** | ui-server | L |
| U6 | Owner-only principal routes (mounted after the guard): mint returning the value once, list, delete; audit log; disabled in ambient modes | ui-server | M |
| U7 | Attribution: span `principal_id`, rollup `principal_id` (migration 012), responder identity on approvals and follow-ups, wire mapping, contract note | ui-server | M |
| U8 | UI "Devices & agents": list, revoke, mint form with one-time copy; migrate the existing "Sign out everywhere" button | ui-react | M |
| U9 | Push subscriptions bound to a principal, unbound on revocation; documented residual for already-sent notifications | ui-server, ui-sdk | S |
| U10 | Docs: `docs/hosting/README.md` (agent access, revocation, version-transition procedure), both SECURITY.md files (what a principal is **not**), ui-server README; changeset naming the exported-API change | ui-server, brain-ui | S |

**U1 detail.** `NOT NULL` on the primary key is load-bearing: SQLite accepts a
NULL `TEXT PRIMARY KEY` (verified — `INSERT … VALUES (NULL, …)` succeeds).

```sql
CREATE TABLE principals (
  id            TEXT PRIMARY KEY NOT NULL,  -- 22 chars base64url, server-generated
  kind          TEXT NOT NULL CHECK (kind IN ('owner','agent','ambient','system')),
  auth_method   TEXT NOT NULL CHECK (auth_method IN ('password','passkey','delegated','ambient')),
  label         TEXT NOT NULL,              -- ≤64 chars, never rendered as HTML
  credential_id TEXT,                       -- passkey_credentials.id, else NULL
  created_by    TEXT,                       -- minting principal, for delegation
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_principals_live ON principals(revoked_at, expires_at);
```

Migrations are recorded by filename after applying (`db/client.ts:39`), so U7's
column ships as its own file (012) — never appended here.

**U6 detail.** Do not reimplement hono's HMAC: take the value from
`generateSignedCookie`, read between `=` and `;`, `decodeURIComponent` it, and
round-trip it through `getSignedCookie` in a test.

## System-wide impact

- **Sessions:** one forced re-login on upgrade.
- **Wire protocol:** no new frames; additive attribution fields on activity
  payloads, documented in `docs/integration-contract.md`.
- **HTTP surface:** `/api/auth/principals` (GET, POST), `/api/auth/principals/:id`
  (DELETE), a caller-only revoke; `/api/auth/logout` unchanged in meaning.
- **Exported API:** `bumpSessionsEpoch` disappears and `isWsAuthorized` changes
  shape; both are exported from the package root (`src/index.ts:44-45`). No
  consumers in this repo — grep brain-ui before landing, and name the change in
  the changeset.
- **DB:** two additive migrations (011, 012), nullable for old writers including
  cron.
- **Per-request cost:** one primary-key read on local WAL SQLite, plus a
  `last_seen_at` write only when >60s stale.

## Risks

| Risk | Mitigation |
| --- | --- |
| A verifier bug locks the owner out | Every rejection asserted and shown red first: v1 payload, unknown id, revoked, expired, malformed, corrupt row, encoded delimiters, duplicate cookie header. Recovery is roll back to known-good code plus targeted row repair — **not** secret rotation, which does not repair a broken verifier |
| **Rollback revives pre-upgrade cookies** | A v1 cookie dead under v2 becomes valid again under v1 code, because v2's revocations never touch the old counter. For the one release the settings row is retained, sign-out-everywhere **also** bumps it; the runbook additionally repeats 0.32.0's instruction to rotate `COOKIE_SECRET` when crossing the format boundary, with an upgrade → rollback → re-upgrade test |
| Selective revocation looks complete but is not | U5's acceptance criteria are the boundary cases: an already-dispatched frame, a queued follow-up, a pending approval, an in-flight turn start, an activity subscription, a push subscription |
| An agent escalates through the mint route | R9's owner-only check, `created_by` recorded, and the SECURITY.md sentence that a hostile principal is a secret-rotation problem, not a revocation problem |
| A minted value leaks | Server-enforced `expires_at` (7 days default), `last_seen_at` visible, single-row revocation, shown once, never logged |
| Row growth | Prune by `expires_at`/`revoked_at` on login and boot plus a live-principal cap — successful logins do not consume the limiter's failure budget (`auth.ts:624`), so nothing else bounds creation |
| Attribution lost to retention | Rollup `principal_id` (Key decision 7) |
| Naming collision | "Session" already means chat session (`app.ts:369`, `activity_spans.session_id`, `SessionCatalog`, the ui-react sidebar). Table and routes are `principals`; the UI says "Devices & agents" |

## Open questions — answered by review

| Q | Answer |
| --- | --- |
| Q1 per login or per credential | **Per login, tagged with `credential_id`.** Revocation is reached for as "that phone / that agent"; per-credential identity is what passkey deletion gets from the tag |
| Q2 keep the global epoch | **No — drop it as an authority** (Key decision 1). Keep writing the settings row for one release as a downgrade guard, then delete it |
| Q3 agent TTL | **7 days** via `expires_at`, owner-settable at mint up to the 30-day owner TTL, no renewal endpoint — renewal is minting a new one, a human step by design |
| Q4 abort running turns | **No.** Drop the revoked principal's queued follow-ups, record the revocation, leave running work running |
| Q5 bearer transport | **Not now, and cheap later**: accept `Authorization: Bearer <same value>` only when no cookie is present, same verifier. No origin exemption is needed — `middleware/origin.ts:82` already admits header-less clients, which the plan previously got wrong |
| Q6 cache the resolution | **No.** One primary-key read on local WAL SQLite is microseconds; a cache reintroduces exactly the staleness window this plan exists to close. Throttle the write instead |

## Review record

- **2026-09-14, revision 1 drafted.**
- **2026-09-14, revision 1 → 2, gpt-6-astra** (read-only; SOUND WITH CHANGES).
  Verified all twelve context rows; corrected three claims (`ClientSet` is
  ui-server, passkey registration calls neither helper, the integration contract
  does cover WS/activity). Blockers folded: agent TTL had no authoritative
  representation; dropping the passkey-delete global bump would strand that
  credential's sessions; "close the socket" is not a revocation boundary; a
  rollback across the cookie format revives credentials. Should-fixes folded:
  logout keeps its "everywhere" meaning for cached clients, the mint route must
  not `Set-Cookie`, push subscriptions bound to a principal, attribution
  surviving retention, responder identity on approvals, pruning by expiry with a
  cap, `NOT NULL` on the primary key (SQLite accepts a NULL one — verified), and
  that secret rotation does not repair a broken verifier. It also surfaced the
  pre-existing activity-subscription leak.
- **2026-09-14, revision 2 → 3, Claude Fable 5.1** (SOUND WITH CHANGES).
  Independently verified the same citations plus hono's signature format. Three
  blockers: two revocation mechanisms for one concept (the epoch **and** a row
  per login) leaving dead-but-unpruned rows and silently reversing hardening
  decision 3; no plumbing named for per-actor socket close or turn attribution;
  and any principal — including an agent — able to mint or revoke principals.
  Should-fixes folded: mint router mounted after the guard and built on
  `generateSignedCookie`, credential-scoped passkey revocation, rollup
  `principal_id`, signature-before-row-lookup, proxy-mode identity as the
  ambient label, the wrong origin-policy premise, the retained-epoch downgrade
  guard, the existing "Sign out everywhere" button, no abort on revoke, and the
  `principals` naming. Nits folded: throttled `last_seen_at`, bounded
  non-HTML labels, the exported-API note, migration numbering, and that a
  revoked device reaches the login screen through `/api/vpn-check`, not the
  close code.
- **Where the reviewers disagreed:** astra recommended keeping the global epoch
  as an O(1) everywhere-switch; Fable recommended deleting it. Resolved in
  Fable's favour on authority — two mechanisms for one concept is precisely how
  the UI comes to show a live row the verifier treats as dead — while keeping
  astra's rollback concern by writing (never reading) the settings row for one
  release as a downgrade guard.
