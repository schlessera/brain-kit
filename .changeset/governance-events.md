---
"@schlessera/brain-ui-server": minor
---

The server now keeps a machine-readable record of sandbox and governance interventions with each session's history (#1651). A new `governance_events` table holds one versioned, schema-validated record per event: promotions, policy blocks and confirmations, read-only refusals, quarantines, budget and scope limits, egress denials, `strict` fallbacks, revert conflicts, outward actions, taint, unavailable providers, worker resource limits and roadblocks. Records survive the 7-day Activity span-detail prune and are deleted with their session. The new authenticated `GET /api/governance/events` reads them, filtered by session, turn and kind. Nothing is shown to the user, and nothing is written to `brain.db` or the brain. This release adds the record and its reader; the features that write each kind land separately.
