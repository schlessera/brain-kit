---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

Preserve complete Activity snapshots by sending byte-bounded append frames and pairing lifecycle records with atomic sequence watermarks. Keep lifecycle observations on one epoch-anchored monotonic clock so wall-clock corrections cannot reverse admission or backend timing. Require governed and journal evidence independently in native admission qualification.

Refetch individually oversized Activity records over REST without acknowledging clipped evidence, and bound per-frame watermark metadata with paginated scope completion. Read REST lifecycle and index root rows consistently with their sequence floors. Recover interrupted lifecycles at their last persisted host observation, and require exact completed admission phases and milestones in native qualification.
