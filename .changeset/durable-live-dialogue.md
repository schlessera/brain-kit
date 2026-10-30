---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

BREAKING: retain recognized and generated live dialogue with its chat across reopening; draft Discard no longer erases archived discussion. Add negotiated bounded history paging with original source provenance and operational recovery, without native replay or automatic expiry.

Preserve explicitly unsaved recognition/reply tails in observed order after real storage failure, and separate contextual correlated capture from bounded task/review caches.

Separate saved and unsaved recognition groups, bound projection work per session, distinguish pending-write pressure from storage errors, and keep both contextual and reviewed-only archival capture independent of rolling review budgets.

Integrate canonical reading/focus and stale-session recovery, qualify unsaved rows accessibly, preserve surviving source anchors during paging, and clear volatile evidence across principal replacement.

Drain task-persistence failures against the exact failed epoch, reject missing-chat reads without inventing legacy history, and qualify unclosed voice history separately from incomplete backend position witnesses.

Keep ordinary typed chats free of invented legacy-voice warnings, preserve true backend suffix offsets when voice starts mid-turn, and distinguish healthy active epochs from unclosed history after restart.

Order same-conversation close/open transitions through device takeover and pending-open replacement, preserve owner-local observation drains, and avoid false interruption from other exact healthy live identities without hiding real failures.

Preserve complete coverage for simultaneous healthy voice entries in one chat, fence and retire pending writer identities, and keep adopted sibling scopes aligned without masking no-close or restart gaps.

Keep already admitted provisional voice scopes healthy when adoption precedes acknowledgement, without relaxing new-start admission or identity fences.
