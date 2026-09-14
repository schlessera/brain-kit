# Give the session a principal

Status: draft (revision 2) · Owner: maintainer · Target: `@schlessera/brain-ui-server`, `@schlessera/brain-ui-react`

## Summary

A brain-ui session carries no identity. The signed cookie is
`<issuedAt>.<epoch>` (`middleware/auth.ts:246`), validity is "the signature is
ours, it is younger than 30 days, and its epoch equals the one global integer
in `settings`" (`auth.ts:265`), and every passkey belongs to one logical user by
construction (`migrations/005_passkey_credentials.sql`: *"single-user app: no
user_id column"*).

Two consequences, both felt the moment a second actor — a phone, a second
laptop, an agent — holds a session:

1. **Revocation is all-or-nothing.** `bumpSessionsEpoch()` (`auth.ts:321`) is
   the only instrument. Logging out one device, or cutting off one agent, signs
   out every session on every device. The only finer tool is rotating
   `COOKIE_SECRET`, which is a deploy.
2. **Nothing is attributable.** The request log records method, path, status and
   duration (`app.ts:267`); the activity record stamps sessions, jobs, models
   and cost (`migrations/007_activity.sql:12`) — but no actor. Every action an
   agent takes reads exactly like the owner taking it.

This plan gives a session a **principal**: a named, individually revocable,
expiring identity carried inside the existing cookie. It is deliberately *not* a
token system — same credential type, same transport, same WebSocket path —
because the two things actually missing are per-actor revocation and
attribution, and both are reachable without a second credential mechanism in
the auth boundary.

**What revision 2 changed, after review:** per-principal epochs are gone (the
global epoch stays as the everywhere-switch, `revoked_at` handles the
individual case); principals now carry a server-enforced `expires_at` and their
credential lineage; passkey deletion keeps its global invalidation; revocation
is defined as a boundary that survives *after* admission rather than a socket
close; and the rollback story now includes secret rotation, because a format
downgrade otherwise revives old cookies. See the review record.

## Problem frame

The deployment this serves is single-owner and private, fronted by auth. The
threat model is not "many users with different rights"; it is "several clients
hold a credential to one powerful surface, and the owner needs to cut one off
and to know which one did what". A session that can start a turn can run
arbitrary code in the container with its credentials — so **this plan does not
create a containment boundary**, and must not be described as one. Scoping
*below* "operate" is a separate, larger question (see Non-goals).

The immediate driver: agent access. Today the only ways to let an agent in are
(a) hand it the owner's cookie, indistinguishable from the owner and revocable
only by logging the owner out too, or (b) re-open password login as break-glass,
which adds a public credential path for everyone. Both were used during the
2026-09-09 incident; neither should be the standing answer.

## Requirements

R1. Every authenticated path resolves a principal — HTTP, the WebSocket
upgrade, and every consequential frame on an open socket.
R2. Revoking one principal stops that principal: its cookies fail, its sockets
close, its queued-but-unstarted work is discarded, and its later frames are
refused. Other principals are untouched.
R3. "Sign out everywhere" still exists, still means everywhere, and stays the
meaning of the existing `/api/auth/logout` endpoint that shipped clients call.
R4. The request log and the activity record attribute work to a principal —
including who answered an approval and who sent a follow-up, not only who
started the turn.
R5. The owner can mint a principal for an agent, see it listed with its last
use and its expiry, and revoke it — from the UI, without a deploy or a shell.
R6. No new credential type, no new header requirement, no change to how the
WebSocket upgrade authenticates.
R7. Fail closed: unknown, revoked, expired, malformed or stale-epoch cookies are
rejected; a corrupt principal row refuses rather than degrading to "valid".
R8. Nothing is attributed to the owner by default. An unattributable action is
recorded as unattributed, never as the owner.

## Non-goals

- **Scopes / least privilege per route.** Every valid principal can do what a
  session does today. A half-enforced scope is worse than none: it buys false
  confidence.
- **Multi-user.** One owner, several principals. No per-user data separation.
- **Bearer tokens.** Rejected: a non-browser client can already send `Cookie:`,
  and the origin policy already admits requests carrying neither `Origin` nor
  fetch metadata (`middleware/origin.ts:82`), so no exemption is needed.
- **Containment of a compromised principal.** Revocation stops *new* work; it
  does not claw back what a turn already did.

## Context: what exists today

Verified against the source; the rows below were re-checked in review.

| Thing | Where | Shape |
| --- | --- | --- |
| Cookie mint | `middleware/auth.ts:246` | `setSignedCookie(c, "brain_ui_session", \`${Date.now()}.${epoch}\`, secret, { httpOnly, sameSite: "Strict", secure: true, path: "/", maxAge: 30d })` |
| Cookie verify | `auth.ts:265` | strict `^(\d+)\.(\d+)$`, safe-integer check, future/expired rejection, `cookieEpoch === sessionsEpoch(db)` |
| Global epoch | `auth.ts:302` | `settings` row `auth.sessionsEpoch`; missing = 0; anything not a non-negative safe integer **throws** |
| Global revoke | `auth.ts:321` | `setSetting` (with an overflow guard) + `clients.closeAll(1008, "Sessions invalidated")` |
| HTTP guard | `app.ts:349` | `app.use("/api/*", authGuard(...))`; the auth routes themselves mount **before** it (`app.ts:334`) |
| WS guard | `app.ts:413` | origin → `isWsAuthorized` → capacity → upgrade-shape → upgrade |
| Password login | `auth.ts:591` | argon2id verify, failure counting, in-flight reservation, then `issueSessionCookie` |
| Passkey login | `passkeys.ts:436` | assertion verified, then the same `issueSessionCookie` |
| Passkey **registration** | `passkeys.ts:505` | inserts a credential and returns its summary — calls **neither** `issueSessionCookie` nor `bumpSessionsEpoch` |
| Logout | `auth.ts:645` | in password mode: verify caller, global bump, delete cookie. Other modes: delete the cookie only |
| Passkey delete | `passkeys.ts:578` | delete the credential, then a **global** bump |
| Sockets | `ws/clients.ts:33` | `ClientSet` keyed on `ws.raw` because hono mints a fresh `WSContext` per callback |
| Activity subscriptions | `activity/stream.ts:153` | a **separate** registry keyed on the `WSContext` wrapper, not `ws.raw` |
| Activity spans | `migrations/007_activity.sql:12` | `origin` is `'session' \| 'cron'`; `session_id`, `job_name`, no actor |

Two things this table made visible that are true today, independent of this
plan:

- **The activity subscription registry leaks.** `subscribe` stores by the
  message-callback wrapper (`stream.ts:326`) and `dropConnection` deletes by the
  close-callback wrapper (`stream.ts:354`) — different objects, which is exactly
  why `ClientSet` keys on `ws.raw`. Entries therefore survive the socket, and
  `isWatched` keeps the poller alive. U5 fixes the keying; it is worth a
  standalone fix if this plan slips.
- **`docs/integration-contract.md` does cover the WebSocket protocol and
  activity streaming** (`:122`, `:158`). "No new frames" is not the same as "no
  contract change": how attribution reaches a client (an existing `attrs` key
  versus new optional fields) is a contract decision, made in Key decision 8.

