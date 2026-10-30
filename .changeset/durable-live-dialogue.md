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
