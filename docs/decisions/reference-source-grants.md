# Decision — owner-managed reference-source grants

The [reference-worktree decision](reference-worktrees.md#authority-and-credential-isolation)
allows private acquisition "through a repository connection already authorized
for the requesting principal", and says host credential availability alone
grants no authority. When
[#2429](https://github.com/schlessera/brain-kit/issues/2429) came to
implement that, no such connection existed. Principals carry kind, auth
method, label and expiry, with no repository or credential scope. The only
repository credentials were host-wide environment selectors. The worker asked
what makes a connection "already authorized"
([question](https://github.com/schlessera/brain-kit/issues/2429#issuecomment-6341473427)).

## The ruling

The maintainer selected **owner-managed grant records** on 2026-10-22
([ruling](https://github.com/schlessera/brain-kit/issues/2429#issuecomment-6341544407)):

- An owner action records a grant of (brain, principal, repository prefix,
  named host credential).
- Private source is fetched only while a live grant covers the requesting
  principal and repository.
- Revoking a grant takes effect immediately, including for in-flight
  refreshes.
- A host credential existing never counts as authority.
- The records add an HTTP contract surface (`CONTRACT:`, additive).

## The record

A grant is one row of the UI database's `reference_grants` table
(`createReferenceGrant`, `packages/ui-server/src/db/reference-grants.ts:117-138`).
The table holds the served brain's identity, the principal, the canonical
repository prefix, the credential name or null, the granting owner and the
revocation time. It stores no credential value. A grant is **live** while it
is unrevoked and its principal is an unrevoked, unexpired owner or agent.
Pruning a principal deletes its grants with it.

Only a live owner can create a grant, and only for a live owner or agent
principal. Cron's system principal and ambient principals cannot hold one. The
routes sit inside the principal-management family, so they inherit its
password-mode and owner checks
(`app.get("/auth/principals/:id/reference-grants"`, `packages/ui-server/src/middleware/principals.ts:216-225`).
Owner sessions are principals too: every login creates one, and a grant to an
owner session ends when that session does.

## Covering and credentials

A repository location is HTTPS without user info, query or fragment; loopback
`http://`; or an absolute `file:///` path
(`referenceRepository`, `packages/ui-server/src/db/reference-grants.ts:51-75`).
SSH is refused: no grantable credential is an SSH key. The canonical form
lowercases the origin and drops a trailing slash and a hosted `.git` suffix. A
prefix covers itself and every path below it at a segment boundary, so
`…/odysseus` never covers `…/odysseus-crew`. The longest covering live prefix
wins, read at the moment of use
(`coveringReferenceGrant`, `packages/ui-server/src/db/reference-grants.ts:158-164`).

A grant names its credential from a fixed list of existing host selectors,
each with the one origin it may be sent to
(`REFERENCE_HOST_CREDENTIALS`, `packages/ui-server/src/db/reference-grants.ts:26-30`):
`BRAIN_UI_SYNC_GITHUB_TOKEN`, `BRAIN_UI_SKILLS_GITHUB_TOKEN` and `GITHUB_TOKEN`,
all for `https://github.com`. Loopback origins may also receive them, because
they stay on this host; that is how the offline fixtures exercise a
credentialed fetch. A file prefix takes no credential, and null means "fetch
without one". Naming a credential does not make it available. A grant whose
credential is unset on the host still cannot fetch, and a set credential with
no grant authorizes nothing.

## What a grant does and does not authorize

A grant authorizes the **private** sharing domain of one brain and principal.
The public domain never uses a grant or a credential: a revision is public only
when an anonymous transport resolves and fetches it. Public bytes therefore
come only from anonymous fetches, and a privately fetched revision can never
enter the shared public cache. File repositories are never public, because
anonymous success there says nothing about who may read the host path.

Revocation is checked, not cached. Every new mount and every step that could
publish private source asks for the live covering grant again. The revoke
routes also report the lost authority synchronously
(`app.delete("/auth/principals/:id/reference-grants/:grantId"`, `packages/ui-server/src/middleware/principals.ts:272-293`),
so the acquisition layer can cancel in-flight private work rather than wait for
its next check. Revocation cannot retract bytes a reader has already read.

## Alternatives the question listed

- **Owner-declared static configuration** maps prefixes to credentials and
  principal kinds. It has no per-principal granularity for delegated
  principals, and revocation needs a restart.
- **Owner principal only** lets the live owner use the host's configured
  credential. That sits too close to "credential availability grants
  authority".
- **Public-only for now** would leave the private half of the acquisition
  criteria open.