## Key technical decisions

**1. The principal id goes in the cookie payload, first.**
`<principalId>.<issuedAt>.<epoch>`. Hono signs the whole value and splits on the
*last* dot to take the signature (`hono/utils/cookie.js:47,75`), so extra dots
are safe and any edit to the principal invalidates the signature. The id is
server-generated, 22 characters of base64url, and can never contain a dot;
ids are never accepted from a User-Agent, a label or a frame.

**2. The global epoch stays; individual revocation is `revoked_at`.**
Revision 1 replaced the global integer with per-principal epochs. That traded an
O(1) everywhere-switch with an overflow guard for an N-row mass update that has
to re-validate every row, and left an unread settings key behind. Instead:
`settings.auth.sessionsEpoch` keeps its current meaning and code path, and
`session_principals.revoked_at` handles the individual case. Validity is
**signature ∧ shape ∧ age < TTL ∧ cookieEpoch === globalEpoch ∧ principal exists
∧ not revoked ∧ not expired**.

**3. Expiry is server state, not a cookie attribute.** A principal row carries
`expires_at NOT NULL`. `maxAge` on the `Set-Cookie` binds only a browser; an
agent holding the value verbatim ignores it entirely, so a 7-day agent
credential that is only 7 days long in the browser is not 7 days long at all.
Expiry is checked on HTTP admission, on WS upgrade, and again before
consequential work on an open socket. `last_seen_at` never extends it; renewal
is an explicit owner action that mints a new principal.

