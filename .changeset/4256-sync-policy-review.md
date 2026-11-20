---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": patch
---

A hosted sync whose pull changes `context/policies/governance.md` no longer fails every time until the upstream commit is reverted (#4256). It publishes nothing and opens a review of the incoming policy, which the owner approves or declines in the sync panel. Approving writes exactly the incoming bytes through the existing policy writer, and the next sync completes. Declining writes nothing. `POST /api/brain/sync` sends a new `policy_review` frame and ends with `reason: "policy_review"`, and `POST /api/brain/sync/policy/:turnId/:requestId` takes the owner's `{ approve }`. A scheduled sync opens no review and names the waiting change. Any other refused tier A change keeps its refusal, and the message now says to revert the upstream commit, or, for a policy file, to change the policy in chat.
