---
"@schlessera/brain-common": minor
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Support user-approved Apify Store Actors with once, persistent Actor approval and denial, scoped revocation, and module-facing availability checks. Share observed and estimated Apify costs across Actors and overall budgets, including platform/transfer estimates for catalog-only requests, retain provisional terminal billing liability, and scan arbitrary Actor inputs and dataset output for credential extraction.

Breaking before 1.0: existing exact-build `actor_grants` no longer admit runs and are not migrated into broader Actor approvals. Approve each Actor again using the new Actor-specific choice. Qualification-profile input/site/output restrictions and the legacy result item/byte truncation settings no longer gate approved Actors. The maintainer ruling is recorded on #3580.