**4. Principals carry their lineage.** `auth_method` (`password` | `passkey` |
`delegated` | `ambient`), `credential_id` for a passkey login, and
`created_by_principal_id` for a delegated one. Without lineage, "revoke this
passkey" cannot find the sessions it produced, and `kind: 'owner'` would be a
claim derived from nothing — any authenticated session can register a passkey
today (`app.ts:349` guards registration only as "a session"), so a label saying
"owner" must never be read as "a human did this".

**5. Passkey deletion keeps its global invalidation.** Selective
credential-linked revocation lands only once lineage exists and is proven
(U5); until then, deleting a credential continues to bump the global epoch
exactly as it does now (`passkeys.ts:584`). Reopening a hardening decision
without its replacement is how a regression ships. Additionally, the credential
must be re-checked *after* the asynchronous assertion verification and before a
principal is created — today the lookup precedes verification
(`passkeys.ts:352`), so a ceremony already in flight can mint a session for a
credential deleted meanwhile.

**6. Revocation is a boundary that outlives admission.** Closing a socket is not
revocation: `onMessage` dispatches without re-checking authorization
(`ws/connection.ts:162`), turn startup awaits routing and billing before
`startTurn` (`ws/run-session.ts:43,129`), and queued follow-ups carry no actor
and execute later (`ws/turns.ts:15`, `run-session.ts:194`). Each connection
therefore holds a server-resolved **authorization context**; revocation marks it
invalid synchronously, after which inbound frames are refused and sends are
dropped; queued-but-unstarted work belonging to that principal is discarded;
work already handed to a backend is left running and reported as such.

**7. `/api/auth/logout` keeps meaning "everywhere".** The shipped client calls
it with no arguments (`ui-react/src/lib/api-client.ts:448`, used by
`passkey-tab.tsx:99`), and a cached client against a new server must not
silently downgrade the owner's "sign out everywhere" to "sign out this tab".
The caller-only operation is a **new** endpoint.

**8. Attribution rides on explicit optional fields, and survives retention.**
`activity_spans.principal_id` plus, on `activity_run_rollups`, the initiator id
and an immutable display snapshot of its label — otherwise attribution vanishes
when span detail is pruned (`activity/store.ts:508,803`) or when a principal row
is pruned. Old rows are never backfilled: historical attribution is nullable and
renders as "unattributed". The wire mapping enumerates its output fields
explicitly (`activity/stream.ts:59,119`), so new fields are additive and
`docs/integration-contract.md` is updated in the same commit.

**9. Ambient modes get a synthetic principal for logging only.** `tailscale`,
`proxy` and `none` have no cookie and no revocation story
(`auth.ts:175,227`). They resolve to a fixed `kind: 'ambient'` principal so
every consumer can assume one exists; minting and revocation routes are
**disabled** in those modes, and the UI says so. Cron opens the database
directly with `origin: 'cron'` (`cron/run-job.ts:103`) and is attributed to an
explicit system principal — never to the owner, never to ambient.

## High-level design

```
login (password | passkey)
        │  create principal row: kind=owner, auth_method, credential_id?,
        │  label from UA, expires_at = now + owner TTL
        ▼
issueSessionCookie(c, auth, db, principalId)      ── browser: Set-Cookie
mintDelegatedCookie(db, { label, ttlDays })       ── agent: value in the BODY,
        │                                            no Set-Cookie, no-store
        ▼
/api/* ──► authGuard ──► resolvePrincipal(db, cookie)
                      │     unknown | revoked | expired | epoch drift → 401
                      │     ok → c.set("principal"), throttled last_seen_at
                      ▼
                 request log: auth.principal.id / .label
/ws upgrade ──► isWsAuthorized (same resolver) ──► ClientSet.add(ws.raw, principalId)
                      │                            + connection authorization context
                      ▼
   every consequential frame (chat, follow-up, approval, cancel)
        └─► context still valid? no → refuse + report; yes → record responder
```

Revocation:

