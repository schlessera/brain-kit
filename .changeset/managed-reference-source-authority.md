---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

Bind managed GitHub source acquisition and cached-source revalidation to the requesting turn's network budget and live authority. Retain sealed-root and tree acquisition facts outside source content; refuse contradictory retained roots after restart. Managed source and worktree file reads remain restricted until actual immutable-read provenance is qualified. Failed worktree grants condition native parking on their requesting generation, preserving another generation's access while still withdrawing a lost-reply grant of their own. Keep stored canonical grant suffixes literal during lookup and duplicate checks, so a repository grant cannot authorize a neighboring repository. Waiting worktree effects reread shared source authority, including durable invalidation by another app or cron owner. Shared repository/revision invalidation versions also fence first publication across app and cron owners, with validation/publication commit checks and retirement of invalidated sealed staging identities. Failed-attempt cleanup preserves another owner's newer publication. Metadata and Git wiring preserve the requested repository's literal canonical suffix, including when metadata reports it missing.

Keep stored worktree repository keys separate from raw clone input so revocation cannot borrow a neighboring repository's grant. Managed roots opt into durable, permanent native publication withdrawal: delayed publication cannot revive a revoked identity, while fresh authorized acquisition uses a new root and legacy withdrawal stays reversible. Recovery keeps invalidated roots masked, and committing a shared invalidation atomically expires matching cached validation.

Condition native publication and catalog updates on the previously observed root so concurrent acquisitions cannot roll a source back to an older revision. Worktrees retain their original acquisition URL after source-catalog cleanup, preserving authorized legacy endpoints without guessing clone suffixes.

Compare expiry against the current root and validation inside the catalog transaction. Preserve independent authorized acquisitions while retiring expired roots, and refuse late publication or validation of retired identities.