```
POST   /api/auth/logout                 ── unchanged: global epoch bump (everywhere)
POST   /api/auth/session/revoke         ── new: the caller's principal only
DELETE /api/auth/principals/:id         ── new: that principal only
        └─ revoked_at = now
        └─ invalidate its connection contexts (refuse later frames)
        └─ close its sockets (1008) + drop its activity subscriptions
        └─ discard its queued, unstarted turns
        └─ unbind its push subscriptions
```

## Implementation units

| # | Unit | Package(s) | Size |
| --- | --- | --- | --- |
| U1 | `session_principals` migration + store (create, resolve, touch, revoke, prune, cap) with strict accessors | ui-server | S |
| U2 | Cookie payload v2: mint with a principal, verify strictly (shape, epoch, existence, revoked, expired), reject v1 | ui-server | M |
| U3 | `authGuard` / `isWsAuthorized` resolve and expose the principal; request-log attribution; throttled `last_seen_at` | ui-server | S |
| U4 | Login paths create principals with lineage; UA labels; credential re-check after verification; pruning and the active cap | ui-server | M |
| U5 | Revocation boundary: connection authorization contexts, frame refusal after invalidation, selective socket close, queued-work discard, **activity-subscription re-keying on `ws.raw`** | ui-server | L |
| U6 | `POST /api/auth/principals` mints a delegated principal and returns the value **once** (no `Set-Cookie`, `Cache-Control: no-store`); list + delete routes; audit log; disabled in ambient modes | ui-server | M |
| U7 | Attribution: `activity_spans.principal_id`, rollup initiator + label snapshot, responder identity on approvals and follow-ups, wire mapping, contract note | ui-server | M |
| U8 | Settings UI: sessions list (label, kind, created, last seen, expiry, "this device"), revoke, mint-an-agent form with a one-time copy view | ui-react | M |
| U9 | Push subscriptions bound to a principal and unbound on revocation; documented residual for already-sent notifications | ui-server, ui-sdk | S |
| U10 | Docs: hosting.md (agent access, revocation, the version-transition procedure), SECURITY.md (what a principal is and is **not**), ui-server README routes; changeset | ui-server, brain-ui | S |

**U1 detail.** Migration 011 — `NOT NULL` on the primary key is load-bearing:
SQLite accepts a NULL `TEXT PRIMARY KEY` (verified: `INSERT … VALUES (NULL,…)`
succeeds on a bare `id TEXT PRIMARY KEY`).

```sql
CREATE TABLE session_principals (
  id            TEXT PRIMARY KEY NOT NULL,  -- 22 chars base64url, server-generated
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('owner','agent','ambient','system')),
  auth_method   TEXT NOT NULL CHECK (auth_method IN ('password','passkey','delegated','ambient')),
  credential_id TEXT,                        -- passkey_credentials.id, when auth_method='passkey'
  created_by_principal_id TEXT,              -- who delegated this one
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_session_principals_live ON session_principals(revoked_at, expires_at);
```

Never append later columns to this file: migrations are recorded by filename
after applying (`db/client.ts:39`), so U7's column ships as its own migration.

**U6 detail.** Requires a valid session, takes `{ label, ttlDays }` (bounded,
default 7), returns `{ id, label, expiresAt, cookie }` where `cookie` is the
signed value for a `Cookie: brain_ui_session=…` header — shown once, never
stored, never logged, and delivered with `Cache-Control: no-store` and **no**
`Set-Cookie`, so minting never replaces the owner browser's own session.

## System-wide impact

- **Sessions:** one forced re-login on upgrade (v1 cookies have two fields).
- **Wire protocol:** no new frames; attribution fields on activity payloads are
  additive and documented in `docs/integration-contract.md` (Key decision 8).
- **HTTP surface:** `/api/auth/principals` (GET, POST), `/api/auth/principals/:id`
  (DELETE), `/api/auth/session/revoke` (POST) added; `/api/auth/logout` unchanged.
- **DB:** one new table (011) and one new span column (012), both additive and
  nullable so an older writer — including cron — keeps working.
- **Per-request cost:** one indexed read, plus a throttled `last_seen_at` write
  (not one write per request).
- **Public API:** `bumpSessionsEpoch` is exported (`src/index.ts:42`); it keeps
  its signature and meaning, so the api-report stays stable.
- **Env contract:** unchanged.

## Risks

| Risk | Mitigation |
| --- | --- |
| A verifier bug locks the owner out of a remote surface | Every rejection case asserted and shown red first: v1 cookie, unknown id, revoked, expired, epoch drift, malformed, corrupt row, encoded delimiters, duplicate cookie header. Recovery is **roll back to known-good code plus targeted repair of the auth row** — not secret rotation, which does not repair a broken verifier |
| **Rollback across the format boundary revives credentials** | Reproducible: a stolen v1 cookie is rejected while upgraded, then valid again after a downgrade, because revocations recorded in the new tables never touched the old counter. The runbook makes `COOKIE_SECRET` rotation **mandatory** when crossing the format boundary in either direction, and a test covers upgrade → rollback → re-upgrade with a retained cookie |
| Selective revocation looks complete but is not | U5's boundary cases are the unit's acceptance criteria: an already-dispatched frame, a queued follow-up, a pending approval, an in-flight turn start, an activity subscription |
| A minted agent value leaks | Server-enforced `expires_at`, default 7 days; `last_seen_at` in the UI; single-row revocation; shown once, never logged |
| Row growth | Prune by `expires_at` and `revoked_at` on login and boot, plus a cap on live principals — successful logins deliberately do not consume the limiter's failure budget (`auth.ts:624`), so nothing else bounds creation |
| "Owner" becomes a misleading label | `kind` is derived from the authentication method, never from a UA string; any authenticated session can register a passkey, so the UI describes principals as credentials, not people |
| Push notifications outlive revocation | U9 binds subscriptions to a principal; already-delivered notifications cannot be recalled, and the docs say so |
| Attribution is lost to retention | Rollups keep the initiator id and a label snapshot; pruned spans lose detail, not the actor |

## Open questions — answered in review

| Q | Answer (both reviewers, where they agree) |
| --- | --- |
| Q1 principal per login or per credential | **Per login, with credential lineage.** A synced passkey logs in from several devices; conflating them would make revocation coarse again. Describe it as a login session, not a physical device |
| Q2 keep the global epoch | **Keep it.** It stays the everywhere-switch with its overflow guard; `revoked_at` covers the individual case. Per-principal epochs dropped |
| Q3 agent TTL | **7 days**, server-enforced via `expires_at`, shorter allowed, renewal is an explicit new mint — no silent extension |
| Q4 abort running turns on revocation | **No.** Refuse further input, discard the principal's queued unstarted work, leave running work running (the existing cancel path clears a whole session queue, which would take another principal's work with it — `ws/turns.ts:164`) |
| Q5 bearer transport | **No.** Cookies already work for non-browser clients and the origin policy already admits header-less requests (`origin.ts:82`) |
| Q6 cache the resolution | **No.** Read authoritative state at each admission and execution boundary; throttle only the `last_seen_at` write. Caching reintroduces the staleness window this plan exists to remove |

## Review record

- **2026-09-14, revision 1 drafted.**
- **2026-09-14, revision 1 → 2, after a gpt-6-astra review** (read-only, against
  the worktree; verdict SOUND WITH CHANGES). It verified all twelve
  "what exists today" rows and corrected three claims: `ClientSet` lives in
  ui-server rather than ui-sdk, passkey registration calls neither
  `issueSessionCookie` nor `bumpSessionsEpoch`, and the integration contract
  does cover the WebSocket and activity surfaces. Four blockers folded in:
  agent TTL had no authoritative representation (now `expires_at`); dropping the
  global bump from passkey deletion would have left that credential's sessions
  alive (now kept, with the post-verification credential re-check); "close the
  socket" is not a revocation boundary (now connection authorization contexts,
  frame refusal, queued-work discard); and a rollback across the cookie format
  revives old credentials (now mandatory `COOKIE_SECRET` rotation plus an
  upgrade → rollback → re-upgrade test). Its should-fixes also produced: the
  logout endpoint keeping its "everywhere" meaning for cached clients, the mint
  route not setting a cookie, push subscriptions bound to a principal,
  attribution surviving retention in rollups, responder identity on approvals
  and follow-ups, pruning by expiry with an active cap, `NOT NULL` on the
  primary key (SQLite accepts a NULL one — verified), and the correction that
  secret rotation does not repair a broken verifier. It also surfaced a
  pre-existing defect: the activity subscription registry is keyed on the hono
  wrapper and leaks on close.
- **2026-09-14, Claude Fable 5.1 review** — pending; findings fold into
  revision 3.
